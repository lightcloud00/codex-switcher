//! Provider outage badges, borrowed from CodexBar (docs/status.md).
//!
//! Polls each provider's public Statuspage summary (`api/v2/status.json`) every few minutes and
//! keeps the last good answer in memory. Public endpoints only: no cookies, no tokens, no account
//! data leave the machine, and the response is read as untrusted text (size-capped, control
//! characters stripped). A failed or stale check shows nothing, never a false outage.

use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use futures::future::join_all;
use serde::{Deserialize, Serialize};

/// (id, label, status page base URL, component). Copilot has no page of its own: it is one
/// component of GitHub's page, so only that component counts (an Actions or Pages incident must
/// not show as a Copilot outage). The others use the page-wide indicator.
const PROVIDERS: [(&str, &str, &str, Option<&str>); 5] = [
    ("openai", "OpenAI", "https://status.openai.com", None),
    ("claude", "Claude", "https://status.claude.com", None),
    ("cursor", "Cursor", "https://status.cursor.com", None),
    ("factory", "Factory", "https://status.factory.ai", None),
    (
        "copilot",
        "GitHub Copilot",
        "https://www.githubstatus.com",
        Some("Copilot"),
    ),
];
/// `summary.json` lists every component and open incident, so it gets a larger cap.
const MAX_SUMMARY_BYTES: usize = 256 * 1024;

/// How often the background poller asks (tray setup spawns it).
pub const POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// The popup asks on open; a answer newer than this is reused instead of hitting the network.
const CACHE_TTL: Duration = Duration::from_secs(4 * 60);
/// An answer older than this is dropped from the badges (the last checks have been failing).
const STALE_AFTER: Duration = Duration::from_secs(20 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_DESCRIPTION_CHARS: usize = 80;

/// Statuspage `status.indicator`, plus `Unknown` for anything else.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Indicator {
    None,
    Minor,
    Major,
    Critical,
    Maintenance,
    Unknown,
}

impl Indicator {
    fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "none" => Indicator::None,
            "minor" => Indicator::Minor,
            "major" => Indicator::Major,
            "critical" => Indicator::Critical,
            "maintenance" => Indicator::Maintenance,
            _ => Indicator::Unknown,
        }
    }

    /// Short word for the badge, or None when nothing should be shown.
    pub fn badge_word(self) -> Option<&'static str> {
        match self {
            Indicator::Minor => Some("degraded"),
            Indicator::Major => Some("outage"),
            Indicator::Critical => Some("major outage"),
            Indicator::Maintenance => Some("maintenance"),
            Indicator::None | Indicator::Unknown => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub indicator: Indicator,
    /// The page's own one-line summary, e.g. "Partial System Degradation"; sanitised and capped.
    pub description: String,
    pub page_url: &'static str,
}

#[derive(Deserialize)]
struct StatusDocument {
    status: StatusBody,
}

#[derive(Deserialize)]
struct StatusBody {
    #[serde(default)]
    indicator: String,
    #[serde(default)]
    description: String,
}

/// Parses a Statuspage `status.json` body. Anything that is not the documented shape is an error,
/// so a changed or hijacked page cannot pass for "all clear" or "outage".
fn parse_status_body(body: &[u8]) -> Result<(Indicator, String), String> {
    if body.len() > MAX_BODY_BYTES {
        return Err("status response too large".to_string());
    }
    let doc: StatusDocument =
        serde_json::from_slice(body).map_err(|_| "status response not understood".to_string())?;
    let indicator = Indicator::parse(&doc.status.indicator);
    if indicator == Indicator::Unknown {
        return Err("status indicator not understood".to_string());
    }
    Ok((indicator, sanitize_description(&doc.status.description)))
}

/// Public text is shown in the menu: drop control characters and cap the length.
fn sanitize_description(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= MAX_DESCRIPTION_CHARS {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(MAX_DESCRIPTION_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

#[derive(Deserialize)]
struct SummaryDocument {
    #[serde(default)]
    components: Vec<SummaryComponent>,
}

#[derive(Deserialize)]
struct SummaryComponent {
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
}

/// Reads one named component out of a Statuspage `summary.json`. A missing component or an
/// unfamiliar status is an error, never "all clear" and never an outage.
fn parse_component_body(body: &[u8], name: &str) -> Result<(Indicator, String), String> {
    if body.len() > MAX_SUMMARY_BYTES {
        return Err("status response too large".to_string());
    }
    let doc: SummaryDocument =
        serde_json::from_slice(body).map_err(|_| "status response not understood".to_string())?;
    let component = doc
        .components
        .iter()
        .find(|c| c.name.trim().eq_ignore_ascii_case(name))
        .ok_or_else(|| "status component not found".to_string())?;
    let indicator = match component.status.trim() {
        "operational" => Indicator::None,
        "degraded_performance" => Indicator::Minor,
        "partial_outage" => Indicator::Major,
        "major_outage" => Indicator::Critical,
        "under_maintenance" => Indicator::Maintenance,
        _ => return Err("status component not understood".to_string()),
    };
    let words = component.status.replace('_', " ");
    let mut chars = words.chars();
    let description = chars
        .next()
        .map(|first| format!("{}{}", first.to_ascii_uppercase(), chars.as_str()))
        .unwrap_or_default();
    Ok((indicator, sanitize_description(&description)))
}

struct Entry {
    status: ProviderStatus,
    checked: Instant,
}

static CACHE: LazyLock<Mutex<HashMap<&'static str, Entry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        // Status pages sometimes move host (status.cursor.com does); follow a few https hops only.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 || attempt.url().scheme() != "https" {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .user_agent("codex-switcher-status-check")
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch_one(
    client: &reqwest::Client,
    provider: &(
        &'static str,
        &'static str,
        &'static str,
        Option<&'static str>,
    ),
) -> Result<ProviderStatus, String> {
    let (id, label, base, component) = *provider;
    let (path, cap) = match component {
        Some(_) => ("summary.json", MAX_SUMMARY_BYTES),
        None => ("status.json", MAX_BODY_BYTES),
    };
    let response = client
        .get(format!("{base}/api/v2/{path}"))
        .send()
        .await
        .map_err(|_| "status request failed".to_string())?;
    if !response.status().is_success() {
        return Err(format!("status request returned {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|len| len as usize > cap)
    {
        return Err("status response too large".to_string());
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| "status response unreadable".to_string())?;
    let (indicator, description) = match component {
        Some(name) => parse_component_body(&body, name)?,
        None => parse_status_body(&body)?,
    };
    Ok(ProviderStatus {
        id,
        label,
        indicator,
        description,
        page_url: base,
    })
}

/// Fetches all five pages at once. A page that fails keeps its previous answer (until it goes
/// stale); it never turns into an outage. Returns true when the visible badges changed.
pub async fn refresh_all() -> bool {
    let Ok(client) = client() else {
        return false;
    };
    let results = join_all(PROVIDERS.iter().map(|p| fetch_one(&client, p))).await;
    let before = degraded();
    if let Ok(mut cache) = CACHE.lock() {
        for status in results.into_iter().flatten() {
            cache.insert(
                status.id,
                Entry {
                    status,
                    checked: Instant::now(),
                },
            );
        }
    }
    before != degraded()
}

fn fresh_entries(now: Instant) -> Vec<ProviderStatus> {
    let Ok(cache) = CACHE.lock() else {
        return Vec::new();
    };
    PROVIDERS
        .iter()
        .filter_map(|(id, _, _, _)| cache.get(id))
        .filter(|entry| now.saturating_duration_since(entry.checked) <= STALE_AFTER)
        .map(|entry| entry.status.clone())
        .collect()
}

/// Everything known and fresh, in a fixed provider order (healthy ones included).
pub fn snapshot() -> Vec<ProviderStatus> {
    fresh_entries(Instant::now())
}

/// Only the providers that deserve a badge.
pub fn degraded() -> Vec<ProviderStatus> {
    snapshot()
        .into_iter()
        .filter(|s| s.indicator.badge_word().is_some())
        .collect()
}

/// One native-menu line per badge, e.g. "⚠ OpenAI: degraded (Partial System Degradation)".
pub fn menu_lines() -> Vec<String> {
    degraded().iter().map(badge_line).collect()
}

pub fn badge_line(status: &ProviderStatus) -> String {
    let Some(word) = status.indicator.badge_word() else {
        return String::new();
    };
    let glyph = if status.indicator == Indicator::Maintenance {
        "🛠"
    } else {
        "⚠"
    };
    if status.description.is_empty() {
        format!("{glyph} {}: {word}", status.label)
    } else {
        format!("{glyph} {}: {word} ({})", status.label, status.description)
    }
}

fn cache_is_fresh() -> bool {
    let Ok(cache) = CACHE.lock() else {
        return false;
    };
    PROVIDERS.iter().all(|(id, _, _, _)| {
        cache
            .get(id)
            .is_some_and(|entry| entry.checked.elapsed() <= CACHE_TTL)
    })
}

/// Answers the popup: reuses a recent answer, otherwise checks the five pages first.
#[tauri::command]
pub async fn get_provider_status() -> Result<Vec<ProviderStatus>, String> {
    if !cache_is_fresh() {
        refresh_all().await;
    }
    Ok(snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"page":{"id":"x","name":"OpenAI","url":"https://status.openai.com/"},
        "status":{"description":"Partial System Degradation","indicator":"minor"}}"#;

    #[test]
    fn parses_real_statuspage_shape() {
        let (indicator, description) = parse_status_body(SAMPLE.as_bytes()).unwrap();
        assert_eq!(indicator, Indicator::Minor);
        assert_eq!(description, "Partial System Degradation");
    }

    #[test]
    fn maps_every_indicator_and_rejects_unknown() {
        let body = |i: &str| format!(r#"{{"status":{{"indicator":"{i}","description":"d"}}}}"#);
        for (raw, expected) in [
            ("none", Indicator::None),
            ("minor", Indicator::Minor),
            ("major", Indicator::Major),
            ("critical", Indicator::Critical),
            ("maintenance", Indicator::Maintenance),
            ("MAJOR", Indicator::Major),
        ] {
            assert_eq!(parse_status_body(body(raw).as_bytes()).unwrap().0, expected);
        }
        assert!(parse_status_body(body("purple").as_bytes()).is_err());
        assert!(parse_status_body(br#"{"status":{}}"#).is_err());
        assert!(parse_status_body(b"<html>blocked</html>").is_err());
        assert!(parse_status_body(b"{}").is_err());
    }

    #[test]
    fn copilot_reads_its_own_component_not_the_page_rollup() {
        // An Actions incident makes the page "minor" but Copilot itself is fine.
        let body = br#"{"status":{"indicator":"minor"},"components":[
            {"name":"Actions","status":"partial_outage"},
            {"name":"Copilot","status":"operational"},
            {"name":"Copilot AI Model Providers","status":"major_outage"}]}"#;
        assert_eq!(
            parse_component_body(body, "Copilot").unwrap().0,
            Indicator::None
        );
        let bad = br#"{"components":[{"name":"Copilot","status":"degraded_performance"}]}"#;
        let (indicator, description) = parse_component_body(bad, "Copilot").unwrap();
        assert_eq!(indicator, Indicator::Minor);
        assert_eq!(description, "Degraded performance");
        for (status, expected) in [
            ("partial_outage", Indicator::Major),
            ("major_outage", Indicator::Critical),
            ("under_maintenance", Indicator::Maintenance),
        ] {
            let b = format!(r#"{{"components":[{{"name":"copilot","status":"{status}"}}]}}"#);
            assert_eq!(
                parse_component_body(b.as_bytes(), "Copilot").unwrap().0,
                expected
            );
        }
    }

    #[test]
    fn missing_or_odd_components_are_errors_not_outages() {
        assert!(parse_component_body(br#"{"components":[]}"#, "Copilot").is_err());
        assert!(parse_component_body(
            br#"{"components":[{"name":"Copilot","status":"??"}]}"#,
            "Copilot"
        )
        .is_err());
        assert!(parse_component_body(b"<html>", "Copilot").is_err());
        assert!(parse_component_body(&vec![b' '; MAX_SUMMARY_BYTES + 1], "Copilot").is_err());
    }

    #[test]
    fn oversized_bodies_are_refused() {
        let big = vec![b' '; MAX_BODY_BYTES + 1];
        assert!(parse_status_body(&big).is_err());
    }

    #[test]
    fn descriptions_are_cleaned_and_capped() {
        assert_eq!(sanitize_description("  hi\u{7}\n there  "), "hi there");
        let long = "x".repeat(200);
        let cut = sanitize_description(&long);
        assert_eq!(cut.chars().count(), MAX_DESCRIPTION_CHARS);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn only_trouble_gets_a_badge() {
        assert_eq!(Indicator::None.badge_word(), None);
        assert_eq!(Indicator::Unknown.badge_word(), None);
        assert_eq!(Indicator::Minor.badge_word(), Some("degraded"));
        assert_eq!(Indicator::Major.badge_word(), Some("outage"));
        assert_eq!(Indicator::Critical.badge_word(), Some("major outage"));
        assert_eq!(Indicator::Maintenance.badge_word(), Some("maintenance"));
    }

    fn status(indicator: Indicator, description: &str) -> ProviderStatus {
        ProviderStatus {
            id: "openai",
            label: "OpenAI",
            indicator,
            description: description.to_string(),
            page_url: "https://status.openai.com",
        }
    }

    #[test]
    fn badge_lines_name_the_provider_and_word() {
        assert_eq!(
            badge_line(&status(Indicator::Minor, "Partial System Degradation")),
            "⚠ OpenAI: degraded (Partial System Degradation)"
        );
        assert_eq!(
            badge_line(&status(Indicator::Major, "")),
            "⚠ OpenAI: outage"
        );
        assert_eq!(badge_line(&status(Indicator::None, "All good")), "");
    }

    /// Real network check against the five public pages: `cargo test live_status -- --ignored`.
    #[tokio::test]
    #[ignore = "uses the network"]
    async fn live_status_pages_answer() {
        CACHE.lock().unwrap().clear();
        refresh_all().await;
        let all = snapshot();
        for s in &all {
            println!("{} => {:?} ({})", s.label, s.indicator, s.description);
        }
        assert!(
            all.len() >= 4,
            "expected most pages to answer, got {}",
            all.len()
        );
        println!("menu lines: {:?}", menu_lines());
        CACHE.lock().unwrap().clear();
    }

    #[test]
    fn stale_answers_drop_out_of_the_badges() {
        let mut cache = CACHE.lock().unwrap();
        cache.clear();
        let now = Instant::now();
        let old = now.checked_sub(STALE_AFTER + Duration::from_secs(1));
        // Instant can't go before boot on a fresh machine; skip the assertion rather than fake it.
        if let Some(old) = old {
            cache.insert(
                "openai",
                Entry {
                    status: status(Indicator::Major, "down"),
                    checked: old,
                },
            );
            cache.insert(
                "claude",
                Entry {
                    status: ProviderStatus {
                        id: "claude",
                        label: "Claude",
                        ..status(Indicator::Minor, "slow")
                    },
                    checked: now,
                },
            );
            drop(cache);
            let ids: Vec<_> = fresh_entries(now).iter().map(|s| s.id).collect();
            assert_eq!(ids, vec!["claude"]);
            CACHE.lock().unwrap().clear();
        }
    }
}
