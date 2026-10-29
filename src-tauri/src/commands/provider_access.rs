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
#[tauri::command]
pub async fn get_provider_access() -> Result<serde_json::Value, String> {
    let providers = [
        ("grok", "Grok", vec!["grok"]),
        ("cursor", "Cursor", vec!["cursor-agent", "agent", "cursor"]),
        ("credvault", "CredVault", vec!["credvault", "credvault-mac"]),
    ]
    .into_iter()
    .map(|(id, label, bins)| {
        serde_json::json!({
            "id": id, "label": label, "installed": bins.iter().any(|b| find_binary(b).is_some()),
            "authentication": "Native sign-in / broker; not checked by Switcher",
        })
    })
    .collect::<Vec<_>>();
    Ok(
        serde_json::json!({"checkedAt": Utc::now().to_rfc3339(), "providers": providers, "plans": read_dates()?}),
    )
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
}
