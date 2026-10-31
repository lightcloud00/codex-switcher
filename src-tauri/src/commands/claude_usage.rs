//! Read-only Claude plan usage, from the local `claude-usage` CLI.
//!
//! The CLI asks each machine's own Claude Code for its plan usage (`claude -p /usage`) and merges it
//! with local worker logs. This module only runs that CLI and parses its JSON: it makes no network
//! calls and reads no Claude credentials.
//!
//! It also reads the fleet seat registry (read-only) so the Claude tab and the capacity exporter can
//! list every Claude seat, including one that has no usage reading yet.

use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::time::Duration;
#[cfg(not(windows))]
use tokio::process::Command;

const SCHEMA: &str = "claude-usage.summary.v1";
#[cfg(not(windows))]
const TIMEOUT: Duration = Duration::from_secs(30);
const REGISTRY_SCHEMA: &str = "aos.subscription_accounts.v1";
const REGISTRY_RELATIVE: &str =
    ".local/share/aos-subscription-access/current/subscription-accounts.v1.json";
const SUMMARY_RELATIVE: &str = ".local/state/claude-usage/summary.json";
/// A summary file older than this is not trusted for capacity (the CLI rewrites it on every run).
const SUMMARY_MAX_AGE_HOURS: i64 = 6;
/// Known seats, usage labels and launchers; the Claude tab reads the same file (src/lib/claudeUsage.ts).
const SEAT_TABLE: &str = include_str!("../../../src/lib/claudeSeatTable.json");

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
    #[cfg(windows)]
    {
        use super::api_credits::{find_metadata_helper, mark_metadata_source, run_probe};
        let binary = find_metadata_helper("claude-usage")
            .ok_or("claude-usage or its fleet metadata bridge is not installed on this computer")?;
        let mut value = parse_claude_usage(
            &run_probe(binary.clone(), &["--json"], 30, "Claude usage check").await?,
        )?;
        mark_metadata_source(&mut value, &binary);
        return Ok(value);
    }
    #[cfg(not(windows))]
    {
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
}

#[tauri::command]
pub async fn get_claude_usage() -> Result<Value, String> {
    fetch_claude_usage().await
}

// ---- Claude seats -------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct KnownSeat {
    id: String,
    plan: String,
    usage_labels: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SeatTable {
    near_limit_pct: f64,
    seats: Vec<KnownSeat>,
}

fn seat_table() -> SeatTable {
    // The table is embedded and covered by a test; never panic at runtime if it were malformed.
    serde_json::from_str(SEAT_TABLE).unwrap_or_else(|_| SeatTable {
        near_limit_pct: 95.0,
        seats: Vec::new(),
    })
}

/// One Claude seat of the fleet registry, reduced to the fields the app needs. The registry's profile
/// paths, binaries and identity hash are never read into this struct.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RegistrySeat {
    pub id: String,
    pub host: Option<String>,
    pub plan: Option<String>,
    /// The label claude-usage reports this seat under; the primary key of the usage join.
    pub usage_account: Option<String>,
}

pub(crate) fn safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
}

/// Claude entries of the seat registry; other CLIs (codex) and malformed rows are skipped.
pub fn parse_seat_registry(raw: &str) -> Result<Vec<RegistrySeat>, String> {
    let value: Value = serde_json::from_str(raw.trim())
        .map_err(|e| format!("seat registry is not valid JSON: {e}"))?;
    match value.get("schema").and_then(Value::as_str) {
        Some(REGISTRY_SCHEMA) => {}
        Some(other) => {
            return Err(format!(
                "seat registry has schema {other}, expected {REGISTRY_SCHEMA}"
            ))
        }
        None => return Err("seat registry has no schema".to_string()),
    }
    let accounts = value
        .get("accounts")
        .and_then(Value::as_array)
        .ok_or_else(|| "seat registry has no accounts".to_string())?;
    let mut seats: Vec<RegistrySeat> = Vec::new();
    for account in accounts {
        if account.get("cli").and_then(Value::as_str) != Some("claude") {
            continue;
        }
        let Some(id) = account
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| safe_token(id))
        else {
            continue;
        };
        if seats.iter().any(|seat| seat.id == id) {
            continue;
        }
        let token = |key: &str| {
            account
                .get(key)
                .and_then(Value::as_str)
                .filter(|v| safe_token(v))
                .map(str::to_string)
        };
        seats.push(RegistrySeat {
            id: id.to_string(),
            host: token("host"),
            plan: token("expected_plan"),
            usage_account: token("usage_account"),
        });
    }
    Ok(seats)
}

fn registry_path(home: &Path) -> PathBuf {
    home.join(REGISTRY_RELATIVE)
}

/// Read the deployed seat registry. `Err` carries a short reason (missing, unreadable, wrong schema).
pub fn read_seat_registry() -> Result<Vec<RegistrySeat>, String> {
    let path = registry_path(&home()?);
    let raw = std::fs::read_to_string(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("seat registry not found (~/{REGISTRY_RELATIVE})"),
        _ => format!("seat registry unreadable: {e}"),
    })?;
    parse_seat_registry(&raw)
}

/// The `get_claude_seats` payload: `{found, seats, error}`. A missing local registry is data;
/// an installed Windows metadata bridge can supply the fleet registry instead.
pub async fn fetch_claude_seats() -> Result<Value, String> {
    #[cfg(windows)]
    if read_seat_registry().is_err() {
        if let Some(binary) = super::api_credits::find_metadata_helper("seat-registry") {
            let seats = parse_seat_registry(
                &super::api_credits::run_probe(binary.clone(), &[], 30, "Claude seat registry")
                    .await?,
            )?;
            let mut value = json!({"found": true, "seats": seats, "error": null});
            super::api_credits::mark_metadata_source(&mut value, &binary);
            return Ok(value);
        }
    }
    Ok(match read_seat_registry() {
        Ok(seats) => json!({ "found": true, "seats": seats, "error": null }),
        Err(error) => json!({ "found": false, "seats": [], "error": error }),
    })
}

#[tauri::command]
pub async fn get_claude_seats() -> Result<Value, String> {
    fetch_claude_seats().await
}

/// Seat health. Mirrors `seatStatus` in src/lib/claudeUsage.ts: exhausted at 100% in either window,
/// near limit at the table's 7-day threshold, ok only with a 7-day reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeatStatus {
    Ok,
    NearLimit,
    Exhausted,
    Unknown,
    NoUsageYet,
}

impl SeatStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SeatStatus::Ok => "ok",
            SeatStatus::NearLimit => "near_limit",
            SeatStatus::Exhausted => "exhausted",
            SeatStatus::Unknown => "unknown",
            SeatStatus::NoUsageYet => "no_usage_yet",
        }
    }
}

fn seat_status(
    five: Option<f64>,
    seven: Option<f64>,
    has_window: bool,
    probe_error: bool,
    near_limit_pct: f64,
) -> SeatStatus {
    if five.unwrap_or(0.0) >= 100.0 || seven.unwrap_or(0.0) >= 100.0 {
        SeatStatus::Exhausted
    } else if seven.is_some_and(|value| value >= near_limit_pct) {
        SeatStatus::NearLimit
    } else if seven.is_some() {
        SeatStatus::Ok
    } else if !has_window && !probe_error {
        SeatStatus::NoUsageYet
    } else {
        SeatStatus::Unknown
    }
}

/// One seat's capacity reading, ready to serialize into a snapshot lane.
#[derive(Debug, Clone, PartialEq)]
pub struct SeatReading {
    pub seat_id: String,
    pub plan: String,
    pub used_5h_pct: Option<f64>,
    pub used_7d_pct: Option<f64>,
    pub resets_at: Option<String>,
    pub status: SeatStatus,
}

fn safe_claude_plan(value: Option<&str>) -> String {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("free") => "free",
        Some("pro") => "pro",
        Some("max") => "max",
        Some("team") => "team",
        Some("enterprise") => "enterprise",
        _ => "unknown",
    }
    .to_string()
}

struct WindowReading {
    used_pct: Option<f64>,
    resets_at: Option<DateTime<Utc>>,
}

/// A window object from a usage account. A window whose reset has passed since the summary was
/// written no longer has a usable percentage.
fn window_reading(window: Option<&Value>, now: DateTime<Utc>) -> Option<WindowReading> {
    let window = window.filter(|w| w.is_object())?;
    let resets_at = window
        .get("resets_at")
        .and_then(Value::as_str)
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|time| time.with_timezone(&Utc));
    let used_pct = window
        .get("used_pct")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0))
        .filter(|_| !resets_at.is_some_and(|reset| reset <= now));
    Some(WindowReading {
        used_pct,
        resets_at,
    })
}

fn has_reading(account: &Value, now: DateTime<Utc>) -> bool {
    ["five_hour", "seven_day"]
        .iter()
        .any(|key| window_reading(account.get(*key), now).is_some_and(|w| w.used_pct.is_some()))
}

/// When the seat's capacity next changes: the exhausted window's reset, otherwise the weekly reset.
fn lane_reset(
    five: Option<&WindowReading>,
    seven: Option<&WindowReading>,
    status: SeatStatus,
    now: DateTime<Utc>,
) -> Option<String> {
    let exhausted = |w: Option<&WindowReading>| {
        w.filter(|w| w.used_pct.is_some_and(|pct| pct >= 100.0))
            .and_then(|w| w.resets_at)
    };
    let reset = if status == SeatStatus::Exhausted {
        [exhausted(five), exhausted(seven)]
            .into_iter()
            .flatten()
            .max()
    } else {
        seven
            .and_then(|w| w.resets_at)
            .or_else(|| five.and_then(|w| w.resets_at))
    };
    reset
        .filter(|time| *time > now)
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Secs, true))
}

/// Usage labels to try for a seat, best first and without repeats: the seat id, the registry's
/// `usage_account` (what claude-usage really calls the seat), then the table's fallback labels.
fn seat_labels(id: &str, usage_account: Option<&str>, fallback: &[String]) -> Vec<String> {
    let mut labels: Vec<String> = Vec::new();
    for label in [Some(id), usage_account]
        .into_iter()
        .flatten()
        .chain(fallback.iter().map(String::as_str))
    {
        if !labels.iter().any(|seen| seen == label) {
            labels.push(label.to_string());
        }
    }
    labels
}

/// Every known seat plus any extra registry seat, each joined to its claude-usage account.
///
/// `accounts` is the summary's `accounts` array, or `None` when no usable summary exists (every
/// seat is then "unknown"; with a summary a seat that has no account is "no usage yet"). Unlike the
/// Claude tab there is no usage-only mode: seat ids stay stable for machine consumers, and usage
/// accounts that match no seat are not exported.
pub fn merge_seats(
    registry: Option<&[RegistrySeat]>,
    accounts: Option<&[Value]>,
    now: DateTime<Utc>,
) -> Vec<SeatReading> {
    let table = seat_table();
    let registry = registry.unwrap_or(&[]);
    let mut defs: Vec<(String, Option<String>, Vec<String>)> = Vec::new();
    for known in &table.seats {
        let entry = registry.iter().find(|seat| seat.id == known.id);
        let plan = entry
            .and_then(|seat| seat.plan.clone())
            .unwrap_or_else(|| known.plan.clone());
        let usage_account = entry.and_then(|seat| seat.usage_account.as_deref());
        let labels = seat_labels(&known.id, usage_account, &known.usage_labels);
        defs.push((known.id.clone(), Some(plan), labels));
    }
    for seat in registry {
        if table.seats.iter().all(|known| known.id != seat.id) {
            let labels = seat_labels(&seat.id, seat.usage_account.as_deref(), &[]);
            defs.push((seat.id.clone(), seat.plan.clone(), labels));
        }
    }

    defs.into_iter()
        .map(|(seat_id, plan, labels)| {
            let rank = |a: &Value| {
                a.get("account")
                    .and_then(Value::as_str)
                    .and_then(|name| labels.iter().position(|label| label == name))
                    .unwrap_or(usize::MAX)
            };
            let mut matches: Vec<&Value> = accounts
                .unwrap_or(&[])
                .iter()
                .filter(|a| rank(a) != usize::MAX)
                .collect();
            // Primary label first (stable, so CLI order breaks ties); the first account with a
            // reading wins, otherwise the primary label's account stands for the seat.
            matches.sort_by_key(|a| rank(a));
            let usage = matches
                .iter()
                .copied()
                .find(|a| has_reading(a, now))
                .or_else(|| matches.first().copied());
            let five = usage.and_then(|a| window_reading(a.get("five_hour"), now));
            let seven = usage.and_then(|a| window_reading(a.get("seven_day"), now));
            let status = match (accounts, usage) {
                (None, _) => SeatStatus::Unknown,
                (Some(_), None) => SeatStatus::NoUsageYet,
                (Some(_), Some(a)) => seat_status(
                    five.as_ref().and_then(|w| w.used_pct),
                    seven.as_ref().and_then(|w| w.used_pct),
                    five.is_some() || seven.is_some(),
                    a.get("probe_error").is_some_and(|e| !e.is_null()),
                    table.near_limit_pct,
                ),
            };
            let resets_at = lane_reset(five.as_ref(), seven.as_ref(), status, now);
            SeatReading {
                seat_id,
                plan: safe_claude_plan(plan.as_deref()),
                used_5h_pct: five.as_ref().and_then(|w| w.used_pct),
                used_7d_pct: seven.as_ref().and_then(|w| w.used_pct),
                resets_at,
                status,
            }
        })
        .collect()
}

/// The usage summary for capacity: the CLI's own state file when it is recent, otherwise one run of
/// the CLI (which answers from its cache). `None` when neither works.
pub async fn load_summary_for_capacity(now: DateTime<Utc>) -> Option<Value> {
    if let Ok(home) = home() {
        if let Ok(raw) = std::fs::read_to_string(home.join(SUMMARY_RELATIVE)) {
            if let Ok(summary) = parse_fresh_summary(&raw, now) {
                return Some(summary);
            }
        }
    }
    check_summary_age(fetch_claude_usage().await.ok()?, now).ok()
}

fn parse_fresh_summary(raw: &str, now: DateTime<Utc>) -> Result<Value, String> {
    check_summary_age(parse_claude_usage(raw)?, now)
}

fn check_summary_age(summary: Value, now: DateTime<Utc>) -> Result<Value, String> {
    let generated = summary
        .get("generated_at")
        .and_then(Value::as_str)
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|time| time.with_timezone(&Utc))
        .ok_or_else(|| "claude-usage summary has no generated_at".to_string())?;
    if generated < now - ChronoDuration::hours(SUMMARY_MAX_AGE_HOURS)
        || generated > now + ChronoDuration::minutes(5)
    {
        return Err("claude-usage summary is not recent".to_string());
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    const FIXTURE: &str = include_str!("../../../tests/fixtures/claude-usage-summary.json");
    const REGISTRY_FIXTURE: &str =
        include_str!("../../../tests/fixtures/subscription-accounts.json");

    /// Just after the usage fixture was generated (2026-10-11T17:21:58Z).
    fn fixture_now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 11, 17, 22, 0).unwrap()
    }

    fn fixture_accounts() -> Vec<Value> {
        parse_claude_usage(FIXTURE).unwrap()["accounts"]
            .as_array()
            .unwrap()
            .clone()
    }

    fn registry() -> Vec<RegistrySeat> {
        parse_seat_registry(REGISTRY_FIXTURE).expect("registry fixture parses")
    }

    fn window(used: Option<f64>, resets_at: &str) -> Value {
        json!({ "used_pct": used, "resets_at": resets_at, "state": "current" })
    }

    fn account(label: &str, five: Option<f64>, seven: Option<f64>) -> Value {
        json!({
            "account": label,
            "five_hour": five.map(|p| window(Some(p), "2026-10-11T19:00:00Z")),
            "seven_day": seven.map(|p| window(Some(p), "2026-10-15T19:00:00Z")),
            "probe_error": null,
        })
    }

    fn reading<'a>(seats: &'a [SeatReading], id: &str) -> &'a SeatReading {
        seats.iter().find(|s| s.seat_id == id).expect("seat listed")
    }

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
        assert_eq!(
            email("mac-gustavo-max"),
            Some(Value::from("mac-gustavo-max@example.com"))
        );
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
        let v = fetch_claude_usage()
            .await
            .expect("claude-usage --json runs");
        assert_eq!(v["schema"], SCHEMA);
        assert!(v["accounts"].as_array().is_some_and(|a| !a.is_empty()));
    }

    #[test]
    fn seat_table_is_valid_and_lists_every_fleet_seat() {
        let table = seat_table();
        let ids: Vec<&str> = table.seats.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "claude-mac-gustavo",
                "claude-mac-main",
                "claude-mac-096",
                "claude-windows",
                "claude-wsl"
            ]
        );
        assert_eq!(table.near_limit_pct, 95.0);
        assert!(table
            .seats
            .iter()
            .all(|s| !s.usage_labels.is_empty() && !s.plan.is_empty()));
    }

    #[test]
    fn registry_keeps_claude_seats_and_drops_everything_else() {
        let seats = registry();
        let ids: Vec<&str> = seats.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "claude-mac-main",
                "claude-mac-gustavo",
                "claude-windows",
                "claude-wsl"
            ]
        );
        assert_eq!(seats[2].host.as_deref(), Some("win"));
        assert_eq!(seats[2].plan.as_deref(), Some("max"));
        let accounts: Vec<Option<&str>> =
            seats.iter().map(|s| s.usage_account.as_deref()).collect();
        assert_eq!(
            accounts,
            [
                Some("mac-main-max"),
                Some("mac-gustavo-max"),
                Some("windows-max"),
                Some("wsl-max")
            ]
        );
        // Profile paths, binaries and identity hashes never reach the payload.
        let rendered = serde_json::to_string(&seats).unwrap();
        for hidden in ["profile", "binary", "identity", "example", "1111"] {
            assert!(!rendered.contains(hidden), "{hidden} leaked: {rendered}");
        }
    }

    #[test]
    fn registry_skips_bad_rows_and_rejects_wrong_schema() {
        let raw = r#"{"schema":"aos.subscription_accounts.v1","accounts":[
            {"id":"claude-a","cli":"claude","host":"mac","expected_plan":"max","usage_account":"a-max"},
            {"id":"claude-a","cli":"claude","host":"win"},
            {"id":"Claude B!","cli":"claude"},
            {"id":"claude-c","cli":"claude","host":"MAC OS","expected_plan":7,"usage_account":"Not A Token"},
            {"id":"claude-d","cli":"claude","usage_account":42},
            {"cli":"claude"},
            "not an object"
        ]}"#;
        let seats = parse_seat_registry(raw).unwrap();
        assert_eq!(
            seats,
            vec![
                RegistrySeat {
                    id: "claude-a".into(),
                    host: Some("mac".into()),
                    plan: Some("max".into()),
                    usage_account: Some("a-max".into()),
                },
                RegistrySeat {
                    id: "claude-c".into(),
                    host: None,
                    plan: None,
                    usage_account: None,
                },
                RegistrySeat {
                    id: "claude-d".into(),
                    host: None,
                    plan: None,
                    usage_account: None,
                },
            ]
        );
        assert!(
            parse_seat_registry(r#"{"schema":"other.v1","accounts":[]}"#)
                .unwrap_err()
                .contains("other.v1")
        );
        assert!(parse_seat_registry(r#"{"accounts":[]}"#).is_err());
        assert!(parse_seat_registry(r#"{"schema":"aos.subscription_accounts.v1"}"#).is_err());
        assert!(parse_seat_registry("not json").is_err());
        assert_eq!(
            parse_seat_registry(r#"{"schema":"aos.subscription_accounts.v1","accounts":[]}"#),
            Ok(Vec::new())
        );
    }

    #[test]
    fn merge_joins_usage_by_label_and_keeps_seats_without_usage() {
        let accounts = fixture_accounts();
        let registry = registry();
        let seats = merge_seats(Some(&registry), Some(&accounts), fixture_now());
        let ids: Vec<&str> = seats.iter().map(|s| s.seat_id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "claude-mac-gustavo",
                "claude-mac-main",
                "claude-mac-096",
                "claude-windows",
                "claude-wsl"
            ]
        );
        let gustavo = reading(&seats, "claude-mac-gustavo");
        assert_eq!(gustavo.plan, "max");
        assert_eq!(gustavo.used_5h_pct, Some(59.0));
        assert_eq!(gustavo.used_7d_pct, Some(41.0));
        assert_eq!(gustavo.status, SeatStatus::Ok);
        assert_eq!(gustavo.resets_at.as_deref(), Some("2026-10-14T20:00:00Z"));
        assert_eq!(reading(&seats, "claude-windows").used_7d_pct, Some(83.0));
        assert_eq!(reading(&seats, "claude-wsl").used_7d_pct, Some(27.0));

        // claude-mac-main has no usage account, and claude-mac-096 is not in the registry at all.
        for id in ["claude-mac-main", "claude-mac-096"] {
            let seat = reading(&seats, id);
            assert_eq!(seat.status, SeatStatus::NoUsageYet, "{id}");
            assert_eq!(seat.used_5h_pct, None);
            assert_eq!(seat.used_7d_pct, None);
            assert_eq!(seat.resets_at, None);
            assert_eq!(seat.plan, "max");
        }
    }

    #[test]
    fn near_limit_and_exhausted_match_the_ui_rules() {
        let accounts = vec![
            account("mac-gustavo-max", Some(20.0), Some(96.0)),
            account("mac-main-max", Some(100.0), Some(40.0)),
            account("windows-max", Some(5.0), Some(100.0)),
            account("wsl-max", Some(5.0), Some(94.0)),
        ];
        let seats = merge_seats(Some(&registry()), Some(&accounts), fixture_now());
        let status = |id: &str| reading(&seats, id).status.as_str();
        assert_eq!(status("claude-mac-gustavo"), "near_limit");
        assert_eq!(status("claude-mac-main"), "exhausted");
        assert_eq!(status("claude-mac-096"), "no_usage_yet");
        assert_eq!(status("claude-windows"), "exhausted");
        assert_eq!(status("claude-wsl"), "ok");
    }

    #[test]
    fn gustavo_seat_reads_mac_gustavo_max_not_the_default_login() {
        // mac-max reports the claude-main login, a different account from the
        // claude-gustavo profile; its numbers must not land on claude-mac-gustavo.
        let accounts = vec![
            account("mac-gustavo-max", Some(3.0), Some(1.0)),
            account("mac-max", Some(80.0), Some(90.0)),
        ];
        let seats = merge_seats(Some(&registry()), Some(&accounts), fixture_now());
        let seat = reading(&seats, "claude-mac-gustavo");
        assert_eq!(seat.used_5h_pct, Some(3.0));
        assert_eq!(seat.used_7d_pct, Some(1.0));
        let only_default = vec![account("mac-max", Some(80.0), Some(90.0))];
        let seats = merge_seats(Some(&registry()), Some(&only_default), fixture_now());
        assert_eq!(
            reading(&seats, "claude-mac-gustavo").status,
            SeatStatus::NoUsageYet
        );
    }

    /// The Claude tab as Gus saw it on 2026-10-30: the retired claude-gustavo probe (reset 17 days ago),
    /// the default login mac-max (probe error) and the live mac-gustavo-max, in that CLI order.
    fn live_shaped_accounts() -> Vec<Value> {
        vec![
            json!({"account": "claude-gustavo", "probe_error": null,
                "five_hour": {"used_pct": null, "last_used_pct": 40.0, "state": "reset",
                    "resets_at": "2026-10-13T03:10:00Z"},
                "seven_day": {"used_pct": null, "last_used_pct": 40.0, "state": "reset",
                    "resets_at": "2026-10-13T03:10:00Z"}}),
            json!({"account": "mac-gustavo-max", "probe_error": null,
                "five_hour": window(Some(9.0), "2026-10-30T12:30:00Z"),
                "seven_day": window(Some(61.0), "2026-11-04T20:00:00Z")}),
            json!({"account": "mac-max", "five_hour": null, "seven_day": null,
                "probe_error": "usage output had no limit lines"}),
        ]
    }

    #[test]
    fn a_live_shaped_summary_gives_the_gustavo_seat_its_numbers() {
        let now = Utc.with_ymd_and_hms(2026, 10, 30, 12, 22, 0).unwrap();
        let accounts = live_shaped_accounts();
        let seats = merge_seats(Some(&registry()), Some(&accounts), now);
        let gustavo = reading(&seats, "claude-mac-gustavo");
        assert_eq!(gustavo.used_5h_pct, Some(9.0));
        assert_eq!(gustavo.used_7d_pct, Some(61.0));
        assert_eq!(gustavo.status, SeatStatus::Ok);
        assert_eq!(gustavo.resets_at.as_deref(), Some("2026-11-04T20:00:00Z"));
    }

    #[test]
    fn registry_usage_account_beats_the_table_labels() {
        let now = fixture_now();
        // The registry renamed the seat's usage label; the table still lists the old one.
        let renamed: Vec<RegistrySeat> = registry()
            .into_iter()
            .map(|mut seat| {
                if seat.id == "claude-mac-gustavo" {
                    seat.usage_account = Some("gus-renamed-max".into());
                }
                seat
            })
            .collect();
        // Both labels have a reading; the registry's label is the primary one, whatever the CLI order.
        for accounts in [
            vec![
                account("mac-gustavo-max", Some(70.0), Some(80.0)),
                account("gus-renamed-max", Some(9.0), Some(61.0)),
            ],
            vec![
                account("gus-renamed-max", Some(9.0), Some(61.0)),
                account("mac-gustavo-max", Some(70.0), Some(80.0)),
            ],
        ] {
            let seats = merge_seats(Some(&renamed), Some(&accounts), now);
            let seat = reading(&seats, "claude-mac-gustavo");
            assert_eq!(seat.used_5h_pct, Some(9.0));
            assert_eq!(seat.used_7d_pct, Some(61.0));
        }
        // Without a reading on the primary label, the table's fallback label still supplies one.
        let fallback_only = vec![account("mac-gustavo-max", Some(70.0), Some(80.0))];
        let seats = merge_seats(Some(&renamed), Some(&fallback_only), now);
        assert_eq!(
            reading(&seats, "claude-mac-gustavo").used_7d_pct,
            Some(80.0)
        );
    }

    #[test]
    fn a_registry_only_seat_joins_usage_through_its_usage_account() {
        let registry = vec![RegistrySeat {
            id: "claude-lab-1".into(),
            host: Some("wsl".into()),
            plan: Some("max".into()),
            usage_account: Some("lab-spare-max".into()),
        }];
        let accounts = vec![account("lab-spare-max", Some(4.0), Some(8.0))];
        let seats = merge_seats(Some(&registry), Some(&accounts), fixture_now());
        let lab = reading(&seats, "claude-lab-1");
        assert_eq!(lab.used_7d_pct, Some(8.0));
        assert_eq!(lab.status, SeatStatus::Ok);
    }

    #[test]
    fn seat_labels_are_ordered_and_deduplicated() {
        let fallback = vec!["mac-gustavo-max".to_string(), "legacy".to_string()];
        assert_eq!(
            seat_labels("claude-mac-gustavo", Some("mac-gustavo-max"), &fallback),
            ["claude-mac-gustavo", "mac-gustavo-max", "legacy"]
        );
        assert_eq!(
            seat_labels("claude-mac-gustavo", None, &fallback),
            ["claude-mac-gustavo", "mac-gustavo-max", "legacy"]
        );
        assert_eq!(seat_labels("claude-x", Some("claude-x"), &[]), ["claude-x"]);
    }

    #[test]
    fn status_edges() {
        let t = 95.0;
        assert_eq!(
            seat_status(Some(1.0), Some(94.9), true, false, t),
            SeatStatus::Ok
        );
        assert_eq!(
            seat_status(Some(1.0), Some(95.0), true, false, t),
            SeatStatus::NearLimit
        );
        assert_eq!(
            seat_status(Some(1.0), Some(100.0), true, false, t),
            SeatStatus::Exhausted
        );
        assert_eq!(
            seat_status(Some(100.0), None, true, false, t),
            SeatStatus::Exhausted
        );
        assert_eq!(
            seat_status(Some(12.0), None, true, false, t),
            SeatStatus::Unknown
        );
        assert_eq!(
            seat_status(None, None, false, false, t),
            SeatStatus::NoUsageYet
        );
        assert_eq!(seat_status(None, None, false, true, t), SeatStatus::Unknown);
        assert_eq!(seat_status(None, None, true, false, t), SeatStatus::Unknown);
    }

    #[test]
    fn exhausted_seat_resets_when_its_exhausted_window_does() {
        let accounts = vec![
            // 5-hour exhausted: back at the 5-hour reset, not the weekly one.
            json!({"account": "mac-gustavo-max",
                "five_hour": window(Some(100.0), "2026-10-11T19:50:00Z"),
                "seven_day": window(Some(40.0), "2026-10-14T20:00:00Z")}),
            // Both exhausted: back when the later one resets.
            json!({"account": "windows-max",
                "five_hour": window(Some(100.0), "2026-10-11T19:50:00Z"),
                "seven_day": window(Some(100.0), "2026-10-14T20:00:00Z")}),
            // Healthy: the weekly reset.
            json!({"account": "wsl-max",
                "five_hour": window(Some(3.0), "2026-10-11T19:50:00Z"),
                "seven_day": window(Some(30.0), "2026-10-14T20:00:00Z")}),
            // Healthy with only a 5-hour window: its reset.
            json!({"account": "mac-main-max",
                "five_hour": window(Some(3.0), "2026-10-11T19:50:00Z"), "seven_day": null}),
        ];
        let seats = merge_seats(Some(&registry()), Some(&accounts), fixture_now());
        let resets = |id: &str| reading(&seats, id).resets_at.clone();
        assert_eq!(
            resets("claude-mac-gustavo").as_deref(),
            Some("2026-10-11T19:50:00Z")
        );
        assert_eq!(
            resets("claude-windows").as_deref(),
            Some("2026-10-14T20:00:00Z")
        );
        assert_eq!(
            resets("claude-wsl").as_deref(),
            Some("2026-10-14T20:00:00Z")
        );
        assert_eq!(
            resets("claude-mac-main").as_deref(),
            Some("2026-10-11T19:50:00Z")
        );
        assert_eq!(resets("claude-mac-096"), None);
    }

    #[test]
    fn a_window_that_reset_since_the_summary_was_written_has_no_percentage() {
        // The fixture was generated at 17:21:58Z; by 2026-10-12 every window in it has reset.
        let later = Utc.with_ymd_and_hms(2026, 10, 16, 0, 0, 0).unwrap();
        let accounts = fixture_accounts();
        let seats = merge_seats(Some(&registry()), Some(&accounts), later);
        let gustavo = reading(&seats, "claude-mac-gustavo");
        assert_eq!(gustavo.used_5h_pct, None);
        assert_eq!(gustavo.used_7d_pct, None);
        assert_eq!(gustavo.status, SeatStatus::Unknown);
        assert_eq!(gustavo.resets_at, None);
    }

    #[test]
    fn without_a_summary_every_seat_is_unknown_and_without_a_registry_the_known_seats_remain() {
        let seats = merge_seats(Some(&registry()), None, fixture_now());
        assert_eq!(seats.len(), 5);
        assert!(seats
            .iter()
            .all(|s| s.status == SeatStatus::Unknown && s.used_7d_pct.is_none()));

        let accounts = fixture_accounts();
        let known_only = merge_seats(None, Some(&accounts), fixture_now());
        let ids: Vec<&str> = known_only.iter().map(|s| s.seat_id.as_str()).collect();
        assert_eq!(ids.len(), 5);
        assert!(ids.contains(&"claude-mac-096"));
        assert_eq!(
            reading(&known_only, "claude-mac-gustavo").status,
            SeatStatus::Ok
        );
    }

    #[test]
    fn an_unknown_registry_seat_is_listed_with_a_safe_plan() {
        let registry = vec![RegistrySeat {
            id: "claude-lab-1".into(),
            host: Some("wsl".into()),
            plan: Some("something-odd".into()),
            usage_account: None,
        }];
        let accounts = vec![account("claude-lab-1", Some(1.0), Some(2.0))];
        let seats = merge_seats(Some(&registry), Some(&accounts), fixture_now());
        assert_eq!(seats.len(), 6);
        let lab = reading(&seats, "claude-lab-1");
        assert_eq!(lab.plan, "unknown");
        assert_eq!(lab.status, SeatStatus::Ok);
    }

    #[test]
    fn capacity_only_trusts_a_recent_summary() {
        let now = Utc.with_ymd_and_hms(2026, 10, 11, 17, 30, 0).unwrap();
        assert!(parse_fresh_summary(FIXTURE, now).is_ok());
        let day_later = now + ChronoDuration::hours(24);
        assert!(parse_fresh_summary(FIXTURE, day_later).is_err());
        let before = Utc.with_ymd_and_hms(2026, 10, 11, 10, 0, 0).unwrap();
        assert!(parse_fresh_summary(FIXTURE, before).is_err());
        assert!(parse_fresh_summary(r#"{"schema":"claude-usage.summary.v1"}"#, now).is_err());
        assert!(parse_fresh_summary("garbage", now).is_err());
    }

    #[test]
    fn registry_path_is_under_the_fleet_access_release() {
        let path = registry_path(Path::new("/home/example"));
        assert_eq!(
            path,
            Path::new("/home/example/.local/share/aos-subscription-access/current/subscription-accounts.v1.json")
        );
    }

    /// Reads the deployed registry and the CLI's summary file. `cargo test -- --ignored live_seats`.
    #[tokio::test]
    #[ignore]
    async fn live_seats() {
        let registry = read_seat_registry().expect("deployed seat registry parses");
        assert!(registry.iter().any(|s| s.id.starts_with("claude-")));
        let now = Utc::now();
        let summary = load_summary_for_capacity(now).await;
        let accounts = summary
            .as_ref()
            .and_then(|v| v["accounts"].as_array().cloned());
        for seat in merge_seats(Some(&registry), accounts.as_deref(), now) {
            println!("{seat:?}");
        }
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(parse_claude_usage("Traceback (most recent call last)").is_err());
        assert!(parse_claude_usage("").is_err());
    }
}
