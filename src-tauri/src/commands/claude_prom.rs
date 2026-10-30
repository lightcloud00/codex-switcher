//! Read-only Prometheus overlay for the Claude tab.
//!
//! `fleet-quota-exporter` publishes `claude_seat_*` series: seat-health state, orphaned fleet-summon
//! locks, and per window the reset time, the age of the reading and, while the reading is fresh, the
//! used percentage. This module makes one instant query against the local Prometheus and folds the
//! vector into a small snapshot the tab overlays on the claude-usage numbers.
//!
//! It never fails: an unreachable, slow, malformed or empty answer is `found: false` with a short
//! reason, and the tab then shows claude-usage alone. Nothing is written and no credentials are sent.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::time::Duration;
use url::{Host, Url};

use super::claude_usage::safe_token;

const DEFAULT_URL: &str = "http://127.0.0.1:9090";
/// Overrides the Prometheus base URL; only http(s) loopback or tailnet hosts are accepted.
const URL_ENV: &str = "CLAUDE_PROMETHEUS_URL";
const TIMEOUT: Duration = Duration::from_secs(3);
const QUERY_PATH: &str = "api/v1/query";
const SELECTOR: &str = r#"{__name__=~"claude_seat_.*"}"#;
/// The whole fleet is a few dozen series; anything larger is not the exporter's answer.
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_SAMPLES: usize = 5_000;
const MAX_SEATS: usize = 64;
const WINDOWS: [&str; 2] = ["5h", "7d"];
/// Reset timestamps after 2100-01-01 are garbage, not a reset time.
const MAX_RESET_EPOCH_S: f64 = 4_102_444_800.0;

/// One limit window of a seat. `used_pct` is set only while the exporter vouches for the reading
/// (`claude_seat_quota_known == 1`); otherwise only the reset time and the reading's age are exposed.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PromWindow {
    pub used_pct: Option<f64>,
    pub resets_at: Option<String>,
    pub age_s: Option<f64>,
    pub known: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PromSeat {
    /// The seat-health state whose series is 1 ("ok", "broken", "held", ...); the alphabetically
    /// first if several are, `None` if none is.
    pub state: Option<String>,
    pub usable: Option<bool>,
    pub lock_orphaned: bool,
    /// Always carries both "5h" and "7d".
    pub windows: BTreeMap<String, PromWindow>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PromSnapshot {
    pub found: bool,
    pub error: Option<String>,
    pub queried_at: String,
    pub seats: BTreeMap<String, PromSeat>,
}

fn stamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn unavailable(error: impl Into<String>, now: DateTime<Utc>) -> PromSnapshot {
    PromSnapshot {
        found: false,
        error: Some(error.into()),
        queried_at: stamp(now),
        seats: BTreeMap::new(),
    }
}

// ---- Endpoint -----------------------------------------------------------------------------------

fn is_tailnet_v4(ip: Ipv4Addr) -> bool {
    // Tailscale's CGNAT range, 100.64.0.0/10.
    let [a, b, ..] = ip.octets();
    a == 100 && (b & 0xC0) == 0x40
}

fn is_tailnet_v6(ip: Ipv6Addr) -> bool {
    // Tailscale's ULA prefix, fd7a:115c:a1e0::/48.
    let s = ip.segments();
    s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
}

fn host_allowed(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(ip) => ip.is_loopback() || is_tailnet_v4(*ip),
        Host::Ipv6(ip) => ip.is_loopback() || is_tailnet_v6(*ip),
        Host::Domain(name) => {
            let name = name.to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost") || name.ends_with(".ts.net")
        }
    }
}

/// The Prometheus base URL: the default, or the override when it is an http(s) loopback or tailnet
/// address without credentials. Errors never echo the override (it could carry a password).
fn prometheus_base_url(override_url: Option<&str>) -> Result<Url, String> {
    let raw = override_url.map(str::trim).filter(|v| !v.is_empty());
    let Some(raw) = raw else {
        return Url::parse(DEFAULT_URL).map_err(|e| format!("default Prometheus URL invalid: {e}"));
    };
    let invalid = || format!("{URL_ENV} must be an http(s) URL on a loopback or tailnet host");
    let url = Url::parse(raw).map_err(|_| invalid())?;
    let scheme_ok = matches!(url.scheme(), "http" | "https");
    let credentials = !url.username().is_empty() || url.password().is_some();
    let host_ok = url.host().as_ref().is_some_and(host_allowed);
    if !scheme_ok || credentials || !host_ok {
        return Err(invalid());
    }
    Ok(url)
}

/// `<base path>/api/v1/query`, with any query or fragment of the base dropped.
fn query_url(base: &Url) -> Url {
    let mut url = base.clone();
    let prefix = base.path().trim_end_matches('/');
    url.set_path(&format!("{prefix}/{QUERY_PATH}"));
    url.set_query(None);
    url.set_fragment(None);
    url
}

fn describe_failure(error: &reqwest::Error, base: &Url) -> String {
    // reqwest's own text embeds the full URL; keep it to host and port.
    let target = match (base.host_str(), base.port_or_known_default()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        _ => "the configured address".to_string(),
    };
    if error.is_timeout() {
        format!(
            "Prometheus at {target} did not answer within {}s",
            TIMEOUT.as_secs()
        )
    } else if error.is_connect() {
        format!("Prometheus is not reachable at {target}")
    } else {
        format!("Prometheus request to {target} failed")
    }
}

async fn query_body(base: &Url) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        // A loopback/tailnet endpoint must not be redirected elsewhere or sent through a proxy.
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| "could not build the Prometheus client".to_string())?;
    let mut response = client
        .get(query_url(base))
        .query(&[("query", SELECTOR)])
        .send()
        .await
        .map_err(|e| describe_failure(&e, base))?;
    if !response.status().is_success() {
        return Err(format!(
            "Prometheus answered HTTP {}",
            response.status().as_u16()
        ));
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| describe_failure(&e, base))?
    {
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err("Prometheus answer is too large".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| "Prometheus answer is not UTF-8".to_string())
}

// ---- Parsing ------------------------------------------------------------------------------------

/// The sample value as a finite number. Prometheus sends it as a string ("0.5", "NaN", "+Inf").
fn sample_value(sample: &Value) -> Option<f64> {
    let raw = sample.get("value")?.as_array()?.get(1)?;
    let number = match raw {
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    number.is_finite().then_some(number)
}

fn reset_time(epoch_s: f64) -> Option<String> {
    if epoch_s <= 0.0 || epoch_s >= MAX_RESET_EPOCH_S {
        return None;
    }
    DateTime::<Utc>::from_timestamp(epoch_s.floor() as i64, 0).map(stamp)
}

#[derive(Default)]
struct SeatAcc {
    states: BTreeSet<String>,
    usable: Option<bool>,
    lock_orphaned: bool,
    windows: BTreeMap<&'static str, WindowAcc>,
}

#[derive(Default)]
struct WindowAcc {
    used: Option<f64>,
    resets_at: Option<String>,
    age_s: Option<f64>,
    known: bool,
}

/// Fold an instant-query answer into a snapshot. `Err` only for an answer that is not a Prometheus
/// vector at all; individual bad samples are skipped.
fn parse_prom_vector(body: &str, now: DateTime<Utc>) -> Result<PromSnapshot, String> {
    let value: Value = serde_json::from_str(body.trim())
        .map_err(|_| "Prometheus returned invalid JSON".to_string())?;
    if value.get("status").and_then(Value::as_str) != Some("success") {
        let kind = value
            .get("errorType")
            .and_then(Value::as_str)
            .filter(|k| safe_token(&k.to_ascii_lowercase()))
            .unwrap_or("unknown");
        return Err(format!("Prometheus query failed ({kind})"));
    }
    let data = value
        .get("data")
        .ok_or_else(|| "Prometheus answer has no data".to_string())?;
    if data.get("resultType").and_then(Value::as_str) != Some("vector") {
        return Err("Prometheus answer is not an instant vector".to_string());
    }
    let samples = data
        .get("result")
        .and_then(Value::as_array)
        .ok_or_else(|| "Prometheus answer has no result".to_string())?;

    let mut accs: BTreeMap<String, SeatAcc> = BTreeMap::new();
    for sample in samples.iter().take(MAX_SAMPLES) {
        let Some(metric) = sample.get("metric").and_then(Value::as_object) else {
            continue;
        };
        let label = |key: &str| metric.get(key).and_then(Value::as_str);
        let Some(name) = label("__name__").filter(|n| n.starts_with("claude_seat_")) else {
            continue;
        };
        let Some(seat) = label("seat").filter(|s| safe_token(s)) else {
            continue;
        };
        let Some(number) = sample_value(sample) else {
            continue;
        };
        if !accs.contains_key(seat) && accs.len() >= MAX_SEATS {
            continue;
        }
        let acc = accs.entry(seat.to_string()).or_default();
        let window = label("window").and_then(|w| WINDOWS.iter().copied().find(|k| *k == w));
        match (name, window) {
            ("claude_seat_state", _) => {
                if let Some(state) = label("state").filter(|s| safe_token(s)) {
                    if number == 1.0 {
                        acc.states.insert(state.to_string());
                    }
                }
            }
            ("claude_seat_usable", _) => acc.usable = Some(number == 1.0),
            ("claude_seat_lock_orphaned", _) => acc.lock_orphaned = number == 1.0,
            ("claude_seat_used_percent", Some(w)) => {
                acc.windows.entry(w).or_default().used = Some(number.clamp(0.0, 100.0));
            }
            ("claude_seat_reset_timestamp_seconds", Some(w)) => {
                acc.windows.entry(w).or_default().resets_at = reset_time(number);
            }
            ("claude_seat_observation_age_seconds", Some(w)) if number >= 0.0 => {
                acc.windows.entry(w).or_default().age_s = Some(number);
            }
            ("claude_seat_quota_known", Some(w)) => {
                acc.windows.entry(w).or_default().known = number == 1.0;
            }
            _ => {}
        }
    }

    let seats = accs
        .into_iter()
        .map(|(id, acc)| {
            let windows = WINDOWS
                .iter()
                .map(|key| {
                    let w = acc.windows.get(key);
                    let known = w.is_some_and(|w| w.known);
                    let window = PromWindow {
                        // Only a reading the exporter vouches for is a number worth showing.
                        used_pct: w.and_then(|w| w.used).filter(|_| known),
                        resets_at: w.and_then(|w| w.resets_at.clone()),
                        age_s: w.and_then(|w| w.age_s),
                        known,
                    };
                    (key.to_string(), window)
                })
                .collect();
            let seat = PromSeat {
                state: acc.states.into_iter().next(),
                usable: acc.usable,
                lock_orphaned: acc.lock_orphaned,
                windows,
            };
            (id, seat)
        })
        .collect();
    Ok(PromSnapshot {
        found: true,
        error: None,
        queried_at: stamp(now),
        seats,
    })
}

// ---- Command ------------------------------------------------------------------------------------

async fn snapshot_from(base: &Url, now: DateTime<Utc>) -> PromSnapshot {
    match query_body(base)
        .await
        .and_then(|body| parse_prom_vector(&body, now))
    {
        Ok(snapshot) => snapshot,
        Err(error) => unavailable(error, now),
    }
}

async fn snapshot(override_url: Option<&str>, now: DateTime<Utc>) -> PromSnapshot {
    match prometheus_base_url(override_url) {
        Ok(base) => snapshot_from(&base, now).await,
        Err(error) => unavailable(error, now),
    }
}

/// The `get_claude_prometheus` payload (a `PromSnapshot`). Never fails; an unreachable Prometheus is
/// data (`found: false`), so the Claude tab keeps working on claude-usage alone.
pub async fn fetch_claude_prometheus() -> Result<Value, String> {
    let now = Utc::now();
    let env_url = std::env::var(URL_ENV).ok();
    let snapshot = snapshot(env_url.as_deref(), now).await;
    Ok(serde_json::to_value(&snapshot).unwrap_or_else(|_| {
        json!({
            "found": false,
            "error": "could not encode the Prometheus snapshot",
            "queried_at": stamp(now),
            "seats": {},
        })
    }))
}

#[tauri::command]
pub async fn get_claude_prometheus() -> Result<Value, String> {
    fetch_claude_prometheus().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// 2026-10-30T12:34:23Z, the instant (1793363663) the live values below were read.
    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 30, 12, 34, 23).unwrap()
    }

    fn sample(name: &str, seat: &str, window: Option<&str>, value: &str) -> Value {
        let mut metric = json!({ "__name__": name, "seat": seat, "job": "aos-textfile" });
        if let Some(window) = window {
            metric["window"] = json!(window);
        }
        json!({ "metric": metric, "value": [1793363663.741, value] })
    }

    fn state(seat: &str, which: &str, value: &str) -> Value {
        let mut s = sample("claude_seat_state", seat, None, value);
        s["metric"]["state"] = json!(which);
        s
    }

    fn vector(samples: Vec<Value>) -> String {
        json!({"status": "success", "data": {"resultType": "vector", "result": samples}})
            .to_string()
    }

    /// Live values: mac-gustavo reads 9% / 61% and is "broken" by an orphaned lock; mac-main has an
    /// 11-day-old reading, no vouched quota and is broken; windows is healthy.
    fn live_body() -> String {
        vector(vec![
            sample(
                "claude_seat_used_percent",
                "claude-mac-gustavo",
                Some("5h"),
                "9",
            ),
            sample(
                "claude_seat_used_percent",
                "claude-mac-gustavo",
                Some("7d"),
                "61",
            ),
            sample(
                "claude_seat_quota_known",
                "claude-mac-gustavo",
                Some("5h"),
                "1",
            ),
            sample(
                "claude_seat_quota_known",
                "claude-mac-gustavo",
                Some("7d"),
                "1",
            ),
            sample(
                "claude_seat_reset_timestamp_seconds",
                "claude-mac-gustavo",
                Some("5h"),
                "1793365800",
            ),
            sample(
                "claude_seat_reset_timestamp_seconds",
                "claude-mac-gustavo",
                Some("7d"),
                "1793822340",
            ),
            sample(
                "claude_seat_observation_age_seconds",
                "claude-mac-gustavo",
                Some("5h"),
                "263.5",
            ),
            sample(
                "claude_seat_observation_age_seconds",
                "claude-mac-gustavo",
                Some("7d"),
                "263.5",
            ),
            state("claude-mac-gustavo", "ok", "0"),
            state("claude-mac-gustavo", "broken", "1"),
            sample("claude_seat_usable", "claude-mac-gustavo", None, "0"),
            sample("claude_seat_lock_orphaned", "claude-mac-gustavo", None, "1"),
            // mac-main: a stale number the exporter does not vouch for must not surface.
            sample(
                "claude_seat_used_percent",
                "claude-mac-main",
                Some("7d"),
                "40",
            ),
            sample(
                "claude_seat_quota_known",
                "claude-mac-main",
                Some("5h"),
                "0",
            ),
            sample(
                "claude_seat_quota_known",
                "claude-mac-main",
                Some("7d"),
                "0",
            ),
            sample(
                "claude_seat_reset_timestamp_seconds",
                "claude-mac-main",
                Some("7d"),
                "1792879200",
            ),
            sample(
                "claude_seat_observation_age_seconds",
                "claude-mac-main",
                Some("5h"),
                "953528",
            ),
            sample(
                "claude_seat_observation_age_seconds",
                "claude-mac-main",
                Some("7d"),
                "953528",
            ),
            state("claude-mac-main", "ok", "0"),
            state("claude-mac-main", "broken", "1"),
            sample("claude_seat_lock_orphaned", "claude-mac-main", None, "0"),
            sample("claude_seat_state", "claude-windows", None, "1"),
            sample(
                "claude_seat_pool_spend_today_usd",
                "claude-windows",
                None,
                "0.2746",
            ),
        ])
    }

    #[test]
    fn live_values_fold_into_one_snapshot_per_seat() {
        let snap = parse_prom_vector(&live_body(), now()).expect("parses");
        assert!(snap.found);
        assert_eq!(snap.error, None);
        assert_eq!(snap.queried_at, "2026-10-30T12:34:23Z");
        let ids: Vec<&str> = snap.seats.keys().map(String::as_str).collect();
        assert_eq!(
            ids,
            ["claude-mac-gustavo", "claude-mac-main", "claude-windows"]
        );

        let gustavo = &snap.seats["claude-mac-gustavo"];
        assert_eq!(gustavo.state.as_deref(), Some("broken"));
        assert_eq!(gustavo.usable, Some(false));
        assert!(gustavo.lock_orphaned);
        assert_eq!(
            gustavo.windows["5h"],
            PromWindow {
                used_pct: Some(9.0),
                resets_at: Some("2026-10-30T13:10:00Z".to_string()),
                age_s: Some(263.5),
                known: true,
            }
        );
        assert_eq!(gustavo.windows["7d"].used_pct, Some(61.0));
        assert_eq!(
            gustavo.windows["7d"].resets_at.as_deref(),
            Some("2026-11-04T19:59:00Z")
        );

        // A reading nobody vouches for exposes only its reset and its age.
        let main = &snap.seats["claude-mac-main"];
        assert_eq!(main.state.as_deref(), Some("broken"));
        assert!(!main.lock_orphaned);
        assert_eq!(main.usable, None);
        assert_eq!(main.windows["7d"].used_pct, None);
        assert!(!main.windows["7d"].known);
        assert_eq!(main.windows["7d"].age_s, Some(953528.0));
        assert_eq!(
            main.windows["7d"].resets_at.as_deref(),
            Some("2026-10-24T22:00:00Z")
        );
        assert_eq!(main.windows["5h"].resets_at, None);

        // A seat with no window series still carries both (empty) windows.
        let windows = &snap.seats["claude-windows"];
        assert_eq!(windows.state.as_deref(), None);
        assert_eq!(windows.windows.len(), 2);
        assert_eq!(windows.windows["5h"], PromWindow::default());
    }

    #[test]
    fn values_are_validated_and_clamped() {
        let body = vector(vec![
            sample("claude_seat_used_percent", "claude-a", Some("5h"), "140"),
            sample("claude_seat_quota_known", "claude-a", Some("5h"), "1"),
            sample("claude_seat_used_percent", "claude-a", Some("7d"), "-5"),
            sample("claude_seat_quota_known", "claude-a", Some("7d"), "1"),
            // Not finite, negative age, absurd reset, unknown window, bad seat id, foreign metric.
            sample("claude_seat_used_percent", "claude-b", Some("5h"), "NaN"),
            sample("claude_seat_quota_known", "claude-b", Some("5h"), "1"),
            sample(
                "claude_seat_observation_age_seconds",
                "claude-b",
                Some("5h"),
                "-3",
            ),
            sample(
                "claude_seat_observation_age_seconds",
                "claude-b",
                Some("7d"),
                "+Inf",
            ),
            sample(
                "claude_seat_reset_timestamp_seconds",
                "claude-b",
                Some("5h"),
                "99999999999999",
            ),
            sample(
                "claude_seat_reset_timestamp_seconds",
                "claude-b",
                Some("7d"),
                "0",
            ),
            sample("claude_seat_used_percent", "claude-b", Some("30d"), "50"),
            sample("claude_seat_used_percent", "Claude C!", Some("5h"), "50"),
            sample("claude_seat_used_percent", "", Some("5h"), "50"),
            sample("node_cpu_seconds_total", "claude-d", Some("5h"), "50"),
            json!({"metric": {"__name__": "claude_seat_usable"}, "value": [1, "1"]}),
            json!({"metric": {"__name__": "claude_seat_usable", "seat": "claude-e"}, "value": "oops"}),
            json!({"metric": {"__name__": "claude_seat_usable", "seat": "claude-e"}, "value": [1, null]}),
            json!("not a sample"),
        ]);
        let snap = parse_prom_vector(&body, now()).unwrap();
        let ids: Vec<&str> = snap.seats.keys().map(String::as_str).collect();
        assert_eq!(ids, ["claude-a", "claude-b"]);
        assert_eq!(snap.seats["claude-a"].windows["5h"].used_pct, Some(100.0));
        assert_eq!(snap.seats["claude-a"].windows["7d"].used_pct, Some(0.0));
        let b = &snap.seats["claude-b"];
        assert_eq!(b.windows["5h"].used_pct, None);
        assert_eq!(b.windows["5h"].age_s, None);
        assert_eq!(b.windows["5h"].resets_at, None);
        assert_eq!(b.windows["7d"].age_s, None);
        assert_eq!(b.windows["7d"].resets_at, None);
    }

    #[test]
    fn the_state_is_the_series_that_is_one() {
        let one = vector(vec![
            state("claude-a", "ok", "0"),
            state("claude-a", "held", "1"),
        ]);
        let snap = parse_prom_vector(&one, now()).unwrap();
        assert_eq!(snap.seats["claude-a"].state.as_deref(), Some("held"));
        let none = vector(vec![
            state("claude-a", "ok", "0"),
            state("claude-a", "held", "0"),
        ]);
        let snap = parse_prom_vector(&none, now()).unwrap();
        assert_eq!(snap.seats["claude-a"].state, None);
        // A state label that is not a plain token is ignored rather than shown.
        let odd = vector(vec![state("claude-a", "<script>", "1")]);
        let snap = parse_prom_vector(&odd, now()).unwrap();
        assert_eq!(snap.seats["claude-a"].state, None);
    }

    #[test]
    fn an_empty_vector_is_an_answer_without_seats() {
        let snap = parse_prom_vector(&vector(Vec::new()), now()).unwrap();
        assert!(snap.found);
        assert!(snap.seats.is_empty());
    }

    #[test]
    fn a_malformed_answer_is_an_error_not_a_panic() {
        for body in [
            "",
            "not json",
            "<html>502 Bad Gateway</html>",
            "[]",
            r#"{"status":"success"}"#,
            r#"{"status":"success","data":{"resultType":"matrix","result":[]}}"#,
            r#"{"status":"success","data":{"resultType":"vector"}}"#,
            r#"{"status":"success","data":{"resultType":"vector","result":"x"}}"#,
        ] {
            assert!(parse_prom_vector(body, now()).is_err(), "{body:?}");
        }
        let failed =
            r#"{"status":"error","errorType":"bad_data","error":"parse error at <secret>"}"#;
        let message = parse_prom_vector(failed, now()).unwrap_err();
        assert_eq!(message, "Prometheus query failed (bad_data)");
        let odd = r#"{"status":"error","errorType":"x y\nz","error":"boom"}"#;
        assert_eq!(
            parse_prom_vector(odd, now()).unwrap_err(),
            "Prometheus query failed (unknown)"
        );
    }

    #[test]
    fn the_endpoint_is_loopback_by_default_and_overridable_only_to_loopback_or_tailnet() {
        let base = |v: Option<&str>| prometheus_base_url(v).map(|u| u.to_string());
        assert_eq!(base(None).unwrap(), "http://127.0.0.1:9090/");
        assert_eq!(base(Some("  ")).unwrap(), "http://127.0.0.1:9090/");
        for ok in [
            "http://127.0.0.1:9091",
            "http://127.9.9.9",
            "http://[::1]:9090",
            "http://localhost:9090",
            "http://prom.localhost:9090",
            "http://100.64.0.1:9090",
            "http://100.101.102.103:9090/prometheus",
            "http://100.127.255.254",
            "https://mac.tail1234.ts.net",
            "http://[fd7a:115c:a1e0::1]:9090",
        ] {
            assert!(base(Some(ok)).is_ok(), "{ok} should be accepted");
        }
        for bad in [
            "http://example.com:9090",
            "http://localhost.example.com:9090",
            "http://evil-ts.net",
            "http://192.168.1.5:9090",
            "http://10.0.0.1:9090",
            "http://100.63.255.255",
            "http://100.128.0.1",
            "http://8.8.8.8",
            "http://[2001:db8::1]:9090",
            "http://[fd7a:115c:a1e1::1]:9090",
            "ftp://127.0.0.1:9090",
            "file:///etc/passwd",
            "http://user:secret@127.0.0.1:9090",
            "127.0.0.1:9090",
            "not a url",
        ] {
            let error = base(Some(bad)).expect_err(bad);
            assert!(error.contains(URL_ENV), "{bad}: {error}");
            assert!(!error.contains("secret"), "{bad} leaked: {error}");
        }
    }

    #[test]
    fn the_query_targets_the_instant_query_api_under_the_base_path() {
        let plain = query_url(&Url::parse("http://127.0.0.1:9090").unwrap());
        assert_eq!(plain.as_str(), "http://127.0.0.1:9090/api/v1/query");
        let prefixed = query_url(&Url::parse("http://100.64.0.1:9090/prom/?x=1#frag").unwrap());
        assert_eq!(
            prefixed.as_str(),
            "http://100.64.0.1:9090/prom/api/v1/query"
        );
    }

    /// Serve one canned HTTP answer on a free loopback port; the receiver yields the request text.
    async fn serve_once(
        status: &str,
        body: String,
    ) -> (Url, tokio::sync::oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0u8; 8192];
                let read = socket.read(&mut buf).await.unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..read]).into_owned());
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        (url, rx)
    }

    #[tokio::test]
    async fn a_live_answer_becomes_a_found_snapshot() {
        let (base, request) = serve_once("200 OK", live_body()).await;
        let snap = snapshot_from(&base, now()).await;
        assert!(snap.found, "{:?}", snap.error);
        assert_eq!(
            snap.seats["claude-mac-gustavo"].windows["7d"].used_pct,
            Some(61.0)
        );
        let request = request.await.unwrap();
        let first_line = request.lines().next().unwrap_or("");
        assert!(
            first_line.starts_with("GET /api/v1/query?query="),
            "{first_line}"
        );
        assert!(first_line.contains("claude_seat_"), "{first_line}");
    }

    #[tokio::test]
    async fn a_refused_connection_is_found_false_not_an_error() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            listener.local_addr().unwrap().port()
        };
        let base = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let snap = snapshot_from(&base, now()).await;
        assert!(!snap.found);
        assert!(snap.seats.is_empty());
        let error = snap.error.expect("reason");
        assert!(error.contains("not reachable"), "{error}");
        assert!(error.contains(&port.to_string()), "{error}");
        assert!(!error.contains("api/v1"), "the URL leaked: {error}");
    }

    #[tokio::test]
    async fn a_malformed_or_failing_server_is_found_false() {
        let (base, _) = serve_once("200 OK", "<html>not prometheus</html>".to_string()).await;
        let snap = snapshot_from(&base, now()).await;
        assert!(!snap.found);
        assert_eq!(
            snap.error.as_deref(),
            Some("Prometheus returned invalid JSON")
        );

        let (base, _) = serve_once("503 Service Unavailable", "{}".to_string()).await;
        let snap = snapshot_from(&base, now()).await;
        assert!(!snap.found);
        assert_eq!(snap.error.as_deref(), Some("Prometheus answered HTTP 503"));
    }

    #[tokio::test]
    async fn a_rejected_override_is_found_false_without_any_request() {
        let snap = snapshot(Some("http://example.com:9090"), now()).await;
        assert!(!snap.found);
        assert!(snap.error.is_some_and(|e| e.contains(URL_ENV)));
    }

    #[tokio::test]
    async fn the_command_payload_has_the_shape_the_tab_reads() {
        let (base, _) = serve_once("200 OK", live_body()).await;
        let value = serde_json::to_value(snapshot_from(&base, now()).await).unwrap();
        assert_eq!(value["found"], true);
        assert_eq!(value["error"], Value::Null);
        assert_eq!(value["queried_at"], "2026-10-30T12:34:23Z");
        let gustavo = &value["seats"]["claude-mac-gustavo"];
        assert_eq!(gustavo["state"], "broken");
        assert_eq!(gustavo["lock_orphaned"], true);
        assert_eq!(gustavo["windows"]["5h"]["used_pct"], 9.0);
        assert_eq!(gustavo["windows"]["7d"]["known"], true);
        assert_eq!(
            value["seats"]["claude-mac-main"]["windows"]["5h"]["used_pct"],
            Value::Null
        );
    }

    /// Reads the real local Prometheus. `cargo test -- --ignored live_prometheus`.
    #[tokio::test]
    #[ignore]
    async fn live_prometheus() {
        let value = fetch_claude_prometheus().await.expect("never fails");
        println!("{value:#}");
        assert!(value["found"].is_boolean());
    }
}
