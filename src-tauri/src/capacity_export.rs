//! Sanitized capacity projection for the AOS adaptive-router MCP.

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, TimeZone, Utc};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Serialize, Serializer};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{collections::HashMap, fs, path::Path};

use crate::{
    api::usage::refresh_all_usage,
    auth::{load_accounts, read_current_auth, reconcile_active_account_with_live_auth},
    commands::{
        cached_subscription_expiry, check_codex_processes, load_summary_for_capacity, merge_seats,
        read_seat_registry, SeatReading,
    },
    types::{AccountsStore, StoredAccount, UsageInfo},
};

const SNAPSHOT_SCHEMA: &str = "aos.capacity-snapshot.v1";
const ADMISSION_SCHEMA: &str = "aos.switcher-admission.v1";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AdmissionProjection {
    schema: String,
    observed_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    host_admitted: bool,
    host_reason: String,
    #[serde(default)]
    lease_valid_by_alias_hash: HashMap<String, bool>,
    receipt_digest: String,
}

#[derive(Debug, Clone, Serialize)]
struct CapacityLane {
    lane_id: String,
    account_alias_hash: String,
    family: &'static str,
    model: &'static str,
    task_classes: [&'static str; 3],
    plan_class: String,
    remaining_percent: Option<f64>,
    reset_at: Option<String>,
    subscription_expires_at: Option<String>,
    running: bool,
    lease_valid: bool,
    refreshed_at: String,
    local_read_only: bool,
    availability_reason: String,
}

/// A Claude seat lane, appended after the Codex lanes. It carries a different field set than a Codex
/// lane (`provider` tells them apart), so it is only exported on request (`--include-claude-seats`).
#[derive(Debug, Clone, PartialEq, Serialize)]
struct ClaudeSeatLane {
    provider: &'static str,
    seat_id: String,
    plan: String,
    used_5h_pct: Option<f64>,
    used_7d_pct: Option<f64>,
    resets_at: Option<String>,
    status: &'static str,
}

impl From<SeatReading> for ClaudeSeatLane {
    fn from(reading: SeatReading) -> Self {
        Self {
            provider: "claude",
            seat_id: reading.seat_id,
            plan: reading.plan,
            used_5h_pct: reading.used_5h_pct,
            used_7d_pct: reading.used_7d_pct,
            resets_at: reading.resets_at,
            status: reading.status.as_str(),
        }
    }
}

/// The `lanes` array: Codex lanes first, then any Claude seat lanes.
struct AllLanes<'a> {
    codex: &'a [CapacityLane],
    claude: &'a [ClaudeSeatLane],
}

impl Serialize for AllLanes<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.codex.len() + self.claude.len()))?;
        for lane in self.codex {
            seq.serialize_element(lane)?;
        }
        for lane in self.claude {
            seq.serialize_element(lane)?;
        }
        seq.end()
    }
}

#[derive(Debug, Clone)]
struct CapacityBody {
    schema: &'static str,
    observed_at: String,
    host_admitted: bool,
    host_reason: String,
    lanes: Vec<CapacityLane>,
    claude_lanes: Vec<ClaudeSeatLane>,
}

impl Serialize for CapacityBody {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(5))?;
        map.serialize_entry("schema", self.schema)?;
        map.serialize_entry("observed_at", &self.observed_at)?;
        map.serialize_entry("host_admitted", &self.host_admitted)?;
        map.serialize_entry("host_reason", &self.host_reason)?;
        map.serialize_entry(
            "lanes",
            &AllLanes {
                codex: &self.lanes,
                claude: &self.claude_lanes,
            },
        )?;
        map.end()
    }
}

#[derive(Debug, Clone)]
struct CapacitySnapshot {
    schema: &'static str,
    snapshot_id: String,
    observed_at: String,
    host_admitted: bool,
    host_reason: String,
    lanes: Vec<CapacityLane>,
    claude_lanes: Vec<ClaudeSeatLane>,
}

impl Serialize for CapacitySnapshot {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(6))?;
        map.serialize_entry("schema", self.schema)?;
        map.serialize_entry("snapshot_id", &self.snapshot_id)?;
        map.serialize_entry("observed_at", &self.observed_at)?;
        map.serialize_entry("host_admitted", &self.host_admitted)?;
        map.serialize_entry("host_reason", &self.host_reason)?;
        map.serialize_entry(
            "lanes",
            &AllLanes {
                codex: &self.lanes,
                claude: &self.claude_lanes,
            },
        )?;
        map.end()
    }
}

fn sha256_text(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}

fn account_alias_hash(account_id: &str) -> String {
    sha256_text(&format!("codex-switcher-capacity-v1\0{account_id}"))
}

fn safe_plan_class(value: Option<String>) -> String {
    match value
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("free") => "free",
        Some("plus") => "plus",
        Some("pro") => "pro",
        Some("team") => "team",
        Some("business") => "business",
        Some("enterprise") => "enterprise",
        Some("edu") => "edu",
        Some("api_key") => "api",
        _ => "unknown",
    }
    .to_string()
}

fn unix_time(value: Option<i64>) -> Option<DateTime<Utc>> {
    value.and_then(|seconds| Utc.timestamp_opt(seconds, 0).single())
}

fn later_reset(usage: &UsageInfo) -> Option<DateTime<Utc>> {
    [
        unix_time(usage.primary_resets_at),
        unix_time(usage.secondary_resets_at),
    ]
    .into_iter()
    .flatten()
    .max()
}

fn remaining_percent(usage: &UsageInfo) -> Option<f64> {
    [usage.primary_used_percent, usage.secondary_used_percent]
        .into_iter()
        .flatten()
        .map(|used| (100.0 - used).clamp(0.0, 100.0))
        .reduce(f64::min)
}

fn admission_receipt_digest(projection: &AdmissionProjection) -> Result<String> {
    let mut value = serde_json::to_value(projection).context("admission_projection_invalid")?;
    value
        .as_object_mut()
        .context("admission_projection_invalid")?
        .remove("receipt_digest");
    let canonical = serde_json::to_vec(&value).context("admission_projection_invalid")?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical)))
}

fn validate_admission_projection(
    projection: &AdmissionProjection,
    now: DateTime<Utc>,
) -> Result<()> {
    let fresh_after = now - Duration::minutes(5);
    let future_limit = now + Duration::minutes(1);
    if projection.schema != ADMISSION_SCHEMA
        || projection.observed_at < fresh_after
        || projection.observed_at > future_limit
        || projection.expires_at <= now
        || projection.expires_at > projection.observed_at + Duration::minutes(5)
        || projection.host_reason.is_empty()
        || projection.host_reason.len() > 128
        || !projection.host_reason.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '_' | '.' | ':' | '-')
        })
        || projection.lease_valid_by_alias_hash.keys().any(|key| {
            key.len() != 71
                || !key.starts_with("sha256:")
                || !key[7..]
                    .chars()
                    .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
        })
        || admission_receipt_digest(projection)? != projection.receipt_digest
    {
        anyhow::bail!("admission_projection_contract_invalid");
    }
    Ok(())
}

fn safe_admission(path: Option<&Path>, now: DateTime<Utc>) -> Result<AdmissionProjection> {
    let Some(path) = path else {
        return Ok(AdmissionProjection {
            schema: ADMISSION_SCHEMA.to_string(),
            observed_at: now,
            expires_at: now,
            host_admitted: false,
            host_reason: "host_admission_receipt_required".to_string(),
            lease_valid_by_alias_hash: HashMap::new(),
            receipt_digest: String::new(),
        });
    };
    let raw = fs::read(path).context("admission_projection_unreadable")?;
    let projection: AdmissionProjection =
        serde_json::from_slice(&raw).context("admission_projection_invalid")?;
    validate_admission_projection(&projection, now)?;
    Ok(projection)
}

/// One Codex account's lane, exactly as the router receives it. `expires` is passed apart from the
/// account so the Use next tab can hand in the live subscription date the app already holds.
fn codex_lane(
    account: &StoredAccount,
    usage: Option<&UsageInfo>,
    expires: Option<DateTime<Utc>>,
    running: bool,
    admission: &AdmissionProjection,
    refreshed_at: &str,
    now: DateTime<Utc>,
) -> CapacityLane {
    let alias_hash = account_alias_hash(&account.id);
    let remaining = usage.and_then(remaining_percent);
    let reset_at = usage
        .and_then(later_reset)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    let lease_valid = admission
        .lease_valid_by_alias_hash
        .get(&alias_hash)
        .copied()
        .unwrap_or(false);
    let availability_reason = if usage.is_none() {
        "usage_unavailable"
    } else if usage.is_some_and(|value| value.error.is_some()) {
        "usage_refresh_failed"
    } else if expires.is_some_and(|value| value <= now) {
        "subscription_expired"
    } else if remaining.is_some_and(|value| value <= 0.0) {
        "allowance_exhausted"
    } else if running {
        "lane_running"
    } else if !admission.host_admitted {
        "host_not_admitted"
    } else if !lease_valid {
        "seat_lease_required"
    } else {
        "available"
    };
    CapacityLane {
        lane_id: format!("codex-seat-{}", &alias_hash[7..23]),
        account_alias_hash: alias_hash,
        family: "codex-spark",
        model: "gpt-5.3-codex-spark",
        task_classes: ["implementation", "test", "refactor"],
        plan_class: safe_plan_class(
            usage
                .and_then(|value| value.plan_type.clone())
                .or_else(|| account.plan_type.clone()),
        ),
        remaining_percent: remaining,
        reset_at,
        subscription_expires_at: expires
            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        running,
        lease_valid,
        refreshed_at: refreshed_at.to_string(),
        local_read_only: false,
        availability_reason: availability_reason.to_string(),
    }
}

const USE_NEXT_SCHEMA: &str = "codex-switcher.use-next.v1";
/// The order `router_plan` gives Codex lanes, named so the tab can say which rule it follows.
const USE_NEXT_RULE: &str = "router_plan_codex_order_then_soonest_back";

/// One row of the Use next tab: the lane the router sees, plus the account it belongs to and its place.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UseNextRow {
    /// 1 is the account to use next.
    pub position: usize,
    pub account_id: String,
    pub lane_id: String,
    /// clean, busy, exhausted, expired, refresh_failed or no_usage.
    pub status: &'static str,
    /// The exporter's reason, e.g. host_not_admitted on a lane that is clean for a manual switch.
    pub availability_reason: String,
    pub plan_class: String,
    pub remaining_percent: Option<f64>,
    /// When an exhausted lane's empty window resets; null for every other status.
    pub back_at: Option<String>,
    pub subscription_expires_at: Option<String>,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct UseNextPlan {
    pub schema: &'static str,
    pub observed_at: String,
    pub selection_rule: &'static str,
    pub rows: Vec<UseNextRow>,
}

/// A manual switch has no host admission or seat lease, so lanes held back only by those still count
/// as clean here; every other exporter reason keeps its own status.
fn use_next_status(reason: &str) -> &'static str {
    match reason {
        "available" | "host_not_admitted" | "seat_lease_required" => "clean",
        "lane_running" => "busy",
        "allowance_exhausted" => "exhausted",
        "subscription_expired" => "expired",
        "usage_refresh_failed" => "refresh_failed",
        _ => "no_usage",
    }
}

/// The reset of whichever window is used up; the later one when both are.
fn back_at(usage: &UsageInfo) -> Option<DateTime<Utc>> {
    [
        (usage.primary_used_percent, usage.primary_resets_at),
        (usage.secondary_used_percent, usage.secondary_resets_at),
    ]
    .into_iter()
    .filter(|(used, _)| used.is_some_and(|value| value >= 100.0))
    .filter_map(|(_, reset)| unix_time(reset))
    .max()
}

fn timestamp(value: Option<&str>) -> Option<i64> {
    value
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|time| time.timestamp())
}

/// Clean lanes come first in the order `router_plan` dispatches Codex lanes: they all share one family and
/// the MCP passes no outcome history, so `rank_lanes` falls through to the soonest subscription end
/// (none last), then the lane id. The lanes it would not dispatch follow: the busy active account, then
/// exhausted lanes soonest back, then failed or missing usage readings, then expired subscriptions.
fn rank_use_next(mut rows: Vec<UseNextRow>) -> Vec<UseNextRow> {
    fn group(status: &str) -> u8 {
        match status {
            "clean" => 0,
            "busy" => 1,
            "exhausted" => 2,
            "refresh_failed" | "no_usage" => 3,
            _ => 4,
        }
    }
    let key = |row: &UseNextRow| {
        let expires = timestamp(row.subscription_expires_at.as_deref());
        let within_group = match row.status {
            "exhausted" => timestamp(row.back_at.as_deref()).unwrap_or(i64::MAX),
            // Most recently ended first: it is the likeliest to have been renewed.
            "expired" => expires.map_or(i64::MAX, |value| -value),
            _ => expires.unwrap_or(i64::MAX),
        };
        (group(row.status), within_group, row.lane_id.clone())
    };
    rows.sort_by_key(key);
    for (index, row) in rows.iter_mut().enumerate() {
        row.position = index + 1;
    }
    rows
}

/// `live_expiry` holds the subscription dates the app read from the account API this session; an
/// account it does not cover keeps its saved date, which is the one the exporter hands the router.
fn build_use_next_plan(
    store: &AccountsStore,
    usage_rows: &[UsageInfo],
    codex_running: bool,
    live_expiry: &HashMap<String, Option<DateTime<Utc>>>,
    now: DateTime<Utc>,
) -> UseNextPlan {
    let usage_by_id: HashMap<&str, &UsageInfo> = usage_rows
        .iter()
        .map(|usage| (usage.account_id.as_str(), usage))
        .collect();
    let observed_at = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    // The app holds no admission receipt, so every lane carries the router's host gate.
    let admission = safe_admission(None, now).expect("no receipt path never fails");
    let rows = store
        .accounts
        .iter()
        .map(|account| {
            let usage = usage_by_id.get(account.id.as_str()).copied();
            let expires = live_expiry
                .get(&account.id)
                .copied()
                .unwrap_or(account.subscription_expires_at);
            let running =
                codex_running && store.active_account_id.as_deref() == Some(account.id.as_str());
            let lane = codex_lane(
                account,
                usage,
                expires,
                running,
                &admission,
                &observed_at,
                now,
            );
            let status = use_next_status(&lane.availability_reason);
            UseNextRow {
                position: 0,
                account_id: account.id.clone(),
                lane_id: lane.lane_id,
                status,
                availability_reason: lane.availability_reason,
                plan_class: lane.plan_class,
                remaining_percent: lane.remaining_percent,
                back_at: (status == "exhausted")
                    .then(|| usage.and_then(back_at))
                    .flatten()
                    .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
                subscription_expires_at: lane.subscription_expires_at,
                running,
            }
        })
        .collect();
    UseNextPlan {
        schema: USE_NEXT_SCHEMA,
        observed_at,
        selection_rule: USE_NEXT_RULE,
        rows: rank_use_next(rows),
    }
}

/// The Use next tab's plan from the usage readings the window already holds. Accounts and the running
/// check are read the way the exporter reads them, so each lane matches what `capacity_list` shows.
pub async fn use_next_plan(usage_rows: &[UsageInfo]) -> Result<UseNextPlan> {
    let mut store = load_accounts().context("accounts_unavailable")?;
    if let Ok(Some(auth)) = read_current_auth() {
        reconcile_active_account_with_live_auth(&mut store, &auth);
    }
    let process = check_codex_processes()
        .await
        .map_err(|_| anyhow::anyhow!("codex_process_probe_failed"))?;
    let live_expiry = cached_subscription_expiry();
    Ok(build_use_next_plan(
        &store,
        usage_rows,
        process.count > 0,
        &live_expiry,
        Utc::now(),
    ))
}

#[cfg(test)]
fn build_snapshot(
    store: &AccountsStore,
    usage_rows: &[UsageInfo],
    codex_running: bool,
    admission: &AdmissionProjection,
    now: DateTime<Utc>,
) -> Result<CapacitySnapshot> {
    build_snapshot_with_claude(store, usage_rows, codex_running, admission, now, Vec::new())
}

fn build_snapshot_with_claude(
    store: &AccountsStore,
    usage_rows: &[UsageInfo],
    codex_running: bool,
    admission: &AdmissionProjection,
    now: DateTime<Utc>,
    claude_lanes: Vec<ClaudeSeatLane>,
) -> Result<CapacitySnapshot> {
    let usage_by_id: HashMap<&str, &UsageInfo> = usage_rows
        .iter()
        .map(|usage| (usage.account_id.as_str(), usage))
        .collect();
    let refreshed_at = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut lanes = Vec::with_capacity(store.accounts.len());
    for account in &store.accounts {
        let running =
            codex_running && store.active_account_id.as_deref() == Some(account.id.as_str());
        lanes.push(codex_lane(
            account,
            usage_by_id.get(account.id.as_str()).copied(),
            account.subscription_expires_at,
            running,
            admission,
            &refreshed_at,
            now,
        ));
    }
    lanes.sort_by(|left, right| left.lane_id.cmp(&right.lane_id));
    let body = CapacityBody {
        schema: SNAPSHOT_SCHEMA,
        observed_at: refreshed_at.clone(),
        host_admitted: admission.host_admitted,
        host_reason: admission.host_reason.clone(),
        lanes: lanes.clone(),
        claude_lanes: claude_lanes.clone(),
    };
    let body_value = serde_json::to_value(&body).context("capacity_projection_failed")?;
    let canonical = serde_json::to_vec(&body_value).context("capacity_projection_failed")?;
    Ok(CapacitySnapshot {
        schema: body.schema,
        snapshot_id: format!("sha256:{:x}", Sha256::digest(&canonical)),
        observed_at: body.observed_at,
        host_admitted: body.host_admitted,
        host_reason: body.host_reason,
        lanes: body.lanes,
        claude_lanes: body.claude_lanes,
    })
}

/// Claude seat lanes from the fleet seat registry and the claude-usage summary. Either source may be
/// missing: a missing registry leaves the known seats, a missing summary leaves every status unknown.
async fn claude_seat_lanes(now: DateTime<Utc>) -> Vec<ClaudeSeatLane> {
    let registry = read_seat_registry().ok();
    let summary = load_summary_for_capacity(now).await;
    let accounts = summary
        .as_ref()
        .and_then(|value| value.get("accounts"))
        .and_then(|value| value.as_array());
    merge_seats(registry.as_deref(), accounts.map(Vec::as_slice), now)
        .into_iter()
        .map(ClaudeSeatLane::from)
        .collect()
}

/// `include_claude_seats` appends the Claude seat lanes. It is opt-in because a consumer that
/// validates `lanes` strictly (as the deployed adaptive router does) must learn the new lane shape
/// before it can accept them.
pub async fn export_capacity(
    output: &Path,
    admission_path: Option<&Path>,
    include_claude_seats: bool,
) -> Result<()> {
    let mut store = load_accounts().context("accounts_unavailable")?;
    // Codex refreshes the active account itself, so fold its live login into
    // this copy: a renewal then shows here even while the app is closed. The
    // copy is never saved.
    if let Ok(Some(auth)) = read_current_auth() {
        reconcile_active_account_with_live_auth(&mut store, &auth);
    }
    let usage = refresh_all_usage(&store.accounts).await;
    let process = check_codex_processes()
        .await
        .map_err(|_| anyhow::anyhow!("codex_process_probe_failed"))?;
    let now = Utc::now();
    let admission = safe_admission(admission_path, now)?;
    let claude_lanes = if include_claude_seats {
        claude_seat_lanes(now).await
    } else {
        Vec::new()
    };
    let snapshot = build_snapshot_with_claude(
        &store,
        &usage,
        process.count > 0,
        &admission,
        now,
        claude_lanes,
    )?;
    let parent = output.parent().context("capacity_output_parent_missing")?;
    fs::create_dir_all(parent).context("capacity_output_parent_unwritable")?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        output
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("capacity"),
        std::process::id()
    ));
    fs::write(&temporary, serde_json::to_vec_pretty(&snapshot)?)
        .context("capacity_output_write_failed")?;
    #[cfg(unix)]
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
        .context("capacity_output_permissions_failed")?;
    fs::rename(&temporary, output).context("capacity_output_publish_failed")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{parse_claude_usage, parse_seat_registry};
    use crate::types::StoredAccount;

    #[test]
    fn projection_never_serializes_account_identity_or_credentials() {
        let account = StoredAccount::new_chatgpt(
            "private name".to_string(),
            Some("private@example.com".to_string()),
            Some("pro".to_string()),
            None,
            "private-id-token".to_string(),
            "private-access-token".to_string(),
            "private-refresh-token".to_string(),
            Some("private-account-id".to_string()),
        );
        let account_id = account.id.clone();
        let store = AccountsStore {
            version: 1,
            accounts: vec![account],
            active_account_id: Some(account_id.clone()),
            masked_account_ids: Vec::new(),
        };
        let usage = UsageInfo {
            account_id,
            plan_type: Some("pro".to_string()),
            primary_used_percent: Some(12.0),
            primary_window_minutes: Some(300),
            primary_resets_at: Some(1_800_000_000),
            secondary_used_percent: Some(40.0),
            secondary_window_minutes: Some(10_080),
            secondary_resets_at: Some(1_800_100_000),
            has_credits: Some(false),
            unlimited_credits: Some(false),
            credits_balance: None,
            error: None,
        };
        let now = Utc.timestamp_opt(1_799_000_000, 0).single().unwrap();
        let mut admission = AdmissionProjection {
            schema: ADMISSION_SCHEMA.to_string(),
            observed_at: now,
            expires_at: now + Duration::minutes(5),
            host_admitted: true,
            host_reason: "green".to_string(),
            lease_valid_by_alias_hash: HashMap::new(),
            receipt_digest: String::new(),
        };
        admission.receipt_digest = admission_receipt_digest(&admission).unwrap();
        validate_admission_projection(&admission, now).unwrap();
        let snapshot = build_snapshot(&store, &[usage], false, &admission, now).unwrap();
        let rendered = serde_json::to_string(&snapshot).unwrap();
        for forbidden in [
            "private name",
            "private@example.com",
            "private-id-token",
            "private-access-token",
            "private-refresh-token",
            "private-account-id",
        ] {
            assert!(!rendered.contains(forbidden));
        }
        assert!(snapshot.lanes[0].account_alias_hash.starts_with("sha256:"));
        assert_eq!(snapshot.lanes[0].plan_class, "pro");
        assert_eq!(snapshot.lanes[0].availability_reason, "seat_lease_required");

        let missing_usage = build_snapshot(&store, &[], false, &admission, now).unwrap();
        assert_eq!(missing_usage.lanes[0].remaining_percent, None);
        assert_eq!(
            missing_usage.lanes[0].availability_reason,
            "usage_unavailable"
        );

        let mut stale = admission.clone();
        stale.observed_at = now - Duration::minutes(6);
        stale.expires_at = now + Duration::minutes(1);
        stale.receipt_digest = admission_receipt_digest(&stale).unwrap();
        assert!(validate_admission_projection(&stale, now).is_err());
    }

    const USAGE_FIXTURE: &str = include_str!("../../tests/fixtures/claude-usage-summary.json");
    const REGISTRY_FIXTURE: &str = include_str!("../../tests/fixtures/subscription-accounts.json");
    /// The fields the adaptive router requires of every Codex lane.
    const CODEX_LANE_KEYS: [&str; 14] = [
        "account_alias_hash",
        "availability_reason",
        "family",
        "lane_id",
        "lease_valid",
        "local_read_only",
        "model",
        "plan_class",
        "refreshed_at",
        "remaining_percent",
        "reset_at",
        "running",
        "subscription_expires_at",
        "task_classes",
    ];

    fn keys_of(value: &serde_json::Value) -> Vec<&str> {
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        keys
    }

    fn sample_snapshot(claude: bool) -> (CapacitySnapshot, DateTime<Utc>) {
        let account = StoredAccount::new_chatgpt(
            "private name".to_string(),
            Some("private@example.com".to_string()),
            Some("pro".to_string()),
            None,
            "private-id-token".to_string(),
            "private-access-token".to_string(),
            "private-refresh-token".to_string(),
            Some("private-account-id".to_string()),
        );
        let account_id = account.id.clone();
        let store = AccountsStore {
            version: 1,
            accounts: vec![account],
            active_account_id: Some(account_id.clone()),
            masked_account_ids: Vec::new(),
        };
        let usage = UsageInfo {
            account_id,
            plan_type: Some("pro".to_string()),
            primary_used_percent: Some(12.0),
            primary_window_minutes: Some(300),
            primary_resets_at: Some(1_800_000_000),
            secondary_used_percent: Some(40.0),
            secondary_window_minutes: Some(10_080),
            secondary_resets_at: Some(1_800_100_000),
            has_credits: Some(false),
            unlimited_credits: Some(false),
            credits_balance: None,
            error: None,
        };
        // The Claude usage fixture was generated at 2026-10-11T17:21:58Z.
        let now = Utc.with_ymd_and_hms(2026, 10, 11, 17, 22, 0).unwrap();
        let admission = AdmissionProjection {
            schema: ADMISSION_SCHEMA.to_string(),
            observed_at: now,
            expires_at: now + Duration::minutes(5),
            host_admitted: true,
            host_reason: "green".to_string(),
            lease_valid_by_alias_hash: HashMap::new(),
            receipt_digest: String::new(),
        };
        let claude_lanes = if claude {
            let registry = parse_seat_registry(REGISTRY_FIXTURE).unwrap();
            let summary = parse_claude_usage(USAGE_FIXTURE).unwrap();
            let accounts = summary["accounts"].as_array().unwrap();
            merge_seats(Some(&registry), Some(accounts.as_slice()), now)
                .into_iter()
                .map(ClaudeSeatLane::from)
                .collect()
        } else {
            Vec::new()
        };
        let snapshot =
            build_snapshot_with_claude(&store, &[usage], false, &admission, now, claude_lanes)
                .unwrap();
        (snapshot, now)
    }

    #[test]
    fn snapshot_without_claude_seats_keeps_the_shape_the_router_validates() {
        let (snapshot, _) = sample_snapshot(false);
        let value = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(
            keys_of(&value),
            [
                "host_admitted",
                "host_reason",
                "lanes",
                "observed_at",
                "schema",
                "snapshot_id"
            ]
        );
        let lanes = value["lanes"].as_array().unwrap();
        assert_eq!(lanes.len(), 1);
        assert_eq!(keys_of(&lanes[0]), CODEX_LANE_KEYS);
        assert!(!serde_json::to_string(&value).unwrap().contains("claude"));
    }

    #[test]
    fn claude_seat_lanes_follow_the_codex_lanes_with_the_seat_fields() {
        let (snapshot, _) = sample_snapshot(true);
        let value = serde_json::to_value(&snapshot).unwrap();
        // Top-level fields and the Codex lane are untouched.
        assert_eq!(keys_of(&value).len(), 6);
        let lanes = value["lanes"].as_array().unwrap();
        assert_eq!(lanes.len(), 1 + 5);
        assert_eq!(keys_of(&lanes[0]), CODEX_LANE_KEYS);
        assert_eq!(lanes[0]["family"], "codex-spark");

        for lane in &lanes[1..] {
            assert_eq!(
                keys_of(lane),
                [
                    "plan",
                    "provider",
                    "resets_at",
                    "seat_id",
                    "status",
                    "used_5h_pct",
                    "used_7d_pct"
                ]
            );
            assert_eq!(lane["provider"], "claude");
            assert_eq!(lane["plan"], "max");
        }
        let by_seat = |id: &str| lanes[1..].iter().find(|l| l["seat_id"] == id).unwrap();
        let gustavo = by_seat("claude-mac-gustavo");
        assert_eq!(gustavo["used_5h_pct"], 59.0);
        assert_eq!(gustavo["used_7d_pct"], 41.0);
        assert_eq!(gustavo["resets_at"], "2026-10-14T20:00:00Z");
        assert_eq!(gustavo["status"], "ok");
        let s096 = by_seat("claude-mac-096");
        assert_eq!(s096["status"], "no_usage_yet");
        assert!(s096["used_5h_pct"].is_null());
        assert!(s096["used_7d_pct"].is_null());
        assert!(s096["resets_at"].is_null());
        assert_eq!(by_seat("claude-mac-main")["status"], "no_usage_yet");
    }

    #[test]
    fn snapshot_id_covers_the_claude_lanes() {
        let (with_claude, _) = sample_snapshot(true);
        let (without, _) = sample_snapshot(false);
        assert_ne!(with_claude.snapshot_id, without.snapshot_id);
        for snapshot in [&with_claude, &without] {
            let mut body = serde_json::to_value(snapshot).unwrap();
            body.as_object_mut().unwrap().remove("snapshot_id");
            let digest = format!(
                "sha256:{:x}",
                Sha256::digest(serde_json::to_vec(&body).unwrap())
            );
            assert_eq!(digest, snapshot.snapshot_id);
        }
    }

    #[test]
    fn claude_seat_lanes_never_serialize_emails_or_registry_internals() {
        let (snapshot, _) = sample_snapshot(true);
        let rendered = serde_json::to_string(&snapshot).unwrap();
        for forbidden in [
            "example.com",
            "@",
            "profile",
            "binary",
            "identity",
            "claude-usage",
            "private",
        ] {
            assert!(!rendered.contains(forbidden), "{forbidden} leaked");
        }
    }

    fn use_next_account(name: &str, expires: Option<DateTime<Utc>>) -> StoredAccount {
        let mut account = StoredAccount::new_chatgpt(
            name.to_string(),
            Some(format!("{name}@example.com")),
            Some("pro".to_string()),
            None,
            "private-id-token".to_string(),
            "private-access-token".to_string(),
            "private-refresh-token".to_string(),
            None,
        );
        account.subscription_expires_at = expires;
        account
    }

    fn use_next_usage(account: &StoredAccount, five_hour: f64, weekly: f64) -> UsageInfo {
        UsageInfo {
            account_id: account.id.clone(),
            plan_type: Some("pro".to_string()),
            primary_used_percent: Some(five_hour),
            primary_window_minutes: Some(300),
            primary_resets_at: Some(1_800_003_600),
            secondary_used_percent: Some(weekly),
            secondary_window_minutes: Some(10_080),
            secondary_resets_at: Some(1_800_300_000),
            has_credits: Some(false),
            unlimited_credits: Some(false),
            credits_balance: None,
            error: None,
        }
    }

    fn use_next_now() -> DateTime<Utc> {
        Utc.timestamp_opt(1_800_000_000, 0).single().unwrap()
    }

    fn store_of(accounts: Vec<StoredAccount>, active: Option<&str>) -> AccountsStore {
        AccountsStore {
            version: 1,
            accounts,
            active_account_id: active.map(str::to_string),
            masked_account_ids: Vec::new(),
        }
    }

    fn names_in_order<'a>(plan: &UseNextPlan, store: &'a AccountsStore) -> Vec<&'a str> {
        plan.rows
            .iter()
            .map(|row| {
                store
                    .accounts
                    .iter()
                    .find(|account| account.id == row.account_id)
                    .map(|account| account.name.as_str())
                    .unwrap()
            })
            .collect()
    }

    #[test]
    fn use_next_orders_clean_lanes_the_way_the_router_does() {
        let now = use_next_now();
        let late = use_next_account("late", Some(now + Duration::days(30)));
        let soon = use_next_account("soon", Some(now + Duration::days(5)));
        let open = use_next_account("open", None);
        let twin_a = use_next_account("twin-a", Some(now + Duration::days(9)));
        let twin_b = use_next_account("twin-b", Some(now + Duration::days(9)));
        let usage: Vec<UsageInfo> = [&late, &soon, &open, &twin_a, &twin_b]
            .iter()
            .map(|account| use_next_usage(account, 10.0, 20.0))
            .collect();
        let store = store_of(vec![late, soon, open, twin_a, twin_b], None);
        let plan = build_use_next_plan(&store, &usage, false, &HashMap::new(), now);

        assert!(plan.rows.iter().all(|row| row.status == "clean"));
        // The app has no admission receipt, so the router's host gate shows on every clean lane.
        assert!(plan
            .rows
            .iter()
            .all(|row| row.availability_reason == "host_not_admitted"));
        let names = names_in_order(&plan, &store);
        assert_eq!(names[0], "soon");
        // Equal end dates fall back to the lane id, as rank_lanes does.
        let twins: Vec<&UseNextRow> = plan.rows[1..3].iter().collect();
        assert!(twins[0].lane_id < twins[1].lane_id);
        assert_eq!(&names[3..], ["late", "open"]);
        assert_eq!(
            plan.rows.iter().map(|row| row.position).collect::<Vec<_>>(),
            [1, 2, 3, 4, 5]
        );
    }

    #[test]
    fn use_next_lists_held_back_lanes_after_the_clean_ones() {
        let now = use_next_now();
        let ends = Some(now + Duration::days(20));
        let active = use_next_account("active", ends);
        let clean = use_next_account("clean", Some(now + Duration::days(40)));
        let weekly_out = use_next_account("weekly-out", ends);
        let five_hour_out = use_next_account("five-hour-out", ends);
        let failed = use_next_account("failed", Some(now + Duration::days(2)));
        let unread = use_next_account("unread", ends);
        let old = use_next_account("old", Some(now - Duration::days(60)));
        let recent = use_next_account("recent", Some(now - Duration::days(1)));

        let mut failed_usage = use_next_usage(&failed, 0.0, 0.0);
        failed_usage.error = Some("401".to_string());
        let usage = vec![
            use_next_usage(&active, 30.0, 14.0),
            use_next_usage(&clean, 0.0, 0.0),
            use_next_usage(&weekly_out, 10.0, 100.0),
            use_next_usage(&five_hour_out, 100.0, 50.0),
            failed_usage,
            use_next_usage(&old, 0.0, 0.0),
            use_next_usage(&recent, 0.0, 0.0),
        ];
        let active_id = active.id.clone();
        let store = store_of(
            vec![
                recent,
                old,
                unread,
                failed,
                five_hour_out,
                weekly_out,
                clean,
                active,
            ],
            Some(&active_id),
        );
        let plan = build_use_next_plan(&store, &usage, true, &HashMap::new(), now);

        assert_eq!(
            names_in_order(&plan, &store),
            [
                "clean",
                "active",
                "five-hour-out",
                "weekly-out",
                "failed",
                "unread",
                "recent",
                "old"
            ]
        );
        let statuses: Vec<&str> = plan.rows.iter().map(|row| row.status).collect();
        assert_eq!(
            statuses,
            [
                "clean",
                "busy",
                "exhausted",
                "exhausted",
                "refresh_failed",
                "no_usage",
                "expired",
                "expired"
            ]
        );
        assert!(plan.rows[1].running);
        // An exhausted lane comes back when its empty window resets, not at the later of the two.
        assert_eq!(
            plan.rows[2].back_at.as_deref(),
            Some("2027-01-15T09:00:00Z")
        );
        assert_eq!(
            plan.rows[3].back_at.as_deref(),
            Some("2027-01-18T19:20:00Z")
        );
        assert!(plan
            .rows
            .iter()
            .filter(|row| row.status != "exhausted")
            .all(|row| row.back_at.is_none()));
    }

    #[test]
    fn use_next_prefers_the_live_subscription_date_over_the_saved_one() {
        let now = use_next_now();
        let renewed = use_next_account("renewed", Some(now - Duration::days(3)));
        let usage = vec![use_next_usage(&renewed, 0.0, 0.0)];
        let live = HashMap::from([(renewed.id.clone(), Some(now + Duration::days(27)))]);
        let store = store_of(vec![renewed], None);

        let saved = build_use_next_plan(&store, &usage, false, &HashMap::new(), now);
        assert_eq!(saved.rows[0].status, "expired");
        let refreshed = build_use_next_plan(&store, &usage, false, &live, now);
        assert_eq!(refreshed.rows[0].status, "clean");
        assert_eq!(
            refreshed.rows[0].subscription_expires_at.as_deref(),
            Some("2027-02-11T08:00:00Z")
        );
    }

    #[test]
    fn use_next_lanes_match_the_exported_lanes() {
        let now = use_next_now();
        let account = use_next_account("same", Some(now + Duration::days(8)));
        let usage = vec![use_next_usage(&account, 20.0, 30.0)];
        let store = store_of(vec![account], None);
        let admission = safe_admission(None, now).unwrap();
        let snapshot = build_snapshot(&store, &usage, false, &admission, now).unwrap();
        let plan = build_use_next_plan(&store, &usage, false, &HashMap::new(), now);
        let (lane, row) = (&snapshot.lanes[0], &plan.rows[0]);
        assert_eq!(row.lane_id, lane.lane_id);
        assert_eq!(row.availability_reason, lane.availability_reason);
        assert_eq!(row.remaining_percent, lane.remaining_percent);
        assert_eq!(row.subscription_expires_at, lane.subscription_expires_at);
        assert_eq!(row.plan_class, lane.plan_class);
    }

    #[test]
    fn use_next_plan_never_serializes_credentials_or_identity() {
        let now = use_next_now();
        let account = use_next_account("private name", None);
        let usage = vec![use_next_usage(&account, 1.0, 1.0)];
        let store = store_of(vec![account], None);
        let rendered = serde_json::to_string(&build_use_next_plan(
            &store,
            &usage,
            false,
            &HashMap::new(),
            now,
        ))
        .unwrap();
        for forbidden in ["private", "example.com", "@", "token"] {
            assert!(!rendered.contains(forbidden), "{forbidden} leaked");
        }
    }

    #[test]
    fn claude_lane_status_mirrors_the_reading() {
        let lane = ClaudeSeatLane::from(SeatReading {
            seat_id: "claude-wsl".to_string(),
            plan: "max".to_string(),
            used_5h_pct: Some(100.0),
            used_7d_pct: Some(40.0),
            resets_at: Some("2026-10-11T19:50:00Z".to_string()),
            status: crate::commands::SeatStatus::Exhausted,
        });
        assert_eq!(lane.provider, "claude");
        assert_eq!(lane.status, "exhausted");
        assert_eq!(lane.seat_id, "claude-wsl");
    }
}
