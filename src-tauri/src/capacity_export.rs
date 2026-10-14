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
    auth::load_accounts,
    commands::{
        check_codex_processes, load_summary_for_capacity, merge_seats, read_seat_registry,
        SeatReading,
    },
    types::{AccountsStore, UsageInfo},
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
        let alias_hash = account_alias_hash(&account.id);
        let usage = usage_by_id.get(account.id.as_str()).copied();
        let remaining = usage.and_then(|value| remaining_percent(value));
        let reset_at = usage
            .and_then(|value| later_reset(value))
            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        let expires = account.subscription_expires_at;
        let running =
            codex_running && store.active_account_id.as_deref() == Some(account.id.as_str());
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
        lanes.push(CapacityLane {
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
            refreshed_at: refreshed_at.clone(),
            local_read_only: false,
            availability_reason: availability_reason.to_string(),
        });
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
    let store = load_accounts().context("accounts_unavailable")?;
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
