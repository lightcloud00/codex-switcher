//! Claude seat end dates from the fleet's local overlay, the same file the codex-switcher MCP reads:
//! `~/.config/aos/claude-seat-subscriptions.json`, or the path in `AOS_SWITCHER_CLAUDE_SEAT_SUBSCRIPTIONS`.
//! `{"seats": {"claude-mac-main": {"subscription_expires_at": "2026-11-14", "plan_note": "..."}}}`.
//! Display only: dates and short notes, never secrets. A missing file is data, not an error; a bad entry
//! is skipped and counted so the page can say a date was ignored.
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

const ENV_PATH: &str = "AOS_SWITCHER_CLAUDE_SEAT_SUBSCRIPTIONS";
/// Same cap as the MCP reader.
const MAX_BYTES: u64 = 65_536;
/// Same note rule as the MCP reader (`_PLAN_NOTE`): no `@`, so an email or token cannot ride along.
const MAX_NOTE_CHARS: usize = 80;
const MAX_SEATS: usize = 64;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatSubscription {
    /// `YYYY-MM-DD`; the plan runs through this day.
    pub subscription_expires_on: String,
    pub plan_note: Option<String>,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatSubscriptions {
    pub found: bool,
    pub seats: BTreeMap<String, SeatSubscription>,
    /// Entries left out because a seat id, date or note was malformed.
    pub ignored: usize,
    /// Set when the file exists but cannot be read as an overlay.
    pub error: Option<String>,
}

fn overlay_path() -> Option<PathBuf> {
    match std::env::var_os(ENV_PATH) {
        Some(path) if !path.is_empty() => Some(PathBuf::from(path)),
        _ => dirs::home_dir().map(|home| home.join(".config/aos/claude-seat-subscriptions.json")),
    }
}

fn valid_seat_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_date(value: &str) -> bool {
    value.len() == 10 && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

fn valid_note(note: &str) -> bool {
    (1..=MAX_NOTE_CHARS).contains(&note.chars().count())
        && note
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || " .,+/()_-".contains(c))
}

/// The overlay's valid seats; anything malformed is counted in `ignored`, never guessed at.
pub(crate) fn parse_overlay(text: &str) -> SeatSubscriptions {
    let unreadable = |reason: &str| SeatSubscriptions {
        found: true,
        error: Some(reason.to_string()),
        ..SeatSubscriptions::default()
    };
    let Ok(root) = serde_json::from_str::<Value>(text) else {
        return unreadable("not valid JSON");
    };
    let Some(entries) = root.get("seats").and_then(Value::as_object) else {
        return unreadable("no seats map");
    };
    let mut result = SeatSubscriptions {
        found: true,
        ..SeatSubscriptions::default()
    };
    for (id, entry) in entries {
        if result.seats.len() >= MAX_SEATS {
            result.ignored += 1;
            continue;
        }
        let date = entry.get("subscription_expires_at").and_then(Value::as_str);
        let note = match entry.get("plan_note") {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(note)) if valid_note(note) => Ok(Some(note.clone())),
            Some(_) => Err(()),
        };
        match (date, note) {
            (Some(date), Ok(plan_note)) if valid_seat_id(id) && valid_date(date) => {
                result.seats.insert(
                    id.clone(),
                    SeatSubscription {
                        subscription_expires_on: date.to_string(),
                        plan_note,
                    },
                );
            }
            _ => result.ignored += 1,
        }
    }
    result
}

fn read_overlay() -> SeatSubscriptions {
    let Some(path) = overlay_path() else {
        return SeatSubscriptions::default();
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return SeatSubscriptions::default();
    };
    if !meta.is_file() {
        return SeatSubscriptions::default();
    }
    if meta.len() > MAX_BYTES {
        return SeatSubscriptions {
            found: true,
            error: Some("file too large".to_string()),
            ..SeatSubscriptions::default()
        };
    }
    match std::fs::read_to_string(&path) {
        Ok(text) => parse_overlay(&text),
        Err(_) => SeatSubscriptions {
            found: true,
            error: Some("file unreadable".to_string()),
            ..SeatSubscriptions::default()
        },
    }
}

/// `{found, seats: {id: {subscriptionExpiresOn, planNote}}, ignored, error}`.
pub async fn fetch_claude_seat_subscriptions() -> Result<Value, String> {
    let overlay = tokio::task::spawn_blocking(read_overlay)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(overlay).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_claude_seat_subscriptions() -> Result<Value, String> {
    fetch_claude_seat_subscriptions().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_valid_seats_and_notes() {
        let parsed = parse_overlay(
            r#"{"schema":"aos.claude-seat-subscriptions.v1","seats":{
                "claude-mac-main":{"subscription_expires_at":"2026-11-14","plan_note":"Apple-billed monthly"},
                "claude-mac-096":{"subscription_expires_at":"2026-12-01"}}}"#,
        );
        assert!(parsed.found);
        assert_eq!(parsed.ignored, 0);
        assert_eq!(parsed.error, None);
        assert_eq!(
            parsed.seats.get("claude-mac-main"),
            Some(&SeatSubscription {
                subscription_expires_on: "2026-11-14".into(),
                plan_note: Some("Apple-billed monthly".into()),
            })
        );
        assert_eq!(
            parsed
                .seats
                .get("claude-mac-096")
                .map(|s| s.plan_note.clone()),
            Some(None)
        );
    }

    #[test]
    fn skips_and_counts_malformed_entries() {
        let parsed = parse_overlay(
            r#"{"seats":{
                "claude-mac-main":{"subscription_expires_at":"2026-02-30"},
                "claude-mac-096":{"subscription_expires_at":"Nov 14"},
                "bad id!":{"subscription_expires_at":"2026-11-14"},
                "claude-wsl":{"subscription_expires_at":"2026-11-14","plan_note":7},
                "claude-windows":"2026-11-14",
                "claude-mac-gustavo":{"subscription_expires_at":"2026-11-30"}}}"#,
        );
        assert_eq!(parsed.ignored, 5);
        assert_eq!(parsed.seats.len(), 1);
        assert!(parsed.seats.contains_key("claude-mac-gustavo"));
    }

    #[test]
    fn rejects_documents_without_a_seat_map() {
        for text in ["", "[]", r#"{"claude-mac-main":{}}"#, r#"{"seats":[]}"#] {
            let parsed = parse_overlay(text);
            assert!(parsed.found);
            assert!(parsed.error.is_some(), "{text}");
            assert!(parsed.seats.is_empty());
        }
    }

    #[test]
    fn notes_follow_the_mcp_rule() {
        let note = |text: &str| {
            parse_overlay(&format!(
                r#"{{"seats":{{"claude-mac-main":{{"subscription_expires_at":"2026-11-14","plan_note":{}}}}}}}"#,
                serde_json::to_string(text).unwrap()
            ))
        };
        assert_eq!(
            note("Apple-billed Claude Max 20x monthly, set 2026-10-23").ignored,
            0
        );
        for bad in [
            "billed to someone@example.com",
            "",
            &"x".repeat(81),
            "sk-ant:secret",
        ] {
            let parsed = note(bad);
            assert_eq!(parsed.ignored, 1, "{bad}");
            assert!(parsed.seats.is_empty(), "{bad}");
        }
        assert_eq!(note(&"x".repeat(80)).ignored, 0);
    }

    #[test]
    fn rejects_control_characters_in_notes() {
        let parsed = parse_overlay(
            r#"{"seats":{"claude-mac-main":{"subscription_expires_at":"2026-11-14","plan_note":"line\nbreak"}}}"#,
        );
        assert_eq!(parsed.ignored, 1);
        assert!(parsed.seats.is_empty());
    }
}
