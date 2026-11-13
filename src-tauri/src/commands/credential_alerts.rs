//! One local "sign in again" notification per provider, borrowed from CodexBar
//! (docs/credential-notifications.md).
//!
//! A provider gets one alert per failure episode. The episode ends only when a fresh, successful
//! check for the account that failed comes back; repeated refreshes, network errors, quota or
//! rate-limit errors and Cloudflare 403s never count as a sign-in failure and never reset one.
//! Episodes live in memory, so an app restart starts clean. The alert names the provider only:
//! never an email, an account name, a token or the raw error.

use std::{
    collections::{HashMap, HashSet},
    sync::{LazyLock, Mutex},
};

use tauri::{AppHandle, Runtime};

use crate::types::UsageInfo;

/// What one check of one account told us about its sign-in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// A fresh, successful reading.
    Fresh,
    /// The provider says the sign-in is gone or needs renewing.
    SignInFailed,
    /// Anything else (offline, rate limit, 403, API-key account...): says nothing about sign-in.
    Other,
}

/// Case-insensitive match on the error shapes the usage and refresh code produce. Deliberately
/// narrow: messages that merely mention "token" or "login" do not count, and a bare 403 is the
/// Cloudflare challenge, not an expired login.
pub fn is_sign_in_failure(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    const MARKERS: [&str; 9] = [
        "unauthorized",
        "invalid_grant",
        "invalid_token",
        "token_expired",
        "token_invalidated",
        "token_revoked",
        "refresh_token_reused",
        "refresh_token_expired",
        "refresh_token_invalidated",
    ];
    MARKERS.iter().any(|m| e.contains(m))
        || e.contains("missing refresh token")
        || contains_word(&e, "401")
}

fn contains_word(haystack: &str, word: &str) -> bool {
    haystack.match_indices(word).any(|(start, _)| {
        let before = haystack[..start].chars().next_back();
        let after = haystack[start + word.len()..].chars().next();
        !before.is_some_and(|c| c.is_alphanumeric() || c == '_')
            && !after.is_some_and(|c| c.is_alphanumeric() || c == '_')
    })
}

/// Classifies one usage check (either an error result or a usage row carrying an error).
pub fn classify_usage(result: &Result<UsageInfo, String>) -> Outcome {
    let error = match result {
        Err(error) => Some(error.as_str()),
        Ok(usage) => usage.error.as_deref(),
    };
    match error {
        Some(error) if is_sign_in_failure(error) => Outcome::SignInFailed,
        Some(_) => Outcome::Other,
        None => Outcome::Fresh,
    }
}

/// The episode bookkeeping, kept free of any app or notification code so it can be tested.
#[derive(Default)]
pub struct Episodes {
    /// provider id -> accounts whose sign-in is currently failing
    failing: HashMap<String, HashSet<String>>,
    /// providers that already have an alert for the current episode
    alerted: HashSet<String>,
}

impl Episodes {
    /// Records an outcome. Returns true when a new alert should be sent for the provider.
    pub fn record(&mut self, provider: &str, account: &str, outcome: Outcome) -> bool {
        match outcome {
            Outcome::Other => false,
            Outcome::SignInFailed => {
                self.failing
                    .entry(provider.to_string())
                    .or_default()
                    .insert(account.to_string());
                self.alerted.insert(provider.to_string())
            }
            Outcome::Fresh => {
                if let Some(accounts) = self.failing.get_mut(provider) {
                    accounts.remove(account);
                    if accounts.is_empty() {
                        self.failing.remove(provider);
                        self.alerted.remove(provider);
                    }
                }
                false
            }
        }
    }

    /// Forgets failing accounts that no longer exist (deleted or replaced), so a removed broken
    /// account cannot keep the episode open and silence every later alert.
    pub fn prune(&mut self, provider: &str, live_accounts: &HashSet<String>) {
        if let Some(accounts) = self.failing.get_mut(provider) {
            accounts.retain(|account| live_accounts.contains(account));
            if accounts.is_empty() {
                self.failing.remove(provider);
                self.alerted.remove(provider);
            }
        }
    }

    /// A delivery the notification layer reports as failed gives its reservation back so a later
    /// check retries. (On desktop the plugin usually cannot tell, so a dropped alert is not retried.)
    pub fn release(&mut self, provider: &str) {
        self.alerted.remove(provider);
    }
}

static EPISODES: LazyLock<Mutex<Episodes>> = LazyLock::new(|| Mutex::new(Episodes::default()));

fn record(provider: &str, account: &str, outcome: Outcome) -> bool {
    EPISODES
        .lock()
        .map(|mut episodes| episodes.record(provider, account, outcome))
        .unwrap_or(false)
}

/// Feeds one Codex usage check into the episode tracker and alerts once when it starts failing.
pub fn observe_codex_usage<R: Runtime>(
    app: &AppHandle<R>,
    account_id: &str,
    result: &Result<UsageInfo, String>,
) {
    // Accounts deleted since an earlier failure must not keep the episode open.
    if let Ok(store) = crate::auth::load_accounts() {
        let live: HashSet<String> = store.accounts.iter().map(|a| a.id.clone()).collect();
        if let Ok(mut episodes) = EPISODES.lock() {
            episodes.prune("codex", &live);
        }
    }
    observe(app, "codex", "Codex", account_id, classify_usage(result));
}

/// Providers whose probe has said "yes" at least once this run. A probe's "no" only counts as an
/// expired sign-in after that: never having signed in (or using an API key the probe ignores)
/// is not an expiry and must not raise an alert.
static PROBE_WAS_SIGNED_IN: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

fn probe_outcome(seen: &mut HashSet<String>, id: &str, signed_in: &str) -> Outcome {
    match signed_in {
        "yes" => {
            seen.insert(id.to_string());
            Outcome::Fresh
        }
        "no" if seen.contains(id) => Outcome::SignInFailed,
        _ => Outcome::Other,
    }
}

/// Same for a provider's sign-in probe (`signedIn` of "yes" is fresh, "no" after a "yes" is failed).
pub fn observe_probe<R: Runtime>(app: &AppHandle<R>, id: &str, label: &str, signed_in: &str) {
    let outcome = PROBE_WAS_SIGNED_IN
        .lock()
        .map(|mut seen| probe_outcome(&mut seen, id, signed_in))
        .unwrap_or(Outcome::Other);
    observe(app, id, label, id, outcome);
}

/// Provider id of the Claude seats (claude-usage accounts); kept apart from any single-login probe.
const CLAUDE_SEATS: &str = "claude-seats";

/// What one claude-usage account row says about its seat's sign-in. claude-usage states it outright
/// (`signed_in: false`, "signed out: run /login ..."), so nothing is guessed from missing numbers:
/// a busy host, a slow probe or an empty /usage page is `Other`, never an expired login.
pub fn classify_claude_account(account: &serde_json::Value) -> Outcome {
    let error = account
        .get("probe_error")
        .and_then(serde_json::Value::as_str)
        .map(str::to_ascii_lowercase);
    match account
        .get("signed_in")
        .and_then(serde_json::Value::as_bool)
    {
        Some(true) => Outcome::Fresh,
        Some(false) => Outcome::SignInFailed,
        None => match error.as_deref() {
            Some(e) if e.starts_with("signed out") => Outcome::SignInFailed,
            Some(e) if e.starts_with("signed in") => Outcome::Fresh,
            // `signed_in: null` with no error is claude-usage's "unknown" (a cached probe it has not
            // refreshed): neither a login nor a loss, so it must not seed or end an episode.
            _ => Outcome::Other,
        },
    }
}

/// A seat's "no" only counts after a "yes" from the same seat in this run, so a seat that was
/// already signed out when the app opened (or never signed in) does not raise an alert.
fn gated_outcome(seen: &mut HashSet<String>, key: &str, raw: Outcome) -> Outcome {
    match raw {
        Outcome::Fresh => {
            seen.insert(key.to_string());
            Outcome::Fresh
        }
        Outcome::SignInFailed if seen.contains(key) => Outcome::SignInFailed,
        _ => Outcome::Other,
    }
}

/// Outcomes for every visible seat account of one claude-usage summary. Archived (hidden) seats
/// are skipped entirely.
pub fn claude_outcomes(
    accounts: &[serde_json::Value],
    hidden_labels: &HashSet<String>,
    seen: &mut HashSet<String>,
) -> Vec<(String, Outcome)> {
    accounts
        .iter()
        .filter_map(|account| {
            let name = account.get("account")?.as_str()?;
            if hidden_labels.contains(name) {
                // Unarchiving a seat that is signed out must not alert as if it had just lost its login.
                seen.remove(name);
                return None;
            }
            let outcome = gated_outcome(seen, name, classify_claude_account(account));
            Some((name.to_string(), outcome))
        })
        .collect()
}

/// What the Claude observer remembers between summaries.
#[derive(Default)]
struct ClaudeState {
    /// seats seen signed in during this run
    seen: HashSet<String>,
    /// `generated_at` of the newest summary applied
    last: String,
}

/// True when `generated` is older than a summary already applied. Concurrent fetches can finish out
/// of order, and an older "signed in" must not end an episode a newer "signed out" started.
fn is_stale_summary(last: &mut String, generated: &str) -> bool {
    if generated.is_empty() {
        return false;
    }
    if generated < last.as_str() {
        return true;
    }
    *last = generated.to_string();
    false
}

/// Feeds one claude-usage summary into the episode tracker: one alert when a seat that was signed
/// in loses its login, none for seats that were already signed out, hidden, busy or unreadable.
/// `hidden_labels` is `None` when the archived-seat list could not be read; the summary is then
/// skipped, because guessing "nothing is archived" would alert for archived seats.
pub fn observe_claude_usage<R: Runtime>(
    app: &AppHandle<R>,
    summary: &serde_json::Value,
    hidden_labels: Option<&HashSet<String>>,
) {
    let (Some(hidden_labels), Some(accounts)) = (
        hidden_labels,
        summary
            .get("accounts")
            .and_then(serde_json::Value::as_array),
    ) else {
        return;
    };
    let generated = summary
        .get("generated_at")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let rows = match CLAUDE_STATE.lock() {
        Ok(mut state) => {
            if is_stale_summary(&mut state.last, generated) {
                return;
            }
            claude_outcomes(accounts, hidden_labels, &mut state.seen)
        }
        Err(_) => return,
    };
    // Seats that disappeared (or were archived) must not keep an episode open.
    let live: HashSet<String> = rows.iter().map(|(name, _)| name.clone()).collect();
    if let Ok(mut episodes) = EPISODES.lock() {
        episodes.prune(CLAUDE_SEATS, &live);
    }
    for (name, outcome) in rows {
        observe(app, CLAUDE_SEATS, "Claude", &name, outcome);
    }
}

static CLAUDE_STATE: LazyLock<Mutex<ClaudeState>> =
    LazyLock::new(|| Mutex::new(ClaudeState::default()));

fn observe<R: Runtime>(
    app: &AppHandle<R>,
    provider: &str,
    label: &str,
    account: &str,
    outcome: Outcome,
) {
    if record(provider, account, outcome) && !deliver(app, provider, label) {
        if let Ok(mut episodes) = EPISODES.lock() {
            episodes.release(provider);
        }
    }
}

pub fn alert_text(provider: &str, label: &str) -> (String, String) {
    // Say how to fix it where the fix is not in this app. Provider name only: no email, no error.
    let fix = match provider {
        "cursor" => "Run cursor-agent login to sign in again.",
        "gemini" => "Run gemini to sign in again.",
        "claude-seats" => "Run /login in Claude Code on the seat that signed out.",
        _ => "Open Codex Switcher to sign in again.",
    };
    (format!("{label} sign-in expired"), fix.to_string())
}

/// Shows one local notification. False means the layer itself reported a refusal or an error;
/// on desktop the plugin always reports permission as granted and hides later delivery errors, so
/// a notification the OS drops cannot be detected here.
fn deliver<R: Runtime>(app: &AppHandle<R>, provider: &str, label: &str) -> bool {
    use tauri_plugin_notification::{NotificationExt, PermissionState};

    // Off in Settings: nothing is shown, and the slot is given back so turning it on alerts again.
    if !crate::auth::load_app_settings()
        .map(|s| s.sign_in_alerts_enabled)
        .unwrap_or(true)
    {
        return false;
    }
    let notification = app.notification();
    let permitted = match notification.permission_state() {
        Ok(PermissionState::Granted) => true,
        Ok(PermissionState::Denied) => false,
        // Mobile only in practice: ask once; a refusal is rechecked next episode without a prompt loop.
        _ => matches!(
            notification.request_permission(),
            Ok(PermissionState::Granted)
        ),
    };
    if !permitted {
        return false;
    }
    let (title, body) = alert_text(provider, label);
    notification
        .builder()
        .title(title)
        .body(body)
        .show()
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(error: Option<&str>) -> UsageInfo {
        match error {
            Some(e) => UsageInfo::error("a".to_string(), e.to_string()),
            None => {
                let mut u = UsageInfo::error("a".to_string(), String::new());
                u.error = None;
                u
            }
        }
    }

    #[test]
    fn real_sign_in_errors_are_recognised() {
        for e in [
            "API error: 401 Unauthorized",
            "Token refresh failed: invalid_grant",
            "refresh_token_reused",
            "Refresh token expired: refresh_token_expired",
            "token_revoked",
            "missing refresh token",
            "HTTP 401",
        ] {
            assert!(is_sign_in_failure(e), "{e}");
        }
    }

    #[test]
    fn other_errors_are_not_sign_in_failures() {
        for e in [
            "API error: 403 Forbidden",
            "API error: 429 Too Many Requests",
            "API error: 500 Internal Server Error",
            "error sending request: connection reset",
            "Usage info not available for API key accounts",
            "Failed to parse usage response",
            "could not read token file",
            "login page changed",
            "port 14010 busy",
            "",
        ] {
            assert!(!is_sign_in_failure(e), "{e}");
        }
    }

    #[test]
    fn classification_reads_both_error_shapes() {
        assert_eq!(classify_usage(&Ok(usage(None))), Outcome::Fresh);
        assert_eq!(
            classify_usage(&Ok(usage(Some("API error: 401 Unauthorized")))),
            Outcome::SignInFailed
        );
        assert_eq!(
            classify_usage(&Err("invalid_grant".to_string())),
            Outcome::SignInFailed
        );
        assert_eq!(
            classify_usage(&Ok(usage(Some("API error: 503")))),
            Outcome::Other
        );
        assert_eq!(
            classify_usage(&Err("timed out".to_string())),
            Outcome::Other
        );
    }

    #[test]
    fn one_alert_per_provider_episode() {
        let mut e = Episodes::default();
        assert!(e.record("codex", "a", Outcome::SignInFailed));
        // Repeats, a second failing account, and noise never alert again.
        assert!(!e.record("codex", "a", Outcome::SignInFailed));
        assert!(!e.record("codex", "b", Outcome::SignInFailed));
        assert!(!e.record("codex", "a", Outcome::Other));
        // A different provider has its own episode.
        assert!(e.record("cursor", "cursor", Outcome::SignInFailed));
    }

    #[test]
    fn episode_ends_only_when_every_failing_account_recovers() {
        let mut e = Episodes::default();
        assert!(e.record("codex", "a", Outcome::SignInFailed));
        assert!(!e.record("codex", "b", Outcome::SignInFailed));
        // Account a recovers but b is still broken: no new alert when a fails again.
        e.record("codex", "a", Outcome::Fresh);
        assert!(!e.record("codex", "a", Outcome::SignInFailed));
        // Both recover: the next failure is a new episode.
        e.record("codex", "a", Outcome::Fresh);
        e.record("codex", "b", Outcome::Fresh);
        assert!(e.record("codex", "b", Outcome::SignInFailed));
    }

    #[test]
    fn noise_and_healthy_accounts_never_reset_an_episode() {
        let mut e = Episodes::default();
        assert!(e.record("codex", "a", Outcome::SignInFailed));
        e.record("codex", "a", Outcome::Other);
        // Another account being healthy says nothing about account a.
        e.record("codex", "z", Outcome::Fresh);
        assert!(!e.record("codex", "a", Outcome::SignInFailed));
    }

    #[test]
    fn deleted_accounts_cannot_hold_an_episode_open() {
        let mut e = Episodes::default();
        assert!(e.record("codex", "old", Outcome::SignInFailed));
        // The account was deleted; only "new" exists now.
        let live: HashSet<String> = ["new".to_string()].into();
        e.prune("codex", &live);
        assert!(e.record("codex", "new", Outcome::SignInFailed));
        // A surviving failing account keeps its own episode.
        let mut e = Episodes::default();
        e.record("codex", "a", Outcome::SignInFailed);
        e.record("codex", "b", Outcome::SignInFailed);
        e.prune("codex", &["a".to_string()].into());
        assert!(!e.record("codex", "c", Outcome::SignInFailed));
    }

    #[test]
    fn a_probe_no_only_counts_after_a_yes() {
        let mut seen = HashSet::new();
        // Never signed in, or an API key the probe ignores: no alert.
        assert_eq!(probe_outcome(&mut seen, "cursor", "no"), Outcome::Other);
        assert_eq!(
            probe_outcome(&mut seen, "cursor", "unknown"),
            Outcome::Other
        );
        assert_eq!(probe_outcome(&mut seen, "cursor", "yes"), Outcome::Fresh);
        assert_eq!(
            probe_outcome(&mut seen, "cursor", "no"),
            Outcome::SignInFailed
        );
        // Another provider is tracked on its own.
        assert_eq!(probe_outcome(&mut seen, "grok", "no"), Outcome::Other);
    }

    #[test]
    fn refused_delivery_gives_the_reservation_back() {
        let mut e = Episodes::default();
        assert!(e.record("codex", "a", Outcome::SignInFailed));
        e.release("codex");
        assert!(e.record("codex", "a", Outcome::SignInFailed));
    }

    #[test]
    fn alert_text_names_only_the_provider_and_says_how_to_fix_it() {
        let (title, body) = alert_text("codex", "Codex");
        assert_eq!(title, "Codex sign-in expired");
        assert_eq!(body, "Open Codex Switcher to sign in again.");
        assert_eq!(
            alert_text("cursor", "Cursor").1,
            "Run cursor-agent login to sign in again."
        );
        assert_eq!(
            alert_text("gemini", "Gemini CLI").1,
            "Run gemini to sign in again."
        );
    }

    fn row(
        account: &str,
        signed_in: serde_json::Value,
        error: serde_json::Value,
    ) -> serde_json::Value {
        serde_json::json!({"account": account, "signed_in": signed_in, "probe_error": error,
            "five_hour": {"used_pct": 10}})
    }

    #[test]
    fn claude_rows_use_what_claude_usage_says_and_never_guess() {
        use serde_json::json;
        // The exact strings claude-usage printed on 2026-11-12 for the live seats.
        assert_eq!(
            classify_claude_account(&row(
                "a",
                json!(false),
                json!("signed out: run /login for this seat")
            )),
            Outcome::SignInFailed
        );
        assert_eq!(
            classify_claude_account(&row(
                "a",
                json!(null),
                json!("signed out: run /login for this seat")
            )),
            Outcome::SignInFailed
        );
        assert_eq!(
            classify_claude_account(&row("a", json!(true), json!(null))),
            Outcome::Fresh
        );
        assert_eq!(
            classify_claude_account(&row(
                "a",
                json!(null),
                json!("signed in, but /usage printed no limit lines this time")
            )),
            Outcome::Fresh
        );
        // Unknown (claude-usage has no fresh answer for this seat): never a login, never a loss.
        assert_eq!(
            classify_claude_account(&row("a", json!(null), json!(null))),
            Outcome::Other
        );
        // A busy host or a slow probe says nothing about the login, and cached numbers do not either.
        for e in [
            "probe failed: /usage took over 90s (host busy)",
            "usage output had no limit lines",
            "",
        ] {
            assert_eq!(
                classify_claude_account(&row("a", json!(null), json!(e))),
                Outcome::Other,
                "{e}"
            );
        }
    }

    #[test]
    fn a_seat_signed_out_at_launch_is_silent_and_one_that_loses_its_login_alerts_once() {
        use serde_json::json;
        let hidden = HashSet::new();
        let mut seen = HashSet::new();
        let mut episodes = Episodes::default();
        let mut alerts = 0;
        let mut feed = |accounts: Vec<serde_json::Value>, seen: &mut HashSet<String>| -> u32 {
            let mut new_alerts = 0;
            for (name, outcome) in claude_outcomes(&accounts, &hidden, seen) {
                if episodes.record("claude-seats", &name, outcome) {
                    new_alerts += 1;
                }
            }
            new_alerts
        };
        let out = |a: &str| {
            row(
                a,
                json!(false),
                json!("signed out: run /login for this seat"),
            )
        };
        let inn = |a: &str| row(a, json!(true), json!(null));
        // Already signed out when the app opens: no alert, however often it is checked.
        alerts += feed(vec![out("mac-main-max"), inn("windows-max")], &mut seen);
        alerts += feed(vec![out("mac-main-max"), inn("windows-max")], &mut seen);
        assert_eq!(alerts, 0);
        // windows-max was signed in this run, then loses its login: exactly one alert.
        alerts += feed(vec![out("mac-main-max"), out("windows-max")], &mut seen);
        alerts += feed(vec![out("mac-main-max"), out("windows-max")], &mut seen);
        assert_eq!(alerts, 1);
        // Signing back in ends the episode; the next loss alerts again.
        alerts += feed(vec![out("mac-main-max"), inn("windows-max")], &mut seen);
        alerts += feed(vec![out("mac-main-max"), out("windows-max")], &mut seen);
        assert_eq!(alerts, 2);
    }

    #[test]
    fn archived_seats_are_skipped() {
        use serde_json::json;
        let hidden: HashSet<String> = ["windows-max".to_string()].into();
        let mut seen = HashSet::new();
        let rows = claude_outcomes(
            &[
                row("windows-max", json!(true), json!(null)),
                row("wsl-max", json!(true), json!(null)),
            ],
            &hidden,
            &mut seen,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "wsl-max");
        assert!(!seen.contains("windows-max"));
    }

    #[test]
    fn unarchiving_a_signed_out_seat_does_not_alert_and_unknown_rows_never_seed_a_login() {
        use serde_json::json;
        let mut seen = HashSet::new();
        // An unknown row (null / null) does not count as having been signed in.
        claude_outcomes(
            &[row("s", json!(null), json!(null))],
            &HashSet::new(),
            &mut seen,
        );
        assert!(seen.is_empty());
        claude_outcomes(
            &[row("s", json!(true), json!(null))],
            &HashSet::new(),
            &mut seen,
        );
        assert!(seen.contains("s"));
        // Archiving forgets the seat, so unarchiving it while signed out is silent.
        let hidden: HashSet<String> = ["s".to_string()].into();
        claude_outcomes(&[row("s", json!(true), json!(null))], &hidden, &mut seen);
        let rows = claude_outcomes(
            &[row(
                "s",
                json!(false),
                json!("signed out: run /login for this seat"),
            )],
            &HashSet::new(),
            &mut seen,
        );
        assert_eq!(rows[0].1, Outcome::Other);
    }

    #[test]
    fn an_older_summary_that_finishes_late_is_ignored() {
        let mut last = String::new();
        assert!(!is_stale_summary(&mut last, "2026-11-12T22:00:00Z"));
        assert!(!is_stale_summary(&mut last, "2026-11-12T22:10:00Z"));
        assert!(is_stale_summary(&mut last, "2026-11-12T22:05:00Z"));
        assert_eq!(last, "2026-11-12T22:10:00Z");
        // A summary without a timestamp is applied (nothing to compare) and leaves the mark alone.
        assert!(!is_stale_summary(&mut last, ""));
        assert_eq!(last, "2026-11-12T22:10:00Z");
    }

    #[test]
    fn claude_alert_text_names_only_the_provider_and_says_how_to_fix_it() {
        assert_eq!(
            alert_text("claude-seats", "Claude"),
            (
                "Claude sign-in expired".to_string(),
                "Run /login in Claude Code on the seat that signed out.".to_string()
            )
        );
    }

    /// The same cases are checked against the TypeScript classifier in tests/signInErrors.test.ts.
    #[test]
    fn rust_and_typescript_agree_on_the_shared_error_cases() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/sign-in-errors.json"))
                .unwrap();
        for e in cases["failures"].as_array().unwrap() {
            assert!(is_sign_in_failure(e.as_str().unwrap()), "{e}");
        }
        for e in cases["others"].as_array().unwrap() {
            assert!(!is_sign_in_failure(e.as_str().unwrap()), "{e}");
        }
    }
}
