//! ChatGPT OAuth token refresh helpers

use anyhow::{Context, Result};
use base64::Engine;
use chrono::Utc;
use tokio::time::{sleep, Duration};

use super::{
    live_auth_may_hold_account, load_accounts, read_current_auth,
    reconcile_active_account_with_live_auth, save_accounts, switch_to_account,
    update_account_chatgpt_tokens, AUTH_OPERATION_LOCK,
};
use crate::types::{
    parse_chatgpt_id_token_claims, AccountsStore, AuthData, AuthDotJson, StoredAccount,
};

const DEFAULT_ISSUER: &str = "https://auth.openai.com";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const EXPIRY_SKEW_SECONDS: i64 = 60;

#[derive(Debug, serde::Deserialize)]
struct RefreshTokenResponse {
    #[serde(default)]
    id_token: Option<String>,
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Debug)]
struct TokenRefreshUpdate {
    id_token: String,
    access_token: String,
    refresh_token: String,
    id_token_error: Option<anyhow::Error>,
}

/// Ensure the account has non-expired ChatGPT OAuth tokens.
/// Returns an updated account when a refresh was performed.
pub async fn ensure_chatgpt_tokens_fresh(account: &StoredAccount) -> Result<StoredAccount> {
    if !chatgpt_tokens_need_refresh(account) {
        return Ok(account.clone());
    }

    let _auth_guard = AUTH_OPERATION_LOCK.lock().await;
    ensure_chatgpt_tokens_fresh_locked(account).await
}

/// Ensure ChatGPT OAuth tokens are fresh while the caller holds AUTH_OPERATION_LOCK.
pub(crate) async fn ensure_chatgpt_tokens_fresh_locked(
    account: &StoredAccount,
) -> Result<StoredAccount> {
    if matches!(account.auth_data, AuthData::ApiKey { .. }) {
        return Ok(account.clone());
    }

    // Codex may have refreshed the active account while this task waited for
    // the lock. Prefer those live credentials over rotating the stored token.
    let (current, _) = load_account_reconciling_live_auth(&account.id)?;

    match &current.auth_data {
        AuthData::ApiKey { .. } => Ok(current.clone()),
        AuthData::ChatGPT {
            id_token,
            access_token,
            ..
        } => {
            if chatgpt_tokens_need_refresh_at(id_token, access_token, Utc::now().timestamp()) {
                refresh_chatgpt_tokens_locked(&current).await
            } else {
                Ok(current)
            }
        }
    }
}

/// Force-refresh ChatGPT OAuth tokens for an account.
pub async fn refresh_chatgpt_tokens(account: &StoredAccount) -> Result<StoredAccount> {
    if matches!(account.auth_data, AuthData::ApiKey { .. }) {
        return Ok(account.clone());
    }

    let _auth_guard = AUTH_OPERATION_LOCK.lock().await;
    refresh_chatgpt_tokens_locked(account).await
}

async fn refresh_chatgpt_tokens_locked(account: &StoredAccount) -> Result<StoredAccount> {
    let (current, is_active) = load_account_reconciling_live_auth(&account.id)?;

    if is_active && crate::commands::process::ensure_codex_not_running().is_err() {
        return Ok(current);
    }

    let (current_id_token, current_refresh_token, current_account_id) = match &current.auth_data {
        AuthData::ChatGPT {
            id_token,
            refresh_token,
            account_id,
            ..
        } => (id_token.clone(), refresh_token.clone(), account_id.clone()),
        AuthData::ApiKey { .. } => return Ok(current),
    };

    if current_refresh_token.is_empty() {
        anyhow::bail!("Missing refresh token for account {}", current.name);
    }

    let refreshed = refresh_tokens_with_refresh_token(&current_refresh_token).await?;
    let next = merge_refresh_response(
        current_id_token,
        current_refresh_token,
        refreshed,
        Utc::now().timestamp(),
    );

    let claims = parse_chatgpt_id_token_claims(&next.id_token);
    let next_account_id = claims.account_id.or(current_account_id);

    let updated = update_account_chatgpt_tokens(
        &account.id,
        next.id_token,
        next.access_token,
        next.refresh_token,
        next_account_id,
        claims.email,
        claims.plan_type,
        claims.subscription_expires_at,
    )?;
    println!("[Auth] Refreshed OAuth tokens for: {}", updated.name);

    // Refresh tokens can be single-use. Persist a rotated replacement before
    // reporting an unusable ID token, so a later retry can still recover.
    if let Some(error) = next.id_token_error {
        return Err(error);
    }

    // Re-read active state after the network request before touching auth.json.
    let store = load_accounts()?;
    if codex_uses_account(&store, &updated, read_current_auth()?.as_ref()) {
        if let Err(err) = switch_to_account(&updated) {
            println!("[Auth] Failed to sync active auth.json after token refresh: {err}");
        }
    }

    Ok(updated)
}

/// Codex owns an account's tokens only while it is the active account and
/// auth.json, if present, still holds it. Otherwise a refresh cannot race
/// Codex, and auth.json belongs to a login made outside the switcher.
fn codex_uses_account(
    store: &AccountsStore,
    account: &StoredAccount,
    live_auth: Option<&AuthDotJson>,
) -> bool {
    store.active_account_id.as_deref() == Some(account.id.as_str())
        && live_auth.is_none_or(|auth| live_auth_may_hold_account(account, auth))
}

fn load_account_reconciling_live_auth(account_id: &str) -> Result<(StoredAccount, bool)> {
    let mut store = load_accounts()?;
    let live_auth = read_current_auth()?;

    if let Some(auth) = &live_auth {
        if reconcile_active_account_with_live_auth(&mut store, auth) {
            save_accounts(&store)?;
        }
    }

    let account = store
        .accounts
        .iter()
        .find(|stored| stored.id == account_id)
        .cloned()
        .context("Account not found")?;
    let is_active = codex_uses_account(&store, &account, live_auth.as_ref());
    Ok((account, is_active))
}

/// Build a new ChatGPT account from a refresh token.
/// This is used by slim import to recreate full credentials.
pub async fn create_chatgpt_account_from_refresh_token(
    account_name: String,
    refresh_token: String,
) -> Result<StoredAccount> {
    if refresh_token.trim().is_empty() {
        anyhow::bail!("Missing refresh token for account {account_name}");
    }

    let refreshed = refresh_tokens_with_refresh_token(&refresh_token).await?;
    let id_token = refreshed
        .id_token
        .context("Refresh response did not include id_token")?;
    let next_refresh_token = refreshed.refresh_token.unwrap_or(refresh_token);
    let claims = parse_chatgpt_id_token_claims(&id_token);

    Ok(StoredAccount::new_chatgpt(
        account_name,
        claims.email,
        claims.plan_type,
        claims.subscription_expires_at,
        id_token,
        refreshed.access_token,
        next_refresh_token,
        claims.account_id,
    ))
}

fn chatgpt_tokens_need_refresh(account: &StoredAccount) -> bool {
    match &account.auth_data {
        AuthData::ApiKey { .. } => false,
        AuthData::ChatGPT {
            id_token,
            access_token,
            ..
        } => chatgpt_tokens_need_refresh_at(id_token, access_token, Utc::now().timestamp()),
    }
}

fn chatgpt_tokens_need_refresh_at(id_token: &str, access_token: &str, now: i64) -> bool {
    id_token_needs_refresh_at(id_token, now) || token_expired_or_near_expiry_at(access_token, now)
}

fn id_token_needs_refresh_at(token: &str, now: i64) -> bool {
    match parse_jwt_exp(token) {
        Some(expiry) => expiry <= now + EXPIRY_SKEW_SECONDS,
        None => true,
    }
}

fn token_expired_or_near_expiry_at(token: &str, now: i64) -> bool {
    match parse_jwt_exp(token) {
        Some(expiry) => expiry <= now + EXPIRY_SKEW_SECONDS,
        None => false,
    }
}

fn resolve_refreshed_id_token(
    current_id_token: String,
    refreshed_id_token: Option<String>,
    now: i64,
) -> Result<String> {
    match refreshed_id_token {
        Some(id_token) if id_token_needs_refresh_at(&id_token, now) => {
            anyhow::bail!("Token refresh returned an invalid or expired id_token")
        }
        Some(id_token) => Ok(id_token),
        None if id_token_needs_refresh_at(&current_id_token, now) => {
            anyhow::bail!(
                "Token refresh did not return a fresh id_token; sign in to the account again"
            )
        }
        None => Ok(current_id_token),
    }
}

fn merge_refresh_response(
    current_id_token: String,
    current_refresh_token: String,
    refreshed: RefreshTokenResponse,
    now: i64,
) -> TokenRefreshUpdate {
    let (id_token, id_token_error) =
        match resolve_refreshed_id_token(current_id_token.clone(), refreshed.id_token, now) {
            Ok(id_token) => (id_token, None),
            Err(error) => (current_id_token, Some(error)),
        };

    TokenRefreshUpdate {
        id_token,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token.unwrap_or(current_refresh_token),
        id_token_error,
    }
}

fn parse_jwt_exp(token: &str) -> Option<i64> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }

    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    json.get("exp").and_then(|v| v.as_i64())
}

async fn refresh_tokens_with_refresh_token(refresh_token: &str) -> Result<RefreshTokenResponse> {
    let client = reqwest::Client::new();
    let body = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}",
        urlencoding::encode(refresh_token),
        urlencoding::encode(CLIENT_ID),
    );

    let mut last_send_error = None;
    let mut response = None;

    for attempt in 1..=3u8 {
        match client
            .post(format!("{DEFAULT_ISSUER}/oauth/token"))
            .timeout(Duration::from_secs(10))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body.clone())
            .send()
            .await
        {
            Ok(resp) => {
                response = Some(resp);
                break;
            }
            Err(err) => {
                last_send_error = Some(err);
                if attempt < 3 {
                    sleep(Duration::from_millis(250 * u64::from(attempt))).await;
                }
            }
        }
    }

    let response = match response {
        Some(resp) => resp,
        None => {
            let err = last_send_error.context("Failed to send token refresh request")?;
            return Err(err.into());
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Token refresh failed: {status} - {body}");
    }

    response
        .json::<RefreshTokenResponse>()
        .await
        .context("Failed to parse token refresh response")
}

#[cfg(test)]
mod tests {
    use super::{
        chatgpt_tokens_need_refresh, chatgpt_tokens_need_refresh_at, codex_uses_account,
        load_account_reconciling_live_auth, merge_refresh_response, resolve_refreshed_id_token,
        RefreshTokenResponse,
    };
    use crate::auth::test_support::TestHome;
    use crate::auth::{
        load_accounts, reconcile_active_account_with_live_auth, save_accounts, switch_to_account,
    };
    use crate::types::{AccountsStore, AuthData, AuthDotJson, StoredAccount, TokenData};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    fn jwt_with_exp(exp: i64) -> String {
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        format!("header.{payload}.signature")
    }

    fn account_jwt(account_id: &str, exp: i64, signature: &str) -> String {
        let payload = URL_SAFE_NO_PAD.encode(format!(
            r#"{{"exp":{exp},"https://api.openai.com/auth":{{"chatgpt_account_id":"{account_id}"}}}}"#
        ));
        format!("header.{payload}.{signature}")
    }

    #[test]
    fn refresh_required_when_id_token_expired_but_access_token_valid() {
        let now = 1_800_000_000;
        let id_token = jwt_with_exp(now - 3_600);
        let access_token = jwt_with_exp(now + 3_600);

        assert!(chatgpt_tokens_need_refresh_at(
            &id_token,
            &access_token,
            now
        ));
    }

    #[test]
    fn refresh_not_required_when_both_tokens_are_valid() {
        let now = 1_800_000_000;
        let id_token = jwt_with_exp(now + 3_600);
        let access_token = jwt_with_exp(now + 3_600);

        assert!(!chatgpt_tokens_need_refresh_at(
            &id_token,
            &access_token,
            now
        ));
    }

    #[test]
    fn refresh_required_when_access_token_expired() {
        let now = 1_800_000_000;
        let id_token = jwt_with_exp(now + 3_600);
        let access_token = jwt_with_exp(now - 3_600);

        assert!(chatgpt_tokens_need_refresh_at(
            &id_token,
            &access_token,
            now
        ));
    }

    #[test]
    fn expired_id_token_requires_replacement_from_refresh_response() {
        let now = 1_800_000_000;
        let current_id_token = jwt_with_exp(now - 3_600);

        let error = resolve_refreshed_id_token(current_id_token, None, now).unwrap_err();

        assert!(error
            .to_string()
            .contains("did not return a fresh id_token"));
    }

    #[test]
    fn valid_id_token_can_be_preserved_when_refresh_response_omits_it() {
        let now = 1_800_000_000;
        let current_id_token = jwt_with_exp(now + 3_600);

        let resolved = resolve_refreshed_id_token(current_id_token.clone(), None, now).unwrap();

        assert_eq!(resolved, current_id_token);
    }

    #[test]
    fn active_account_uses_fresh_tokens_from_live_auth() {
        let now = chrono::Utc::now().timestamp();
        let mut account = StoredAccount::new_chatgpt(
            "Active".into(),
            None,
            None,
            None,
            account_jwt("workspace-a", now - 3_600, "stored"),
            jwt_with_exp(now - 3_600),
            "stored-refresh".into(),
            Some("workspace-a".into()),
        );
        let local_id = account.id.clone();
        let mut store = AccountsStore {
            accounts: vec![account.clone()],
            active_account_id: Some(local_id.clone()),
            ..AccountsStore::default()
        };
        let auth = AuthDotJson {
            openai_api_key: None,
            tokens: Some(TokenData {
                id_token: account_jwt("workspace-a", now + 3_600, "live"),
                access_token: jwt_with_exp(now + 3_600),
                refresh_token: "live-refresh".into(),
                account_id: Some("workspace-a".into()),
            }),
            last_refresh: None,
        };

        assert!(chatgpt_tokens_need_refresh(&account));
        assert!(reconcile_active_account_with_live_auth(&mut store, &auth));

        account = store.accounts.remove(0);
        assert!(!chatgpt_tokens_need_refresh(&account));
        let AuthData::ChatGPT { refresh_token, .. } = account.auth_data else {
            panic!("expected ChatGPT account");
        };
        assert_eq!(refresh_token, "live-refresh");
    }

    fn chatgpt_account(name: &str, workspace: &str, now: i64) -> StoredAccount {
        StoredAccount::new_chatgpt(
            name.into(),
            None,
            None,
            None,
            account_jwt(workspace, now + 3_600, name),
            jwt_with_exp(now + 3_600),
            format!("{name}-refresh"),
            Some(workspace.into()),
        )
    }

    fn live_auth(workspace: &str, now: i64) -> AuthDotJson {
        AuthDotJson {
            openai_api_key: None,
            tokens: Some(TokenData {
                id_token: account_jwt(workspace, now + 3_600, "live"),
                access_token: jwt_with_exp(now + 3_600),
                refresh_token: "live-refresh".into(),
                account_id: Some(workspace.into()),
            }),
            last_refresh: None,
        }
    }

    #[test]
    fn codex_owns_active_account_only_while_auth_json_holds_it() {
        let now = chrono::Utc::now().timestamp();
        let active = chatgpt_account("Active", "workspace-a", now);
        let store = AccountsStore {
            accounts: vec![active.clone()],
            active_account_id: Some(active.id.clone()),
            ..AccountsStore::default()
        };

        assert!(codex_uses_account(&store, &active, None));
        assert!(codex_uses_account(
            &store,
            &active,
            Some(&live_auth("workspace-a", now))
        ));
        // Signed in elsewhere: refreshing cannot race Codex, and auth.json
        // must not be overwritten with this account.
        assert!(!codex_uses_account(
            &store,
            &active,
            Some(&live_auth("workspace-elsewhere", now))
        ));
    }

    #[test]
    fn refresh_adopts_the_account_codex_signed_in_to_outside_the_switcher() {
        let _home = TestHome::new();
        let now = chrono::Utc::now().timestamp();
        let revoked = chatgpt_account("Revoked", "workspace-a", now);
        let signed_in = chatgpt_account("SignedIn", "workspace-b", now);
        save_accounts(&AccountsStore {
            accounts: vec![revoked.clone(), signed_in.clone()],
            active_account_id: Some(revoked.id.clone()),
            ..AccountsStore::default()
        })
        .unwrap();
        let mut live = signed_in.clone();
        if let AuthData::ChatGPT { refresh_token, .. } = &mut live.auth_data {
            *refresh_token = "live-refresh".into();
        }
        switch_to_account(&live).unwrap();

        // The stale active account is no longer Codex's, so it may refresh.
        let (_, revoked_is_codex_owned) = load_account_reconciling_live_auth(&revoked.id).unwrap();
        assert!(!revoked_is_codex_owned);

        let store = load_accounts().unwrap();
        assert_eq!(
            store.active_account_id.as_deref(),
            Some(signed_in.id.as_str())
        );
        let AuthData::ChatGPT { refresh_token, .. } = &store.accounts[1].auth_data else {
            panic!("expected ChatGPT account");
        };
        assert_eq!(refresh_token, "live-refresh");
        let (_, signed_in_is_codex_owned) =
            load_account_reconciling_live_auth(&signed_in.id).unwrap();
        assert!(signed_in_is_codex_owned);
    }

    #[test]
    fn rotated_refresh_token_is_retained_when_id_token_is_missing() {
        let now = 1_800_000_000;
        let current_id_token = jwt_with_exp(now - 3_600);
        let refreshed = RefreshTokenResponse {
            id_token: None,
            access_token: "new-access".into(),
            refresh_token: Some("rotated-refresh".into()),
        };

        let update = merge_refresh_response(
            current_id_token.clone(),
            "old-refresh".into(),
            refreshed,
            now,
        );

        assert_eq!(update.id_token, current_id_token);
        assert_eq!(update.refresh_token, "rotated-refresh");
        assert!(update.id_token_error.is_some());
    }
}
