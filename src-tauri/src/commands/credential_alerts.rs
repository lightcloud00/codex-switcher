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

    /// Drops one account's episode (an archived Claude seat).
    pub fn forget(&mut self, provider: &str) {
        self.failing.remove(provider);
        self.alerted.remove(provider);
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
/// It picks the alert text; each seat has its own episode under `claude-seats:<account>`, so one
/// seat that is already signed out cannot hide another seat losing its login.
const CLAUDE_SEATS: &str = "claude-seats";

fn claude_episode_key(account: &str) -> String {
    format!("{CLAUDE_SEATS}:{account}")
}

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

/// What the Claude observer remembers between summaries.
///
/// Scope: claude-usage only reports `signed_in` for seats on this Mac (kind `local`). A remote seat
/// (Windows, WSL) is always `signed_in: null` and its lost login reads as a non-sign-in error, so
/// remote seats never alert. Archived seats also never alert, but the archived list is the local
/// registry only: seats that merely share a login with an archived one (`shares_login_with`) are not
/// hidden here, and neither is a seat archived through the Windows metadata bridge registry
/// (`fetch_claude_seats` falls back to it on Windows, `hidden_usage_labels` does not).
#[derive(Default)]
struct ClaudeState {
    /// seats confirmed signed in during this run
    seen: HashSet<String>,
    /// seat -> time of the first summary that said "signed in". claude-usage answers from cached
    /// probes (`generated_at` is just the time of the call) and refreshes a probe in the background
    /// only once it is about 10 minutes old, so one "signed in", or several within minutes of each
    /// other, may all be the same hours-old cached answer. A seat counts as having been signed in
    /// only when a later summary says so again at least `ARM_AFTER` after the first.
    pending: HashMap<String, chrono::DateTime<chrono::FixedOffset>>,
    /// newest summary applied
    last: Option<chrono::DateTime<chrono::FixedOffset>>,
}

/// Probe refresh interval (10 minutes) plus slack.
const ARM_AFTER: chrono::Duration = chrono::Duration::minutes(15);
/// How far ahead of this machine's clock a summary time may be before it is ignored.
const MAX_CLOCK_SKEW: chrono::Duration = chrono::Duration::minutes(5);

impl ClaudeState {
    /// True when `generated` is older than a summary already applied. Concurrent fetches can finish
    /// out of order, and an older "signed in" must not end an episode a newer "signed out" started.
    /// No usable timestamp (unparseable, or dated in the future) means nothing to compare: the
    /// summary is applied and the newest-time mark is left alone.
    fn is_stale(&mut self, at: Option<chrono::DateTime<chrono::FixedOffset>>) -> bool {
        let Some(at) = at else {
            return false;
        };
        match self.last {
            Some(last) if at < last => true,
            _ => {
                self.last = Some(at);
                false
            }
        }
    }

    fn gate(
        &mut self,
        name: &str,
        raw: Outcome,
        at: Option<chrono::DateTime<chrono::FixedOffset>>,
    ) -> Outcome {
        match raw {
            Outcome::Fresh if self.seen.contains(name) => Outcome::Fresh,
            // Without a usable summary time nothing can be armed.
            Outcome::Fresh => match (self.pending.get(name).copied(), at) {
                (Some(first), Some(now)) if now - first >= ARM_AFTER => {
                    self.pending.remove(name);
                    self.seen.insert(name.to_string());
                    Outcome::Fresh
                }
                (Some(_), _) | (None, None) => Outcome::Other,
                (None, Some(now)) => {
                    self.pending.insert(name.to_string(), now);
                    Outcome::Other
                }
            },
            // A "no" only counts for a seat confirmed signed in this run, so a seat that was already
            // signed out when the app opened (or never signed in) does not alert.
            Outcome::SignInFailed => {
                self.pending.remove(name);
                if self.seen.contains(name) {
                    Outcome::SignInFailed
                } else {
                    Outcome::Other
                }
            }
            // A busy host or an unknown row neither confirms nor cancels: a pending first "signed
            // in" survives it (and a summary that omits the seat), on purpose.
            Outcome::Other => Outcome::Other,
        }
    }

    /// Applies one claude-usage summary and returns the seats that need a new alert. A seat missing
    /// from a summary changes nothing; an archived seat is forgotten (history and open episode).
    fn apply(
        &mut self,
        episodes: &mut Episodes,
        accounts: &[serde_json::Value],
        hidden_labels: &HashSet<String>,
        generated: &str,
    ) -> Vec<String> {
        self.apply_at(
            episodes,
            accounts,
            hidden_labels,
            generated,
            chrono::Utc::now().fixed_offset(),
        )
    }

    fn apply_at(
        &mut self,
        episodes: &mut Episodes,
        accounts: &[serde_json::Value],
        hidden_labels: &HashSet<String>,
        generated: &str,
        now: chrono::DateTime<chrono::FixedOffset>,
    ) -> Vec<String> {
        // A summary dated well ahead of this clock (skew) is not trusted as a time: it would
        // otherwise make every later, correctly dated summary look stale until the app restarts.
        let at = chrono::DateTime::parse_from_rfc3339(generated)
            .ok()
            .filter(|t| *t <= now + MAX_CLOCK_SKEW);
        if self.is_stale(at) {
            return Vec::new();
        }
        let mut alerts = Vec::new();
        for account in accounts {
            let Some(name) = account.get("account").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let key = claude_episode_key(name);
            if hidden_labels.contains(name) {
                self.seen.remove(name);
                self.pending.remove(name);
                episodes.forget(&key);
                continue;
            }
            let outcome = self.gate(name, classify_claude_account(account), at);
            if episodes.record(&key, name, outcome) {
                alerts.push(name.to_string());
            }
        }
        alerts
    }
}

/// Feeds one claude-usage summary into the episode tracker: one alert per seat that was signed in
/// and loses its login, none for seats already signed out, archived, remote, busy or unreadable.
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
    // One guard from the stale check to the last record, so overlapping fetches cannot interleave.
    // Lock order is CLAUDE_STATE, then EPISODES; nothing awaits while they are held. The alerts are
    // only collected here and shown after both guards are dropped, so a panic in the notification
    // layer cannot poison the episode tracker the other providers share.
    let alerts = {
        let Ok(mut state) = CLAUDE_STATE.lock() else {
            return;
        };
        let Ok(mut episodes) = EPISODES.lock() else {
            return;
        };
        state.apply(&mut episodes, accounts, hidden_labels, generated)
    };
    // Several seats failing in one summary show one notification (it names no seat anyway).
    if !alerts.is_empty() && !deliver(app, CLAUDE_SEATS, "Claude") {
        if let Ok(mut episodes) = EPISODES.lock() {
            for name in &alerts {
                episodes.release(&claude_episode_key(name));
            }
        }
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

    const T1: &str = "2026-11-12T22:00:00Z";
    const T2: &str = "2026-11-12T22:20:00Z";
    const T3: &str = "2026-11-12T22:40:00Z";
    const T4: &str = "2026-11-12T23:00:00Z";
    const T5: &str = "2026-11-12T23:20:00Z";

    fn out(a: &str) -> serde_json::Value {
        row(
            a,
            serde_json::json!(false),
            serde_json::json!("signed out: run /login for this seat"),
        )
    }

    fn inn(a: &str) -> serde_json::Value {
        row(a, serde_json::json!(true), serde_json::json!(null))
    }

    fn feed(
        state: &mut ClaudeState,
        episodes: &mut Episodes,
        accounts: Vec<serde_json::Value>,
        at: &str,
    ) -> Vec<String> {
        state.apply_at(episodes, &accounts, &HashSet::new(), at, test_now())
    }

    /// Later than every timestamp the tests use, so none counts as "from the future".
    fn test_now() -> chrono::DateTime<chrono::FixedOffset> {
        chrono::DateTime::parse_from_rfc3339("2030-01-01T00:00:00Z").unwrap()
    }

    #[test]
    fn a_seat_signed_out_at_launch_is_silent_and_one_that_loses_its_login_alerts_once() {
        let (mut state, mut episodes) = (ClaudeState::default(), Episodes::default());
        // mac-main-max is already signed out when the app opens: silent however often it is checked.
        // mac-gustavo-max is signed in; two summaries in a row confirm it.
        assert!(feed(
            &mut state,
            &mut episodes,
            vec![out("mac-main-max"), inn("mac-gustavo-max")],
            T1
        )
        .is_empty());
        assert!(feed(
            &mut state,
            &mut episodes,
            vec![out("mac-main-max"), inn("mac-gustavo-max")],
            T2
        )
        .is_empty());
        // mac-gustavo-max now loses its login: exactly one alert, however many summaries follow.
        assert_eq!(
            feed(
                &mut state,
                &mut episodes,
                vec![out("mac-main-max"), out("mac-gustavo-max")],
                T3
            ),
            ["mac-gustavo-max"]
        );
        assert!(feed(
            &mut state,
            &mut episodes,
            vec![out("mac-main-max"), out("mac-gustavo-max")],
            T4
        )
        .is_empty());
    }

    #[test]
    fn signing_back_in_ends_the_episode_and_the_next_loss_alerts_again() {
        let (mut state, mut episodes) = (ClaudeState::default(), Episodes::default());
        feed(&mut state, &mut episodes, vec![inn("mac-main-max")], T1);
        feed(&mut state, &mut episodes, vec![inn("mac-main-max")], T2);
        assert_eq!(
            feed(&mut state, &mut episodes, vec![out("mac-main-max")], T3),
            ["mac-main-max"]
        );
        feed(&mut state, &mut episodes, vec![inn("mac-main-max")], T4);
        assert_eq!(
            feed(&mut state, &mut episodes, vec![out("mac-main-max")], T5),
            ["mac-main-max"]
        );
    }

    #[test]
    fn a_second_seat_losing_its_login_still_alerts_while_the_first_is_failing() {
        let (mut state, mut episodes) = (ClaudeState::default(), Episodes::default());
        let both_in = || vec![inn("mac-main-max"), inn("mac-096-max")];
        feed(&mut state, &mut episodes, both_in(), T1);
        feed(&mut state, &mut episodes, both_in(), T2);
        assert_eq!(
            feed(
                &mut state,
                &mut episodes,
                vec![out("mac-main-max"), inn("mac-096-max")],
                T3
            ),
            ["mac-main-max"]
        );
        assert_eq!(
            feed(
                &mut state,
                &mut episodes,
                vec![out("mac-main-max"), out("mac-096-max")],
                T4
            ),
            ["mac-096-max"]
        );
    }

    #[test]
    fn signed_in_summaries_seconds_apart_do_not_arm_a_seat_but_ones_16_minutes_apart_do() {
        // claude-usage stamps generated_at on every call but reads signed_in from cached probes that
        // refresh about every 10 minutes: polls 5 s apart can all repeat one hours-old answer.
        let (mut state, mut episodes) = (ClaudeState::default(), Episodes::default());
        let seats = || vec![inn("mac-main-max")];
        feed(&mut state, &mut episodes, seats(), "2026-11-12T22:00:00Z");
        feed(&mut state, &mut episodes, seats(), "2026-11-12T22:00:05Z");
        feed(&mut state, &mut episodes, seats(), "2026-11-12T22:14:59Z");
        // The refresh then shows the seat has long been signed out: no alert, it was never armed.
        assert!(feed(
            &mut state,
            &mut episodes,
            vec![out("mac-main-max")],
            "2026-11-12T22:15:30Z"
        )
        .is_empty());
        // A fresh start: first "signed in" at 22:00, the next one 16 minutes later arms it.
        let (mut state, mut episodes) = (ClaudeState::default(), Episodes::default());
        feed(&mut state, &mut episodes, seats(), "2026-11-12T22:00:00Z");
        feed(&mut state, &mut episodes, seats(), "2026-11-12T22:16:00Z");
        assert_eq!(
            feed(
                &mut state,
                &mut episodes,
                vec![out("mac-main-max")],
                "2026-11-12T22:17:00Z"
            ),
            ["mac-main-max"]
        );
        // A summary without a usable time arms nothing.
        let (mut state, mut episodes) = (ClaudeState::default(), Episodes::default());
        feed(&mut state, &mut episodes, seats(), "");
        feed(&mut state, &mut episodes, seats(), "");
        assert!(state.seen.is_empty() && state.pending.is_empty());
    }

    #[test]
    fn a_summary_that_omits_a_seat_changes_nothing_for_it() {
        let (mut state, mut episodes) = (ClaudeState::default(), Episodes::default());
        feed(&mut state, &mut episodes, vec![inn("mac-main-max")], T1);
        feed(&mut state, &mut episodes, vec![inn("mac-main-max")], T2);
        assert_eq!(
            feed(&mut state, &mut episodes, vec![out("mac-main-max")], T3),
            ["mac-main-max"]
        );
        // The seat drops out of one summary (host left out, or a row without an account name)...
        feed(
            &mut state,
            &mut episodes,
            vec![serde_json::json!({"probe_error": null})],
            T4,
        );
        // ...and is signed out again in the next: still the same episode, no second alert.
        assert!(feed(&mut state, &mut episodes, vec![out("mac-main-max")], T5).is_empty());
    }

    #[test]
    fn an_older_summary_that_finishes_late_is_ignored() {
        let (mut state, mut episodes) = (ClaudeState::default(), Episodes::default());
        feed(&mut state, &mut episodes, vec![inn("mac-main-max")], T1);
        feed(&mut state, &mut episodes, vec![inn("mac-main-max")], T2);
        // The newer "signed out" (T4) lands first and alerts; the older "signed in" (T3) arrives late.
        assert_eq!(
            feed(&mut state, &mut episodes, vec![out("mac-main-max")], T4),
            ["mac-main-max"]
        );
        assert!(feed(&mut state, &mut episodes, vec![inn("mac-main-max")], T3).is_empty());
        // It did not end the episode: the next signed-out summary does not alert again.
        assert!(feed(&mut state, &mut episodes, vec![out("mac-main-max")], T5).is_empty());
        // Timestamps compare as times, not text: 09:00 in +05:00 is before 05:00Z.
        let mut s = ClaudeState::default();
        assert!(!s.is_stale(chrono::DateTime::parse_from_rfc3339("2026-11-12T05:00:00Z").ok()));
        assert!(s.is_stale(chrono::DateTime::parse_from_rfc3339("2026-11-12T09:00:00+05:00").ok()));
        assert!(!s.is_stale(None));
    }

    #[test]
    fn archived_seats_are_skipped_forgotten_and_silent_after_unarchiving() {
        let (mut state, mut episodes) = (ClaudeState::default(), Episodes::default());
        feed(&mut state, &mut episodes, vec![inn("mac-main-max")], T1);
        feed(&mut state, &mut episodes, vec![inn("mac-main-max")], T2);
        let hidden: HashSet<String> = ["mac-main-max".to_string()].into();
        // Archived: no alert even though it reports signed out, and its history is dropped.
        assert!(state
            .apply(&mut episodes, &[out("mac-main-max")], &hidden, T3)
            .is_empty());
        assert!(!state.seen.contains("mac-main-max"));
        // Unarchived while signed out: silent, as for any seat that was already signed out.
        assert!(feed(&mut state, &mut episodes, vec![out("mac-main-max")], T4).is_empty());
    }

    #[test]
    fn unknown_rows_never_confirm_a_login() {
        let (mut state, mut episodes) = (ClaudeState::default(), Episodes::default());
        let unknown = || vec![row("s", serde_json::json!(null), serde_json::json!(null))];
        feed(&mut state, &mut episodes, unknown(), T1);
        feed(&mut state, &mut episodes, unknown(), T2);
        assert!(state.seen.is_empty() && state.pending.is_empty());
    }

    #[test]
    fn exactly_15_minutes_between_the_two_signed_in_summaries_arms_a_seat() {
        let seats = || vec![inn("mac-main-max")];
        // 15:00 exactly arms (the gate is >=); one second less does not.
        let (mut state, mut episodes) = (ClaudeState::default(), Episodes::default());
        feed(&mut state, &mut episodes, seats(), "2026-11-12T22:00:00Z");
        feed(&mut state, &mut episodes, seats(), "2026-11-12T22:15:00Z");
        assert_eq!(
            feed(
                &mut state,
                &mut episodes,
                vec![out("mac-main-max")],
                "2026-11-12T22:16:00Z"
            ),
            ["mac-main-max"]
        );
        let (mut state, mut episodes) = (ClaudeState::default(), Episodes::default());
        feed(&mut state, &mut episodes, seats(), "2026-11-12T22:00:00Z");
        feed(&mut state, &mut episodes, seats(), "2026-11-12T22:14:59Z");
        assert!(feed(
            &mut state,
            &mut episodes,
            vec![out("mac-main-max")],
            "2026-11-12T22:16:00Z"
        )
        .is_empty());
    }

    #[test]
    fn one_summary_dated_in_the_future_does_not_make_later_summaries_stale() {
        let (mut state, mut episodes) = (ClaudeState::default(), Episodes::default());
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-12T22:00:00Z").unwrap();
        let seats = || vec![inn("mac-main-max")];
        // A clock-skewed summary (a day ahead) is applied but its time is not trusted...
        state.apply_at(
            &mut episodes,
            &seats(),
            &HashSet::new(),
            "2026-11-13T22:00:00Z",
            now,
        );
        assert!(state.last.is_none());
        // ...so a correctly dated summary a minute later is not stale, and one within the skew allowance counts.
        let ok = |t: &str, st: &mut ClaudeState, ep: &mut Episodes| {
            st.apply_at(ep, &seats(), &HashSet::new(), t, now)
        };
        ok("2026-11-12T22:01:00Z", &mut state, &mut episodes);
        assert!(state.pending.contains_key("mac-main-max"));
        ok("2026-11-12T22:04:00Z", &mut state, &mut episodes);
        assert!(state.last.is_some());
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
