//! Read-only Claude plan usage, from the local `claude-usage` CLI.
//!
//! The CLI asks each machine's own Claude Code for its plan usage (`claude -p /usage`) and merges it
//! with local worker logs. This module only runs that CLI and parses its JSON: it makes no network
//! calls and reads no Claude credentials.

use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

const SCHEMA: &str = "claude-usage.summary.v1";
const TIMEOUT: Duration = Duration::from_secs(30);

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "home directory not found".to_string())
}

/// Accept only a JSON object carrying the expected schema.
pub fn parse_claude_usage(stdout: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("claude-usage returned invalid JSON: {e}"))?;
    match value.get("schema").and_then(Value::as_str) {
        Some(SCHEMA) => Ok(value),
        Some(other) => Err(format!(
            "claude-usage returned schema {other}, expected {SCHEMA}"
        )),
        None => Err("claude-usage returned JSON without a schema".to_string()),
    }
}

/// Run `claude-usage --json` (shared by the Tauri command and web mode).
pub async fn fetch_claude_usage() -> Result<Value, String> {
    let home = home()?;
    let binary = home.join(".local/bin/claude-usage");
    if !binary.exists() {
        return Err("claude-usage is not installed (~/.local/bin/claude-usage)".to_string());
    }
    // A GUI app starts with a minimal PATH; the CLI needs python3, ssh, node and ccusage.
    let extra = [".local/bin", ".npm-global/bin"]
        .iter()
        .map(|p| home.join(p).to_string_lossy().into_owned())
        .chain([
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
        ]);
    let path = extra
        .chain(std::env::var("PATH").ok())
        .collect::<Vec<_>>()
        .join(":");

    let child = Command::new(&binary)
        .arg("--json")
        .env("PATH", path)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(TIMEOUT, child)
        .await
        .map_err(|_| format!("claude-usage timed out after {}s", TIMEOUT.as_secs()))?
        .map_err(|e| format!("could not run claude-usage: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let last = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("no output");
        let last: String = last.chars().take(300).collect();
        return Err(format!("claude-usage failed: {last}"));
    }
    parse_claude_usage(&String::from_utf8_lossy(&output.stdout))
}

#[tauri::command]
pub async fn get_claude_usage() -> Result<Value, String> {
    fetch_claude_usage().await
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../tests/fixtures/claude-usage-summary.json");

    #[test]
    fn fixture_parses() {
        let v = parse_claude_usage(FIXTURE).expect("fixture parses");
        assert!(v["accounts"].as_array().is_some_and(|a| !a.is_empty()));
    }

    #[test]
    fn account_email_passes_through_and_is_optional() {
        let v = parse_claude_usage(FIXTURE).expect("fixture parses");
        let accounts = v["accounts"].as_array().expect("accounts");
        let email = |name: &str| {
            accounts
                .iter()
                .find(|a| a["account"] == name)
                .map(|a| a["email"].clone())
        };
        assert_eq!(email("mac-max"), Some(Value::from("mac-max@example.com")));
        assert_eq!(email("wsl-max"), Some(Value::Null));
    }

    #[test]
    fn wrong_or_missing_schema_is_rejected() {
        assert!(parse_claude_usage(r#"{"schema":"other.v1"}"#)
            .unwrap_err()
            .contains("other.v1"));
        assert!(parse_claude_usage(r#"{"accounts":[]}"#).is_err());
        assert!(parse_claude_usage("[1,2]").is_err());
    }

    /// Runs the real CLI. `cargo test -- --ignored live_fetch` on a machine with claude-usage installed.
    #[tokio::test]
    #[ignore]
    async fn live_fetch() {
        let v = fetch_claude_usage().await.expect("claude-usage --json runs");
        assert_eq!(v["schema"], SCHEMA);
        assert!(v["accounts"].as_array().is_some_and(|a| !a.is_empty()));
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(parse_claude_usage("Traceback (most recent call last)").is_err());
        assert!(parse_claude_usage("").is_err());
    }
}
