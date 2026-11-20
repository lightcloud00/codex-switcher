//! Open the ChatGPT sign-in link where the right account can sign in.
//!
//! The plain "open in the default browser" route lands in whatever Chrome
//! profile was used last, which is usually already signed in to ChatGPT as a
//! different account. OpenAI then signs that account in without asking, so a
//! re-login fails the identity check and an add saves the wrong login. On macOS
//! this opens the link in the Chrome profile signed in to the account's email,
//! or in a private window when no profile matches.

use serde::Serialize;
use serde_json::Value;

const AUTHORIZE_PREFIX: &str = "https://auth.openai.com/oauth/authorize?";

/// How the sign-in link was opened, so the dialog can say where to look.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoginBrowserOpened {
    /// "profile" (the Chrome profile for that email) or "private" (a private window).
    pub mode: String,
    /// The Chrome profile's display name, when a profile was used.
    pub profile_name: Option<String>,
}

/// The Chrome profile folder and display name signed in to `email`, from Chrome's
/// `Local State`. Several profiles can share one Google account; the one used most
/// recently wins, then the folder name, so the choice is stable.
pub fn pick_chrome_profile(local_state: &Value, email: &str) -> Option<(String, String)> {
    let want = email.trim();
    if want.is_empty() || !want.contains('@') {
        return None;
    }
    let cache = local_state.pointer("/profile/info_cache")?.as_object()?;
    cache
        .iter()
        .filter(|(_, info)| {
            info.get("user_name")
                .and_then(Value::as_str)
                .is_some_and(|user| user.trim().eq_ignore_ascii_case(want))
        })
        .map(|(dir, info)| {
            let active = info
                .get("active_time")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let name = info
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(dir.as_str())
                .to_string();
            (dir.clone(), name, active)
        })
        .max_by(|a, b| a.2.total_cmp(&b.2).then_with(|| b.0.cmp(&a.0)))
        .map(|(dir, name, _)| (dir, name))
}

/// Only the OpenAI sign-in page may be opened this way.
fn check_authorize_url(url: &str) -> Result<(), String> {
    if url.starts_with(AUTHORIZE_PREFIX) && !url.contains(char::is_whitespace) {
        Ok(())
    } else {
        Err("Only the ChatGPT sign-in link can be opened here".into())
    }
}

/// Chrome's command-line arguments for the chosen route.
fn chrome_args(url: &str, profile_dir: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    match profile_dir {
        Some(dir) => args.push(format!("--profile-directory={dir}")),
        None => args.push("--incognito".to_string()),
    }
    args.push(url.to_string());
    args
}

#[cfg(target_os = "macos")]
fn open_in_chrome(url: &str, email: Option<&str>) -> Result<LoginBrowserOpened, String> {
    const CHROME_APP: &str = "/Applications/Google Chrome.app";
    if !std::path::Path::new(CHROME_APP).exists() {
        return Err("Google Chrome is not installed".into());
    }
    let profile = email.and_then(|email| {
        let path = dirs::home_dir()?.join("Library/Application Support/Google/Chrome/Local State");
        let text = std::fs::read_to_string(path).ok()?;
        let state: Value = serde_json::from_str(&text).ok()?;
        pick_chrome_profile(&state, email)
    });
    let mut command = std::process::Command::new("/usr/bin/open");
    command.args(["-na", CHROME_APP, "--args"]);
    command.args(chrome_args(
        url,
        profile.as_ref().map(|(dir, _)| dir.as_str()),
    ));
    let status = command
        .status()
        .map_err(|e| format!("Could not open Chrome: {e}"))?;
    if !status.success() {
        return Err(format!("Could not open Chrome (exit {status})"));
    }
    Ok(match profile {
        Some((_, name)) => LoginBrowserOpened {
            mode: "profile".into(),
            profile_name: Some(name),
        },
        None => LoginBrowserOpened {
            mode: "private".into(),
            profile_name: None,
        },
    })
}

#[cfg(not(target_os = "macos"))]
fn open_in_chrome(_url: &str, _email: Option<&str>) -> Result<LoginBrowserOpened, String> {
    Err("Opening a Chrome profile is only supported on macOS".into())
}

/// Open the sign-in link in the Chrome profile for `email`, or a private window.
/// An error means the caller should fall back to the default browser.
#[tauri::command]
pub async fn open_login_url(
    url: String,
    email: Option<String>,
) -> Result<LoginBrowserOpened, String> {
    check_authorize_url(&url)?;
    let email = email.filter(|e| !e.trim().is_empty());
    tokio::task::spawn_blocking(move || open_in_chrome(&url, email.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state() -> Value {
        json!({"profile": {"info_cache": {
            "Default": {"name": "lightcloud", "user_name": "main@example.test", "active_time": 300.0},
            "Profile 3": {"name": "yt", "user_name": "Two@Example.test", "active_time": 100.0},
            "Profile 21": {"name": "Gustavo", "user_name": "two@example.test", "active_time": 200.0},
            "Profile 49": {"name": "Lakes", "user_name": "lakes@example.test"},
            "Profile 50": {"name": "No Google"}
        }}})
    }

    #[test]
    fn picks_the_profile_signed_in_to_the_email_case_insensitively() {
        assert_eq!(
            pick_chrome_profile(&state(), " LAKES@example.test "),
            Some(("Profile 49".into(), "Lakes".into()))
        );
    }

    #[test]
    fn prefers_the_most_recently_used_of_several_matching_profiles() {
        assert_eq!(
            pick_chrome_profile(&state(), "two@example.test"),
            Some(("Profile 21".into(), "Gustavo".into()))
        );
    }

    #[test]
    fn no_profile_for_unknown_or_non_email_names() {
        assert_eq!(pick_chrome_profile(&state(), "nobody@example.test"), None);
        assert_eq!(pick_chrome_profile(&state(), "Work account"), None);
        assert_eq!(pick_chrome_profile(&state(), ""), None);
        assert_eq!(pick_chrome_profile(&json!({}), "two@example.test"), None);
    }

    #[test]
    fn only_the_openai_sign_in_link_is_accepted() {
        assert!(check_authorize_url("https://auth.openai.com/oauth/authorize?a=1").is_ok());
        assert!(check_authorize_url("https://evil.example/oauth/authorize?a=1").is_err());
        assert!(check_authorize_url("https://auth.openai.com/oauth/authorize?a=1 --x").is_err());
        assert!(check_authorize_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn uses_the_profile_or_a_private_window() {
        assert_eq!(
            chrome_args("U", Some("Profile 49")),
            vec![
                "--profile-directory=Profile 49".to_string(),
                "U".to_string()
            ]
        );
        assert_eq!(
            chrome_args("U", None),
            vec!["--incognito".to_string(), "U".to_string()]
        );
    }
}
