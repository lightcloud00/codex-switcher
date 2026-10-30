//! Provider launchers and non-secret plan dates. Never reads provider auth files or vault values.
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanDates {
    pub id: String,
    pub billing_renews_on: Option<String>,
    pub credit_expires_on: Option<String>,
    pub credential_expires_on: Option<String>,
}
const PLAN_IDS: &[&str] = &[
    "x-subscription",
    "anthropic-api",
    "claude-mac-gustavo",
    "claude-mac-main",
    "claude-mac-096",
    "claude-windows",
    "claude-wsl",
];
fn dates_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("config directory unavailable")?
        .join("codex-switcher")
        .join("provider-dates.json"))
}
fn validate(plans: &[PlanDates]) -> Result<(), String> {
    if plans.len() > PLAN_IDS.len() {
        return Err("Too many plans".into());
    }
    let mut seen = std::collections::HashSet::new();
    for p in plans {
        if !PLAN_IDS.contains(&p.id.as_str()) || !seen.insert(&p.id) {
            return Err("Unknown or duplicate plan".into());
        }
        for value in [
            &p.billing_renews_on,
            &p.credit_expires_on,
            &p.credential_expires_on,
        ]
        .into_iter()
        .flatten()
        {
            if value.len() != 10
                || NaiveDate::parse_from_str(value, "%Y-%m-%d")
                    .map(|d| d.to_string() != *value)
                    .unwrap_or(true)
            {
                return Err("Dates must be valid YYYY-MM-DD values".into());
            }
        }
    }
    Ok(())
}
fn read_dates() -> Result<Vec<PlanDates>, String> {
    match std::fs::read_to_string(dates_path()?) {
        Ok(raw) => {
            let rows: Vec<PlanDates> =
                serde_json::from_str(&raw).map_err(|_| "Invalid provider date file")?;
            validate(&rows)?;
            Ok(rows)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PLAN_IDS
            .iter()
            .map(|id| PlanDates {
                id: id.to_string(),
                billing_renews_on: None,
                credit_expires_on: None,
                credential_expires_on: None,
            })
            .collect()),
        Err(_) => Err("Could not read provider dates".into()),
    }
}
fn find_binary(name: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let mut paths = vec![
        home.join(".local/bin"),
        home.join(".grok/bin"),
        home.join(".npm-global/bin"),
    ];
    if let Some(appdata) = std::env::var_os("APPDATA") {
        paths.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        paths.push(PathBuf::from(local).join("cursor-agent"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    #[cfg(target_os = "macos")]
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if name == "cursor" {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let desktop = PathBuf::from(local).join("Programs/Cursor/Cursor.exe");
            if desktop.is_file() {
                return Some(desktop);
            }
        }
    }
    let names = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]
    } else {
        vec![name.to_string()]
    };
    paths
        .into_iter()
        .flat_map(|p| names.iter().map(move |n| p.join(n)))
        .find(|p| p.is_file())
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SignIn {
    Yes,
    No,
    Unknown,
}
impl SignIn {
    fn as_str(self) -> &'static str {
        match self {
            SignIn::Yes => "yes",
            SignIn::No => "no",
            SignIn::Unknown => "unknown",
        }
    }
}
const NOT_CHECKED: &str = "not checked";
const CHECK_FAILED: &str = "check failed";
/// The probes run after the dates are already shown, so a slow CLI costs a label, not the tab.
const PROBE_TIMEOUT_SECS: u64 = 10;
/// Windows has no probe yet; it reports "not checked" rather than a check that never ran.
const PROBES_SUPPORTED: bool = cfg!(not(windows));
/// Read-only status probe: fixed argv, no stdin, stderr dropped, stdout capped and handed only
/// to the caller's parser (never logged or returned). Timeout, spawn failure or a read error is None.
#[cfg(not(windows))]
async fn probe(binary: PathBuf, args: &[&str], secs: u64) -> Option<(bool, String)> {
    use tokio::io::AsyncReadExt;
    const STDOUT_CAP: u64 = 64 * 1024;
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
        // Closing the pipe lets a chatty child exit on SIGPIPE instead of blocking on a full buffer.
        drop(out);
        let status = child.wait().await.ok()?;
        Some((status.success(), String::from_utf8_lossy(&buf).into_owned()))
    };
    tokio::time::timeout(std::time::Duration::from_secs(secs), run)
        .await
        .ok()
        .flatten()
}
#[cfg(windows)]
async fn probe(_binary: PathBuf, _args: &[&str], _secs: u64) -> Option<(bool, String)> {
    None
}
/// `grok models` doubles as the sign-in probe; only the positive line counts.
fn parse_grok(stdout: &str) -> SignIn {
    if stdout
        .lines()
        .any(|l| l.starts_with("You are logged in with"))
    {
        SignIn::Yes
    } else {
        SignIn::Unknown
    }
}
/// Reads only `isAuthenticated`; `userInfo` (email, user id) is never deserialised.
fn parse_cursor(stdout: &str) -> SignIn {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Status {
        is_authenticated: Option<bool>,
    }
    match serde_json::from_str::<Status>(stdout.trim()) {
        Ok(Status {
            is_authenticated: Some(true),
        }) => SignIn::Yes,
        Ok(Status {
            is_authenticated: Some(false),
        }) => SignIn::No,
        _ => SignIn::Unknown,
    }
}
fn parse_credvault(exit_ok: bool, stdout: &str) -> SignIn {
    if exit_ok
        && stdout
            .lines()
            .any(|l| l.starts_with("Vault state: UNLOCKED"))
    {
        SignIn::Yes
    } else {
        SignIn::Unknown
    }
}
/// Maps a finished probe to a sign-in state and a fixed detail. A nonzero exit or any output the
/// parsers do not recognise stays unknown: logged-out output was never observed, so never "no".
fn classify(id: &str, exit_ok: bool, stdout: &str) -> (SignIn, &'static str) {
    match (id, exit_ok) {
        ("grok", true) => match parse_grok(stdout) {
            SignIn::Yes => (SignIn::Yes, "grok models: logged in"),
            _ => (SignIn::Unknown, CHECK_FAILED),
        },
        ("cursor", true) => match parse_cursor(stdout) {
            SignIn::Yes => (SignIn::Yes, "cursor-agent status: authenticated"),
            SignIn::No => (SignIn::No, "cursor-agent status: not authenticated"),
            SignIn::Unknown => (SignIn::Unknown, CHECK_FAILED),
        },
        ("credvault", _) => match parse_credvault(exit_ok, stdout) {
            SignIn::Yes => (SignIn::Yes, "credvault status: unlocked"),
            _ => (SignIn::Unknown, CHECK_FAILED),
        },
        _ => (SignIn::Unknown, CHECK_FAILED),
    }
}
struct SignInCheck {
    state: SignIn,
    detail: &'static str,
    checked_at: Option<String>,
}
/// Runs the provider's fixed status command when `enabled`. Cursor resolves only `cursor-agent`,
/// never the `agent` or `cursor` fallbacks, so Grok's `agent` binary is never mistaken for it.
async fn check_sign_in(id: &str, enabled: bool) -> SignInCheck {
    let unchecked = SignInCheck {
        state: SignIn::Unknown,
        detail: NOT_CHECKED,
        checked_at: None,
    };
    let (bin, args): (&str, &[&str]) = match id {
        "grok" => ("grok", &["models"]),
        "cursor" => ("cursor-agent", &["status", "--format", "json"]),
        "credvault" => ("credvault", &["status"]),
        _ => return unchecked,
    };
    let Some(binary) = (enabled && PROBES_SUPPORTED)
        .then(|| find_binary(bin))
        .flatten()
    else {
        return unchecked;
    };
    let (state, detail) = match probe(binary, args, PROBE_TIMEOUT_SECS).await {
        Some((exit_ok, stdout)) => classify(id, exit_ok, &stdout),
        None => (SignIn::Unknown, CHECK_FAILED),
    };
    SignInCheck {
        state,
        detail,
        checked_at: Some(Utc::now().to_rfc3339()),
    }
}
const PROVIDERS: [(&str, &str, &[&str]); 3] = [
    ("grok", "Grok", &["grok"]),
    ("cursor", "Cursor", &["cursor-agent", "cursor"]),
    ("credvault", "CredVault", &["credvault", "credvault-mac"]),
];
/// Provider rows without the dates file. `probe` false runs no CLI at all, so every sign-in stays
/// "unknown" and unstamped; the three probes run concurrently and only for installed providers.
async fn provider_rows(probe: bool) -> Vec<serde_json::Value> {
    let installed = PROVIDERS.map(|(_, _, bins)| bins.iter().any(|b| find_binary(b).is_some()));
    let (grok, cursor, credvault) = tokio::join!(
        check_sign_in("grok", probe && installed[0]),
        check_sign_in("cursor", probe && installed[1]),
        check_sign_in("credvault", probe && installed[2]),
    );
    PROVIDERS
        .iter()
        .zip(installed)
        .zip([grok, cursor, credvault])
        .map(|(((id, label, _), installed), check)| {
            serde_json::json!({
                "id": id, "label": label, "installed": installed,
                "signedIn": check.state.as_str(), "signInDetail": check.detail,
                "signInCheckedAt": check.checked_at,
            })
        })
        .collect()
}
/// Never probes: installed state and dates only, so it answers at once and is safe on the LAN route.
async fn access_snapshot(plans: Vec<PlanDates>) -> serde_json::Value {
    serde_json::json!({
        "checkedAt": Utc::now().to_rfc3339(),
        "providers": provider_rows(false).await,
        "plans": plans,
    })
}
#[tauri::command]
pub async fn get_provider_access() -> Result<serde_json::Value, String> {
    Ok(access_snapshot(read_dates()?).await)
}
/// The read-only sign-in probes, kept apart from `get_provider_access` so a slow CLI never blocks
/// the tab. Desktop only: the LAN web route does not expose it, so no CLI runs for LAN callers.
#[tauri::command]
pub async fn check_provider_sign_in() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "providers": provider_rows(true).await }))
}
#[tauri::command]
pub async fn save_provider_dates(plans: Vec<PlanDates>) -> Result<(), String> {
    validate(&plans)?;
    let path = dates_path()?;
    std::fs::create_dir_all(path.parent().ok_or("Invalid config path")?)
        .map_err(|_| "Could not create config directory")?;
    // Write a complete validated snapshot before replacing the previous dates.
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&plans).map_err(|_| "Could not encode dates")?,
    )
    .map_err(|_| "Could not save dates")?;
    #[cfg(windows)]
    if path.exists() {
        std::fs::copy(&tmp, &path).map_err(|_| "Could not update dates")?;
        std::fs::remove_file(&tmp).ok();
    } else {
        std::fs::rename(&tmp, &path).map_err(|_| "Could not update dates")?;
    }
    #[cfg(not(windows))]
    std::fs::rename(&tmp, &path).map_err(|_| "Could not update dates")?;
    Ok(())
}
/// Fixed provider ids only: never accepts a user command, arguments, or a credential.
#[tauri::command]
pub async fn launch_provider(provider: String) -> Result<(), String> {
    if provider != "grok" && provider != "cursor" && provider != "credvault" {
        return Err("Unknown provider".into());
    }
    #[cfg(not(windows))]
    if provider == "credvault" {
        let binary =
            find_binary("credvault").ok_or("CredVault CLI is not installed on this computer")?;
        let path = format!(
            "/opt/homebrew/bin:/usr/local/bin:{}",
            std::env::var("PATH").unwrap_or_default()
        );
        let mut child = tokio::process::Command::new(binary);
        child
            .arg("status")
            .env("PATH", path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let status = tokio::time::timeout(std::time::Duration::from_secs(5), child.status())
            .await
            .map_err(|_| "CredVault status timed out")?
            .map_err(|_| "Could not check CredVault")?;
        return if status.success() {
            Ok(())
        } else {
            Err("CredVault status check failed; use the native broker to recover access".into())
        };
    }
    #[cfg(target_os = "macos")]
    {
        let app = match provider.as_str() {
            "grok" => "Grok Bot",
            "cursor" => "Cursor",
            _ => "CredVault",
        };
        let status = std::process::Command::new("/usr/bin/open")
            .args(["-a", app])
            .status()
            .map_err(|_| "Could not open app")?;
        return if status.success() {
            Ok(())
        } else {
            Err(format!("{app} is not installed; use the CLI command below"))
        };
    }
    #[cfg(windows)]
    {
        if provider == "cursor" {
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                let desktop = PathBuf::from(local).join("Programs/Cursor/Cursor.exe");
                if desktop.is_file() {
                    std::process::Command::new(desktop)
                        .spawn()
                        .map_err(|_| "Could not open Cursor")?;
                    return Ok(());
                }
            }
        }
        let command = match provider.as_str() {
            "grok" => "grok",
            "cursor" => "cursor",
            _ => {
                if find_binary("credvault").is_some() {
                    "credvault"
                } else {
                    "credvault-mac"
                }
            }
        };
        if find_binary(command).is_none() {
            return Err(format!("{command} is not installed on this computer"));
        }
        // The only command text comes from this allowlist, never from renderer input.
        let mut launcher = std::process::Command::new("cmd.exe");
        launcher.args(["/C", "start", "", "cmd.exe", "/K", command]);
        if provider == "credvault" {
            launcher.arg("status");
        }
        launcher.spawn().map_err(|_| "Could not open provider")?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    Err("Use the provider CLI command on this platform".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn plan(id: &str, date: &str) -> PlanDates {
        PlanDates {
            id: id.into(),
            billing_renews_on: Some(date.into()),
            credit_expires_on: None,
            credential_expires_on: None,
        }
    }
    #[test]
    fn dates_reject_injection_invalid_calendar_and_unknown_fields() {
        assert!(validate(&[plan("x-subscription", "2026-11-13")]).is_ok());
        for date in ["2026-02-30", "2026-1-3", "$(whoami)", "sk-secret"] {
            assert!(validate(&[plan("x-subscription", date)]).is_err());
        }
        assert!(validate(&[plan("bad", "2026-11-13")]).is_err());
        assert!(validate(&[
            plan("x-subscription", "2026-11-13"),
            plan("x-subscription", "2026-11-13")
        ])
        .is_err());
        assert!(
            serde_json::from_str::<PlanDates>(r#"{"id":"x-subscription","apiKey":"secret"}"#)
                .is_err()
        );
    }
    #[tokio::test]
    async fn launcher_rejects_renderer_command() {
        assert!(launch_provider("grok; whoami".into()).await.is_err());
    }
    const GROK_OUT: &str = "You are logged in with grok.com.\n\nDefault model: grok-4.7";
    const CURSOR_OUT: &str = r#"{"status":"authenticated","isAuthenticated":true,"userInfo":{"email":"a@b.c","userId":7}}"#;
    const CREDVAULT_OUT: &str = "Vault file: exists\nPassword protected: NO\nVault state: UNLOCKED (no password required)\nCredentials stored: 730";
    #[test]
    fn grok_is_signed_in_only_on_the_logged_in_line() {
        assert_eq!(parse_grok(GROK_OUT), SignIn::Yes);
        assert_eq!(parse_grok(""), SignIn::Unknown);
        assert_eq!(parse_grok("Default model: grok-4.7"), SignIn::Unknown);
        assert_eq!(parse_grok("Error: You are logged in with"), SignIn::Unknown);
    }
    #[test]
    fn cursor_reads_only_is_authenticated() {
        assert_eq!(parse_cursor(CURSOR_OUT), SignIn::Yes);
        assert_eq!(parse_cursor("{\"isAuthenticated\":false}\n"), SignIn::No);
        assert_eq!(parse_cursor("garbage"), SignIn::Unknown);
        assert_eq!(parse_cursor(""), SignIn::Unknown);
        assert_eq!(
            parse_cursor(r#"{"status":"authenticated"}"#),
            SignIn::Unknown
        );
        assert_eq!(
            parse_cursor(r#"{"isAuthenticated":"true"}"#),
            SignIn::Unknown
        );
    }
    #[test]
    fn credvault_needs_exit_zero_and_unlocked_line() {
        assert_eq!(parse_credvault(true, CREDVAULT_OUT), SignIn::Yes);
        assert_eq!(parse_credvault(false, CREDVAULT_OUT), SignIn::Unknown);
        assert_eq!(
            parse_credvault(true, "Vault state: LOCKED"),
            SignIn::Unknown
        );
        assert_eq!(parse_credvault(true, ""), SignIn::Unknown);
    }
    #[test]
    fn unobserved_output_is_unknown_never_no_and_detail_leaks_nothing() {
        let cases = [
            ("grok", true, GROK_OUT, SignIn::Yes),
            ("grok", false, GROK_OUT, SignIn::Unknown),
            ("grok", true, "", SignIn::Unknown),
            ("cursor", true, CURSOR_OUT, SignIn::Yes),
            ("cursor", true, r#"{"isAuthenticated":false}"#, SignIn::No),
            (
                "cursor",
                false,
                r#"{"isAuthenticated":false}"#,
                SignIn::Unknown,
            ),
            ("cursor", true, "garbage", SignIn::Unknown),
            ("credvault", true, CREDVAULT_OUT, SignIn::Yes),
            ("credvault", false, CREDVAULT_OUT, SignIn::Unknown),
            ("credvault", true, "Vault state: LOCKED", SignIn::Unknown),
            ("other", true, GROK_OUT, SignIn::Unknown),
        ];
        for (id, exit_ok, out, want) in cases {
            let (state, detail) = classify(id, exit_ok, out);
            assert_eq!(state, want, "{id} {exit_ok} {out:?}");
            assert!(!detail.contains('@') && !detail.contains("a@b.c"));
        }
        // The Cursor fixture carries an email; none of it may reach the returned detail.
        assert_eq!(
            classify("cursor", true, CURSOR_OUT).1,
            "cursor-agent status: authenticated"
        );
    }
    #[cfg(not(windows))]
    #[tokio::test]
    async fn probe_returns_exit_status_and_stdout() {
        let ok = probe("/bin/echo".into(), &["hello"], 10).await;
        assert_eq!(ok, Some((true, "hello\n".to_string())));
        let failed = probe("/usr/bin/false".into(), &[], 10).await;
        assert_eq!(failed, Some((false, String::new())));
        assert_eq!(probe("/no/such/binary".into(), &[], 10).await, None);
    }
    #[cfg(not(windows))]
    #[tokio::test]
    async fn probe_caps_stdout_and_ends_a_chatty_child() {
        let (exit_ok, out) = probe("/usr/bin/yes".into(), &[], 10).await.unwrap();
        assert!(!exit_ok);
        assert_eq!(out.len(), 64 * 1024);
    }
    #[cfg(not(windows))]
    #[tokio::test]
    async fn probe_gives_the_child_a_closed_stdin() {
        // `cat` with an open stdin would block until the timeout; a null stdin ends it at once.
        let started = std::time::Instant::now();
        assert_eq!(
            probe("/bin/cat".into(), &[], 10).await,
            Some((true, String::new()))
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }
    #[cfg(not(windows))]
    fn process_is_gone(pid: &str) -> bool {
        // A killed child can linger as a zombie until tokio reaps it, which still counts as dead.
        let out = std::process::Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", pid])
            .output()
            .unwrap();
        let stat = String::from_utf8_lossy(&out.stdout);
        stat.trim().is_empty() || stat.trim().starts_with('Z')
    }
    #[cfg(not(windows))]
    #[tokio::test]
    async fn probe_times_out_a_hung_child_and_kills_it() {
        let pid_file = std::env::temp_dir().join(format!("probe-pid-{}", uuid::Uuid::new_v4()));
        let script = format!("echo $$ > '{}'; exec sleep 30", pid_file.display());
        let started = std::time::Instant::now();
        assert_eq!(probe("/bin/sh".into(), &["-c", &script], 2).await, None);
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        let pid = std::fs::read_to_string(&pid_file).expect("the child never started");
        std::fs::remove_file(&pid_file).ok();
        let pid = pid.trim();
        assert!(!pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()));
        for _ in 0..100 {
            if process_is_gone(pid) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("timed-out probe left child {pid} running");
    }
    #[tokio::test]
    async fn disabled_check_runs_no_cli_and_reports_unknown() {
        for id in ["grok", "cursor", "credvault"] {
            let check = check_sign_in(id, false).await;
            assert_eq!(check.state, SignIn::Unknown);
            assert_eq!(check.detail, NOT_CHECKED);
            assert!(check.checked_at.is_none());
        }
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_reports_not_checked_instead_of_a_failed_check() {
        for id in ["grok", "cursor", "credvault"] {
            let check = check_sign_in(id, true).await;
            assert_eq!(check.state, SignIn::Unknown);
            assert_eq!(check.detail, NOT_CHECKED);
            assert!(check.checked_at.is_none());
        }
    }
    #[tokio::test]
    async fn snapshot_without_probing_leaves_every_provider_unknown_and_unstamped() {
        // Backs the LAN route: get_provider_access is built from this and must run no CLI.
        let snapshot = access_snapshot(vec![plan("x-subscription", "2026-11-13")]).await;
        let providers = snapshot["providers"].as_array().unwrap();
        let ids: Vec<_> = providers
            .iter()
            .map(|p| p["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["grok", "cursor", "credvault"]);
        for p in providers {
            assert_eq!(p["signedIn"], "unknown", "{p}");
            assert_eq!(p["signInDetail"], NOT_CHECKED, "{p}");
            assert!(p["signInCheckedAt"].is_null(), "{p}");
        }
        assert_eq!(snapshot["plans"][0]["billingRenewsOn"], "2026-11-13");
        assert!(snapshot["checkedAt"].is_string());
    }
}
