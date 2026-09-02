use std::fs;
use std::path::{Path, PathBuf};

use tokio::process::{Child, Command};

use crate::discovery::Found;
use crate::paa_cli::cli_argv;
use crate::registry::Registry;

/// dedicated session の instruction の上限(argv 1 要素)。これを超えると OS の argv 上限で
/// spawn が `spawn failed` に埋もれるため、名前の付いた reason で手前で止める(PBI-0019 AC-11)。
/// Cloud 側は 21 件上限で ≤ 4KB を担保するので、16KB は多層防御の最終境界。
const MAX_INSTRUCTION_BYTES: usize = 16 * 1024;

/// dedicated session 起動時の 1 CLI あたりの最大 turn 数(コスト上限。実測 C: 3 turn で $0.31〜0.39)。
const MAX_TURNS: &str = "40";

/// AUTO の dedicated session(PBI-0019)の起動引数を runtime ごとに固定で組む。
///
/// argv は実測 C(backlog/PBI-0019 G1 表)の通り。`instruction` は argv の 1 要素として渡す
/// 前提 —— shell を経由させない(Cloud から届いた文字列を shell に解釈させると任意コマンド実行の
/// 口になる)。`session_dir` は codex の `-o`(結果ファイル)にだけ使う。所有権のある `String` を
/// 返すのは、`instruction`/`session_dir` が実行時に決まる可変長データで `&'static str` にできないため。
///
/// 実測 argv を持たない runtime は `None` —— registry で足しただけの新 runtime(PBI-0022)を
/// instruction 無しで bare spawn してしまうと「AUTO で起こしたのに何も指示していない」session になる。
pub fn dedicated_args(runtime: &str, instruction: &str, session_dir: &str) -> Option<Vec<String>> {
    match runtime {
        // 実測 C: claude -p <instruction> --permission-mode dontAsk --allowedTools mcp__paa
        //         --output-format json --max-turns 40
        "claude" => Some(vec![
            "-p".to_string(),
            instruction.to_string(),
            "--permission-mode".to_string(),
            "dontAsk".to_string(),
            "--allowedTools".to_string(),
            "mcp__paa".to_string(),
            "--output-format".to_string(),
            "json".to_string(),
            "--max-turns".to_string(),
            MAX_TURNS.to_string(),
        ]),
        // codex exec --skip-git-repo-check -C <dir> -o <dir>/result.txt <instruction>
        "codex" => Some(vec![
            "exec".to_string(),
            "--skip-git-repo-check".to_string(),
            "-C".to_string(),
            session_dir.to_string(),
            "-o".to_string(),
            format!("{session_dir}/result.txt"),
            instruction.to_string(),
        ]),
        // 実測 D(2026-08-28, gemini-cli 0.46.0。PBI-0061 / W9c):
        //   gemini -p <instruction> --approval-mode yolo --skip-trust
        //          --allowed-mcp-server-names paa -o json
        // `--skip-trust` は**必須** —— session_dir は必ず「信頼していないフォルダ」なので、
        // 無いと `Approval mode overridden to "default" because the current folder is not
        // trusted.` に落ちて tool 呼び出しが承認待ちで固まる(実測)。
        // `--allowed-tools` は DEPRECATED なので `--allowed-mcp-server-names` で PAA の
        // MCP server だけに絞る(claude の `--allowedTools mcp__paa` に相当)。
        // claude の `--max-turns` に相当する flag は gemini に**無い**(help 実測) ——
        // 暴走の抑えは tool 制限と session timeout に委ねる。
        "gemini" => Some(vec![
            "-p".to_string(),
            instruction.to_string(),
            "--approval-mode".to_string(),
            "yolo".to_string(),
            "--skip-trust".to_string(),
            "--allowed-mcp-server-names".to_string(),
            "paa".to_string(),
            "-o".to_string(),
            "json".to_string(),
        ]),
        _ => None,
    }
}

/// requestId は session_dir のパス要素になる(信頼境界を跨ぐ Cloud からの文字列)。
/// path traversal(`../`)や区切り文字を弾き、安全な id だけを通す。
fn is_safe_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 128
        && request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `$PAA_BROKER_HOME`(default `~/.paa/broker`)。sessions/<requestId>/ と registry cache の親。
pub fn broker_home() -> PathBuf {
    if let Ok(dir) = std::env::var("PAA_BROKER_HOME") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".paa").join("broker")
}

/// spawn する program。scan で見つかった path があればそれ(PATH に無い brew / npm の binary も
/// 起こせる — PBI-0022 AC-4b)、無ければ bare name(従来どおり PATH 解決)。app bundle(`source:"app"`)は
/// 実行ファイルではないので bare name に落とす。
pub fn resolve_program(found: &[Found], runtime: &str) -> String {
    found
        .iter()
        .find(|f| f.id == runtime && f.source != "app")
        .map(|f| f.path.clone())
        .unwrap_or_else(|| runtime.to_string())
}

/// registry に照らした起動可否。判定順序(図18): registry に無い → `unknown_runtime`、
/// 有るが `adapter: null`(Ollama 等 — 検出・表示のみ)→ `not_launchable`。
fn check_launchable(registry: &Registry, runtime: &str) -> Result<(), String> {
    match registry.detector(runtime) {
        Some(d) if d.adapter.is_none() => Err("not_launchable".to_string()),
        Some(_) => Ok(()),
        None => Err("unknown_runtime".to_string()),
    }
}

/// `runtime` は Cloud から WS メッセージで届く未検証の文字列(信頼境界を跨ぐ)。
/// Broker はローカルで強い権限を持つため(アーキ §16)、`allowlist` に無い名前は
/// 一切 spawn しない(任意コマンド実行の口にしない)。テストから安全なダミー名で
/// allowlist ごと差し替えられるよう、実 spawn を伴う検証を本物の CLI 名から分離する。
///
/// `program` は `resolve_program` が返した path か bare name。`args` は `session_args`/
/// `dedicated_args` が組んだものだけを渡す前提(Cloud から届いた文字列を allowlist 検査なしに引数へ
/// 混ぜない)。`session_dir` を渡すと (a) 子プロセスの **cwd をそこに固定** し、(b) stdout/stderr を
/// その配下のファイルへ向ける(dedicated session。None なら両方とも broker から継承)。
///
/// cwd を固定するのは安全のため(PBI-0033)。`claude -p` は **workspace trust dialog をスキップする**
/// (`claude --help` の `-p`: *The workspace trust dialog is skipped when Claude is run in
/// non-interactive mode … Only use this in directories you trust. Settings files that fail
/// validation are silently ignored*)。cwd を継承したままだと、broker daemon を起動したディレクトリの
/// `.claude/settings.json`(**hooks を含む**)・`CLAUDE.md`・project scope の `.mcp.json` を、
/// user の実 credential で走る無人 session が黙って読み込む。session_dir は broker が作った空
/// ディレクトリなので、そこに固定すれば読み込まれる設定は HOME 側(user scope)だけに決まる
/// —— PBI-0019 の実測 C(cwd = scratchpad)と同じ条件を再現する。codex に渡している
/// `-C <session_dir>` の claude 版でもある(左右非対称の解消)。MCP server の登録は絶対パス
/// (`MCP_SERVER_ENTRY` = `fileURLToPath(new URL(...))`)＋ user scope 登録なので cwd に依存しない
/// (コード確認。この機には paa MCP server が未登録なので実登録での実測はしていない)。
///
/// `resolve_program` が返す `Found.path` は scan 側(discovery.rs `absolutize`)で絶対化済みなので、
/// cwd を session_dir に固定しても `PATH` / `PAA_SCAN_DIRS` の相対 entry で解決が壊れない(PBI-0039)。
///
/// **Manual routing(`launch()`)では None のまま**にすること: `claude --continue` /
/// `codex resume --last` は「**そのディレクトリの**直近 session」を継ぐので、cwd を変えると
/// human が続けたかった会話とは別の(あるいは存在しない)session に繋がる。
///
/// 起動した子プロセスの `Child` を返す。reaper(終了 wait と session_result 送信)は
/// 呼び出し側(main.rs)が tokio task で引き受ける —— PBI-0015 は別スレッドで捨てるだけだったが、
/// PBI-0019 で終了を Cloud へ報告するため wait を呼び出し側の管理下に移した。
pub fn launch_with_allowlist(
    runtime: &str,
    program: &str,
    args: &[String],
    allowlist: &[String],
    session_dir: Option<&str>,
) -> Result<Child, String> {
    launch_with_scope(runtime, program, args, allowlist, session_dir, None)
}

/// `launch_with_allowlist` の本体 + triage session の scope token(EP-0013 W3 / PBI-0117)。
/// `scope` が有る時だけ子プロセスの env `PAA_SESSION_SCOPE` に載せる(MCP server が全 request の
/// `x-paa-session-scope` header で Cloud へ返す。REQ-61 enforcement ②)。無い時は env を
/// 触らない = Manual / AUTO / owner lane の dedicated session は従来どおり全権。
pub fn launch_with_scope(
    runtime: &str,
    program: &str,
    args: &[String],
    allowlist: &[String],
    session_dir: Option<&str>,
    scope: Option<&str>,
) -> Result<Child, String> {
    if !allowlist.contains(&runtime.to_string()) {
        return Err("unknown_runtime".to_string());
    }
    let mut cmd = Command::new(program);
    cmd.args(args);
    // 両 CLI とも非 TTY stdin を読みに行って hang するため null に落とす(実測 — codex exec は
    // "Reading additional input from stdin..." で待つ / claude -p も同様)。
    cmd.stdin(std::process::Stdio::null());
    // Claude Code の中から broker を起動した時、CLAUDECODE が残っていると nested 判定で落ちる。
    cmd.env_remove("CLAUDECODE");
    if let Some(scope) = scope {
        cmd.env("PAA_SESSION_SCOPE", scope);
    }
    if let Some(dir) = session_dir {
        // dedicated session の作業ディレクトリを session_dir に固定する(上の doc コメント: `-p` は
        // trust dialog を出さずに cwd の設定・hooks を読むため、継承した cwd のままにしない)。
        cmd.current_dir(dir);
        // dedicated session の出力は session_dir に残す(Cloud へは送らない — cost/内容の集計は
        // スコープ外)。open に失敗したら継承にフォールバックせず session_dir_failed 相当で扱う
        // ため、ここでは Result を上へ返す。
        // reason は AC-11 が literal 'session_dir_failed' を期待する(OBSERVE の grep 対象でもある)。
        // 詳細は eprintln へ逃がし、返す reason は bare token に保つ。
        let stdout = fs::File::create(format!("{dir}/stdout.log")).map_err(|e| {
            eprintln!("broker: session_dir stdout.log 作成失敗: {e}");
            "session_dir_failed".to_string()
        })?;
        let stderr = fs::File::create(format!("{dir}/stderr.log")).map_err(|e| {
            eprintln!("broker: session_dir stderr.log 作成失敗: {e}");
            "session_dir_failed".to_string()
        })?;
        cmd.stdout(stdout);
        cmd.stderr(stderr);
    }
    cmd.spawn().map_err(|e| format!("spawn failed: {e}"))
}

/// Cloud から受けた wake 要求(Manual routing / instruction 無し)に応じて runtime CLI を
/// bare spawn する(要件 §21.1 runtime launch)。`session_mode` は Manual routing(§20.1)の
/// New/Existing 選択。AUTO 経路は必ず `launch_session`(instruction 付き)を通る。
/// allowlist・起動引数は registry(署名検証済み ∪ built-in)から、program は scan 結果から引く(PBI-0022)。
pub fn launch(
    registry: &Registry,
    found: &[Found],
    runtime: &str,
    session_mode: &str,
) -> Result<Child, String> {
    check_launchable(registry, runtime)?;
    let args = registry.session_args(runtime, session_mode);
    let program = resolve_program(found, runtime);
    launch_with_allowlist(runtime, &program, &args, &registry.allowlist(), None)
}

/// 外部 API provider の runtime(`kind: "api"`。PBI-0070 / EP-0009 C)を起こす。
///
/// 実体は端末側の `paa agent <provider> --thread <id>`(PBI-0057) —— 端末に binary は無いので
/// `resolve_program`(scan の path)ではなく **`PAA_CLI` の argv** で起こす(`paa adopt` と同じ解決)。
/// runtime id は `<provider>-api` の規約で、provider 名はその接頭辞。
///
/// 判定順序: unknown_runtime / not_launchable(registry。Cloud から来た名前を先に潰す)→
/// thread_required(thread 無しでは返信先が無い)→ paa_cli_not_found → spawn。
/// wake payload に thread が無い時に bare spawn しない —— 何に返信するか決まっていない
/// session を起こしても、下書きの宛先が無い。
pub fn launch_api(
    registry: &Registry,
    runtime: &str,
    thread_id: &str,
    argv: &[String],
) -> Result<Child, String> {
    check_launchable(registry, runtime)?;
    if thread_id.is_empty() {
        return Err("thread_required".to_string());
    }
    let provider = runtime.strip_suffix("-api").unwrap_or(runtime);
    let Some((program, leading)) = argv.split_first() else {
        return Err("paa_cli_not_found".to_string());
    };
    let mut args: Vec<String> = leading.to_vec();
    args.extend([
        "agent".to_string(),
        provider.to_string(),
        "--thread".to_string(),
        thread_id.to_string(),
    ]);
    launch_with_allowlist(runtime, program, &args, &registry.allowlist(), None)
}

/// `launch_api` の env を読む面(`PAA_CLI`)。test は argv を値で渡せるよう本体と分ける。
pub fn launch_api_env(registry: &Registry, runtime: &str, thread_id: &str) -> Result<Child, String> {
    launch_api(registry, runtime, thread_id, &cli_argv())
}

/// dedicated session(PBI-0019 の AUTO と PBI-0117 の triage)を起動する。判定順序(図15):
/// invalid_request_id → instruction_too_long → session_dir_failed → unknown_runtime / not_launchable
/// (registry)→ dedicated_unsupported → spawn。
///
/// session_dir(`$PAA_BROKER_HOME/sessions/<requestId>/`)を作り、instruction.txt を残してから
/// spawn する。stdout/stderr は session_dir のファイルへ向ける。返すのは起動した `Child` で、
/// 終了の wait と session_result 送信は呼び出し側(main.rs)の reaper が引き受ける。
///
/// `scope` は triage session の token(PBI-0117)。`Some` の時だけ子 env `PAA_SESSION_SCOPE` が
/// 載る(launch_with_scope)。AUTO / owner lane からは `None` で呼ぶ = env に載らない = 全権。
pub fn launch_session_scoped(
    registry: &Registry,
    found: &[Found],
    runtime: &str,
    instruction: &str,
    request_id: &str,
    scope: Option<&str>,
) -> Result<Child, String> {
    launch_session_scoped_in(
        &broker_home(),
        registry,
        found,
        runtime,
        instruction,
        request_id,
        scope,
    )
}

/// `launch_session_scoped` の本体。broker home を引数で受けるのはテストのため —— `env::set_var` で
/// `PAA_BROKER_HOME` を差し替える方式は、並列に走る他テストの spawn 中の子プロセスの環境を壊す
/// (実測: version probe の子 `sh` が落ちて出力が空になる)。
pub fn launch_session_scoped_in(
    home: &Path,
    registry: &Registry,
    found: &[Found],
    runtime: &str,
    instruction: &str,
    request_id: &str,
    scope: Option<&str>,
) -> Result<Child, String> {
    if !is_safe_request_id(request_id) {
        return Err("invalid_request_id".to_string());
    }
    if instruction.len() > MAX_INSTRUCTION_BYTES {
        return Err("instruction_too_long".to_string());
    }
    let session_dir = home.join("sessions").join(request_id);
    fs::create_dir_all(&session_dir).map_err(|e| {
        eprintln!("broker: session_dir mkdir 失敗 ({session_dir:?}): {e}");
        "session_dir_failed".to_string()
    })?;
    let dir_str = session_dir.to_string_lossy().to_string();
    fs::write(session_dir.join("instruction.txt"), instruction).map_err(|e| {
        eprintln!("broker: instruction.txt 書込失敗: {e}");
        "session_dir_failed".to_string()
    })?;
    check_launchable(registry, runtime)?;
    let args = dedicated_args(runtime, instruction, &dir_str).ok_or_else(|| "dedicated_unsupported".to_string())?;
    let program = resolve_program(found, runtime);
    launch_with_scope(runtime, &program, &args, &registry.allowlist(), Some(&dir_str), scope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry;

    // 実 claude/codex には触れない(テストプロセスの PATH 上に本物が存在しうるため、
    // built-in registry をそのまま使う spawn 検証は事故のもと — allowlist ごと差し替えて検証する)。

    fn allow(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn reg_with_ollama() -> Registry {
        registry::parse(
            r#"{"version":1,"detectors":[
                {"id":"ollama","detect":{"binaries":["ollama"]},"adapter":null},
                {"id":"superagent","detect":{"binaries":["superagent"]},"adapter":"official/superagent"}
            ]}"#,
            "t",
        )
        .unwrap()
        .merged_with_builtin()
    }

    #[tokio::test]
    async fn name_outside_allowlist_is_rejected_without_spawning() {
        let result = launch_with_allowlist("not-allowed", "not-allowed", &[], &allow(&["allowed-name"]), None);
        assert_eq!(result.err(), Some("unknown_runtime".to_string()));
    }

    #[tokio::test]
    async fn name_in_allowlist_but_missing_binary_returns_spawn_error() {
        // allowlist は通るが、そんな名前の実行可能ファイルは存在しない
        let name = "paa-broker-definitely-not-a-real-binary";
        let result = launch_with_allowlist(name, name, &[], &allow(&[name]), None);
        assert!(result.is_err());
        assert_ne!(result.err(), Some("unknown_runtime".to_string()));
    }

    // PBI-0033 AC-1/AC-2: dedicated session は session_dir を cwd にし、Manual の bare spawn は
    // broker の cwd を継承すること(`claude -p` は trust dialog を出さずに cwd の設定・hooks を
    // 読むので、無人 session を broker daemon のカレントディレクトリで走らせない)。
    // 実 CLI は起動しない —— cwd を出力するだけの POSIX コマンド(pwd)を allowlist ごと注入する。

    #[tokio::test]
    async fn dedicated_session_runs_in_session_dir() {
        let dir = std::env::temp_dir().join(format!("paa-broker-cwd-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dir_str = dir.to_string_lossy().to_string();
        let mut child = launch_with_allowlist("pwd", "pwd", &[], &allow(&["pwd"]), Some(&dir_str))
            .expect("pwd should spawn");
        assert!(child.wait().await.unwrap().success());
        let printed = fs::read_to_string(dir.join("stdout.log")).unwrap();
        // macOS の temp は /var → /private/var の symlink なので実体パスで比較する。
        assert_eq!(
            fs::canonicalize(printed.trim()).unwrap(),
            fs::canonicalize(&dir).unwrap(),
            "dedicated session の cwd が session_dir になっていない"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn manual_bare_spawn_keeps_broker_cwd() {
        // session_dir を渡さない経路(Manual routing の --continue / resume --last)では cwd を
        // 変えてはいけない —— 継ぐべき「直近 session」はディレクトリごとに決まるため。
        // stdout は継承なので、ここでは起動できることだけを見る(cwd の実体は AC-1 側で観測済み)。
        let mut child =
            launch_with_allowlist("pwd", "pwd", &[], &allow(&["pwd"]), None).expect("spawn");
        assert!(child.wait().await.unwrap().success());
    }

    // PBI-0117: triage session は scope token を子 env `PAA_SESSION_SCOPE` で受け取る(MCP が
    // 全 request の `x-paa-session-scope` header で Cloud へ返す)。scope 無しの起動は env を
    // 載せない(Manual / AUTO / owner lane が従来どおり全権であることの片側確認)。
    #[tokio::test]
    async fn scoped_session_passes_env_and_unscoped_leaves_it_unset() {
        let dir = std::env::temp_dir().join(format!("paa-broker-scope-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dir_str = dir.to_string_lossy().to_string();
        let print_scope = vec!["-c".to_string(), "printenv PAA_SESSION_SCOPE".to_string()];

        let mut child = launch_with_scope(
            "env-probe",
            "sh",
            &print_scope,
            &allow(&["env-probe"]),
            Some(&dir_str),
            Some("pst_test_scope_token"),
        )
        .expect("sh should spawn");
        assert!(child.wait().await.unwrap().success());
        assert_eq!(
            fs::read_to_string(dir.join("stdout.log")).unwrap().trim(),
            "pst_test_scope_token",
            "scope token が子プロセスの env に載っていない"
        );

        let mut child = launch_with_scope(
            "env-probe",
            "sh",
            &print_scope,
            &allow(&["env-probe"]),
            Some(&dir_str),
            None,
        )
        .expect("sh should spawn");
        // printenv は未設定の変数で非 0 終了する = env に載っていない
        assert!(!child.wait().await.unwrap().success());
        assert_eq!(fs::read_to_string(dir.join("stdout.log")).unwrap().trim(), "");
        let _ = fs::remove_dir_all(&dir);
    }

    // PBI-0022 AC-4c: adapter: null の id は allowlist に入らず not_launchable、registry 外は unknown_runtime
    #[tokio::test]
    async fn adapter_null_is_not_launchable_and_unknown_is_unknown() {
        let reg = reg_with_ollama();
        assert_eq!(launch(&reg, &[], "ollama", "new").err(), Some("not_launchable".to_string()));
        assert_eq!(launch(&reg, &[], "hermes", "new").err(), Some("unknown_runtime".to_string()));
        assert_eq!(launch(&reg, &[], "rm", "existing").err(), Some("unknown_runtime".to_string()));
        assert!(!reg.allowlist().contains(&"ollama".to_string()));
        assert!(reg.allowlist().contains(&"superagent".to_string()));
    }

    // PBI-0022 AC-3 / AC-4b: registry で足した id は allowlist を通り、found の path で spawn される
    #[tokio::test]
    async fn registry_added_runtime_launches_by_found_path() {
        let reg = reg_with_ollama();
        let dir = std::env::temp_dir().join(format!("paa-broker-launch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("ran");
        let bin = dir.join("superagent");
        fs::write(&bin, format!("#!/bin/sh\n: > \"{}\"\n", marker.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let found = vec![Found {
            id: "superagent".into(),
            version: None,
            source: "dir".into(),
            path: bin.to_string_lossy().into(),
            models: vec![],
        }];
        // PATH には無い名前なので、found の path で起動できたことが marker で分かる
        let mut child = launch(&reg, &found, "superagent", "new").expect("spawn by found path");
        child.wait().await.unwrap();
        assert!(marker.exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolve_program_prefers_found_path_but_not_app_bundles() {
        let found = vec![
            Found { id: "codex".into(), version: None, source: "brew".into(), path: "/opt/homebrew/bin/codex".into(), models: vec![] },
            Found { id: "ollama".into(), version: None, source: "app".into(), path: "/Applications/Ollama.app".into(), models: vec![] },
        ];
        assert_eq!(resolve_program(&found, "codex"), "/opt/homebrew/bin/codex");
        assert_eq!(resolve_program(&found, "ollama"), "ollama");
        assert_eq!(resolve_program(&found, "claude"), "claude");
    }

    // PBI-0019 AC-1/AC-2: dedicated session の argv が実測 C の通りに組まれること。

    #[test]
    fn dedicated_args_claude_matches_measured_argv() {
        let args = dedicated_args("claude", "INSTR", "/tmp/sess").unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "INSTR",
                "--permission-mode",
                "dontAsk",
                "--allowedTools",
                "mcp__paa",
                "--output-format",
                "json",
                "--max-turns",
                "40",
            ]
        );
    }

    #[test]
    fn dedicated_args_codex_matches_measured_argv() {
        let args = dedicated_args("codex", "INSTR", "/tmp/sess").unwrap();
        assert_eq!(
            args,
            vec![
                "exec",
                "--skip-git-repo-check",
                "-C",
                "/tmp/sess",
                "-o",
                "/tmp/sess/result.txt",
                "INSTR",
            ]
        );
    }

    // PBI-0061 / W9c: 2026-08-28 に gemini-cli 0.46.0 を実際に叩いて確かめた argv。
    // `--skip-trust` が落ちると untrusted folder 判定で承認モードが default に戻り、
    // AUTO の session が tool 呼び出しの承認待ちで固まる(実測した失敗)。
    #[test]
    fn dedicated_args_gemini_matches_measured_argv() {
        let args = dedicated_args("gemini", "INSTR", "/tmp/sess").unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "INSTR",
                "--approval-mode",
                "yolo",
                "--skip-trust",
                "--allowed-mcp-server-names",
                "paa",
                "-o",
                "json",
            ]
        );
        // 承認待ちで固まらないための必須 flag(単独でも守る)
        assert!(args.iter().any(|a| a == "--skip-trust"));
    }

    #[test]
    fn dedicated_args_unknown_runtime_is_none() {
        assert!(dedicated_args("hermes", "INSTR", "/tmp/sess").is_none());
        assert!(dedicated_args("superagent", "INSTR", "/tmp/sess").is_none());
    }

    // registry で足した runtime を AUTO で起こそうとしても bare spawn にはならない(dedicated_unsupported)
    #[test]
    fn launch_session_refuses_runtime_without_dedicated_argv() {
        let tmp = std::env::temp_dir().join(format!("paa-broker-ded-{}", std::process::id()));
        let result = launch_session_scoped_in(&tmp, &reg_with_ollama(), &[], "superagent", "instr", "req-ded", None);
        assert_eq!(result.err(), Some("dedicated_unsupported".to_string()));
        let _ = fs::remove_dir_all(&tmp);
    }

    // PBI-0019 AC-11: dedicated session の境界(instruction 長・request_id 安全性・session_dir)。

    #[test]
    fn launch_session_rejects_oversized_instruction() {
        // runtime は registry 外のダミー名(PBI-0040) —— instruction_too_long は request_id/長さ判定
        // だけで確定するので実 runtime 名である必要が無い。判定順序を触る改修が入っても spawn に
        // 届かないための多層防御(launch_session_writes_instruction_file_and_reports_dir_failure と同じ意図)。
        let big = "x".repeat(MAX_INSTRUCTION_BYTES + 1);
        let result = launch_session_scoped(&registry::builtin(), &[], "not-a-real-runtime", &big, "req-1", None);
        assert_eq!(result.err(), Some("instruction_too_long".to_string()));
    }

    #[test]
    fn launch_session_accepts_instruction_at_limit_boundary() {
        // 16KB ちょうどは instruction_too_long にならない(> で判定。境界の 1 バイト差を守る)。
        // registry 外の名前を使い、instruction_too_long を通過した後で unknown_runtime に
        // 落ちることで「長さ判定は通った」ことだけを確認する(実 CLI は spawn しない)。
        let at_limit = "x".repeat(MAX_INSTRUCTION_BYTES);
        // request_id を安全な値にし、broker home を temp に向ける(env は触らない)
        let tmp = std::env::temp_dir().join(format!("paa-broker-limit-{}", std::process::id()));
        let result =
            launch_session_scoped_in(&tmp, &registry::builtin(), &[], "not-a-real-runtime", &at_limit, "req-limit", None);
        // instruction_too_long ではないこと(registry で弾かれるのが正しい)
        assert_eq!(result.err(), Some("unknown_runtime".to_string()));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn launch_session_rejects_unsafe_request_id() {
        // runtime は registry 外のダミー名(PBI-0040) —— invalid_request_id は他の全判定より先に
        // 確定するので実 runtime 名である必要が無い。
        for bad in ["", "../escape", "a/b", "with space", &"z".repeat(129)] {
            let result = launch_session_scoped(&registry::builtin(), &[], "not-a-real-runtime", "instr", bad, None);
            assert_eq!(
                result.err(),
                Some("invalid_request_id".to_string()),
                "request_id {bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn is_safe_request_id_accepts_generated_ids() {
        // generateId("wr") は wr_<uuidv7 hex/base32 相当>。英数と _/- のみ想定。
        assert!(is_safe_request_id("wr_01hxyz9abc"));
        assert!(is_safe_request_id("wr-ABC_123"));
        assert!(!is_safe_request_id("wr_/etc/passwd"));
    }

    #[test]
    fn launch_session_writes_instruction_file_and_reports_dir_failure() {
        // 前半 = 名前が主張しているもう半分(PBI-0034 で足され PBI-0022/0023 の launch_session_scoped_in
        // 6引数化で一度落ちたので PBI-0040 で復元): 成功経路では session_dir に instruction.txt が
        // 中身ごと残る。runtime は registry 外のダミー名 —— 万一 dir 判定をすり抜けても実 CLI に
        // 到達しない。
        let home = std::env::temp_dir().join(format!("paa-broker-instr-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let result =
            launch_session_scoped_in(&home, &registry::builtin(), &[], "not-a-real-runtime", "INSTR", "req-ok", None);
        assert_eq!(result.err(), Some("unknown_runtime".to_string()));
        assert_eq!(
            fs::read_to_string(home.join("sessions").join("req-ok").join("instruction.txt")).unwrap(),
            "INSTR",
            "instruction.txt が session_dir に残っていない、または中身が instruction と一致しない"
        );
        let _ = fs::remove_dir_all(&home);

        // 後半: session_dir が作れない状況(broker home が既存の通常ファイル)では session_dir_failed。
        // runtime は registry 外のダミー名 —— 万一 dir 判定をすり抜けても実 CLI に到達しない。
        let tmp_file = std::env::temp_dir().join(format!("paa-broker-file-{}", std::process::id()));
        fs::write(&tmp_file, "not a dir").unwrap();
        let result =
            launch_session_scoped_in(&tmp_file, &registry::builtin(), &[], "not-a-real-runtime", "instr", "req-dir", None);
        // AC-11: reason は bare token 'session_dir_failed'(詳細は付けない)。
        assert_eq!(result.err(), Some("session_dir_failed".to_string()));
        let _ = fs::remove_file(&tmp_file);
    }

    // ---- 外部 API provider runtime(PBI-0070 / EP-0009 C)----

    fn reg_with_api() -> Registry {
        registry::parse(
            r#"{"version":1,"detectors":[
                {"id":"openai-api","kind":"api","detect":{"always":true},"adapter":"official/api"},
                {"id":"noadapter-api","kind":"api","detect":{"always":true},"adapter":null}
            ]}"#,
            "t",
        )
        .unwrap()
        .merged_with_builtin()
    }

    /// argv を marker file に書くだけの fake CLI(実 paa には到達させない。EP-0001 LEARN 13)
    fn fake_cli(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("paa-launch-api-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("argv.log");
        let bin = dir.join("fake-paa");
        fs::write(&bin, format!("#!/bin/sh\necho \"$@\" >> {}\nexit 0\n", marker.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        (bin, marker)
    }

    #[tokio::test]
    async fn api_runtime_spawns_paa_agent_with_thread() {
        let (bin, marker) = fake_cli("ok");
        let argv = vec![bin.to_string_lossy().to_string()];
        let mut child = launch_api(&reg_with_api(), "openai-api", "th_1", &argv).expect("spawn");
        let _ = child.wait().await;
        let logged = fs::read_to_string(&marker).unwrap();
        assert_eq!(logged.trim(), "agent openai --thread th_1");
    }

    #[tokio::test]
    async fn api_runtime_keeps_leading_argv_from_paa_cli() {
        // PAA_CLI="bun:<path>" 相当。argv0 の後ろの先行引数を落とさない
        let (bin, marker) = fake_cli("leading");
        let argv = vec![bin.to_string_lossy().to_string(), "/repo/paa.ts".to_string()];
        let mut child = launch_api(&reg_with_api(), "openai-api", "th_2", &argv).expect("spawn");
        let _ = child.wait().await;
        assert_eq!(
            fs::read_to_string(&marker).unwrap().trim(),
            "/repo/paa.ts agent openai --thread th_2"
        );
    }

    #[tokio::test]
    async fn api_runtime_unknown_name_is_rejected_before_spawn() {
        let (bin, marker) = fake_cli("unknown");
        let argv = vec![bin.to_string_lossy().to_string()];
        let result = launch_api(&reg_with_api(), "evil-api", "th_1", &argv);
        assert_eq!(result.err(), Some("unknown_runtime".to_string()));
        assert!(!marker.exists(), "spawn してはいけない");
    }

    #[tokio::test]
    async fn api_runtime_without_thread_or_cli_never_spawns() {
        let (bin, marker) = fake_cli("guard");
        let argv = vec![bin.to_string_lossy().to_string()];
        assert_eq!(
            launch_api(&reg_with_api(), "openai-api", "", &argv).err(),
            Some("thread_required".to_string())
        );
        assert_eq!(
            launch_api(&reg_with_api(), "openai-api", "th_1", &[]).err(),
            Some("paa_cli_not_found".to_string())
        );
        // adapter: null(検出のみ)の api runtime も起こさない
        assert_eq!(
            launch_api(&reg_with_api(), "noadapter-api", "th_1", &argv).err(),
            Some("not_launchable".to_string())
        );
        assert!(!marker.exists(), "どの経路でも spawn してはいけない");
    }

    #[tokio::test]
    async fn api_runtime_two_wakes_spawn_independently() {
        let (bin, marker) = fake_cli("parallel");
        let argv = vec![bin.to_string_lossy().to_string()];
        let reg = reg_with_api();
        let mut a = launch_api(&reg, "openai-api", "th_a", &argv).expect("spawn a");
        let mut b = launch_api(&reg, "openai-api", "th_b", &argv).expect("spawn b");
        let (ra, rb) = tokio::join!(a.wait(), b.wait());
        assert!(ra.is_ok() && rb.is_ok());
        let logged = fs::read_to_string(&marker).unwrap();
        assert!(logged.contains("--thread th_a"), "logged={logged}");
        assert!(logged.contains("--thread th_b"), "logged={logged}");
    }
}
