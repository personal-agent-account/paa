//! 自動登録(PBI-0023 / REQ-19、図18)の materialize 面。Cloud が hello の応答で返した
//! `registered` を受け、kind ごとに `atn adopt` を起こして credential + MCP config を書かせる。
//!
//! credentials.json の書式・lock 手順・`claude mcp add` の呼び方の正本は TS 側(Common
//! Installation Engine)の 1 箇所に置く —— Rust に写すと正本が 2 枚になり、片方だけ直る。
//! ここがやるのは「起こして token を stdin へ渡し、exit code を見る」だけ。
//!
//! token を argv に載せないのは、argv が同一ホストの他プロセスから `ps` で見えるため。

use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::paa_cli::cli_argv;

/// `registered.runtimes[]` の 1 件。
#[derive(Debug, Clone, PartialEq)]
pub struct Adoption {
    pub kind: String,
    pub runtime_id: String,
    pub token: String,
    pub base_url: String,
    pub name: String,
}

/// materialize 1 件の上限。CLI が対話待ちで固まっても WS ループを巻き込まない。
const ADOPT_TIMEOUT: Duration = Duration::from_secs(5);

/// `registered` payload から取り出す。欠落・型不正の要素は捨てる(1 つ壊れていても残りは進める)。
/// `name` だけは空でも通す —— 表示名が無いことは materialize の失敗理由にならない。
pub fn parse_registered(msg: &Value) -> Vec<Adoption> {
    let Some(items) = msg.get("runtimes").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|v| {
            let field = |k: &str| {
                v.get(k)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            };
            Some(Adoption {
                kind: field("kind")?,
                runtime_id: field("runtime_id")?,
                token: field("token")?,
                base_url: field("base_url")?,
                name: field("name").unwrap_or_default(),
            })
        })
        .collect()
}

/// 1 件を materialize する。戻り値 `(ok, detail)` の `detail` は `register_ack` に載る短い理由。
/// CLI 不在は `paa_cli_not_found`(配布で PATH に paa が無い、を運用で名指しできるようにする)。
pub async fn adopt(a: &Adoption) -> (bool, String) {
    adopt_with(&cli_argv(), a).await
}

/// `adopt` の本体。CLI の argv を引数で受けるので、test は env(`PAA_CLI`)を触らずに済む ——
/// cargo test は同一プロセスでスレッド並列に走るため、env を書き換える test は互いを壊す。
pub async fn adopt_with(argv: &[String], a: &Adoption) -> (bool, String) {
    let Some((program, leading)) = argv.split_first() else {
        return (false, "paa_cli_not_found".to_string());
    };
    let mut cmd = Command::new(program);
    cmd.args(leading);
    cmd.arg("adopt")
        .arg("--kind")
        .arg(&a.kind)
        .arg("--runtime-id")
        .arg(&a.runtime_id)
        .arg("--base-url")
        .arg(&a.base_url)
        .arg("--name")
        .arg(&a.name)
        .arg("--token-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // timeout で future を drop した時に子を確実に殺す(credential を書きかけたまま
        // 取り残さない)
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("broker: cannot start the atn CLI ({e})");
            return (false, "paa_cli_not_found".to_string());
        }
    };
    // token は stdin へ 1 行書いて close する(EOF を送らないと CLI 側の読み取りが返らない)
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(format!("{}\n", a.token).as_bytes()).await {
            return (false, format!("stdin write failed: {e}"));
        }
        drop(stdin);
    }
    match tokio::time::timeout(ADOPT_TIMEOUT, child.wait_with_output()).await {
        Err(_) => (false, "adopt_timeout".to_string()),
        Ok(Err(e)) => (false, format!("wait failed: {e}")),
        Ok(Ok(out)) if out.status.success() => (true, String::new()),
        Ok(Ok(out)) => {
            // stderr の 1 行目だけを理由にする(任意長の出力を Cloud へ送らない)
            let stderr = String::from_utf8_lossy(&out.stderr);
            let first: String = stderr
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .chars()
                .take(200)
                .collect();
            let detail = if first.is_empty() {
                format!("exit {}", out.status.code().unwrap_or(-1))
            } else {
                first
            };
            (false, detail)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample(kind: &str) -> Adoption {
        Adoption {
            kind: kind.to_string(),
            runtime_id: "rt_1".into(),
            token: "par_x".into(),
            base_url: "http://127.0.0.1:1".into(),
            name: "M / Codex".into(),
        }
    }

    #[test]
    fn parse_registered_は不正要素を捨てて有効な分だけ返す() {
        let msg = json!({
            "type": "registered",
            "runtimes": [
                {"kind": "codex", "runtime_id": "rt_1", "token": "par_x",
                 "base_url": "http://h", "name": "M / Codex"},
                {"kind": "claude", "runtime_id": "rt_2", "token": "", "base_url": "http://h"},
                {"kind": "claude"},
                "claude",
                42
            ]
        });
        let got = parse_registered(&msg);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, "codex");
        assert_eq!(got[0].token, "par_x");
        assert_eq!(got[0].name, "M / Codex");
    }

    #[test]
    fn parse_registered_は_runtimes_が無ければ空() {
        assert!(parse_registered(&json!({"type": "registered"})).is_empty());
        assert!(parse_registered(&json!({"runtimes": "x"})).is_empty());
    }

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    // PBI-0023 AC-4b: CLI が居ない環境でも broker は落ちず、名前の付いた reason を返す
    #[tokio::test]
    async fn adopt_は_cli_が無ければ_paa_cli_not_found() {
        let (ok, detail) = adopt_with(&argv(&["/nonexistent/atn-broker-test"]), &sample("codex")).await;
        assert!(!ok);
        assert_eq!(detail, "paa_cli_not_found");
        // PAA_CLI が空文字(= 分割後 0 要素)でも同じ扱い
        let (ok2, detail2) = adopt_with(&[], &sample("codex")).await;
        assert!(!ok2);
        assert_eq!(detail2, "paa_cli_not_found");
    }

    // PBI-0023 AC-4: exit != 0 は stderr の 1 行目を detail にして ok:false
    #[tokio::test]
    async fn adopt_は_exit_非0_を_stderr_の1行目付きで返す() {
        let cli = argv(&["/bin/sh", "-c", "echo no config >&2; exit 3"]);
        let (ok, detail) = adopt_with(&cli, &sample("codex")).await;
        assert!(!ok);
        assert_eq!(detail, "no config");
    }

    // 成功時は stdin から token を受け取れている(CLI 側で読める形で渡している)
    #[tokio::test]
    async fn adopt_は_成功時に_ok_true_と_空_detail_を返し_token_を_stdin_で渡す() {
        let dir = std::env::temp_dir().join(format!("paa-adopt-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let out = dir.join("stdin.txt");
        let cli = argv(&["/bin/sh", "-c", &format!("cat > {}", out.display())]);
        let (ok, detail) = adopt_with(&cli, &sample("codex")).await;
        assert!(ok, "detail={detail}");
        assert_eq!(detail, "");
        assert_eq!(std::fs::read_to_string(&out).unwrap().trim(), "par_x");
        let _ = std::fs::remove_dir_all(&dir);
    }

}
