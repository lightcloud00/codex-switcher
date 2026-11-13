//! Gemini CLI quota, borrowed from CodexBar (docs/gemini.md).
//!
//! Uses the Gemini CLI's own local OAuth login (`~/.gemini/oauth_creds.json`) to ask Google's
//! quota API how much of each model tier is left. No browser cookies. The token is read in this
//! process for the request only: it is never logged, printed, returned to the UI or written back
//! (a refreshed access token is thrown away; the CLI refreshes its own file when it next runs).
//! Errors map to a few fixed phrases, so no response body, header or credential ever reaches the
//! screen. API-key and Vertex AI logins are reported as unsupported, not read.

use std::{
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const QUOTA_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const LOAD_CODE_ASSIST_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const OVERALL_TIMEOUT: Duration = Duration::from_secs(40);
const CACHE_TTL: Duration = Duration::from_secs(3 * 60);
/// A token this close to its expiry is refreshed first.
const EXPIRY_SKEW_MS: i64 = 60_000;
const MAX_BODY_BYTES: usize = 256 * 1024;
/// The CLI bundle is read only to find two public client constants; cap what is scanned.
const MAX_SCRIPT_BYTES: u64 = 48 * 1024 * 1024;
/// The scan reads this much at a time and keeps a short overlap so a constant cannot be cut in two.
const SCAN_CHUNK_BYTES: usize = 1024 * 1024;
const SCAN_OVERLAP_BYTES: usize = 600;
const MAX_SCRIPTS: usize = 400;

/// What the stored login file holds. No `Debug`: a stray `{:?}` must never print a token.
#[derive(Deserialize)]
struct StoredCreds {
    access_token: Option<String>,
    refresh_token: Option<String>,
    /// Milliseconds since the epoch.
    expiry_date: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Ok,
    /// No Gemini CLI login file on this computer.
    NotInstalled,
    /// API-key or Vertex AI login: no OAuth quota to read.
    UnsupportedAuth,
    /// Google refused the stored login: run `gemini` once to sign in again.
    SignInNeeded,
    /// The login needs a refresh and the CLI's client details could not be found.
    ClientNotFound,
    /// Offline, rate limited, or an answer this app does not understand.
    Unavailable,
}

impl State {
    fn message(self) -> &'static str {
        match self {
            State::Ok => "",
            State::NotInstalled => "Gemini CLI is not signed in on this computer.",
            State::UnsupportedAuth => {
                "Gemini CLI uses an API key or Vertex AI, which has no quota to show here."
            }
            State::SignInNeeded => "Gemini CLI sign-in expired. Run gemini once to sign in again.",
            State::ClientNotFound => {
                "Could not refresh the Gemini CLI login. Run gemini once, then refresh."
            }
            State::Unavailable => "Could not read Gemini quota right now.",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TierQuota {
    pub id: &'static str,
    pub label: &'static str,
    pub percent_left: f64,
    /// RFC 3339 reset time, when Google gave one.
    pub resets_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiQuota {
    pub state: State,
    pub message: &'static str,
    pub plan: Option<String>,
    pub tiers: Vec<TierQuota>,
    pub checked_at: String,
}

impl GeminiQuota {
    fn failed(state: State) -> Self {
        Self {
            state,
            message: state.message(),
            plan: None,
            tiers: Vec::new(),
            checked_at: Utc::now().to_rfc3339(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Pure parsing helpers (all covered by tests)
// ---------------------------------------------------------------------------------------------

fn parse_creds(text: &str) -> Option<StoredCreds> {
    serde_json::from_str(text).ok()
}

/// True while the access token is still usable (with a safety margin).
fn token_is_fresh(expiry_ms: Option<i64>, now_ms: i64) -> bool {
    expiry_ms.is_some_and(|expiry| expiry - EXPIRY_SKEW_MS > now_ms)
}

/// `security.auth.selectedType` of the CLI settings; only API-key and Vertex logins are unsupported.
fn auth_type_is_unsupported(settings_text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(settings_text) else {
        return false;
    };
    matches!(
        value["security"]["auth"]["selectedType"].as_str(),
        Some("gemini-api-key") | Some("vertex-ai")
    )
}

/// Finds `NAME = "value"` (or single quotes) in bundled JavaScript. The value is accepted only if
/// it looks like a plain OAuth client string, never arbitrary code.
fn extract_constant(js: &str, name: &str) -> Option<String> {
    let mut from = 0;
    while let Some(found) = js[from..].find(name) {
        let after = from + found + name.len();
        from = after;
        let rest = js[after..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            continue;
        };
        let body = &rest[1..];
        let Some(end) = body.find(quote) else {
            continue;
        };
        let value = &body[..end];
        let plain = !value.is_empty()
            && value.len() <= 200
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '~'));
        if plain {
            return Some(value.to_string());
        }
    }
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tier {
    Pro,
    Flash,
    FlashLite,
}

impl Tier {
    fn of_model(model_id: &str) -> Option<Self> {
        let m = model_id.to_ascii_lowercase();
        if m.contains("flash-lite") {
            Some(Tier::FlashLite)
        } else if m.contains("flash") {
            Some(Tier::Flash)
        } else if m.contains("pro") {
            Some(Tier::Pro)
        } else {
            None
        }
    }
    fn id(self) -> &'static str {
        match self {
            Tier::Pro => "pro",
            Tier::Flash => "flash",
            Tier::FlashLite => "flash_lite",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Tier::Pro => "Pro",
            Tier::Flash => "Flash",
            Tier::FlashLite => "Flash Lite",
        }
    }
}

/// Reads `buckets[]` (`modelId`, `remainingFraction`, `resetTime`): per tier, the lowest fraction
/// left across its models wins. Missing tiers stay absent; a reported zero stays zero.
fn parse_quota(body: &Value) -> Vec<TierQuota> {
    let mut lowest: Vec<(Tier, f64, Option<String>)> = Vec::new();
    for bucket in body["buckets"].as_array().into_iter().flatten() {
        let Some(tier) = bucket["modelId"].as_str().and_then(Tier::of_model) else {
            continue;
        };
        let Some(fraction) = bucket["remainingFraction"]
            .as_f64()
            .filter(|f| f.is_finite())
        else {
            continue;
        };
        let fraction = fraction.clamp(0.0, 1.0);
        let reset = bucket["resetTime"]
            .as_str()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.with_timezone(&Utc).to_rfc3339());
        match lowest.iter_mut().find(|(t, _, _)| *t == tier) {
            Some(entry) if fraction < entry.1 => *entry = (tier, fraction, reset),
            Some(_) => {}
            None => lowest.push((tier, fraction, reset)),
        }
    }
    [Tier::Pro, Tier::Flash, Tier::FlashLite]
        .into_iter()
        .filter_map(|tier| {
            lowest
                .iter()
                .find(|(t, _, _)| *t == tier)
                .map(|(_, fraction, reset)| TierQuota {
                    id: tier.id(),
                    label: tier.label(),
                    percent_left: (fraction * 1000.0).round() / 10.0,
                    resets_at: reset.clone(),
                })
        })
        .collect()
}

/// The paid plan name Google reports, else a label for the tier id. The CLI's `hd` (Workspace)
/// claim lives in the id token, which this module never reads, so free stays "Free".
fn parse_plan(load: &Value) -> Option<String> {
    let clean = |s: &str| {
        let s: String = s.chars().filter(|c| !c.is_control()).collect();
        let s = s.trim().to_string();
        (!s.is_empty() && s.chars().count() <= 40).then_some(s)
    };
    if let Some(name) = load["paidTier"]["name"].as_str().and_then(clean) {
        return Some(name);
    }
    match load["currentTier"]["id"].as_str()? {
        "standard-tier" => Some("Paid".to_string()),
        "free-tier" => Some("Free".to_string()),
        "legacy-tier" => Some("Legacy".to_string()),
        _ => None,
    }
}

/// `cloudaicompanionProject` is either a string or an object with an `id`.
fn parse_project_id(load: &Value) -> Option<String> {
    let project = &load["cloudaicompanionProject"];
    project
        .as_str()
        .or_else(|| project["id"].as_str())
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .map(str::to_string)
}

// ---------------------------------------------------------------------------------------------
// Finding the CLI's public OAuth client (needed only to refresh an expired access token)
// ---------------------------------------------------------------------------------------------

struct OAuthClient {
    id: String,
    secret: String,
}

fn candidate_scripts(binary: &Path) -> Vec<PathBuf> {
    let Ok(real) = std::fs::canonicalize(binary) else {
        return Vec::new();
    };
    let mut scripts = Vec::new();
    for dir in real.ancestors().skip(1).take(6) {
        let core = dir.join("node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js");
        if core.is_file() {
            scripts.push(core);
        }
        // `<dir>/bundle` is the package root itself (a symlinked bin, e.g. macOS and Linux);
        // `<dir>/node_modules/@google/gemini-cli/bundle` is a global install next to a bin shim
        // that is a real file (Windows `%APPDATA%\npm\gemini.cmd`).
        for bundle in [
            dir.join("bundle"),
            dir.join("node_modules/@google/gemini-cli/bundle"),
        ] {
            if let Ok(entries) = std::fs::read_dir(&bundle) {
                scripts.extend(
                    entries
                        .flatten()
                        .map(|e| e.path())
                        .filter(|p| p.extension().is_some_and(|x| x == "js")),
                );
            }
        }
        if scripts.len() >= MAX_SCRIPTS {
            break;
        }
    }
    scripts.truncate(MAX_SCRIPTS);
    scripts
}

/// Streams a script in bounded chunks looking for the two constants, so a 17 MB minified bundle
/// chunk is never held in memory whole (and a one-line file has no line-length problem).
fn scan_for_client(mut reader: impl std::io::Read) -> Option<OAuthClient> {
    let mut id = None;
    let mut secret = None;
    let mut carry: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; SCAN_CHUNK_BYTES];
    loop {
        let read = reader.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        carry.extend_from_slice(&chunk[..read]);
        let window = String::from_utf8_lossy(&carry);
        id = id.or_else(|| extract_constant(&window, "OAUTH_CLIENT_ID"));
        secret = secret.or_else(|| extract_constant(&window, "OAUTH_CLIENT_SECRET"));
        if let (Some(id), Some(secret)) = (&id, &secret) {
            return Some(OAuthClient {
                id: id.clone(),
                secret: secret.clone(),
            });
        }
        let keep = carry.len().saturating_sub(SCAN_OVERLAP_BYTES);
        carry.drain(..keep);
    }
}

fn client_from_script(path: &Path) -> Option<OAuthClient> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_SCRIPT_BYTES {
        return None;
    }
    scan_for_client(std::fs::File::open(path).ok()?)
}

/// The constants never change for an installed CLI, so a found pair is kept for the session.
/// A miss is not cached, so installing or updating the CLI is picked up on the next try.
static FOUND_CLIENT: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();

/// Env override, then an `oauth2.js` path override, then the installed CLI package.
fn find_oauth_client() -> Option<OAuthClient> {
    if let (Ok(id), Ok(secret)) = (
        std::env::var("GEMINI_OAUTH_CLIENT_ID"),
        std::env::var("GEMINI_OAUTH_CLIENT_SECRET"),
    ) {
        if !id.is_empty() && !secret.is_empty() {
            return Some(OAuthClient { id, secret });
        }
    }
    if let Ok(path) = std::env::var("GEMINI_OAUTH2_JS_PATH") {
        if let Some(client) = client_from_script(Path::new(&path)) {
            return Some(client);
        }
    }
    if let Some((id, secret)) = FOUND_CLIENT.get() {
        return Some(OAuthClient {
            id: id.clone(),
            secret: secret.clone(),
        });
    }
    let binary = super::provider_access::find_binary("gemini")?;
    let client = candidate_scripts(&binary)
        .iter()
        .find_map(|script| client_from_script(script))?;
    let _ = FOUND_CLIENT.set((client.id.clone(), client.secret.clone()));
    Some(client)
}

// ---------------------------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------------------------

fn http() -> Result<reqwest::Client, State> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("codex-switcher-gemini-quota")
        .build()
        .map_err(|_| State::Unavailable)
}

/// The state a refused token exchange means: `invalid_grant` is a lost sign-in, anything else is not.
fn refresh_error_state(body: &Value) -> State {
    if body["error"].as_str() == Some("invalid_grant") {
        State::SignInNeeded
    } else {
        State::Unavailable
    }
}

/// Like `read_json` but for an error status: size-capped, and never maps the status itself.
async fn read_body_json(response: reqwest::Response) -> Result<Value, State> {
    if response
        .content_length()
        .is_some_and(|len| len as usize > MAX_BODY_BYTES)
    {
        return Err(State::Unavailable);
    }
    let bytes = response.bytes().await.map_err(|_| State::Unavailable)?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(State::Unavailable);
    }
    serde_json::from_slice(&bytes).map_err(|_| State::Unavailable)
}

async fn read_json(response: reqwest::Response) -> Result<Value, State> {
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(State::SignInNeeded);
    }
    if !status.is_success() {
        return Err(State::Unavailable);
    }
    if response
        .content_length()
        .is_some_and(|len| len as usize > MAX_BODY_BYTES)
    {
        return Err(State::Unavailable);
    }
    let bytes = response.bytes().await.map_err(|_| State::Unavailable)?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(State::Unavailable);
    }
    serde_json::from_slice(&bytes).map_err(|_| State::Unavailable)
}

/// Exchanges the refresh token for a short-lived access token. The result is used once and dropped.
async fn refresh_access_token(
    client: &reqwest::Client,
    oauth: &OAuthClient,
    refresh_token: &str,
) -> Result<String, State> {
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", oauth.id.as_str()),
            ("client_secret", oauth.secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|_| State::Unavailable)?;
    // Only `invalid_grant` means the login itself is gone. Other 400/401 answers (invalid_client
    // from a stale or mismatched client id/secret) are not the user's sign-in.
    if matches!(response.status().as_u16(), 400 | 401) {
        let body = read_body_json(response).await.unwrap_or(Value::Null);
        return Err(refresh_error_state(&body));
    }
    let body = read_json(response).await?;
    body["access_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .ok_or(State::Unavailable)
}

async fn post_json(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    body: Value,
) -> Result<Value, State> {
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|_| State::Unavailable)?;
    read_json(response).await
}

async fn fetch_quota(home: &Path) -> GeminiQuota {
    let dir = home.join(".gemini");
    let Ok(creds_text) = std::fs::read_to_string(dir.join("oauth_creds.json")) else {
        return GeminiQuota::failed(State::NotInstalled);
    };
    if std::fs::read_to_string(dir.join("settings.json"))
        .is_ok_and(|text| auth_type_is_unsupported(&text))
    {
        return GeminiQuota::failed(State::UnsupportedAuth);
    }
    let Some(creds) = parse_creds(&creds_text) else {
        return GeminiQuota::failed(State::NotInstalled);
    };
    drop(creds_text);
    match run(creds).await {
        Ok(quota) => quota,
        Err(state) => GeminiQuota::failed(state),
    }
}

async fn run(creds: StoredCreds) -> Result<GeminiQuota, State> {
    let client = http()?;
    let now_ms = Utc::now().timestamp_millis();
    let refresh_token = creds.refresh_token.filter(|t| !t.is_empty());
    let stored = creds
        .access_token
        .filter(|t| !t.is_empty() && token_is_fresh(creds.expiry_date, now_ms));
    if let Some(token) = stored {
        match read_quota(&client, &token).await {
            // A stored token Google refuses (clock skew, revoked access token) gets one refresh
            // before the sign-in is called lost.
            Err(State::SignInNeeded) if refresh_token.is_some() => {}
            other => return other,
        }
    }
    let refresh = refresh_token.ok_or(State::SignInNeeded)?;
    // Reading the CLI's files is blocking work: keep it off the async workers.
    let oauth = tokio::task::spawn_blocking(find_oauth_client)
        .await
        .ok()
        .flatten()
        .ok_or(State::ClientNotFound)?;
    let token = refresh_access_token(&client, &oauth, &refresh).await?;
    read_quota(&client, &token).await
}

async fn read_quota(client: &reqwest::Client, token: &str) -> Result<GeminiQuota, State> {
    let load = post_json(
        client,
        LOAD_CODE_ASSIST_URL,
        token,
        json!({ "metadata": { "ideType": "GEMINI_CLI", "pluginType": "GEMINI" } }),
    )
    .await
    .unwrap_or(Value::Null);
    let body = match parse_project_id(&load) {
        Some(project) => json!({ "project": project }),
        None => json!({}),
    };
    let quota = post_json(client, QUOTA_URL, token, body).await?;
    let tiers = parse_quota(&quota);
    if tiers.is_empty() {
        return Err(State::Unavailable);
    }
    Ok(GeminiQuota {
        state: State::Ok,
        message: "",
        plan: parse_plan(&load),
        tiers,
        checked_at: Utc::now().to_rfc3339(),
    })
}

static CACHE: LazyLock<Mutex<Option<(Instant, GeminiQuota)>>> = LazyLock::new(|| Mutex::new(None));

fn cached() -> Option<GeminiQuota> {
    let cache = CACHE.lock().ok()?;
    cache
        .as_ref()
        .filter(|(at, _)| at.elapsed() <= CACHE_TTL)
        .map(|(_, quota)| quota.clone())
}

/// Desktop only (the LAN web route never reads local login files). `force` skips the 3-minute cache.
#[tauri::command]
pub async fn get_gemini_quota(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<GeminiQuota, String> {
    if force != Some(true) {
        if let Some(quota) = cached() {
            return Ok(quota);
        }
    }
    let Some(home) = dirs::home_dir() else {
        return Ok(GeminiQuota::failed(State::NotInstalled));
    };
    let quota = tokio::time::timeout(OVERALL_TIMEOUT, fetch_quota(&home))
        .await
        .unwrap_or_else(|_| GeminiQuota::failed(State::Unavailable));
    // A refused sign-in starts one local alert; only a good reading ends the episode.
    let signed_in = match quota.state {
        State::Ok => "yes",
        State::SignInNeeded => "no",
        _ => "unknown",
    };
    super::credential_alerts::observe_probe(&app, "gemini", "Gemini CLI", signed_in);
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), quota.clone()));
    }
    Ok(quota)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creds_parse_without_needing_every_field() {
        let c = parse_creds(r#"{"access_token":"a","refresh_token":"r","expiry_date":1700000000000,"id_token":"x"}"#).unwrap();
        assert_eq!(c.access_token.as_deref(), Some("a"));
        assert_eq!(c.refresh_token.as_deref(), Some("r"));
        assert_eq!(c.expiry_date, Some(1_700_000_000_000));
        let c = parse_creds(r#"{"access_token":"a"}"#).unwrap();
        assert!(c.refresh_token.is_none() && c.expiry_date.is_none());
        assert!(parse_creds("not json").is_none());
    }

    #[test]
    fn token_freshness_keeps_a_margin() {
        let now = 1_000_000;
        assert!(token_is_fresh(Some(now + 120_000), now));
        assert!(!token_is_fresh(Some(now + 30_000), now));
        assert!(!token_is_fresh(Some(now - 1), now));
        assert!(!token_is_fresh(None, now));
    }

    #[test]
    fn api_key_and_vertex_logins_are_unsupported() {
        let s = |t: &str| format!(r#"{{"security":{{"auth":{{"selectedType":"{t}"}}}}}}"#);
        assert!(auth_type_is_unsupported(&s("gemini-api-key")));
        assert!(auth_type_is_unsupported(&s("vertex-ai")));
        assert!(!auth_type_is_unsupported(&s("oauth-personal")));
        assert!(!auth_type_is_unsupported("{}"));
        assert!(!auth_type_is_unsupported("garbage"));
    }

    #[test]
    fn client_constants_are_read_from_bundled_js_only_when_plain() {
        let js = r#"var a=1;var OAUTH_CLIENT_ID = "123-abc.apps.example.com";
            const OAUTH_CLIENT_SECRET = 'GOCSPX-fake_secret~1'; x();"#;
        assert_eq!(
            extract_constant(js, "OAUTH_CLIENT_ID").as_deref(),
            Some("123-abc.apps.example.com")
        );
        assert_eq!(
            extract_constant(js, "OAUTH_CLIENT_SECRET").as_deref(),
            Some("GOCSPX-fake_secret~1")
        );
        // Not an assignment, not plain text, or missing: nothing is returned.
        assert_eq!(
            extract_constant("OAUTH_CLIENT_ID;", "OAUTH_CLIENT_ID"),
            None
        );
        assert_eq!(
            extract_constant(r#"OAUTH_CLIENT_ID = "a b; rm -rf""#, "OAUTH_CLIENT_ID"),
            None
        );
        assert_eq!(extract_constant("nothing here", "OAUTH_CLIENT_ID"), None);
        // A later real assignment wins over an earlier mention.
        assert_eq!(
            extract_constant(
                r#"log(OAUTH_CLIENT_ID); OAUTH_CLIENT_ID = "good-1""#,
                "OAUTH_CLIENT_ID"
            )
            .as_deref(),
            Some("good-1")
        );
    }

    #[test]
    fn only_invalid_grant_means_the_sign_in_is_lost() {
        assert_eq!(
            refresh_error_state(&json!({"error":"invalid_grant"})),
            State::SignInNeeded
        );
        assert_eq!(
            refresh_error_state(&json!({"error":"invalid_client"})),
            State::Unavailable
        );
        assert_eq!(refresh_error_state(&Value::Null), State::Unavailable);
        assert_eq!(refresh_error_state(&json!({})), State::Unavailable);
    }

    #[test]
    fn windows_npm_global_layout_is_searched() {
        let root = std::env::temp_dir().join(format!("gemini-layout-{}", std::process::id()));
        let bundle = root.join("npm/node_modules/@google/gemini-cli/bundle");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(
            bundle.join("chunk-1.js"),
            r#"var OAUTH_CLIENT_ID = "id-1"; var OAUTH_CLIENT_SECRET = "secret-1";"#,
        )
        .unwrap();
        // A real-file shim next to node_modules, like %APPDATA%\npm\gemini.cmd.
        let shim = root.join("npm/gemini.cmd");
        std::fs::write(&shim, "@echo off").unwrap();
        let scripts = candidate_scripts(&shim);
        assert!(
            scripts.iter().any(|p| p.ends_with("chunk-1.js")),
            "{scripts:?}"
        );
        let client = scripts.iter().find_map(|p| client_from_script(p)).unwrap();
        assert_eq!(
            (client.id.as_str(), client.secret.as_str()),
            ("id-1", "secret-1")
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_client_script_bigger_than_the_old_cap_is_still_read() {
        // Gemini CLI 0.68 keeps the constants in bundle chunks of about 17 MB.
        let dir = std::env::temp_dir().join(format!("gemini-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chunk-big.js");
        let mut body = vec![b'a'; 13 * 1024 * 1024];
        body.extend_from_slice(
            br#";var OAUTH_CLIENT_ID = "big-id"; var OAUTH_CLIENT_SECRET = "big-secret";"#,
        );
        std::fs::write(&path, &body).unwrap();
        let client = client_from_script(&path).unwrap();
        assert_eq!(
            (client.id.as_str(), client.secret.as_str()),
            ("big-id", "big-secret")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_constant_split_across_two_chunks_is_still_found() {
        // Put the assignment right over the 1 MiB chunk boundary.
        let mut body = vec![b' '; SCAN_CHUNK_BYTES - 20];
        body.extend_from_slice(
            br#"OAUTH_CLIENT_ID = "edge-id"; OAUTH_CLIENT_SECRET = "edge-secret";"#,
        );
        let client = scan_for_client(std::io::Cursor::new(body)).unwrap();
        assert_eq!(
            (client.id.as_str(), client.secret.as_str()),
            ("edge-id", "edge-secret")
        );
        assert!(scan_for_client(std::io::Cursor::new(vec![b'x'; 3 * SCAN_CHUNK_BYTES])).is_none());
    }

    #[test]
    fn models_map_to_three_tiers() {
        assert_eq!(Tier::of_model("gemini-2.5-pro"), Some(Tier::Pro));
        assert_eq!(Tier::of_model("gemini-2.5-flash"), Some(Tier::Flash));
        assert_eq!(
            Tier::of_model("gemini-2.5-flash-lite"),
            Some(Tier::FlashLite)
        );
        assert_eq!(Tier::of_model("embedding-001"), None);
    }

    #[test]
    fn quota_takes_the_lowest_fraction_per_tier() {
        let body = json!({"buckets":[
            {"modelId":"gemini-2.5-pro","remainingFraction":0.8,"resetTime":"2026-11-13T05:00:00Z"},
            {"modelId":"gemini-3-pro-preview","remainingFraction":0.25,"resetTime":"2026-11-13T07:30:00Z"},
            {"modelId":"gemini-2.5-flash","remainingFraction":0.0,"resetTime":"2026-11-13T09:00:00Z"},
            {"modelId":"gemini-2.5-flash-lite","remainingFraction":1.5},
            {"modelId":"embedding-001","remainingFraction":0.1},
            {"modelId":"gemini-2.5-pro"},
            {"modelId":"gemini-2.5-pro","remainingFraction":"bad"}
        ]});
        let tiers = parse_quota(&body);
        assert_eq!(
            tiers
                .iter()
                .map(|t| (t.id, t.percent_left))
                .collect::<Vec<_>>(),
            vec![("pro", 25.0), ("flash", 0.0), ("flash_lite", 100.0)]
        );
        assert_eq!(
            tiers[0].resets_at.as_deref(),
            Some("2026-11-13T07:30:00+00:00")
        );
        assert_eq!(tiers[2].resets_at, None);
    }

    #[test]
    fn empty_or_odd_quota_bodies_give_no_tiers() {
        assert!(parse_quota(&json!({})).is_empty());
        assert!(parse_quota(&json!({"buckets": "x"})).is_empty());
        assert!(parse_quota(&json!({"buckets": [{"modelId": 5}]})).is_empty());
    }

    #[test]
    fn plan_prefers_the_paid_name_then_the_tier() {
        assert_eq!(
            parse_plan(
                &json!({"paidTier":{"name":"Google AI Pro"},"currentTier":{"id":"free-tier"}})
            )
            .as_deref(),
            Some("Google AI Pro")
        );
        assert_eq!(
            parse_plan(&json!({"currentTier":{"id":"standard-tier"}})).as_deref(),
            Some("Paid")
        );
        assert_eq!(
            parse_plan(&json!({"currentTier":{"id":"free-tier"}})).as_deref(),
            Some("Free")
        );
        assert_eq!(
            parse_plan(&json!({"currentTier":{"id":"legacy-tier"}})).as_deref(),
            Some("Legacy")
        );
        assert_eq!(parse_plan(&json!({"currentTier":{"id":"mystery"}})), None);
        assert_eq!(parse_plan(&json!({})), None);
        let long = "x".repeat(60);
        assert_eq!(parse_plan(&json!({"paidTier":{"name": long}})), None);
    }

    #[test]
    fn project_id_is_a_string_or_an_object() {
        assert_eq!(
            parse_project_id(&json!({"cloudaicompanionProject":"p-1"})).as_deref(),
            Some("p-1")
        );
        assert_eq!(
            parse_project_id(&json!({"cloudaicompanionProject":{"id":"p-2"}})).as_deref(),
            Some("p-2")
        );
        assert_eq!(
            parse_project_id(&json!({"cloudaicompanionProject":""})),
            None
        );
        assert_eq!(parse_project_id(&json!({})), None);
    }

    #[test]
    fn failed_readings_carry_a_fixed_message_and_no_data() {
        for state in [
            State::NotInstalled,
            State::UnsupportedAuth,
            State::SignInNeeded,
            State::ClientNotFound,
            State::Unavailable,
        ] {
            let q = GeminiQuota::failed(state);
            assert_eq!(q.state, state);
            assert!(!q.message.is_empty());
            assert!(q.tiers.is_empty() && q.plan.is_none());
        }
        assert_eq!(State::Ok.message(), "");
    }

    /// Reads from a fake home, so no real login file is ever touched.
    #[tokio::test]
    async fn missing_login_file_means_not_installed() {
        let dir = std::env::temp_dir().join(format!("gemini-quota-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let q = fetch_quota(&dir).await;
        assert_eq!(q.state, State::NotInstalled);
        std::fs::create_dir_all(dir.join(".gemini")).unwrap();
        std::fs::write(
            dir.join(".gemini/oauth_creds.json"),
            r#"{"access_token":"fake"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join(".gemini/settings.json"),
            r#"{"security":{"auth":{"selectedType":"vertex-ai"}}}"#,
        )
        .unwrap();
        assert_eq!(fetch_quota(&dir).await.state, State::UnsupportedAuth);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn expired_login_without_a_refresh_token_needs_sign_in() {
        let dir = std::env::temp_dir().join(format!("gemini-quota-test2-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".gemini")).unwrap();
        std::fs::write(
            dir.join(".gemini/oauth_creds.json"),
            r#"{"access_token":"fake","expiry_date":1}"#,
        )
        .unwrap();
        assert_eq!(fetch_quota(&dir).await.state, State::SignInNeeded);
        std::fs::remove_dir_all(&dir).ok();
    }
}
