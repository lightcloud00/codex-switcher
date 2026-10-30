//! Coding-client and Grok Bot status. Runs the `fleet-client-status` script, which reads versions, sign-in state
//! and the last hand-typed Grok usage from local files and each client's own status command (plus two read-only
//! ssh reads for the Windows and Miguel Grok Bots). This module only relays the script's JSON.
use super::api_credits::run_probe;
use super::provider_access::find_binary;

const SCHEMA: &str = "aos.client-status.v1";
const UNEXPECTED: &str = "Client status check returned an unexpected result";
/// The local reads take a second or two; the two ssh reads are capped at 25 s each and run in parallel.
const STATUS_TIMEOUT_SECS: u64 = 45;

/// Takes the last stdout line that starts with `{` and accepts it only with the expected schema and both
/// `tools` and `grok` arrays. Anything else is one fixed message, so stray output never reaches the renderer.
pub fn parse_status_output(stdout: &str) -> Result<serde_json::Value, String> {
    let value: serde_json::Value = stdout
        .lines()
        .rev()
        .find(|l| l.starts_with('{'))
        .and_then(|l| serde_json::from_str(l).ok())
        .ok_or(UNEXPECTED)?;
    if value["schema"] == SCHEMA && value["tools"].is_array() && value["grok"].is_array() {
        Ok(value)
    } else {
        Err(UNEXPECTED.into())
    }
}

#[tauri::command]
pub async fn get_client_status() -> Result<serde_json::Value, String> {
    let binary = find_binary("fleet-client-status")
        .ok_or("fleet-client-status is not installed on this computer")?;
    parse_status_output(&run_probe(binary, &[], STATUS_TIMEOUT_SECS, "Client status check").await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    const GOOD: &str = r#"{"schema":"aos.client-status.v1","observed_at":"2026-10-30T16:20:00Z","tools":[{"id":"codex-cli"}],"grok":[{"id":"grok-mac"}]}"#;
    #[test]
    fn valid_output_after_a_noise_line_is_returned() {
        let value = parse_status_output(&format!("warming up\n{GOOD}\n")).unwrap();
        assert_eq!(value["tools"][0]["id"], "codex-cli");
        assert_eq!(value["grok"][0]["id"], "grok-mac");
    }
    #[test]
    fn wrong_schema_or_missing_arrays_is_rejected() {
        for out in [
            r#"{"schema":"aos.client-status.v2","tools":[],"grok":[]}"#,
            r#"{"schema":"aos.client-status.v1","tools":[]}"#,
            r#"{"schema":"aos.client-status.v1","grok":[]}"#,
            r#"{"schema":"aos.client-status.v1","tools":{},"grok":[]}"#,
            "",
            "{not json",
        ] {
            assert_eq!(parse_status_output(out).unwrap_err(), UNEXPECTED, "{out}");
        }
    }
}
