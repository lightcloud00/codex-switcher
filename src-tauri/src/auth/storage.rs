//! Account storage module - manages reading and writing accounts.json

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};

use crate::types::{
    parse_chatgpt_id_token_claims, AccountsStore, AppSettings, AuthData, AuthDotJson, StoredAccount,
};

/// The ChatGPT account and, when the ID token carries one, the login email
/// that a set of tokens belongs to.
struct ChatGptIdentity {
    account_id: String,
    email: Option<String>,
}

impl ChatGptIdentity {
    fn from_tokens(
        id_token: &str,
        account_id: Option<&String>,
        email: Option<&String>,
    ) -> Option<Self> {
        let claims = parse_chatgpt_id_token_claims(id_token);
        Some(Self {
            account_id: claims.account_id.or_else(|| account_id.cloned())?,
            email: claims
                .email
                .or_else(|| email.cloned())
                .map(|email| email.to_lowercase()),
        })
    }

    fn of_live_auth(auth: &AuthDotJson) -> Option<Self> {
        let tokens = auth.tokens.as_ref()?;
        Self::from_tokens(&tokens.id_token, tokens.account_id.as_ref(), None)
    }

    fn of_account(account: &StoredAccount) -> Option<Self> {
        let AuthData::ChatGPT {
            id_token,
            account_id,
            ..
        } = &account.auth_data
        else {
            return None;
        };
        Self::from_tokens(id_token, account_id.as_ref(), account.email.as_ref())
    }

    /// Members of one team workspace share an account id, so compare the
    /// login email too whenever both sides carry one.
    fn matches(&self, other: &Self) -> bool {
        self.account_id == other.account_id
            && match (&self.email, &other.email) {
                (Some(ours), Some(theirs)) => ours == theirs,
                _ => true,
            }
    }
}

/// Whether Codex's live auth.json may hold this account's tokens. A login with
/// no readable identity counts as a match, so callers stay cautious with it.
pub fn live_auth_may_hold_account(account: &StoredAccount, auth: &AuthDotJson) -> bool {
    if auth.tokens.is_none() {
        return false;
    }
    match (
        ChatGptIdentity::of_account(account),
        ChatGptIdentity::of_live_auth(auth),
    ) {
        (Some(stored), Some(live)) => stored.matches(&live),
        _ => true,
    }
}

/// Make the stored account that Codex is signed in to the active one, then
/// copy its live tokens.
///
/// Codex can sign in or out without the switcher. That left
/// `active_account_id` on a session Codex no longer held, so the active card
/// showed 401 forever: refreshing the active account is skipped while Codex
/// runs. Only an unambiguous match is adopted.
pub fn reconcile_active_account_with_live_auth(
    store: &mut AccountsStore,
    auth: &AuthDotJson,
) -> bool {
    let Some(live) = ChatGptIdentity::of_live_auth(auth) else {
        return false;
    };
    let active_holds_live = store
        .active_account_id
        .as_deref()
        .and_then(|active_id| {
            store
                .accounts
                .iter()
                .find(|account| account.id == active_id)
        })
        .and_then(ChatGptIdentity::of_account)
        .is_some_and(|stored| stored.matches(&live));
    if active_holds_live {
        return sync_active_account_tokens(store, auth);
    }

    let mut holders = store.accounts.iter().filter(|account| {
        ChatGptIdentity::of_account(account).is_some_and(|stored| stored.matches(&live))
    });
    let (Some(holder), None) = (holders.next(), holders.next()) else {
        return false;
    };
    store.active_account_id = Some(holder.id.clone());
    sync_active_account_tokens(store, auth);
    true
}

pub fn sync_active_account_tokens(store: &mut AccountsStore, auth: &AuthDotJson) -> bool {
    let Some(active_id) = store.active_account_id.as_deref() else {
        return false;
    };
    let Some(tokens) = auth.tokens.as_ref() else {
        return false;
    };
    let Some(account) = store
        .accounts
        .iter_mut()
        .find(|account| account.id == active_id)
    else {
        return false;
    };
    let (Some(stored), Some(current)) = (
        ChatGptIdentity::of_account(account),
        ChatGptIdentity::of_live_auth(auth),
    ) else {
        return false;
    };
    if !stored.matches(&current) {
        return false;
    }
    let current_account_id = current.account_id;
    let AuthData::ChatGPT {
        id_token,
        access_token,
        refresh_token,
        account_id,
    } = &mut account.auth_data
    else {
        return false;
    };

    let mut changed = *id_token != tokens.id_token
        || *access_token != tokens.access_token
        || *refresh_token != tokens.refresh_token
        || account_id.as_ref() != Some(&current_account_id);
    if changed {
        id_token.clone_from(&tokens.id_token);
        access_token.clone_from(&tokens.access_token);
        refresh_token.clone_from(&tokens.refresh_token);
        *account_id = Some(current_account_id);
    }

    // Codex refreshes the active account itself, so a renewed plan or
    // subscription only reaches the store through these tokens. Without this
    // the active account kept the expiry from its last switcher refresh and
    // read as expired after renewing.
    let claims = parse_chatgpt_id_token_claims(&tokens.id_token);
    if let Some(plan_type) = claims.plan_type {
        if account.plan_type.as_ref() != Some(&plan_type) {
            account.plan_type = Some(plan_type);
            changed = true;
        }
    }
    if let Some(expires_at) = claims.subscription_expires_at {
        if account.subscription_expires_at != Some(expires_at) {
            account.subscription_expires_at = Some(expires_at);
            changed = true;
        }
    }
    changed
}

/// Get the path to the codex-switcher config directory
pub fn get_config_dir() -> Result<PathBuf> {
    #[cfg(test)]
    {
        Ok(super::test_support::home_dir()?.join(".codex-switcher"))
    }

    #[cfg(not(test))]
    {
        let home = dirs::home_dir().context("Could not find home directory")?;
        Ok(home.join(".codex-switcher"))
    }
}

/// Get the path to accounts.json
pub fn get_accounts_file() -> Result<PathBuf> {
    Ok(get_config_dir()?.join("accounts.json"))
}

pub fn get_settings_file() -> Result<PathBuf> {
    Ok(get_config_dir()?.join("settings.json"))
}

/// Load the accounts store from disk
pub fn load_accounts() -> Result<AccountsStore> {
    let path = get_accounts_file()?;

    if !path.exists() {
        return Ok(AccountsStore::default());
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read accounts file: {}", path.display()))?;

    let store: AccountsStore = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse accounts file: {}", path.display()))?;

    Ok(store)
}

pub fn load_app_settings() -> Result<AppSettings> {
    let path = get_settings_file()?;

    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read settings file: {}", path.display()))?;

    let settings: AppSettings = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse settings file: {}", path.display()))?;

    Ok(settings)
}

pub fn save_app_settings(settings: &AppSettings) -> Result<()> {
    let path = get_settings_file()?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create config directory: {}", parent.display()))?;
    }

    let content = serde_json::to_string_pretty(settings).context("Failed to serialize settings")?;
    fs::write(&path, content)
        .with_context(|| format!("Failed to write settings file: {}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&path, perms)?;
    }

    Ok(())
}

/// Save the accounts store to disk
pub fn save_accounts(store: &AccountsStore) -> Result<()> {
    let path = get_accounts_file()?;

    // Ensure the config directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create config directory: {}", parent.display()))?;
    }

    let content =
        serde_json::to_string_pretty(store).context("Failed to serialize accounts store")?;

    fs::write(&path, content)
        .with_context(|| format!("Failed to write accounts file: {}", path.display()))?;

    // Set restrictive permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&path, perms)?;
    }

    Ok(())
}

/// Add a new account to the store
pub fn add_account(account: StoredAccount) -> Result<StoredAccount> {
    let mut store = load_accounts()?;

    let stored = add_account_to_store(&mut store, account)?;
    save_accounts(&store)?;
    Ok(stored)
}

fn add_account_to_store(
    store: &mut AccountsStore,
    account: StoredAccount,
) -> Result<StoredAccount> {
    // Check for duplicate names
    if store.accounts.iter().any(|a| a.name == account.name) {
        anyhow::bail!("An account with name '{}' already exists", account.name);
    }

    let account_clone = account.clone();
    store.accounts.push(account);
    Ok(account_clone)
}

/// Remove an account by ID
pub fn remove_account(account_id: &str) -> Result<()> {
    let mut store = load_accounts()?;

    let initial_len = store.accounts.len();
    store.accounts.retain(|a| a.id != account_id);

    if store.accounts.len() == initial_len {
        anyhow::bail!("Account not found: {account_id}");
    }

    // If we removed the active account, clear it or set to first available
    if store.active_account_id.as_deref() == Some(account_id) {
        store.active_account_id = store.accounts.first().map(|a| a.id.clone());
    }

    save_accounts(&store)?;
    Ok(())
}

/// Update the active account ID
pub fn set_active_account(account_id: &str) -> Result<()> {
    let mut store = load_accounts()?;

    // Verify the account exists
    if !store.accounts.iter().any(|a| a.id == account_id) {
        anyhow::bail!("Account not found: {account_id}");
    }

    store.active_account_id = Some(account_id.to_string());
    save_accounts(&store)?;
    Ok(())
}

/// Get an account by ID
pub fn get_account(account_id: &str) -> Result<Option<StoredAccount>> {
    let store = load_accounts()?;
    Ok(store.accounts.into_iter().find(|a| a.id == account_id))
}

/// Get the currently active account
pub fn get_active_account() -> Result<Option<StoredAccount>> {
    let store = load_accounts()?;
    let active_id = match &store.active_account_id {
        Some(id) => id,
        None => return Ok(None),
    };
    Ok(store.accounts.into_iter().find(|a| a.id == *active_id))
}

/// Update an account's last_used_at timestamp
pub fn touch_account(account_id: &str) -> Result<()> {
    let mut store = load_accounts()?;

    if let Some(account) = store.accounts.iter_mut().find(|a| a.id == account_id) {
        account.last_used_at = Some(chrono::Utc::now());
        save_accounts(&store)?;
    }

    Ok(())
}

/// Update an account's metadata (name, email, plan_type, subscription expiry)
pub fn update_account_metadata(
    account_id: &str,
    name: Option<String>,
    email: Option<String>,
    plan_type: Option<String>,
    subscription_expires_at: Option<Option<DateTime<Utc>>>,
) -> Result<StoredAccount> {
    let mut store = load_accounts()?;

    // Check for duplicate names first (if renaming)
    if let Some(ref new_name) = name {
        if store
            .accounts
            .iter()
            .any(|a| a.id != account_id && a.name == *new_name)
        {
            anyhow::bail!("An account with name '{new_name}' already exists");
        }
    }

    // Now find and update the account
    let account = store
        .accounts
        .iter_mut()
        .find(|a| a.id == account_id)
        .context("Account not found")?;

    let mut changed = false;

    if let Some(new_name) = name {
        if account.name != new_name {
            account.name = new_name;
            changed = true;
        }
    }

    if let Some(new_email) = email {
        if account.email.as_ref() != Some(&new_email) {
            account.email = Some(new_email);
            changed = true;
        }
    }

    if let Some(new_plan_type) = plan_type {
        if account.plan_type.as_ref() != Some(&new_plan_type) {
            account.plan_type = Some(new_plan_type);
            changed = true;
        }
    }

    if let Some(subscription_expires_at) = subscription_expires_at {
        if account.subscription_expires_at != subscription_expires_at {
            account.subscription_expires_at = subscription_expires_at;
            changed = true;
        }
    }

    let updated = account.clone();
    if changed {
        save_accounts(&store)?;
        println!("[Account] Saved updated metadata for: {}", updated.name);
    }
    Ok(updated)
}

/// Update ChatGPT OAuth tokens for an account and return the updated account.
pub fn update_account_chatgpt_tokens(
    account_id: &str,
    id_token: String,
    access_token: String,
    refresh_token: String,
    chatgpt_account_id: Option<String>,
    email: Option<String>,
    plan_type: Option<String>,
    subscription_expires_at: Option<DateTime<Utc>>,
) -> Result<StoredAccount> {
    let mut store = load_accounts()?;

    let account = store
        .accounts
        .iter_mut()
        .find(|a| a.id == account_id)
        .context("Account not found")?;

    match &mut account.auth_data {
        AuthData::ChatGPT {
            id_token: stored_id_token,
            access_token: stored_access_token,
            refresh_token: stored_refresh_token,
            account_id: stored_account_id,
        } => {
            *stored_id_token = id_token;
            *stored_access_token = access_token;
            *stored_refresh_token = refresh_token;
            if let Some(new_account_id) = chatgpt_account_id {
                *stored_account_id = Some(new_account_id);
            }
        }
        AuthData::ApiKey { .. } => {
            anyhow::bail!("Cannot update OAuth tokens for an API key account");
        }
    }

    if let Some(new_email) = email {
        account.email = Some(new_email);
    }

    if let Some(new_plan_type) = plan_type {
        account.plan_type = Some(new_plan_type);
    }

    if let Some(subscription_expires_at) = subscription_expires_at {
        account.subscription_expires_at = Some(subscription_expires_at);
    }

    let updated = account.clone();
    save_accounts(&store)?;
    Ok(updated)
}

/// Get the list of masked account IDs
pub fn get_masked_account_ids() -> Result<Vec<String>> {
    let store = load_accounts()?;
    Ok(store.masked_account_ids.clone())
}

/// Set the list of masked account IDs
pub fn set_masked_account_ids(ids: Vec<String>) -> Result<()> {
    let mut store = load_accounts()?;
    store.masked_account_ids = ids;
    save_accounts(&store)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        add_account_to_store, live_auth_may_hold_account, reconcile_active_account_with_live_auth,
        sync_active_account_tokens,
    };
    use crate::types::{AccountsStore, AuthData, AuthDotJson, StoredAccount, TokenData};
    use base64::Engine;

    fn account(name: &str, account_id: &str, suffix: &str) -> StoredAccount {
        StoredAccount::new_chatgpt(
            name.into(),
            None,
            None,
            None,
            format!("id-{suffix}"),
            format!("access-{suffix}"),
            format!("refresh-{suffix}"),
            Some(account_id.into()),
        )
    }

    fn auth(account_id: &str, suffix: &str) -> AuthDotJson {
        AuthDotJson {
            openai_api_key: None,
            tokens: Some(TokenData {
                id_token: format!("id-{suffix}"),
                access_token: format!("access-{suffix}"),
                refresh_token: format!("refresh-{suffix}"),
                account_id: Some(account_id.into()),
            }),
            last_refresh: None,
        }
    }

    fn refresh_token(account: &StoredAccount) -> &str {
        match &account.auth_data {
            AuthData::ChatGPT { refresh_token, .. } => refresh_token,
            AuthData::ApiKey { .. } => panic!("expected ChatGPT account"),
        }
    }

    fn id_token_with_account_id(account_id: &str, suffix: &str) -> String {
        let payload =
            format!(r#"{{"https://api.openai.com/auth":{{"chatgpt_account_id":"{account_id}"}}}}"#);
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        format!("header.{encoded}.{suffix}")
    }

    fn id_token_with_member(account_id: &str, email: &str, suffix: &str) -> String {
        let payload = format!(
            r#"{{"email":"{email}","https://api.openai.com/auth":{{"chatgpt_account_id":"{account_id}"}}}}"#
        );
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        format!("header.{encoded}.{suffix}")
    }

    fn id_token_with_subscription(account_id: &str, active_until: &str, suffix: &str) -> String {
        let payload = format!(
            r#"{{"https://api.openai.com/auth":{{"chatgpt_account_id":"{account_id}","chatgpt_plan_type":"pro","chatgpt_subscription_active_until":"{active_until}"}}}}"#
        );
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        format!("header.{encoded}.{suffix}")
    }

    fn team_member(email: &str, suffix: &str) -> StoredAccount {
        let mut member = account(email, "workspace-team", suffix);
        if let AuthData::ChatGPT { id_token, .. } = &mut member.auth_data {
            *id_token = id_token_with_member("workspace-team", email, suffix);
        }
        member
    }

    fn team_auth(email: &str, suffix: &str) -> AuthDotJson {
        let mut live = auth("workspace-team", suffix);
        live.tokens.as_mut().unwrap().id_token =
            id_token_with_member("workspace-team", &email.to_uppercase(), suffix);
        live
    }

    fn active_refresh_token(store: &AccountsStore) -> &str {
        let active_id = store.active_account_id.as_deref().unwrap();
        refresh_token(store.accounts.iter().find(|a| a.id == active_id).unwrap())
    }

    #[test]
    fn adding_account_does_not_change_the_active_account() {
        let active = StoredAccount::new_api_key("A".into(), "sk-a".into());
        let active_id = active.id.clone();
        let stores = [
            AccountsStore::default(),
            AccountsStore {
                accounts: vec![active],
                active_account_id: Some(active_id),
                ..AccountsStore::default()
            },
        ];

        for mut store in stores {
            let expected_active_id = store.active_account_id.clone();

            add_account_to_store(
                &mut store,
                StoredAccount::new_api_key("B".into(), "sk-b".into()),
            )
            .unwrap();

            assert_eq!(store.active_account_id, expected_active_id);
        }
    }

    #[test]
    fn preserves_rotated_tokens_before_switching_away_and_back() {
        let account_a = account("A", "workspace-a", "a1");
        let account_a_id = account_a.id.clone();
        let account_b = account("B", "workspace-b", "b1");
        let account_b_id = account_b.id.clone();
        let mut store = AccountsStore {
            accounts: vec![account_a, account_b],
            active_account_id: Some(account_a_id.clone()),
            ..AccountsStore::default()
        };

        assert!(!sync_active_account_tokens(
            &mut store,
            &auth("workspace-b", "wrong-account")
        ));
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-a1");

        let mut auth_without_top_level_id = auth("workspace-b", "missing-id");
        let tokens = auth_without_top_level_id.tokens.as_mut().unwrap();
        tokens.id_token = id_token_with_account_id("workspace-b", "signature");
        tokens.account_id = None;
        assert!(!sync_active_account_tokens(
            &mut store,
            &auth_without_top_level_id
        ));
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-a1");

        let mut auth_without_identity = auth("workspace-a", "unknown");
        auth_without_identity.tokens.as_mut().unwrap().account_id = None;
        assert!(!sync_active_account_tokens(
            &mut store,
            &auth_without_identity
        ));
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-a1");

        assert!(sync_active_account_tokens(
            &mut store,
            &auth("workspace-a", "a2")
        ));
        store.active_account_id = Some(account_b_id);

        let restored_a = store
            .accounts
            .iter()
            .find(|account| account.id == account_a_id)
            .unwrap();
        let AuthData::ChatGPT { refresh_token, .. } = &restored_a.auth_data else {
            panic!("expected ChatGPT account");
        };
        assert_eq!(refresh_token, "refresh-a2");
    }

    #[test]
    fn live_tokens_carry_a_renewed_subscription_into_the_active_account() {
        let mut stale = account("A", "workspace-a", "a1");
        stale.plan_type = Some("plus".into());
        stale.subscription_expires_at = Some("2026-09-05T14:34:47Z".parse().unwrap());
        let account_id = stale.id.clone();
        let mut store = AccountsStore {
            accounts: vec![stale],
            active_account_id: Some(account_id),
            ..AccountsStore::default()
        };
        let renewed: chrono::DateTime<chrono::Utc> = "2026-11-30T19:55:27Z".parse().unwrap();
        let mut live = auth("workspace-a", "a2");
        live.tokens.as_mut().unwrap().id_token =
            id_token_with_subscription("workspace-a", "2026-11-30T19:55:27+00:00", "a2");

        assert!(sync_active_account_tokens(&mut store, &live));
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-a2");
        assert_eq!(store.accounts[0].plan_type.as_deref(), Some("pro"));
        assert_eq!(store.accounts[0].subscription_expires_at, Some(renewed));

        // Tokens synced before the fix leave a stale expiry behind; the same
        // live tokens repair it once and then report nothing to save.
        store.accounts[0].subscription_expires_at = Some("2026-09-05T14:34:47Z".parse().unwrap());
        assert!(sync_active_account_tokens(&mut store, &live));
        assert_eq!(store.accounts[0].subscription_expires_at, Some(renewed));
        assert!(!sync_active_account_tokens(&mut store, &live));

        // An ID token without the claim keeps the stored expiry.
        assert!(sync_active_account_tokens(
            &mut store,
            &auth("workspace-a", "a3")
        ));
        assert_eq!(store.accounts[0].subscription_expires_at, Some(renewed));
        assert_eq!(store.accounts[0].plan_type.as_deref(), Some("pro"));
    }

    #[test]
    fn rejects_live_tokens_when_stored_account_identity_is_unknown() {
        let mut account = account("A", "workspace-a", "a1");
        let account_id = account.id.clone();
        let AuthData::ChatGPT {
            id_token,
            account_id: chatgpt_account_id,
            ..
        } = &mut account.auth_data
        else {
            panic!("expected ChatGPT account");
        };
        *id_token = "opaque-id-token".into();
        *chatgpt_account_id = None;

        let mut store = AccountsStore {
            accounts: vec![account],
            active_account_id: Some(account_id),
            ..AccountsStore::default()
        };

        assert!(!sync_active_account_tokens(
            &mut store,
            &auth("workspace-a", "a2")
        ));
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-a1");
    }

    #[test]
    fn derives_stored_identity_from_id_token_and_backfills_account_id() {
        let mut account = account("A", "workspace-a", "a1");
        let account_id = account.id.clone();
        let AuthData::ChatGPT {
            id_token,
            account_id: chatgpt_account_id,
            ..
        } = &mut account.auth_data
        else {
            panic!("expected ChatGPT account");
        };
        *id_token = id_token_with_account_id("workspace-a", "stored");
        *chatgpt_account_id = None;

        let mut store = AccountsStore {
            accounts: vec![account],
            active_account_id: Some(account_id),
            ..AccountsStore::default()
        };

        assert!(sync_active_account_tokens(
            &mut store,
            &auth("workspace-a", "a2")
        ));
        let AuthData::ChatGPT { account_id, .. } = &store.accounts[0].auth_data else {
            panic!("expected ChatGPT account");
        };
        assert_eq!(account_id.as_deref(), Some("workspace-a"));
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-a2");
    }

    #[test]
    fn adopts_the_stored_account_codex_signed_in_to_outside_the_switcher() {
        let account_a = account("A", "workspace-a", "a1");
        let account_b = account("B", "workspace-b", "b1");
        let account_b_id = account_b.id.clone();
        let mut store = AccountsStore {
            accounts: vec![account_a.clone(), account_b],
            active_account_id: Some(account_a.id.clone()),
            ..AccountsStore::default()
        };

        assert!(reconcile_active_account_with_live_auth(
            &mut store,
            &auth("workspace-b", "b2")
        ));
        assert_eq!(
            store.active_account_id.as_deref(),
            Some(account_b_id.as_str())
        );
        assert_eq!(active_refresh_token(&store), "refresh-b2");
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-a1");

        // Already reconciled: nothing further to change.
        assert!(!reconcile_active_account_with_live_auth(
            &mut store,
            &auth("workspace-b", "b2")
        ));
    }

    #[test]
    fn adopts_from_no_active_account() {
        let account_a = account("A", "workspace-a", "a1");
        let account_a_id = account_a.id.clone();
        let mut store = AccountsStore {
            accounts: vec![account_a],
            ..AccountsStore::default()
        };

        assert!(reconcile_active_account_with_live_auth(
            &mut store,
            &auth("workspace-a", "a2")
        ));
        assert_eq!(
            store.active_account_id.as_deref(),
            Some(account_a_id.as_str())
        );
        assert_eq!(active_refresh_token(&store), "refresh-a2");
    }

    #[test]
    fn leaves_active_account_for_unknown_ambiguous_or_api_key_logins() {
        let account_a = account("A", "workspace-a", "a1");
        let account_a_id = account_a.id.clone();
        let mut store = AccountsStore {
            accounts: vec![
                account_a,
                account("Shared 1", "workspace-shared", "s1"),
                account("Shared 2", "workspace-shared", "s2"),
            ],
            active_account_id: Some(account_a_id.clone()),
            ..AccountsStore::default()
        };
        let api_key_login = AuthDotJson {
            openai_api_key: Some("sk-test".into()),
            tokens: None,
            last_refresh: None,
        };

        for live in [
            auth("workspace-unknown", "u1"),
            auth("workspace-shared", "s3"),
            api_key_login,
        ] {
            assert!(!reconcile_active_account_with_live_auth(&mut store, &live));
            assert_eq!(
                store.active_account_id.as_deref(),
                Some(account_a_id.as_str())
            );
            assert_eq!(active_refresh_token(&store), "refresh-a1");
        }
    }

    #[test]
    fn team_members_sharing_a_workspace_are_told_apart_by_email() {
        let first = team_member("first@example.com", "f1");
        let second = team_member("second@example.com", "s1");
        let second_id = second.id.clone();
        let mut store = AccountsStore {
            accounts: vec![first.clone(), second],
            active_account_id: Some(first.id.clone()),
            ..AccountsStore::default()
        };

        assert!(!sync_active_account_tokens(
            &mut store,
            &team_auth("second@example.com", "s2")
        ));
        assert_eq!(active_refresh_token(&store), "refresh-f1");

        assert!(reconcile_active_account_with_live_auth(
            &mut store,
            &team_auth("second@example.com", "s2")
        ));
        assert_eq!(store.active_account_id.as_deref(), Some(second_id.as_str()));
        assert_eq!(active_refresh_token(&store), "refresh-s2");
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-f1");
    }

    #[test]
    fn live_auth_ownership_is_cautious_only_when_identity_is_unknown() {
        let account_a = account("A", "workspace-a", "a1");
        let mut unknown = auth("workspace-a", "unknown");
        unknown.tokens.as_mut().unwrap().account_id = None;
        let api_key_login = AuthDotJson {
            openai_api_key: Some("sk-test".into()),
            tokens: None,
            last_refresh: None,
        };

        assert!(live_auth_may_hold_account(
            &account_a,
            &auth("workspace-a", "a2")
        ));
        assert!(live_auth_may_hold_account(&account_a, &unknown));
        assert!(!live_auth_may_hold_account(
            &account_a,
            &auth("workspace-b", "b1")
        ));
        assert!(!live_auth_may_hold_account(&account_a, &api_key_login));
    }
}
