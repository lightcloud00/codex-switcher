//! OAuth login Tauri commands

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use crate::auth::oauth_server::{start_oauth_login, wait_for_oauth_login, OAuthLoginResult};
use crate::auth::storage::same_chatgpt_login;
use crate::auth::{
    add_account, codex_holds_account, codex_uses_account, load_accounts, load_store_reconciled,
    save_accounts, switch_to_account, AUTH_OPERATION_LOCK,
};
use crate::types::{AccountInfo, AccountsStore, AuthData, OAuthLoginInfo, StoredAccount};

struct PendingOAuth {
    rx: Option<oneshot::Receiver<anyhow::Result<OAuthLoginResult>>>,
    cancelled: Arc<AtomicBool>,
    reauth_account_id: Option<String>,
}

static OAUTH_START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static PENDING_OAUTH: Mutex<Option<PendingOAuth>> = Mutex::new(None);

/// Start an add-account or targeted re-login flow.
#[tauri::command]
pub async fn start_login(
    account_name: String,
    reauth_account_id: Option<String>,
) -> Result<OAuthLoginInfo, String> {
    let _start_guard = OAUTH_START_LOCK.lock().await;
    if let Some(id) = &reauth_account_id {
        let store = load_accounts().map_err(|e| e.to_string())?;
        let account = store
            .accounts
            .iter()
            .find(|a| &a.id == id)
            .ok_or("Account no longer exists")?;
        if !matches!(account.auth_data, AuthData::ChatGPT { .. }) {
            return Err("Only ChatGPT accounts support re-login".into());
        }
        // Codex holds the account only while auth.json does too; a stale
        // active id must not demand closing Codex.
        if codex_holds_account(id).map_err(|e| e.to_string())? {
            ensure_active_relogin_safe()?;
        }
    }

    if let Some(previous) = PENDING_OAUTH.lock().unwrap().take() {
        previous.cancelled.store(true, Ordering::Relaxed);
    }
    let (info, rx, cancelled) = start_oauth_login(account_name.trim().to_string())
        .await
        .map_err(|e| e.to_string())?;
    *PENDING_OAUTH.lock().unwrap() = Some(PendingOAuth {
        rx: Some(rx),
        cancelled,
        reauth_account_id,
    });
    Ok(info)
}

fn ensure_active_relogin_safe() -> Result<(), String> {
    super::process::ensure_codex_not_running().map_err(|_| {
        "Close Codex or switch to another account before re-logging in to the active account."
            .into()
    })
}

/// The email a fresh login reports, for messages; never a token.
fn login_email(account: &StoredAccount) -> String {
    account
        .email
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .unwrap_or("another account")
        .to_string()
}

/// Match both the user and workspace; workspace IDs alone can be shared by a team.
fn validate_relogin_identity(old: &StoredAccount, new: &StoredAccount) -> Result<(), String> {
    if !matches!(
        (&old.auth_data, &new.auth_data),
        (AuthData::ChatGPT { .. }, AuthData::ChatGPT { .. })
    ) {
        return Err("Only ChatGPT accounts support re-login".into());
    }
    if same_chatgpt_login(old, new) {
        return Ok(());
    }
    let wanted = old.email.as_deref().unwrap_or(old.name.as_str());
    if login_email(new).eq_ignore_ascii_case(wanted.trim()) {
        return Err(format!(
            "You signed in as {wanted}, but in a different workspace. The login does not match this account and workspace. Sign in again and pick the same workspace as before."
        ));
    }
    Err(format!(
        "You signed in as {}, but this account is {wanted}. The login does not match this account and workspace. Sign in again from the switcher: it opens the Chrome profile for {wanted}.",
        login_email(new)
    ))
}

/// Adding a login that is already saved would only duplicate it; this happens
/// when the browser was already signed in to that account.
fn reject_duplicate_login(store: &AccountsStore, new: &StoredAccount) -> Result<(), String> {
    match store
        .accounts
        .iter()
        .find(|saved| same_chatgpt_login(saved, new))
    {
        Some(saved) => Err(format!(
            "You signed in as {}, which is already saved as \"{}\". To add a different account, sign in with that account's email (the switcher opens its Chrome profile) or paste the link into a private window.",
            login_email(new),
            saved.name
        )),
        None => Ok(()),
    }
}

fn save_relogin(id: &str, new: StoredAccount) -> Result<StoredAccount, String> {
    save_relogin_with_check(id, new, ensure_active_relogin_safe)
}

fn save_relogin_with_check(
    id: &str,
    new: StoredAccount,
    check_active: impl FnOnce() -> Result<(), String>,
) -> Result<StoredAccount, String> {
    // Decide from the store reconciled against Codex's live login, as a refresh
    // does. Only an account Codex really holds is written to auth.json, so a
    // stale active id cannot overwrite a login made outside the switcher. And an
    // account that auth.json holds is adopted first, so the next sync cannot
    // replace the renewed tokens with stale live ones.
    let (mut store, live_auth) = load_store_reconciled().map_err(|e| e.to_string())?;
    let index = store
        .accounts
        .iter()
        .position(|a| a.id == id)
        .ok_or("Account no longer exists")?;
    let active = codex_uses_account(&store, &store.accounts[index], live_auth.as_ref());
    let account = &mut store.accounts[index];
    validate_relogin_identity(account, &new)?;
    if active {
        check_active()?;
    }
    account.auth_data = new.auth_data;
    account.email = new.email;
    account.plan_type = new.plan_type;
    account.subscription_expires_at = new.subscription_expires_at;
    let updated = account.clone();
    if active {
        // Live auth is the source of truth during reconciliation. Write it first
        // so an I/O failure cannot later replace renewed tokens with stale ones.
        switch_to_account(&updated).map_err(|e| {
            format!("Could not update Codex auth; saved account was not changed: {e}")
        })?;
    }
    save_accounts(&store).map_err(|e| {
        if active {
            format!("Codex login renewed, but saving the account failed: {e}. Refresh usage to sync it again.")
        } else {
            e.to_string()
        }
    })?;
    Ok(updated)
}

/// Keep cancellation reachable while awaiting the browser and the auth lock.
#[tauri::command]
pub async fn complete_login() -> Result<AccountInfo, String> {
    let (rx, cancelled, reauth_account_id) = {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        let pending = pending.as_mut().ok_or("No pending OAuth login")?;
        (
            pending
                .rx
                .take()
                .ok_or("OAuth login is already being completed")?,
            pending.cancelled.clone(),
            pending.reauth_account_id.clone(),
        )
    };
    let result = async {
        let account = wait_for_oauth_login(rx).await.map_err(|e| e.to_string())?;
        let _auth_guard = AUTH_OPERATION_LOCK.lock().await;
        if cancelled.load(Ordering::Relaxed) {
            return Err("OAuth login cancelled".into());
        }
        let stored = if let Some(id) = reauth_account_id {
            save_relogin(&id, account)?
        } else {
            reject_duplicate_login(&load_accounts().map_err(|e| e.to_string())?, &account)?;
            add_account(account).map_err(|e| e.to_string())?
        };
        let store = load_accounts().map_err(|e| e.to_string())?;
        Ok(AccountInfo::from_stored(
            &stored,
            store.active_account_id.as_deref(),
        ))
    }
    .await;
    let mut pending = PENDING_OAUTH.lock().unwrap();
    if pending
        .as_ref()
        .is_some_and(|p| Arc::ptr_eq(&p.cancelled, &cancelled))
    {
        pending.take();
    }
    result
}

#[tauri::command]
pub async fn cancel_login() -> Result<(), String> {
    let _start_guard = OAUTH_START_LOCK.lock().await;
    if let Some(pending) = PENDING_OAUTH.lock().unwrap().take() {
        pending.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
#[path = "oauth_tests.rs"]
mod tests;
