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

    /// A delivery that failed or was refused gives its reservation back so a later check retries.
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
    observe(app, "codex", "Codex", account_id, classify_usage(result));
}

/// Same for a provider's sign-in probe (`signedIn` of "yes" is fresh, "no" is failed).
pub fn observe_probe<R: Runtime>(app: &AppHandle<R>, id: &str, label: &str, signed_in: &str) {
    let outcome = match signed_in {
        "yes" => Outcome::Fresh,
        "no" => Outcome::SignInFailed,
        _ => Outcome::Other,
    };
    observe(app, id, label, id, outcome);
}

fn observe<R: Runtime>(
    app: &AppHandle<R>,
    provider: &str,
    label: &str,
    account: &str,
    outcome: Outcome,
) {
    if record(provider, account, outcome) && !deliver(app, label) {
        if let Ok(mut episodes) = EPISODES.lock() {
            episodes.release(provider);
        }
    }
}

pub fn alert_text(label: &str) -> (String, String) {
    (
        format!("{label} sign-in expired"),
        "Open Codex Switcher to sign in again.".to_string(),
    )
}

/// Shows one local notification. False means it was not shown (permission refused or an error).
fn deliver<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
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
        // Not asked yet: ask once; a refusal is rechecked next episode without a prompt loop.
        _ => matches!(
            notification.request_permission(),
            Ok(PermissionState::Granted)
        ),
    };
    if !permitted {
        return false;
    }
    let (title, body) = alert_text(label);
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
    fn refused_delivery_gives_the_reservation_back() {
        let mut e = Episodes::default();
        assert!(e.record("codex", "a", Outcome::SignInFailed));
        e.release("codex");
        assert!(e.record("codex", "a", Outcome::SignInFailed));
    }

    #[test]
    fn alert_text_names_only_the_provider() {
        let (title, body) = alert_text("Codex");
        assert_eq!(title, "Codex sign-in expired");
        assert_eq!(body, "Open Codex Switcher to sign in again.");
    }
}
