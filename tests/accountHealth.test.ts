import assert from "node:assert/strict";
import test from "node:test";
import type { AccountWithUsage, UsageInfo } from "../src/types/index.ts";
import { accountHealth, assessUsage, lastCheckedText, USAGE_FRESHNESS_MS, validDate } from "../src/lib/accountHealth.ts";

const NOW = Date.parse("2026-11-26T20:00:00Z");
const FUTURE_RESET = NOW / 1000 + 3600;

function usage(over: Partial<UsageInfo> = {}): UsageInfo {
  return {
    account_id: "test-account", plan_type: "pro",
    primary_used_percent: 25, primary_window_minutes: 300, primary_resets_at: FUTURE_RESET,
    secondary_used_percent: 50, secondary_window_minutes: 10080, secondary_resets_at: FUTURE_RESET + 86400,
    has_credits: null, unlimited_credits: null, credits_balance: null, error: null,
    ...over,
  };
}

function account(over: Partial<AccountWithUsage> = {}): AccountWithUsage {
  return {
    id: "test-account", name: "Test", email: "test@example.com", plan_type: "pro",
    auth_mode: "chat_g_p_t", is_active: false, subscription_expires_at: "2026-12-06T20:00:00Z",
    created_at: "2026-01-01T00:00:00Z", last_used_at: null, usage: usage(), usageCheckedAt: NOW,
    ...over,
  };
}

test("ready and exhausted require a current valid quota reading", () => {
  assert.equal(accountHealth(account(), NOW).state, "ready");
  for (const changed of [{ primary_used_percent: 100 }, { secondary_used_percent: 100 }]) {
    const health = accountHealth(account({ usage: usage(changed) }), NOW);
    assert.equal(health.state, "exhausted");
    assert.equal(health.label, "Quota exhausted");
  }
  assert.equal(accountHealth(account({ usage: usage({ primary_used_percent: null }) }), NOW).state, "ready");
  assert.equal(accountHealth(account({ usage: usage({ primary_used_percent: null, secondary_used_percent: null }) }), NOW).state, "unknown");
});

test("old or reset-passed quota is stale even if its last value was exhausted", () => {
  assert.equal(accountHealth(account({ usageCheckedAt: NOW - USAGE_FRESHNESS_MS }), NOW).state, "ready");
  assert.equal(accountHealth(account({ usageCheckedAt: NOW - USAGE_FRESHNESS_MS - 1 }), NOW).state, "stale");
  for (const changed of [
    { primary_used_percent: 100, primary_resets_at: NOW / 1000 },
    { secondary_used_percent: 100, secondary_resets_at: NOW / 1000 - 1 },
  ]) {
    const reading = assessUsage(usage(changed), NOW, NOW);
    assert.equal(reading.state, "stale");
    assert.equal(reading.valid, true);
    assert.equal(accountHealth(account({ usage: usage(changed) }), NOW).state, "stale");
  }
});

test("missing and invalid check timestamps never become a fresh reading", () => {
  for (const checkedAt of [undefined, NaN, Infinity, 0, -1, NOW + 1]) {
    const reading = assessUsage(usage(), checkedAt, NOW);
    assert.equal(reading.state, "unknown", String(checkedAt));
    assert.equal(reading.valid, true);
    assert.equal(accountHealth(account({ usageCheckedAt: checkedAt }), NOW).state, "unknown");
    assert.equal(lastCheckedText(checkedAt, NOW), "Unknown");
  }
});

test("last checked uses the recorded backend time, including failed attempts", () => {
  assert.equal(lastCheckedText(NOW, NOW), "Just now");
  assert.equal(lastCheckedText(NOW - 30_000, NOW), "30s ago");
  assert.equal(lastCheckedText(NOW - 5 * 60_000, NOW), "5m ago");
  assert.equal(lastCheckedText(NOW - 2 * 3600_000, NOW), "2h ago");
  const failed = account({ usage: usage({ error: "Network timeout" }), usageCheckedAt: NOW - 60_000 });
  assert.equal(accountHealth(failed, NOW).state, "unknown");
  assert.equal(lastCheckedText(failed.usageCheckedAt, NOW), "1m ago");
});

test("malformed usage percentages and reset dates are never rendered as allowance", () => {
  for (const used of [NaN, Infinity, -1, 101]) {
    const reading = assessUsage(usage({ primary_used_percent: used }), NOW, NOW);
    assert.equal(reading.state, "unknown");
    assert.equal(reading.valid, false);
  }
  for (const reset of [NaN, Infinity, -1, 0, 1e20]) {
    assert.equal(assessUsage(usage({ secondary_resets_at: reset }), NOW, NOW).valid, false);
  }
  assert.equal(assessUsage(usage({ primary_resets_at: null, secondary_resets_at: null }), NOW, NOW).state, "current");
});

test("a missing window does not contribute a stale reset", () => {
  const reading = assessUsage(usage({ primary_used_percent: null, primary_resets_at: NOW / 1000 - 1 }), NOW, NOW);
  assert.equal(reading.state, "current");
});

test("subscription expiry is distinct from session expiry and malformed dates are safe", () => {
  const ended = accountHealth(account({ subscription_expires_at: "2026-11-26T20:00:00Z" }), NOW);
  assert.equal(ended.state, "expired");
  assert.equal(ended.label, "Subscription expired");
  const session = accountHealth(account({ usage: usage({ error: "Token refresh failed: refresh_token_expired" }) }), NOW);
  assert.equal(session.state, "expired");
  assert.equal(session.label, "Session expired");
  assert.equal(validDate("not-a-date"), null);
  assert.equal(validDate(null), null);
  assert.equal(accountHealth(account({ subscription_expires_at: "not-a-date" }), NOW).state, "unknown");
  assert.equal(accountHealth(account({ subscription_expires_at: null }), NOW).state, "ready");
});

test("terminal refresh failures require authentication but generic 401 and network failures do not", () => {
  for (const error of ["refresh_token_reused", "refresh_token_invalidated", "invalid_grant", "Missing refresh token for account"]) {
    assert.equal(accountHealth(account({ usage: usage({ error }) }), NOW).state, "auth_required", error);
  }
  for (const error of ["API error: 401 Unauthorized", "Network timeout", "API error: 403 Forbidden", "API error: 429 Too Many Requests"]) {
    assert.equal(accountHealth(account({ usage: usage({ error }) }), NOW).state, "unknown", error);
  }
});

test("API-key subscription quota is unsupported without implying a failed API credential", () => {
  const health = accountHealth(account({ auth_mode: "api_key", usage: undefined, usageCheckedAt: undefined }), NOW);
  assert.equal(health.state, "unsupported");
  assert.equal(health.label, "Quota unsupported");
  assert.equal(health.tone, "muted");
});
