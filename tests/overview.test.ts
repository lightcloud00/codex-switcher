import assert from "node:assert/strict";
import test from "node:test";
import type { ApiCreditRow } from "../src/lib/apiCredits.ts";
import {
  apiLeftText,
  apiPlanId,
  buildApiCreditRows,
  buildClaudeRows,
  buildCodexRows,
  claudeSeatsFromSources,
  codexExpiryText,
  isCodexAccountInactive,
  isSubscriptionExpired,
  leftText,
  NONE,
  PREPAID_RESETS,
  planDatesExpired,
  planDatesText,
  sortOverviewRows,
  type OverviewRow,
} from "../src/lib/overview.ts";
import type { PlanDates } from "../src/lib/providerAccess.ts";
import type { AccountWithUsage, ClaudeSeat, ClaudeUsageWindow, UsageInfo } from "../src/types/index.ts";

// Local noon, so the date-only plan dates (read in the user's time zone) behave the same everywhere.
const NOW = new Date(2026, 9, 30, 12, 0, 0).getTime();
const NOW_DATE = new Date(NOW);
const inMs = (ms: number) => NOW + ms;
const unix = (ms: number) => Math.floor(ms / 1000);
const HOUR = 3600 * 1000;

function account(over: Partial<AccountWithUsage> = {}): AccountWithUsage {
  return {
    id: "a1",
    name: "work",
    email: "work@example.com",
    plan_type: "pro",
    subscription_expires_at: "2026-12-04T00:00:00Z",
    auth_mode: "chat_g_p_t",
    is_active: false,
    created_at: "2026-01-01T00:00:00Z",
    last_used_at: null,
    ...over,
  };
}

function usage(over: Partial<UsageInfo> = {}): UsageInfo {
  return {
    account_id: "a1",
    plan_type: "pro",
    primary_used_percent: 38,
    primary_window_minutes: 300,
    primary_resets_at: unix(inMs(HOUR + 18 * 60 * 1000)),
    secondary_used_percent: null,
    secondary_window_minutes: null,
    secondary_resets_at: null,
    has_credits: null,
    unlimited_credits: null,
    credits_balance: null,
    error: null,
    ...over,
  };
}

function week(over: Partial<ClaudeUsageWindow> = {}): ClaudeUsageWindow {
  return {
    used_pct: 41,
    last_used_pct: 41,
    resets_at: new Date(inMs(26 * HOUR)).toISOString(),
    observed_at: new Date(NOW).toISOString(),
    age_s: 60,
    state: "current",
    source: "usage",
    ...over,
  };
}

function seat(over: Partial<ClaudeSeat> = {}): ClaudeSeat {
  return {
    id: "claude-mac-main",
    host: "mac",
    plan: "max",
    email: "main@example.com",
    usageAccount: "mac-main-max",
    fiveHour: null,
    sevenDay: week(),
    modelWeeks: {},
    poolSpendTodayUsd: null,
    probeError: null,
    status: "ok",
    launcher: "claude-main",
    inRegistry: true,
    promState: null,
    lockOrphaned: false,
    lastReadAgeS: 60,
    unknownReason: null,
    ...over,
  };
}

function credit(over: Partial<ApiCreditRow> = {}): ApiCreditRow {
  return {
    id: "deepseek",
    label: "DeepSeek API",
    credential: "deepseek_api_key",
    dashboard: "https://platform.deepseek.com/usage",
    observed_at: "2026-10-30T13:30:16Z",
    available: true,
    email: "ds@example.com",
    balance: { currency: "USD", total: "55.94", granted: "3.96", topped_up: "51.98" },
    ...over,
  };
}

function dates(id: string, over: Partial<PlanDates> = {}): PlanDates {
  return { id, billingRenewsOn: null, creditExpiresOn: null, credentialExpiresOn: null, ...over };
}

function row(over: Partial<OverviewRow> = {}): OverviewRow {
  return {
    id: "r",
    account: "x@example.com",
    type: "Codex Pro",
    left: "50%",
    resets: NONE,
    renews: NONE,
    status: "active",
    tone: "ok",
    inactive: false,
    ...over,
  };
}

test("left text shows the percent left, clamped, and a dash with no reading", () => {
  assert.equal(leftText(38), "62%");
  assert.equal(leftText(0), "100%");
  assert.equal(leftText(99.6), "0%");
  assert.equal(leftText(120), "0%");
  assert.equal(leftText(-5), "100%");
  assert.equal(leftText(null), NONE);
  assert.equal(leftText(undefined), NONE);
  assert.equal(leftText(Number.NaN), NONE);
});

test("API left text is the balance when there is one and 'see billing' when the balance is null", () => {
  assert.equal(apiLeftText(credit()), "$55.94");
  assert.equal(apiLeftText(credit({ balance: { currency: "USD", total: "5.00" } })), "$5.00");
  assert.equal(apiLeftText(credit({ balance: { currency: "CNY", total: "12.00", granted: "2.00" } })), "CNY 12.00");
  assert.equal(apiLeftText(credit({ balance: null, balance_note: "no balance API" })), "see billing");
  assert.equal(apiLeftText(credit({ balance: undefined })), "see billing");
  // A failed probe row never shows the balance it may still carry.
  assert.equal(apiLeftText(credit({ error: "http_500" })), "see billing");
});

test("a subscription is expired at or after its end and never from a missing or bad date", () => {
  assert.equal(isSubscriptionExpired("2026-10-29T00:00:00Z", NOW), true);
  assert.equal(isSubscriptionExpired(new Date(NOW).toISOString(), NOW), true);
  assert.equal(isSubscriptionExpired(new Date(NOW + 1000).toISOString(), NOW), false);
  assert.equal(isSubscriptionExpired(null, NOW), false);
  assert.equal(isSubscriptionExpired(undefined, NOW), false);
  assert.equal(isSubscriptionExpired("", NOW), false);
  assert.equal(isSubscriptionExpired("not a date", NOW), false);
});

test("the Codex tab moves an account to Inactive only when its subscription date has passed", () => {
  assert.equal(isCodexAccountInactive(account({ subscription_expires_at: "2026-10-01T00:00:00Z" }), NOW), true);
  assert.equal(isCodexAccountInactive(account({ plan_type: "free", subscription_expires_at: "2026-10-01T00:00:00Z" }), NOW), true);
  assert.equal(isCodexAccountInactive(account({ subscription_expires_at: "2026-12-04T00:00:00Z" }), NOW), false);
  assert.equal(isCodexAccountInactive(account({ plan_type: "free", subscription_expires_at: null }), NOW), false);
});

test("Codex expiry text uses the card's Until / Expired wording", () => {
  const format = (iso: string) =>
    new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
  assert.equal(codexExpiryText("2026-12-04T00:00:00Z", NOW), `Until ${format("2026-12-04T00:00:00Z")}`);
  assert.equal(codexExpiryText("2026-10-01T00:00:00Z", NOW), `Expired ${format("2026-10-01T00:00:00Z")}`);
  assert.equal(codexExpiryText(null, NOW), NONE);
  assert.equal(codexExpiryText("nope", NOW), NONE);
});

test("a Codex row carries email, plan, percent left, reset, expiry and an active status", () => {
  const [r] = buildCodexRows([account({ usage: usage() })], NOW);
  assert.equal(r.account, "work@example.com");
  assert.equal(r.detail, "work");
  assert.equal(r.maskId, "a1");
  assert.equal(r.type, "Codex Pro");
  assert.equal(r.left, "62%");
  assert.equal(r.resets, "in 1h 18m");
  assert.equal(r.renews, codexExpiryText("2026-12-04T00:00:00Z", NOW));
  assert.equal(r.status, "active");
  assert.equal(r.tone, "ok");
  assert.equal(r.inactive, false);
});

test("a Codex row falls back to the name without an email and reads the plan from the account", () => {
  const [named] = buildCodexRows([account({ email: null, name: "spare", plan_type: "plus" })], NOW);
  assert.equal(named.account, "spare");
  assert.equal(named.detail, undefined);
  assert.equal(named.type, "Codex Plus");
  const [same] = buildCodexRows([account({ email: "a@example.com", name: "a@example.com" })], NOW);
  assert.equal(same.detail, undefined);
  const [key] = buildCodexRows([account({ plan_type: null, auth_mode: "api_key", email: null })], NOW);
  assert.equal(key.type, "Codex API Key");
  const [unknown] = buildCodexRows([account({ plan_type: null })], NOW);
  assert.equal(unknown.type, "Codex Unknown");
});

test("Codex left and reset come from the window with the least left", () => {
  const weekly = unix(inMs(52 * HOUR));
  const [r] = buildCodexRows(
    [account({ usage: usage({ primary_used_percent: 10, secondary_used_percent: 90, secondary_resets_at: weekly }) })],
    NOW,
  );
  assert.equal(r.left, "10%");
  assert.equal(r.resets, "in 2d 4h");
  // Only a weekly window (a free plan): that window is the reading.
  const [only] = buildCodexRows(
    [account({ usage: usage({ primary_used_percent: null, primary_resets_at: null, secondary_used_percent: 25, secondary_resets_at: weekly }) })],
    NOW,
  );
  assert.equal(only.left, "75%");
  assert.equal(only.resets, "in 2d 4h");
  // A tie goes to the primary window.
  const [tie] = buildCodexRows(
    [account({ usage: usage({ primary_used_percent: 50, secondary_used_percent: 50, secondary_resets_at: weekly }) })],
    NOW,
  );
  assert.equal(tie.resets, "in 1h 18m");
});

test("Codex rows without a reading show dashes", () => {
  const [loading] = buildCodexRows([account()], NOW);
  assert.deepEqual([loading.left, loading.resets], [NONE, NONE]);
  const [empty] = buildCodexRows(
    [account({ usage: usage({ primary_used_percent: null, primary_resets_at: null }) })],
    NOW,
  );
  assert.deepEqual([empty.left, empty.resets], [NONE, NONE]);
});

test("Codex status: expired wins, a broken login says so, another usage error does not", () => {
  const status = (a: Partial<AccountWithUsage>) => {
    const [r] = buildCodexRows([account(a)], NOW);
    return [r.status, r.tone, r.inactive];
  };
  assert.deepEqual(status({ usage: usage({ error: "refresh_token_invalidated" }) }), ["login broken", "bad", false]);
  assert.deepEqual(status({ usage: usage({ error: "HTTP 401 Unauthorized" }) }), ["login broken", "bad", false]);
  assert.deepEqual(status({ usage: usage({ error: "network unreachable" }) }), ["usage error", "warn", false]);
  assert.deepEqual(
    status({ subscription_expires_at: "2026-10-01T00:00:00Z", usage: usage({ error: "refresh_token_invalidated" }) }),
    ["expired", "bad", true],
  );
});

test("a broken login shows no stale numbers", () => {
  const [r] = buildCodexRows([account({ usage: usage({ error: "refresh_token_invalidated" }) })], NOW);
  assert.deepEqual([r.left, r.resets], [NONE, NONE]);
});

test("Codex rows are inactive when expired, or free with nothing left", () => {
  const inactive = (a: Partial<AccountWithUsage>) => buildCodexRows([account(a)], NOW)[0].inactive;
  assert.equal(inactive({ subscription_expires_at: "2026-10-01T00:00:00Z" }), true);
  assert.equal(inactive({ plan_type: "free", subscription_expires_at: null, usage: usage({ primary_used_percent: 100 }) }), true);
  assert.equal(inactive({ plan_type: "Free", subscription_expires_at: null, usage: usage({ primary_used_percent: 38 }) }), false);
  // Nothing left on a paid plan is still an active subscription.
  assert.equal(inactive({ plan_type: "pro", usage: usage({ primary_used_percent: 100 }) }), false);
  // No reading is not "nothing left".
  assert.equal(inactive({ plan_type: "free", subscription_expires_at: null }), false);
});

test("a Claude row carries email, plan, 7-day left, reset and the status", () => {
  const [r] = buildClaudeRows([seat()], [], NOW);
  assert.equal(r.id, "claude:claude-mac-main");
  assert.equal(r.account, "main@example.com");
  assert.equal(r.detail, "claude-mac-main · Mac");
  assert.equal(r.type, "Claude Max");
  assert.equal(r.left, "59%");
  assert.equal(r.resets, "in 1d 2h");
  assert.equal(r.renews, NONE);
  assert.equal(r.status, "OK");
  assert.equal(r.tone, "ok");
  assert.equal(r.inactive, false);
});

test("a Claude seat without an email shows its id and without numbers shows dashes", () => {
  const [r] = buildClaudeRows(
    [seat({ email: null, plan: null, sevenDay: null, status: "no_usage_yet" })],
    [],
    NOW,
  );
  assert.equal(r.account, "claude-mac-main");
  assert.equal(r.type, "Claude");
  assert.deepEqual([r.left, r.resets], [NONE, NONE]);
  assert.deepEqual([r.status, r.tone], ["No usage yet", "muted"]);
  const [reset] = buildClaudeRows([seat({ sevenDay: week({ used_pct: null, state: "reset" }) })], [], NOW);
  assert.deepEqual([reset.left, reset.resets], [NONE, NONE]);
});

test("a stale Claude reading says so and keeps its reset", () => {
  const [r] = buildClaudeRows([seat({ sevenDay: week({ state: "stale", used_pct: 100 }), status: "exhausted" })], [], NOW);
  assert.equal(r.left, "0% (stale)");
  assert.equal(r.resets, "in 1d 2h");
  assert.deepEqual([r.status, r.tone], ["Exhausted", "bad"]);
  assert.equal(r.inactive, false);
});

test("Claude seat dates come from the plan dates saved under the seat id", () => {
  const plans = [
    dates("claude-mac-main", { billingRenewsOn: "2026-11-02" }),
    dates("claude-mac-096", { billingRenewsOn: "2026-12-25" }),
  ];
  const [r] = buildClaudeRows([seat()], plans, NOW);
  assert.equal(r.renews, "Renews: Due in 3 days");
  assert.equal(r.inactive, false);
  const [other] = buildClaudeRows([seat({ id: "claude-windows" })], plans, NOW);
  assert.equal(other.renews, NONE);
});

test("a passed Claude renewal date says verify; a passed credit or key expiry marks the seat expired", () => {
  const [verify] = buildClaudeRows([seat()], [dates("claude-mac-main", { billingRenewsOn: "2026-10-01" })], NOW);
  assert.equal(verify.renews, "Renews: Date passed · verify");
  assert.deepEqual([verify.status, verify.inactive], ["OK", false]);
  const [expired] = buildClaudeRows([seat()], [dates("claude-mac-main", { credentialExpiresOn: "2026-10-29" })], NOW);
  assert.equal(expired.renews, "Key expires: Date passed · verify");
  assert.deepEqual([expired.status, expired.tone, expired.inactive], ["expired", "bad", true]);
});

test("a free Claude seat with nothing left is inactive", () => {
  const [r] = buildClaudeRows([seat({ plan: "free", sevenDay: week({ used_pct: 100 }), status: "exhausted" })], [], NOW);
  assert.equal(r.inactive, true);
});

test("an API row shows the balance, no reset, no dates and a ready status", () => {
  const [r] = buildApiCreditRows([credit()], [], NOW);
  assert.equal(r.id, "api:deepseek");
  assert.equal(r.account, "ds@example.com");
  assert.equal(r.type, "DeepSeek API");
  assert.equal(r.left, "$55.94");
  assert.equal(r.resets, PREPAID_RESETS);
  assert.equal(r.renews, NONE);
  assert.deepEqual([r.status, r.tone, r.inactive], ["ready", "ok", false]);
});

test("every probe provider gets a row, Kimi included, and a null balance reads 'see billing'", () => {
  const rows = buildApiCreditRows(
    [
      credit(),
      credit({ id: "fireworks", label: "Fireworks AI", email: null, balance: null, balance_note: "no balance API" }),
      credit({ id: "kimi", label: "Kimi API", email: null, account_name: "gus-kimi", balance: { currency: "CNY", total: "49.00" } }),
    ],
    [],
    NOW,
  );
  assert.deepEqual(rows.map((r) => r.type), ["DeepSeek API", "Fireworks AI", "Kimi API"]);
  assert.deepEqual(rows.map((r) => r.left), ["$55.94", "see billing", "CNY 49.00"]);
  assert.deepEqual(rows.map((r) => r.account), ["ds@example.com", null, "gus-kimi"]);
  assert.ok(rows.every((r) => r.resets === PREPAID_RESETS));
});

test("an API row with an email and an account name keeps the name as the detail line", () => {
  const [r] = buildApiCreditRows([credit({ account_name: "ds-main" })], [], NOW);
  assert.deepEqual([r.account, r.detail], ["ds@example.com", "ds-main"]);
});

test("an API row takes its dates from the provider plan and a failed probe shows its status label", () => {
  const plans = [dates("fireworks-api", { creditExpiresOn: "2026-11-01" })];
  const [r] = buildApiCreditRows([credit({ id: "fireworks", label: "Fireworks AI", balance: null })], plans, NOW);
  assert.equal(r.renews, "Credits expire: Due in 2 days");
  const [bad] = buildApiCreditRows([credit({ error: "http_401" })], plans, NOW);
  assert.deepEqual([bad.status, bad.tone, bad.left], ["key rejected", "warn", "see billing"]);
  const [off] = buildApiCreditRows([credit({ available: false })], [], NOW);
  assert.deepEqual([off.status, off.tone], ["unavailable", "warn"]);
});

test("an API row whose credits or key have expired is expired and inactive", () => {
  const plans = [dates("deepseek-api", { creditExpiresOn: "2026-10-29" })];
  const [r] = buildApiCreditRows([credit()], plans, NOW);
  assert.deepEqual([r.status, r.tone, r.inactive], ["expired", "bad", true]);
});

test("the plan id for a probe provider adds -api once", () => {
  assert.equal(apiPlanId("deepseek"), "deepseek-api");
  assert.equal(apiPlanId("anthropic-api"), "anthropic-api");
});

test("plan dates text lists each date that is set and skips unset or invalid ones", () => {
  assert.equal(planDatesText(undefined, NOW_DATE), "");
  assert.equal(planDatesText(dates("x"), NOW_DATE), "");
  assert.equal(planDatesText(dates("x", { billingRenewsOn: "2026-02-30" }), NOW_DATE), "");
  assert.equal(
    planDatesText(dates("x", { billingRenewsOn: "2026-11-02", creditExpiresOn: "2026-10-30", credentialExpiresOn: "2026-10-31" }), NOW_DATE),
    "Renews: Due in 3 days · Credits expire: Due today · verify · Key expires: Due tomorrow",
  );
  const far = new Date(2027, 0, 15).toLocaleDateString();
  assert.equal(planDatesText(dates("x", { billingRenewsOn: "2027-01-15" }), NOW_DATE), `Renews: ${far}`);
});

test("only a passed credit or key expiry counts as expired, never a due-today or passed renewal", () => {
  assert.equal(planDatesExpired(undefined, NOW_DATE), false);
  assert.equal(planDatesExpired(dates("x"), NOW_DATE), false);
  assert.equal(planDatesExpired(dates("x", { creditExpiresOn: "2026-10-29" }), NOW_DATE), true);
  assert.equal(planDatesExpired(dates("x", { credentialExpiresOn: "2026-10-29" }), NOW_DATE), true);
  assert.equal(planDatesExpired(dates("x", { creditExpiresOn: "2026-10-30" }), NOW_DATE), false);
  assert.equal(planDatesExpired(dates("x", { creditExpiresOn: "2026-11-30" }), NOW_DATE), false);
  assert.equal(planDatesExpired(dates("x", { billingRenewsOn: "2026-10-01" }), NOW_DATE), false);
});

test("inactive rows sort last, every other row keeps its order, and the input is left alone", () => {
  const rows = [
    row({ id: "expired-codex", inactive: true }),
    row({ id: "codex" }),
    row({ id: "free-empty", inactive: true }),
    row({ id: "claude" }),
    row({ id: "claude-2" }),
  ];
  const sorted = sortOverviewRows(rows);
  assert.deepEqual(sorted.map((r) => r.id), ["codex", "claude", "claude-2", "expired-codex", "free-empty"]);
  assert.deepEqual(rows.map((r) => r.id), ["expired-codex", "codex", "free-empty", "claude", "claude-2"]);
  assert.deepEqual(sortOverviewRows([]), []);
});

test("the Subscriptions section puts expired Codex and empty free rows after the live Codex and Claude rows", () => {
  const rows = sortOverviewRows([
    ...buildCodexRows(
      [
        account({ id: "old", email: "old@example.com", subscription_expires_at: "2026-10-01T00:00:00Z", usage: usage() }),
        account({ id: "live", email: "live@example.com", usage: usage() }),
        account({ id: "free", email: "free@example.com", plan_type: "free", subscription_expires_at: null, usage: usage({ primary_used_percent: 100 }) }),
      ],
      NOW,
    ),
    ...buildClaudeRows([seat()], [], NOW),
  ]);
  assert.deepEqual(rows.map((r) => r.account), ["live@example.com", "main@example.com", "old@example.com", "free@example.com"]);
  assert.deepEqual(rows.map((r) => r.inactive), [false, false, true, true]);
});

test("Claude seats come from the registry, usage and Prometheus, and nothing when none answered", () => {
  assert.deepEqual(claudeSeatsFromSources(null, null, undefined, NOW), []);
  assert.deepEqual(claudeSeatsFromSources(null, { found: false, seats: [] }, null, NOW), []);
  const seats = claudeSeatsFromSources(
    null,
    { found: true, seats: [{ id: "claude-mac-main", host: "mac", plan: "max", usage_account: "mac-main-max" }] },
    null,
    NOW,
  );
  assert.ok(seats.some((s) => s.id === "claude-mac-main"));
  assert.ok(seats.every((s) => s.status === "no_usage_yet"));
});
