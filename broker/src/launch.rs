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

/// dedicated session に載せる MCP server 名(runtime 側の登録名。install.ts の `MCP_SERVER_NAME`)。
const MCP_SERVER_NAME: &str = "atn";

/// gemini の閉じ込め policy(PBI-0167)。**admin tier** に「paa MCP 以外は全部 deny」を置く。
/// `toolName = "*"` + `mcpName = "atn"` は「その server の任意の tool」に一致する(bundle の
/// `ruleMatches` 実測: mcpName で server を絞ってから toolName の `*` を素通しする)。
/// 最終 priority = tier base(admin = 5)+ priority/1000 なので、deny(5.000)< allow(5.900)。
/// workspace tier(`<cwd>/.gemini/policies`)は 0.46.0 時点で**機能しない**(docs の警告)ため、
/// session_dir に置いた file を `--admin-policy` で明示的に読ませる。
const GEMINI_POLICY_TOML: &str = r#"# Containment policy the atn broker writes for each dedicated session.
# A notification body is attacker-controlled input, so no built-in tool
# (run_shell_command / write_file / …) is allowed — only the atn MCP server's tools.
[[rule]]
toolName = "*"
decision = "deny"
priority = 0

[[rule]]
toolName = "*"
mcpName = "atn"
decision = "allow"
priority = 900
"#;

/// 閉じ込めの成否を決める外部の状態(path)。実環境の既定は `containment_env()`、test は値で差し替える。
pub struct ContainmentEnv {
    /// claude の user config(`$CLAUDE_CONFIG_DIR` か `$HOME` の `.claude.json`)。
    /// paa MCP server の定義をここから読んで session_dir へ複製する。
    pub claude_config: PathBuf,
    /// claude の plugin 台帳(`<claude 設定 dir>/plugins/installed_plugins.json`)。
    /// **配布戦略 §7.1 は plugin-first**(図10)で、plugin が持ち込む MCP server は
    /// `.claude.json` の `mcpServers` には**書かれない**(実測 2026-09-02: 同じ機の
    /// fakechat plugin の server が top-level に無い)。台帳の `installPath` から
    /// plugin 同梱の `.mcp.json` を読んで複製元にする —— 無いと plugin で入れた人だけ
    /// 全 dedicated session が containment_unavailable になり、AUTO が黙って止まる。
    pub claude_plugin_registry: PathBuf,
    /// codex の user config(`$CODEX_HOME` か `$HOME/.codex` の `config.toml`)。
    /// codex には claude の `--strict-mcp-config` に相当する flag が無く、dedicated session でも
    /// **user が設定した MCP server を全部載せる**(実測 2026-09-02: `codex mcp list` に playwright /
    /// obsidian / unityMCP … が並ぶ)。MCP server は sandbox の外で動く別プロセスなので、
    /// `--sandbox read-only` を掛けても攻撃者の本文から network 越しの書込み・持ち出しができる。
    /// ここから server 名を読み、paa 以外を `-c mcp_servers.<name>.enabled=false` で落とす。
    pub codex_config: PathBuf,
    /// gemini の**標準** admin policy dir。ここに `.toml` が 1 つでも在ると、
    /// `--admin-policy` で渡す supplemental policy は **丸ごと無視される**(gemini の
    /// security guard: 中央 policy が既に在る所で flag 越しの上書きをさせない)。
    /// = 閉じ込めが効かないので、その時は起こさない(fail-closed)。
    pub gemini_admin_dirs: Vec<PathBuf>,
}

/// 実環境の `ContainmentEnv`。
pub fn containment_env() -> ContainmentEnv {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let claude_home = std::env::var("CLAUDE_CONFIG_DIR").unwrap_or_else(|_| home.clone());
    // plugin dir は CLAUDE_CONFIG_DIR 未設定時だけ `~/.claude/` の下(adapter の skillsDir と同じ規則)。
    let plugin_root = match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => PathBuf::from(&home).join(".claude"),
    };
    ContainmentEnv {
        claude_config: PathBuf::from(claude_home).join(".claude.json"),
        claude_plugin_registry: plugin_root.join("plugins").join("installed_plugins.json"),
        codex_config: match std::env::var("CODEX_HOME") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => PathBuf::from(&home).join(".codex"),
        }
        .join("config.toml"),
        gemini_admin_dirs: vec![
            // macOS / Linux / Windows の標準 admin policy dir(gemini docs)。
            // 3 つとも見るのは、broker が動く OS を argv 組み立ての条件にしないため
            // (存在しない path は「.toml 無し」と同じ扱いになるだけ)。
            PathBuf::from("/Library/Application Support/GeminiCli/policies"),
            PathBuf::from("/etc/gemini-cli/policies"),
            PathBuf::from(r"C:\ProgramData\gemini-cli\policies"),
        ],
    }
}

/// claude の paa MCP server の定義を抜き、`--mcp-config` に渡せる JSON にする。
/// 探す順序は ① user config(`.claude.json` の `mcpServers.paa` = `atn install claude` 経路)
/// → ② plugin 台帳(`installed_plugins.json` → `<installPath>/.mcp.json` = **plugin-first** 経路。
/// 図10 / 配布戦略 §7.1)。どちらでも見つからなければ `containment_unavailable` —— **user settings を
/// 落とすと MCP 登録ごと消える**(実測 2026-09-02: `--setting-sources project` で `atn` が tool 一覧から
/// 消える)ので、定義を複製できないなら「閉じ込めたまま仕事ができる session」を作れない。
/// 閉じ込めを緩めて起こす選択はしない(便利さより「mail 1 通で shell」を塞ぐ)。
///
/// ② を見るのは、plugin で入れた人の `.claude.json` に `mcpServers.paa` が**無い**ため
/// (実測 2026-09-02: 同じ機で plugin 由来の fakechat server は top-level `mcpServers` に無く、
/// `atn install claude` で入れた paa だけが在る)。① だけだと plugin-first の user は
/// 全 dedicated session が fail-closed になり、AUTO が dispatch_skip の log 1 行だけ残して止まる。
fn claude_mcp_config(config_path: &Path, plugin_registry: &Path) -> Result<String, String> {
    let server = claude_user_mcp_server(config_path)
        .or_else(|| claude_plugin_mcp_server(plugin_registry))
        .ok_or_else(|| {
            eprintln!(
                "broker: the atn MCP server definition was not found (neither in the user config {config_path:?} \
                 nor in the plugin registry {plugin_registry:?}). Cannot start it contained, so not starting it"
            );
            "containment_unavailable".to_string()
        })?;
    Ok(serde_json::json!({ "mcpServers": { MCP_SERVER_NAME: server } }).to_string())
}

/// ①: `.claude.json`(`claude mcp add -s user` が書く場所)の `mcpServers.paa`。
fn claude_user_mcp_server(config_path: &Path) -> Option<serde_json::Value> {
    let text = fs::read_to_string(config_path)
        .map_err(|e| eprintln!("broker: cannot read the claude config ({config_path:?}): {e}"))
        .ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| eprintln!("broker: the claude config is not valid JSON ({config_path:?}): {e}"))
        .ok()?;
    parsed.get("mcpServers")?.get(MCP_SERVER_NAME).cloned()
}

/// ②: plugin 台帳 → plugin 同梱の `.mcp.json` の `mcpServers.paa`。
/// 台帳の key は `<plugin 名>@<marketplace 名>`、値は install ごとの配列(scope: user / local)。
/// `${CLAUDE_PLUGIN_ROOT}` は claude が展開する変数なので、複製する時に **broker が実 path へ畳む**
/// (`--mcp-config` で渡す JSON は plugin の文脈で読まれないため、展開されないまま渡すと command が
/// 見つからず、閉じ込めただけで何も出来ない session になる)。
fn claude_plugin_mcp_server(registry_path: &Path) -> Option<serde_json::Value> {
    let text = fs::read_to_string(registry_path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| eprintln!("broker: the claude plugin registry is broken ({registry_path:?}): {e}"))
        .ok()?;
    let plugins = parsed.get("plugins")?.as_object()?;
    let mut candidates: Vec<&serde_json::Value> = plugins
        .iter()
        .filter(|(key, _)| key.split('@').next() == Some(MCP_SERVER_NAME))
        .filter_map(|(_, installs)| installs.as_array())
        .flatten()
        .collect();
    // scope:"user" を先に見る(local は「その project でだけ入れた」もの。dedicated session の
    // cwd は session_dir なので、user scope の install の方が実態に近い)。
    candidates.sort_by_key(|i| i.get("scope").and_then(|s| s.as_str()) != Some("user"));
    for install in candidates {
        let Some(root) = install.get("installPath").and_then(|p| p.as_str()) else { continue };
        let Ok(text) = fs::read_to_string(Path::new(root).join(".mcp.json")) else { continue };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let Some(server) = parsed.get("mcpServers").and_then(|s| s.get(MCP_SERVER_NAME)) else {
            continue;
        };
        return Some(expand_plugin_root(server, root));
    }
    None
}

/// JSON の文字列すべてで `${CLAUDE_PLUGIN_ROOT}` を実 path に置き換える(command / args / env 横断)。
fn expand_plugin_root(value: &serde_json::Value, root: &str) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => {
            serde_json::Value::String(s.replace("${CLAUDE_PLUGIN_ROOT}", root))
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(|v| expand_plugin_root(v, root)).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter().map(|(k, v)| (k.clone(), expand_plugin_root(v, root))).collect(),
        ),
        other => other.clone(),
    }
}

/// codex の config.toml から **paa 以外の MCP server 名**を拾う(PBI-0167 review 指摘)。
/// codex には claude の `--strict-mcp-config` に相当する flag が無いので、`-c
/// mcp_servers.<name>.enabled=false` を 1 つずつ積んで落とす(実測 2026-09-02, codex-cli 0.151.0:
/// `codex mcp list --json -c 'mcp_servers.playwright.enabled=false'` で該当 server だけ
/// `"enabled": false` になる)。**`codex mcp list` を broker から引く形は採らない** ——
/// 実測 7.1 秒かかり、auth 状態を見るために server を実際に起こしてしまう(wake の度に
/// user の playwright / obsidian が立ち上がる)。
///
/// 読めない config は「MCP server が 1 つも無い」ではなく **判定不能**として扱い、
/// `[mcp_servers.<name>]` 以外の書き方(inline table `mcp_servers = {…}` / quoted key)が
/// 現れたら名前を取り切れないので `containment_unavailable` で止める(fail-closed。
/// 「落とし忘れた server が 1 つ」は静かな全開放になるため、曖昧なら起こさない)。
fn codex_disabled_mcp_servers(config_path: &Path) -> Result<Vec<String>, String> {
    let Ok(text) = fs::read_to_string(config_path) else {
        // config.toml が無い = MCP server の設定も無い(paa は plugin 側から来る)。落とす相手が居ない。
        return Ok(vec![]);
    };
    let mut names: Vec<String> = vec![];
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let header = line.strip_prefix('[').and_then(|l| l.split(']').next());
        if let Some(header) = header {
            let header = header.trim_start_matches('[');
            let mut parts = header.split('.');
            if parts.next().map(str::trim) != Some("mcp_servers") {
                continue;
            }
            let Some(name) = parts.next().map(str::trim) else {
                eprintln!("broker: cannot read the server names under [mcp_servers] in the codex config ({config_path:?})");
                return Err("containment_unavailable".to_string());
            };
            if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                // quoted key(`["mcp_servers"."x y"]`)等。`-c` の key に安全に埋められない
                // = 落とし切れないので起こさない。
                eprintln!("broker: unexpected MCP server name in the codex config ({name:?} in {config_path:?})");
                return Err("containment_unavailable".to_string());
            }
            if name != MCP_SERVER_NAME && !names.iter().any(|n| n == name) {
                names.push(name.to_string());
            }
            continue;
        }
        if line.starts_with("mcp_servers") {
            // inline table(`mcp_servers = { github = { … } }`)は行単位では名前を取り切れない。
            eprintln!("broker: mcp_servers in the codex config is an inline table ({config_path:?}); cannot strip it safely, so not starting");
            return Err("containment_unavailable".to_string());
        }
    }
    Ok(names)
}

/// dir に `.toml` が 1 つでも在るか(gemini の標準 admin policy の有無)。
fn has_toml(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else { return false };
    entries.flatten().any(|e| {
        e.path()
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("toml"))
            .unwrap_or(false)
    })
}

/// AUTO / triage / draft / owner の dedicated session(PBI-0019 / PBI-0117)の起動引数と、
/// session_dir に置く**閉じ込め用の file** を runtime ごとに固定で組む(PBI-0167)。
///
/// argv は実測(PBI-0019 の実測 C / PBI-0061 の実測 D / PBI-0167 の実測 E)の通り。`instruction` は
/// argv の 1 要素として渡す前提 —— shell を経由させない(Cloud から届いた文字列を shell に解釈させると
/// 任意コマンド実行の口になる)。`session_dir` は codex の `-o`(結果ファイル)と、閉じ込め file の置き場に使う。
///
/// **閉じ込め(PBI-0167)**: dedicated session の入力(通知本文)は攻撃者が書ける。3 runtime とも
/// 「組込み tool は通さず paa MCP だけ通す」に揃える —— 揃っていないと「gemini を既定にしている人
/// だけ mail 1 通で shell を握られる」という、user から見えない差になる。
///
/// 返り値は (argv, session_dir に置く file の (相対 path, 中身))。実測 argv を持たない runtime は
/// `dedicated_unsupported` —— registry で足しただけの新 runtime(PBI-0022)を instruction 無しで
/// bare spawn してしまうと「AUTO で起こしたのに何も指示していない」session になる。
/// 閉じ込めが組めない環境は `containment_unavailable`(fail-closed。起こさない)。
pub fn dedicated_launch(
    runtime: &str,
    instruction: &str,
    session_dir: &str,
    env: &ContainmentEnv,
) -> Result<(Vec<String>, Vec<(String, String)>), String> {
    let argv = |args: &[&str]| args.iter().map(|s| s.to_string()).collect::<Vec<String>>();
    match runtime {
        // 実測 C(PBI-0019)+ 実測 E(PBI-0167, 2026-09-02, Claude Code 2.1.258):
        //   claude -p <instruction> --tools "" --setting-sources project --strict-mcp-config
        //          --mcp-config <dir>/atn-mcp.json --permission-mode dontAsk --allowedTools mcp__paa
        //          --output-format json --max-turns 40
        //
        // `--allowedTools mcp__paa` **だけでは Bash が通る**(実測 E: `--permission-mode dontAsk` は
        // 「聞かずに実行する」であって allow list ではない。user の `~/.claude/settings.json` に
        // `allow: ["Bash"]` が有ろうと無かろうと Bash は動いた)。組込み tool を落とすのは
        // `--tools ""`(= 組込みを 1 つも積まない。MCP tool は別枠なので paa は残る — 実測 E)。
        //
        // `--tools` / `--mcp-config` / `--allowedTools` は可変長引数なので、**直後には必ず別の flag を置く**
        // (positional が続くと flag が食う —— 実測 E で `--mcp-config <path> mcp list` が
        // "MCP config file not found: .../mcp" に化けた)。
        "claude" => {
            let mcp_config = claude_mcp_config(&env.claude_config, &env.claude_plugin_registry)?;
            let rel = "atn-mcp.json";
            Ok((
                argv(&[
                    "-p",
                    instruction,
                    "--tools",
                    "",
                    "--setting-sources",
                    "project",
                    "--strict-mcp-config",
                    "--mcp-config",
                    &format!("{session_dir}/{rel}"),
                    "--permission-mode",
                    "dontAsk",
                    "--allowedTools",
                    "mcp__atn",
                    "--output-format",
                    "json",
                    "--max-turns",
                    MAX_TURNS,
                ]),
                vec![(rel.to_string(), mcp_config)],
            ))
        }
        // codex exec --skip-git-repo-check --sandbox read-only -C <dir> -o <dir>/result.txt <instruction>
        //
        // `--sandbox read-only` は**明示する**(PBI-0167 AC-3)—— 既定も read-only だが、既定は
        // `~/.codex/config.toml` の `sandbox_mode` で user が上書きできる。攻撃者が書いた本文を
        // 読ませる session の権限を、user の設定 file 任せにしない。
        "codex" => {
            let mut args = argv(&["exec", "--skip-git-repo-check", "--sandbox", "read-only"]);
            // paa 以外の MCP server を 1 つずつ落とす(review 指摘: `--sandbox read-only` は
            // MCP server に掛からない —— server は sandbox の外の別プロセスなので、
            // 攻撃者の本文から playwright / obsidian 越しに network も書込みも届く)。
            for name in codex_disabled_mcp_servers(&env.codex_config)? {
                args.push("-c".to_string());
                args.push(format!("mcp_servers.{name}.enabled=false"));
            }
            args.extend(argv(&[
                "-C",
                session_dir,
                "-o",
                &format!("{session_dir}/result.txt"),
                instruction,
            ]));
            Ok((args, vec![]))
        }
        // 実測 D(2026-08-28, gemini-cli 0.46.0。PBI-0061 / W9c)+ 実測 E(PBI-0167):
        //   gemini -p <instruction> --approval-mode yolo --skip-trust
        //          --allowed-mcp-server-names paa --admin-policy <dir>/policies -o json
        //
        // `--skip-trust` は**必須** —— session_dir は必ず「信頼していないフォルダ」なので、
        // 無いと `Approval mode overridden to "default" because the current folder is not
        // trusted.` に落ちて tool 呼び出しが承認待ちで固まる(実測)。
        // `--allowed-mcp-server-names` は **MCP の絞りでしかない**(組込み tool は素通し)。
        // `--approval-mode yolo` は全 tool を自動承認するので、実測 E では
        // 「`run_shell_command` で date を実行しろ」の 1 文で **実際に shell が動いた**
        // (policy 無し: totalCalls 1 / policy 有り: totalCalls 0)。塞ぐのは policy engine。
        // claude の `--max-turns` に相当する flag は gemini に**無い**(help 実測) ——
        // 暴走の抑えは tool 制限と session timeout に委ねる。
        "gemini" => {
            if let Some(dir) = env.gemini_admin_dirs.iter().find(|d| has_toml(d)) {
                eprintln!(
                    "broker: a .toml exists in gemini's standard admin policy dir ({dir:?}), so \
                     --admin-policy would be ignored. Cannot contain the session, so not starting"
                );
                return Err("containment_unavailable".to_string());
            }
            let rel = "policies/paa-containment.toml";
            Ok((
                argv(&[
                    "-p",
                    instruction,
                    "--approval-mode",
                    "yolo",
                    "--skip-trust",
                    "--allowed-mcp-server-names",
                    "atn",
                    "--admin-policy",
                    &format!("{session_dir}/policies"),
                    "-o",
                    "json",
                ]),
                vec![(rel.to_string(), GEMINI_POLICY_TOML.to_string())],
            ))
        }
        _ => Err("dedicated_unsupported".to_string()),
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

/// `$PAA_BROKER_HOME`(default `~/.atn/broker`)。sessions/<requestId>/ と registry cache の親。
pub fn broker_home() -> PathBuf {
    if let Ok(dir) = std::env::var("PAA_BROKER_HOME") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".atn").join("broker")
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
/// `dedicated_launch` が組んだものだけを渡す前提(Cloud から届いた文字列を allowlist 検査なしに引数へ
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
            eprintln!("broker: could not create session_dir stdout.log: {e}");
            "session_dir_failed".to_string()
        })?;
        let stderr = fs::File::create(format!("{dir}/stderr.log")).map_err(|e| {
            eprintln!("broker: could not create session_dir stderr.log: {e}");
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
/// 実体は端末側の `atn agent <provider> --thread <id>`(PBI-0057) —— 端末に binary は無いので
/// `resolve_program`(scan の path)ではなく **`PAA_CLI` の argv** で起こす(`atn adopt` と同じ解決)。
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
        &containment_env(),
    )
}

/// `launch_session_scoped` の本体。broker home と `ContainmentEnv` を引数で受けるのはテストのため —— `env::set_var` で
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
    env: &ContainmentEnv,
) -> Result<Child, String> {
    if !is_safe_request_id(request_id) {
        return Err("invalid_request_id".to_string());
    }
    if instruction.len() > MAX_INSTRUCTION_BYTES {
        return Err("instruction_too_long".to_string());
    }
    let session_dir = home.join("sessions").join(request_id);
    fs::create_dir_all(&session_dir).map_err(|e| {
        eprintln!("broker: session_dir mkdir failed ({session_dir:?}): {e}");
        "session_dir_failed".to_string()
    })?;
    let dir_str = session_dir.to_string_lossy().to_string();
    fs::write(session_dir.join("instruction.txt"), instruction).map_err(|e| {
        eprintln!("broker: could not write instruction.txt: {e}");
        "session_dir_failed".to_string()
    })?;
    check_launchable(registry, runtime)?;
    let (args, files) = dedicated_launch(runtime, instruction, &dir_str, env)?;
    // 閉じ込め用の file(claude の `--mcp-config` / gemini の admin policy)を session_dir に置く。
    // spawn より **前** に全部書く —— 置けなかった runtime を「flag だけ付いた丸腰」で起こさない。
    for (rel, content) in &files {
        let path = session_dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                eprintln!("broker: could not create the dir for a containment file ({parent:?}): {e}");
                "session_dir_failed".to_string()
            })?;
        }
        fs::write(&path, content).map_err(|e| {
            eprintln!("broker: could not write a containment file ({path:?}): {e}");
            "session_dir_failed".to_string()
        })?;
    }
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
        let name = "atn-broker-definitely-not-a-real-binary";
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
        let dir = std::env::temp_dir().join(format!("atn-broker-cwd-{}", std::process::id()));
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
        let dir = std::env::temp_dir().join(format!("atn-broker-scope-{}", std::process::id()));
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
        let dir = std::env::temp_dir().join(format!("atn-broker-launch-{}", std::process::id()));
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

    // PBI-0019 AC-1/AC-2 + PBI-0167 AC-1〜AC-4: dedicated session の argv が実測どおりに組まれ、
    // 3 runtime とも閉じ込め(組込み tool を通さない)が argv / file として載ること。

    /// paa MCP が登録済みの claude user config と、admin policy の無い gemini を模した env。
    fn test_env() -> ContainmentEnv {
        let dir = std::env::temp_dir().join(format!("atn-broker-cenv-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let config = dir.join(".claude.json");
        fs::write(
            &config,
            r#"{"mcpServers":{"atn":{"type":"stdio","command":"bun","args":["/x/server.ts"],
               "env":{"PAA_RUNTIME_KIND":"claude","PAA_URL":"http://localhost:8787"}},
               "other":{"command":"other"}}}"#,
        )
        .unwrap();
        // codex は user の MCP server を全部載せる(--strict-mcp-config が無い)ので、
        // paa 以外は `-c ….enabled=false` で落とす —— 実機の config.toml と同じ形で置く。
        let codex_config = dir.join("codex-config.toml");
        fs::write(
            &codex_config,
            "model = \"gpt-5\"\n\n[mcp_servers.playwright]\ncommand = \"npx\"\n\n\
             [mcp_servers.playwright.tools.browser_click]\nenabled = true\n\n\
             # [mcp_servers.commented-out]\n\
             [mcp_servers.atn]\ncommand = \"bun\"\n\n[mcp_servers.obsidian]\ncommand = \"uvx\"\n",
        )
        .unwrap();
        ContainmentEnv {
            claude_config: config,
            claude_plugin_registry: dir.join("no-such-plugins.json"),
            codex_config,
            gemini_admin_dirs: vec![dir.join("no-such-admin-policies")],
        }
    }

    #[test]
    fn dedicated_launch_claude_matches_measured_argv() {
        let (args, files) = dedicated_launch("claude", "INSTR", "/tmp/sess", &test_env()).unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "INSTR",
                "--tools",
                "",
                "--setting-sources",
                "project",
                "--strict-mcp-config",
                "--mcp-config",
                "/tmp/sess/atn-mcp.json",
                "--permission-mode",
                "dontAsk",
                "--allowedTools",
                "mcp__atn",
                "--output-format",
                "json",
                "--max-turns",
                "40",
            ]
        );
        // AC-2: 組込み tool を 1 つも積まない(`--allowedTools` は allow list ではないので
        // これが落ちると user の settings.json の有無に関わらず Bash が通る — 実測 E)
        let tools = args.iter().position(|a| a == "--tools").expect("--tools が無い");
        assert_eq!(args[tools + 1], "", "--tools が空文字でない = 組込み tool が積まれる");
        // AC-2: user / local の settings.json(allow 規則と hooks)を読ませない
        let sources = args.iter().position(|a| a == "--setting-sources").unwrap();
        assert_eq!(args[sources + 1], "project");
        // 可変長引数の直後は必ず別の flag(positional が続くと flag が食う — 実測 E)
        for flag in ["--tools", "--mcp-config", "--allowedTools"] {
            let i = args.iter().position(|a| a == flag).unwrap();
            assert!(
                args.get(i + 2).map(|a| a.starts_with('-')).unwrap_or(false),
                "{flag} の値の後ろが flag でない: {args:?}"
            );
        }
        // user settings を落とすと MCP 登録ごと消えるので、paa の定義を session_dir に複製する
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "atn-mcp.json");
        let cfg: serde_json::Value = serde_json::from_str(&files[0].1).unwrap();
        assert_eq!(cfg["mcpServers"]["atn"]["command"], "bun");
        assert!(cfg["mcpServers"].get("other").is_none(), "paa 以外の MCP まで持ち込まない");
    }

    // AC-4(claude 側): paa MCP の定義を複製できない環境では起こさない。閉じ込めを緩めて
    // 起こす(user settings を読ませる)選択はしない。
    #[test]
    fn dedicated_launch_claude_without_paa_mcp_is_containment_unavailable() {
        let dir = std::env::temp_dir().join(format!("atn-broker-cenv-none-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let no_plugin = dir.join("no-such-plugins.json");
        let missing = ContainmentEnv {
            claude_config: dir.join("absent.json"),
            claude_plugin_registry: no_plugin.clone(),
            codex_config: dir.join("no-such-codex.toml"),
            gemini_admin_dirs: vec![],
        };
        assert_eq!(
            dedicated_launch("claude", "I", "/tmp/s", &missing).err(),
            Some("containment_unavailable".to_string())
        );
        let broken = dir.join("broken.json");
        fs::write(&broken, "{ not json").unwrap();
        assert_eq!(
            dedicated_launch("claude", "I", "/tmp/s", &ContainmentEnv { claude_config: broken, claude_plugin_registry: no_plugin.clone(), codex_config: dir.join("no-such-codex.toml"), gemini_admin_dirs: vec![] }).err(),
            Some("containment_unavailable".to_string())
        );
        let no_paa = dir.join("no-paa.json");
        fs::write(&no_paa, r#"{"mcpServers":{"other":{"command":"x"}}}"#).unwrap();
        assert_eq!(
            dedicated_launch("claude", "I", "/tmp/s", &ContainmentEnv { claude_config: no_paa, claude_plugin_registry: no_plugin.clone(), codex_config: dir.join("no-such-codex.toml"), gemini_admin_dirs: vec![] }).err(),
            Some("containment_unavailable".to_string())
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // review 指摘(順95): **plugin-first**(配布戦略 §7.1・図10)で入れた claude は
    // `.claude.json` の `mcpServers` に paa を持たない —— ① だけを見ていた実装では、
    // plugin で入れた user の全 dedicated session が containment_unavailable になり、
    // AUTO が dispatch_skip の log 1 行だけ残して黙って止まっていた。
    // ② plugin 台帳 → `<installPath>/.mcp.json` を複製元にし、`${CLAUDE_PLUGIN_ROOT}` を畳む。
    #[test]
    fn dedicated_launch_claude_falls_back_to_plugin_mcp_config() {
        let dir = std::env::temp_dir().join(format!("atn-broker-cenv-plugin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        // local scope の install は壊れた plugin dir を指す(user scope が先に選ばれることの確認)
        let local_root = dir.join("cache/paa/local");
        let user_root = dir.join("cache/paa/0.1.0");
        fs::create_dir_all(&user_root).unwrap();
        fs::write(
            user_root.join(".mcp.json"),
            r#"{"mcpServers":{"atn":{"command":"${CLAUDE_PLUGIN_ROOT}/atn-mcp",
               "args":["${CLAUDE_PLUGIN_ROOT}/mcp-server.bundle.js"],
               "env":{"PAA_RUNTIME_KIND":"claude"}}}}"#,
        )
        .unwrap();
        let registry = dir.join("installed_plugins.json");
        fs::write(
            &registry,
            format!(
                r#"{{"version":2,"plugins":{{
                   "other@mkt":[{{"scope":"user","installPath":"{other}"}}],
                   "atn@atn-marketplace":[
                     {{"scope":"local","installPath":"{local}"}},
                     {{"scope":"user","installPath":"{user}"}}]}}}}"#,
                other = dir.join("cache/other").display(),
                local = local_root.display(),
                user = user_root.display(),
            ),
        )
        .unwrap();
        let env = ContainmentEnv {
            // user config は「有るが paa は未登録」= plugin で入れた人の実態
            claude_config: {
                let c = dir.join(".claude.json");
                fs::write(&c, r#"{"mcpServers":{"other":{"command":"x"}}}"#).unwrap();
                c
            },
            claude_plugin_registry: registry,
            codex_config: dir.join("no-such-codex.toml"),
            gemini_admin_dirs: vec![],
        };
        let (_, files) = dedicated_launch("claude", "I", "/tmp/sess", &env).expect("起こせること");
        let cfg: serde_json::Value = serde_json::from_str(&files[0].1).unwrap();
        let root = user_root.display().to_string();
        assert_eq!(cfg["mcpServers"]["atn"]["command"], format!("{root}/atn-mcp"));
        assert_eq!(cfg["mcpServers"]["atn"]["args"][0], format!("{root}/mcp-server.bundle.js"));
        assert_eq!(cfg["mcpServers"]["atn"]["env"]["PAA_RUNTIME_KIND"], "claude");
        assert!(
            !files[0].1.contains("CLAUDE_PLUGIN_ROOT"),
            "変数が畳まれずに残ると command が見つからず、閉じ込めただけの丸腰 session になる: {}",
            files[0].1
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // ① が有る時は ① を使う(plugin 台帳より user 登録が優先。`atn install claude` した人の実態)。
    #[test]
    fn dedicated_launch_claude_prefers_user_config_over_plugin() {
        let (_, files) = dedicated_launch("claude", "I", "/tmp/sess", &test_env()).unwrap();
        let cfg: serde_json::Value = serde_json::from_str(&files[0].1).unwrap();
        assert_eq!(cfg["mcpServers"]["atn"]["command"], "bun");
    }

    // AC-3: codex は既定に頼らず `--sandbox read-only` を明示する(既定は user の
    // ~/.codex/config.toml で上書きできる)。
    #[test]
    fn dedicated_launch_codex_matches_measured_argv() {
        let (args, files) = dedicated_launch("codex", "INSTR", "/tmp/sess", &test_env()).unwrap();
        assert_eq!(
            args,
            vec![
                "exec",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                // review 指摘: paa 以外の MCP server は sandbox の外で動くので明示的に落とす
                "-c",
                "mcp_servers.playwright.enabled=false",
                "-c",
                "mcp_servers.obsidian.enabled=false",
                "-C",
                "/tmp/sess",
                "-o",
                "/tmp/sess/result.txt",
                "INSTR",
            ]
        );
        assert!(files.is_empty());
        let sandbox = args.iter().position(|a| a == "--sandbox").expect("--sandbox が無い");
        assert_eq!(args[sandbox + 1], "read-only");
        // paa 自身は落とさない(落とすと閉じ込めただけで何も出来ない session になる)
        assert!(!args.iter().any(|a| a == "mcp_servers.atn.enabled=false"));
        // instruction は最後(可変長の `-c` の直後に positional を置かない)
        assert_eq!(args.last().unwrap(), "INSTR");
    }

    // review 指摘(順95): codex の MCP は `--sandbox read-only` の外(別プロセス)なので、
    // 名前を取り切れない config は「server 無し」ではなく **判定不能**として起こさない。
    #[test]
    fn dedicated_launch_codex_with_unreadable_mcp_names_is_containment_unavailable() {
        let dir = std::env::temp_dir().join(format!("atn-broker-codex-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let env_with = |file: &str, body: &str| {
            let path = dir.join(file);
            fs::write(&path, body).unwrap();
            ContainmentEnv {
                claude_config: dir.join("no.json"),
                claude_plugin_registry: dir.join("no-plugins.json"),
                codex_config: path,
                gemini_admin_dirs: vec![],
            }
        };
        // inline table: 行単位では名前を取り切れない
        let inline = env_with("inline.toml", "mcp_servers = { github = { command = \"x\" } }\n");
        assert_eq!(
            dedicated_launch("codex", "I", "/tmp/s", &inline).err(),
            Some("containment_unavailable".to_string())
        );
        // quoted key: `-c` の key に埋められない
        let quoted = env_with("quoted.toml", "[mcp_servers.\"we ird\"]\ncommand = \"x\"\n");
        assert_eq!(
            dedicated_launch("codex", "I", "/tmp/s", &quoted).err(),
            Some("containment_unavailable".to_string())
        );
        // config.toml 自体が無い = 落とす相手が居ない(paa は plugin 側から来る)。起こしてよい
        let none = ContainmentEnv {
            claude_config: dir.join("no.json"),
            claude_plugin_registry: dir.join("no-plugins.json"),
            codex_config: dir.join("absent.toml"),
            gemini_admin_dirs: vec![],
        };
        let (args, _) = dedicated_launch("codex", "I", "/tmp/s", &none).unwrap();
        assert!(!args.iter().any(|a| a == "-c"));
        let _ = fs::remove_dir_all(&dir);
    }

    // PBI-0061 / W9c: 2026-08-28 に gemini-cli 0.46.0 を実際に叩いて確かめた argv。
    // `--skip-trust` が落ちると untrusted folder 判定で承認モードが default に戻り、
    // AUTO の session が tool 呼び出しの承認待ちで固まる(実測した失敗)。
    // PBI-0167 AC-1: `--approval-mode yolo` は組込み tool も自動承認するので、
    // admin tier の deny policy が唯一の壁になる(実測 E: policy 無しで shell が動いた)。
    #[test]
    fn dedicated_launch_gemini_matches_measured_argv() {
        let (args, files) = dedicated_launch("gemini", "INSTR", "/tmp/sess", &test_env()).unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "INSTR",
                "--approval-mode",
                "yolo",
                "--skip-trust",
                "--allowed-mcp-server-names",
                "atn",
                "--admin-policy",
                "/tmp/sess/policies",
                "-o",
                "json",
            ]
        );
        // 承認待ちで固まらないための必須 flag(単独でも守る)
        assert!(args.iter().any(|a| a == "--skip-trust"));
        // policy は session_dir に置く(workspace tier は 0.46.0 では機能しない)
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "policies/paa-containment.toml");
        assert!(files[0].1.contains("decision = \"deny\""), "{}", files[0].1);
        assert!(files[0].1.contains("mcpName = \"atn\""), "{}", files[0].1);
    }

    // AC-4(gemini 側): 標準 admin policy dir に .toml が在ると --admin-policy は無視される
    // (gemini の security guard)= 閉じ込められないので起こさない。
    #[test]
    fn dedicated_launch_gemini_with_system_policy_is_containment_unavailable() {
        let dir = std::env::temp_dir().join(format!("atn-broker-admin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("corp.toml"), "").unwrap();
        let env = ContainmentEnv {
            claude_config: dir.join(".claude.json"),
            claude_plugin_registry: dir.join("no-such-plugins.json"),
            codex_config: dir.join("no-such-codex.toml"),
            gemini_admin_dirs: vec![dir.clone()],
        };
        assert_eq!(
            dedicated_launch("gemini", "I", "/tmp/s", &env).err(),
            Some("containment_unavailable".to_string())
        );
        // .toml 以外しか無い dir は素通し(閉じ込めは効く)
        fs::remove_file(dir.join("corp.toml")).unwrap();
        fs::write(dir.join("README.md"), "").unwrap();
        assert!(dedicated_launch("gemini", "I", "/tmp/s", &env).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dedicated_launch_unknown_runtime_is_unsupported() {
        let env = test_env();
        assert_eq!(
            dedicated_launch("hermes", "INSTR", "/tmp/sess", &env).err(),
            Some("dedicated_unsupported".to_string())
        );
        assert_eq!(
            dedicated_launch("superagent", "INSTR", "/tmp/sess", &env).err(),
            Some("dedicated_unsupported".to_string())
        );
    }

    // registry で足した runtime を AUTO で起こそうとしても bare spawn にはならない(dedicated_unsupported)
    #[test]
    fn launch_session_refuses_runtime_without_dedicated_argv() {
        let tmp = std::env::temp_dir().join(format!("atn-broker-ded-{}", std::process::id()));
        let result = launch_session_scoped_in(&tmp, &reg_with_ollama(), &[], "superagent", "instr", "req-ded", None, &test_env());
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
        let tmp = std::env::temp_dir().join(format!("atn-broker-limit-{}", std::process::id()));
        let result =
            launch_session_scoped_in(&tmp, &registry::builtin(), &[], "not-a-real-runtime", &at_limit, "req-limit", None, &test_env());
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
        let home = std::env::temp_dir().join(format!("atn-broker-instr-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let result =
            launch_session_scoped_in(&home, &registry::builtin(), &[], "not-a-real-runtime", "INSTR", "req-ok", None, &test_env());
        assert_eq!(result.err(), Some("unknown_runtime".to_string()));
        assert_eq!(
            fs::read_to_string(home.join("sessions").join("req-ok").join("instruction.txt")).unwrap(),
            "INSTR",
            "instruction.txt が session_dir に残っていない、または中身が instruction と一致しない"
        );
        let _ = fs::remove_dir_all(&home);

        // 後半: session_dir が作れない状況(broker home が既存の通常ファイル)では session_dir_failed。
        // runtime は registry 外のダミー名 —— 万一 dir 判定をすり抜けても実 CLI に到達しない。
        let tmp_file = std::env::temp_dir().join(format!("atn-broker-file-{}", std::process::id()));
        fs::write(&tmp_file, "not a dir").unwrap();
        let result =
            launch_session_scoped_in(&tmp_file, &registry::builtin(), &[], "not-a-real-runtime", "instr", "req-dir", None, &test_env());
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
