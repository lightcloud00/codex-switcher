//! Prepaid API credit snapshot. Runs the `api-credit-probe` script, which reads keys through
//! CredVault itself; this module never sees a key or a vault value, it only relays the script's JSON.
use super::provider_access::find_binary;

const SCHEMA: &str = "aos.api-credit-probe.v1";
const UNEXPECTED: &str = "API credit check returned an unexpected result";
/// The probe reads its providers in parallel, each capped at 25 s, so this leaves a margin.
const PROBE_TIMEOUT_SECS: u64 = 60;

/// Takes the last stdout line that starts with `{` and accepts it only with the expected schema and a
/// `providers` array. Anything else is one fixed message, so stray output never reaches the renderer.
pub fn parse_probe_output(stdout: &str) -> Result<serde_json::Value, String> {
    let value: serde_json::Value = stdout
        .lines()
        .rev()
        .find(|l| l.starts_with('{'))
        .and_then(|l| serde_json::from_str(l).ok())
        .ok_or(UNEXPECTED)?;
    if value["schema"] == SCHEMA && value["providers"].is_array() {
        Ok(value)
    } else {
        Err(UNEXPECTED.into())
    }
}

/// Fixed argv from the caller, no stdin, stderr dropped, stdout capped. Timeout is its own message; a spawn or
/// read failure is the generic one. The exit status is ignored: the schema check decides validity.
#[cfg(not(windows))]
pub(super) async fn run_probe(
    binary: std::path::PathBuf,
    args: &[&str],
    secs: u64,
    what: &str,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    const STDOUT_CAP: u64 = 256 * 1024;
    let path = format!(
        "/opt/homebrew/bin:/usr/local/bin:{}",
        std::env::var("PATH").unwrap_or_default()
    );
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(args)
        .env("PATH", path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let run = async move {
        let mut child = cmd.spawn().ok()?;
        let mut out = child.stdout.take()?;
        let mut buf = Vec::new();
        (&mut out)
            .take(STDOUT_CAP)
            .read_to_end(&mut buf)
            .await
            .ok()?;
        drop(out);
        child.wait().await.ok()?;
        Some(String::from_utf8_lossy(&buf).into_owned())
    };
    match tokio::time::timeout(std::time::Duration::from_secs(secs), run).await {
        Err(_) => Err(format!("{what} timed out")),
        Ok(None) => Err(UNEXPECTED.into()),
        Ok(Some(stdout)) => Ok(stdout),
    }
}
#[cfg(windows)]
pub(super) async fn run_probe(
    _binary: std::path::PathBuf,
    _args: &[&str],
    _secs: u64,
    what: &str,
) -> Result<String, String> {
    Err(format!("{what} is not available on Windows"))
}

#[tauri::command]
pub async fn get_api_credits() -> Result<serde_json::Value, String> {
    let binary = find_binary("api-credit-probe")
        .ok_or("api-credit-probe is not installed on this computer")?;
    parse_probe_output(&run_probe(binary, &[], PROBE_TIMEOUT_SECS, "API credit check").await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    const GOOD: &str = r#"{"schema":"aos.api-credit-probe.v1","observed_at":"2026-10-30T13:30:16Z","providers":[{"id":"deepseek","available":true}]}"#;
    #[test]
    fn valid_output_after_a_noise_line_is_returned() {
        let value = parse_probe_output(&format!("warming up\n{GOOD}\n")).unwrap();
        assert_eq!(value["schema"], SCHEMA);
        assert_eq!(value["providers"][0]["id"], "deepseek");
        assert_eq!(parse_probe_output(GOOD).unwrap(), value);
    }
    #[test]
    fn the_last_json_line_wins() {
        let out = format!("{{\"schema\":\"other\"}}\n{GOOD}");
        assert!(parse_probe_output(&out).is_ok());
    }
    #[test]
    fn wrong_schema_or_missing_providers_is_rejected() {
        for out in [
            r#"{"schema":"aos.api-credit-probe.v2","providers":[]}"#,
            r#"{"schema":"aos.api-credit-probe.v1","providers":{}}"#,
            r#"{"schema":"aos.api-credit-probe.v1"}"#,
            r#"{"providers":[]}"#,
            "{not json",
        ] {
            assert_eq!(parse_probe_output(out).unwrap_err(), UNEXPECTED, "{out}");
        }
    }
    #[test]
    fn empty_or_non_json_output_is_rejected() {
        for out in [
            "",
            "\n",
            "no json here\nstill none",
            "  {\"indented\":true}",
        ] {
            assert_eq!(parse_probe_output(out).unwrap_err(), UNEXPECTED, "{out:?}");
        }
    }
    #[cfg(not(windows))]
    #[tokio::test]
    async fn run_probe_returns_stdout_and_reports_a_timeout() {
        let out = run_probe("/bin/echo".into(), &["hello"], 10, "API credit check").await;
        assert_eq!(out.unwrap(), "hello\n");
        let started = std::time::Instant::now();
        let hung = run_probe("/bin/sh".into(), &["-c", "exec sleep 30"], 1, "API credit check").await;
        assert_eq!(hung.unwrap_err(), "API credit check timed out");
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        let missing = run_probe("/no/such/binary".into(), &[], 10, "API credit check").await;
        assert_eq!(missing.unwrap_err(), UNEXPECTED);
    }
}
