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
  codexPlanLabel,
  codexPlanText,
  claudePlanEndText,
  CODEX_EMPTY,
  hiddenClaudeLogins,
  isCodexPaying,
  SIGN_IN_AGAIN,
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

test("Claude Overview prioritizes authentication over retained quota", () => {
  for (const state of ["current", "stale"] as const) {
    const [row] = buildClaudeRows([seat({
      sevenDay: week({ used_pct: 100, state }),
      status: "exhausted",
      probeError: "usage output had no limit lines",
      signedIn: false,
    })], [], NOW);
    assert.equal(row.status, "Sign-in check failed");
    assert.equal(row.left, "Unknown");
    assert.equal(row.resets, NONE);
  }
});
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
    usageCheckedAt: NOW,
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
  assert.equal(r.renews, codexPlanText(account({ usage: usage() }), NOW));
  assert.match(r.renews, /^Paid until /);
  assert.equal(r.paying, true);
  assert.equal(r.status, "available");
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
  assert.deepEqual(status({ usage: usage({ error: "refresh_token_invalidated" }) }), [SIGN_IN_AGAIN, "bad", false]);
  assert.deepEqual(status({ usage: usage({ error: "HTTP 401 Unauthorized" }) }), ["usage error", "warn", false]);
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

test("Codex without a usage reading is unknown, never active", () => {
  const [r] = buildCodexRows([account()], NOW);
  assert.deepEqual([r.status, r.tone], ["usage unknown", "muted"]);
});

test("Codex exhausted usage is not shown as active", () => {
  const [r] = buildCodexRows([account({ usage: usage({ primary_used_percent: 100 }) })], NOW);
  assert.deepEqual([r.status, r.tone], [CODEX_EMPTY, "bad"]);
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
  assert.equal(r.renews, "Expiry not recorded");
  assert.equal(r.status, "Ready");
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
  assert.deepEqual([r.left, r.resets], ["Unknown", NONE]);
  assert.deepEqual([r.status, r.tone], ["Not used yet", "muted"]);
  const [reset] = buildClaudeRows([seat({ sevenDay: week({ used_pct: null, state: "reset" }) })], [], NOW);
  assert.deepEqual([reset.left, reset.resets], ["Unknown", NONE]);
});

test("a stale Claude reading says so and keeps its reset", () => {
  const [r] = buildClaudeRows([seat({ sevenDay: week({ state: "stale", used_pct: 100 }), status: "exhausted" })], [], NOW);
  assert.equal(r.left, "0% (stale)");
  assert.equal(r.resets, "in 1d 2h");
  assert.deepEqual([r.status, r.tone], ["Stale", "warn"]);
  assert.equal(r.inactive, false);
});

test("Claude left uses whichever usable 5-hour or weekly allowance is tighter", () => {
  const [r] = buildClaudeRows([seat({ fiveHour: week({ used_pct: 87 }), sevenDay: week({ used_pct: 41 }) })], [], NOW);
  assert.equal(r.left, "13%");
  const [unknown] = buildClaudeRows([seat({ fiveHour: null, sevenDay: null, status: "unknown" })], [], NOW);
  assert.deepEqual([unknown.left, unknown.status, unknown.tone], ["Unknown", "No reading", "muted"]);
});

test("Claude seat dates come from the plan dates saved under the seat id", () => {
  const plans = [
    dates("claude-mac-main", { billingRenewsOn: "2026-11-02" }),
    dates("claude-mac-096", { billingRenewsOn: "2026-12-25" }),
  ];
  const [r] = buildClaudeRows([seat()], plans, NOW);
  assert.equal(r.renews, "Recorded renews: Due in 3 days");
  assert.equal(r.inactive, false);
  const [other] = buildClaudeRows([seat({ id: "claude-windows" })], plans, NOW);
  assert.equal(other.renews, "Expiry not recorded");
});

test("a passed Claude renewal date says verify; a passed credit or key expiry marks the seat expired", () => {
  const [verify] = buildClaudeRows([seat()], [dates("claude-mac-main", { billingRenewsOn: "2026-10-01" })], NOW);
  assert.equal(verify.renews, "Recorded renews: Date passed · verify");
  assert.deepEqual([verify.status, verify.inactive], ["Ready", false]);
  const [expired] = buildClaudeRows([seat()], [dates("claude-mac-main", { credentialExpiresOn: "2026-10-29" })], NOW);
  assert.equal(expired.renews, "Recorded key expires: Date passed · verify");
  assert.deepEqual([expired.status, expired.tone, expired.inactive], ["Plan ended", "bad", true]);
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
  assert.equal(r.renews, "Recorded credits expire: Due in 2 days");
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
    "Recorded renews: Due in 3 days · Recorded credits expire: Due today · verify · Recorded key expires: Due tomorrow",
  );
  const far = new Date(2027, 0, 15).toLocaleDateString();
  assert.equal(planDatesText(dates("x", { billingRenewsOn: "2027-01-15" }), NOW_DATE), `Recorded renews: ${far}`);
  assert.equal(planDatesText(dates("x", { billingInterval: "annual" }), NOW_DATE), "Annual billing · no monthly estimate");
  assert.equal(planDatesText(dates("x", { billingInterval: "none" }), NOW_DATE), "No subscription renewal");
  assert.match(planDatesText(dates("x", { subscriptionExpiresOn: "2026-12-01" }), NOW_DATE), /^Recorded expiry:/);
  assert.match(planDatesText(dates("x", { subscriptionExpiresOn: "2026-12-01", evidenceSource: "invoice", lastVerifiedOn: "2026-10-30" }), NOW_DATE), /^Confirmed expiry:/);
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


test("Codex freshness and login identity stay separate from availability", () => {
  const stale = buildCodexRows([account({ is_active: true, usage: usage(), usageCheckedAt: NOW - 360_000 })], NOW)[0];
  assert.equal(stale.status, "usage stale");
  assert.equal(stale.activeLogin, true);
  const missing = buildCodexRows([account({ usage: usage(), usageCheckedAt: undefined })], NOW)[0];
  assert.equal(missing.status, "usage stale");
});
test("confirmed annual renewal is shown before an interval fallback", () => {
  assert.match(planDatesText(dates("x", { billingInterval: "annual", billingRenewsOn: "2027-10-30", evidenceSource: "Billing page", lastVerifiedOn: "2026-10-30" }), NOW_DATE), /^Confirmed renews:/);
});
test("cold-start visibility failure never exposes usage-only Claude rows", () => {
  assert.deepEqual(claudeSeatsFromSources({ accounts: [{ account: "windows-max" }] } as any, null, null, NOW), []);
});

test("a broken Claude seat shows a dash, not a stale percent", () => {
  const stale = week({ used_pct: 0, state: "stale" });
  const [r] = buildClaudeRows([seat({ promState: "broken", sevenDay: stale })], [], NOW);
  assert.equal(r.left, NONE);
  const [ok] = buildClaudeRows([seat({ promState: "ok", sevenDay: stale })], [], NOW);
  assert.equal(ok.left, "100% (stale)");
});

test("a Codex account whose plan has ended shows no reset countdown", () => {
  const live = buildCodexRows([account({ usage: usage(), subscription_expires_at: "2026-12-04T00:00:00Z" })], NOW)[0];
  assert.equal(live.resets, "in 1h 18m");
  const ended = buildCodexRows([account({ usage: usage(), subscription_expires_at: "2026-10-20T00:00:00Z" })], NOW)[0];
  assert.equal(ended.status, "expired");
  assert.equal(ended.resets, NONE);
  assert.match(ended.renews, /^Ended /);
  assert.equal(ended.paying, false);
});

test("Claude seats use the same short words as Use next", () => {
  const word = (over: Partial<ClaudeSeat>) => buildClaudeRows([seat(over)], [], NOW)[0].status;
  assert.equal(word({ status: "ok" }), "Ready");
  assert.equal(word({ status: "near_limit", sevenDay: week({ used_pct: 96 }) }), "Almost empty");
  assert.equal(word({ status: "exhausted", sevenDay: week({ used_pct: 100 }) }), "Empty");
  assert.equal(word({ status: "no_usage_yet", sevenDay: null }), "Not used yet");
  assert.equal(word({ status: "unknown", sevenDay: null }), "No reading");
  assert.equal(word({ promState: "broken" }), "Not working");
  // The default seat answered after Oct 1, so a passed Oct 1 end date is out of date, not an ended plan.
  const [working] = buildClaudeRows([seat({ billingType: "stripe_subscription" })], [{ id: "claude-mac-main", subscriptionExpiresOn: "2026-10-01" } as PlanDates], NOW);
  assert.equal(working.status, "Ready");
  const [ended] = buildClaudeRows(
    [seat({ sevenDay: week({ observed_at: "2026-09-30T12:00:00Z" }) })],
    [{ id: "claude-mac-main", subscriptionExpiresOn: "2026-10-01" } as PlanDates],
    NOW,
  );
  assert.equal(ended.status, "Plan ended");
});

test("Codex plan names read as people say them", () => {
  assert.equal(codexPlanLabel("promax"), "Pro Max");
  assert.equal(codexPlanLabel("pro"), "Pro");
  assert.equal(codexPlanLabel("plus"), "Plus");
  assert.equal(codexPlanLabel("Free"), "Free");
  assert.equal(codexPlanLabel("mystery"), "Mystery");
  assert.equal(codexPlanLabel(null), "");
  assert.equal(buildCodexRows([account({ plan_type: "promax" })], NOW)[0].type, "Codex Pro Max");
});

test("a signed-out paid Codex account keeps its last known paid-until date and stays under Paying now", () => {
  const signedOut = account({
    subscription_expires_at: null,
    last_known_subscription_expires_at: "2026-11-23T14:22:58Z",
    usage: usage({ error: "Token refresh failed: 401 Unauthorized - Your session has ended. Please log in again." }),
  });
  const [r] = buildCodexRows([signedOut], NOW);
  assert.equal(r.status, SIGN_IN_AGAIN);
  assert.match(r.renews, /^Paid until .* \(last known\) · sign in again on the Codex tab$/);
  assert.equal(r.paying, true);
  assert.equal(r.inactive, false);
});

test("a last known date that has passed is shown as ended and not paying", () => {
  const old = account({ subscription_expires_at: null, last_known_subscription_expires_at: "2026-10-01T00:00:00Z" });
  assert.match(codexPlanText(old, NOW, true), /^Probably ended .* \(last known\)$/);
  assert.equal(isCodexPaying(old, NOW, true), false);
  // While signed in, a saved date is never used: a missing live date is just "not known yet".
  assert.equal(codexPlanText(old, NOW, false), "Paid plan · end date not known yet");
  assert.equal(isCodexPaying(old, NOW, false), true);
  // As a row: signed out with a passed last known date is listed as ended and dimmed.
  const [row] = buildCodexRows([{ ...old, usage: usage({ error: "refresh_token_invalidated" }) }], NOW);
  assert.deepEqual([row.paying, row.inactive, row.status], [false, true, SIGN_IN_AGAIN]);
  // A live date always wins over the saved one.
  const renewed = account({ subscription_expires_at: "2026-12-04T00:00:00Z", last_known_subscription_expires_at: "2026-10-01T00:00:00Z" });
  assert.match(codexPlanText(renewed, NOW, true), /^Paid until /);
  assert.equal(isCodexPaying(renewed, NOW, true), true);
});

test("free and API-key Codex accounts are never paying, even with an old paid date saved", () => {
  const free = account({ plan_type: "free", subscription_expires_at: null, last_known_subscription_expires_at: "2026-12-05T00:00:00Z" });
  assert.equal(codexPlanText(free, NOW, true), "Free plan");
  assert.equal(isCodexPaying(free, NOW, true), false);
  const key = account({ plan_type: null, auth_mode: "api_key", subscription_expires_at: null });
  assert.equal(isCodexPaying(key, NOW), false);
  // A paid plan with no date at all still counts as paying.
  const undated = account({ plan_type: "pro", subscription_expires_at: null, last_known_subscription_expires_at: null });
  assert.equal(codexPlanText(undated, NOW), "Paid plan · end date not known yet");
  assert.equal(isCodexPaying(undated, NOW), true);
});

test("a Claude login with no paid billing is a free account, not a paying one", () => {
  const [r] = buildClaudeRows([seat({ billingType: "none" })], [], NOW);
  assert.equal(r.type, "Claude Free");
  assert.equal(r.paying, false);
  assert.deepEqual([r.status, r.renews], ["Free", "Free · no paid plan"]);
  // A free login whose old paid plan ended is "Free", never "Plan ended", with the end day as a footnote.
  const [old] = buildClaudeRows(
    [seat({ billingType: "none", sevenDay: week({ observed_at: "2026-09-30T12:00:00Z" }) })],
    [dates("claude-mac-main", { subscriptionExpiresOn: "2026-10-01" })],
    NOW,
  );
  assert.equal(old.status, "Free");
  assert.match(old.renews, /^Free · no paid plan \(paid plan ended .*\)$/);
  const [paid] = buildClaudeRows([seat({ billingType: "stripe_subscription" })], [], NOW);
  assert.equal(paid.paying, true);
});

test("a Claude seat still answering after its recorded end date says the date needs updating", () => {
  const [r] = buildClaudeRows([seat({ billingType: "stripe_subscription" })], [dates("claude-mac-main", { subscriptionExpiresOn: "2026-10-01" })], NOW);
  assert.equal(r.status, "Ready");
  assert.match(r.renews, /^Still working · was due to end .* · check billing$/);
  assert.equal(r.paying, true);
  // A passed key expiry is never overridden by a reading.
  const [key] = buildClaudeRows([seat({ billingType: "stripe_subscription" })], [dates("claude-mac-main", { subscriptionExpiresOn: "2026-10-01", credentialExpiresOn: "2026-10-29" })], NOW);
  assert.equal(key.status, "Plan ended");
  assert.equal(key.paying, false);
  // Unknown billing or a broken seat proves nothing: the recorded end stands.
  const [unknownBilling] = buildClaudeRows([seat({ billingType: null })], [dates("claude-mac-main", { subscriptionExpiresOn: "2026-10-01" })], NOW);
  assert.deepEqual([unknownBilling.status, unknownBilling.paying], ["Plan ended", false]);
  const [broken] = buildClaudeRows([seat({ billingType: "stripe_subscription", promState: "broken" })], [dates("claude-mac-main", { subscriptionExpiresOn: "2026-10-01" })], NOW);
  assert.deepEqual([broken.status, broken.paying], ["Plan ended", false]);
});

test("hidden Claude logins are listed with their email and recorded end date", () => {
  const registry = {
    found: true,
    seats: [{ id: "claude-mac-gustavo", host: "mac", plan: "max", usage_account: "mac-gustavo-max" }],
    hidden_seat_ids: ["claude-mac-gustavo", "claude-unknown"],
  };
  const accounts = [{ account: "mac-gustavo-max", email: " gus00@example.com " }] as never;
  const plans = [dates("claude-mac-gustavo", { subscriptionExpiresOn: "2026-10-10" })];
  const logins = hiddenClaudeLogins(registry, accounts, plans, NOW);
  assert.equal(logins.length, 2);
  assert.equal(logins[0].email, "gus00@example.com");
  assert.equal(logins[0].where, "Mac");
  assert.match(logins[0].ended ?? "", /^Ended /);
  assert.deepEqual([logins[1].email, logins[1].ended], [null, null]);
  // A canceled seat still inside its paid time says when it stops, not "Paid until".
  const future = hiddenClaudeLogins(registry, accounts, [dates("claude-mac-gustavo", { subscriptionExpiresOn: "2026-12-06" })], NOW);
  assert.match(future[0].ended ?? "", /^Ends .* \(canceled\)$/);
  assert.deepEqual(hiddenClaudeLogins(null, [], [], NOW), []);
});

test("Claude plan end dates show the real day, like Codex rows", () => {
  assert.match(claudePlanEndText(dates("s", { subscriptionExpiresOn: "2026-11-30" }), NOW), /^Paid until Nov 30, 2026$/);
  assert.match(claudePlanEndText(dates("s", { subscriptionExpiresOn: "2026-10-10" }), NOW), /^Ended Oct 10, 2026$/);
  // Other saved dates keep the Providers wording.
  assert.equal(claudePlanEndText(dates("s", { billingRenewsOn: "2026-10-01" }), NOW), "Recorded renews: Date passed · verify");
  assert.equal(claudePlanEndText(undefined, NOW), "");
  const [r] = buildClaudeRows([seat()], [dates("claude-mac-main", { subscriptionExpiresOn: "2026-11-30" })], NOW);
  assert.match(r.renews, /^Paid until /);
  assert.equal(r.paying, true);
});
