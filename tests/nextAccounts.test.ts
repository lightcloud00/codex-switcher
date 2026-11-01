import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDay,
  formatWhen,
  NONE,
  planEntries,
  planInputKey,
  planText,
  reasonLine,
  statusBadge,
  usageWindows,
  usagesForPlan,
  windowLabel,
  windowUsageText,
  type WhenFormat,
} from "../src/lib/nextAccounts.ts";
import type { AccountWithUsage, UsageInfo, UseNextPlan, UseNextRow } from "../src/types/index.ts";

const ET: WhenFormat = { locale: "en-US", timeZone: "America/New_York" };
const NOW = Date.parse("2026-11-01T07:00:00Z");
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function usage(over: Partial<UsageInfo> = {}): UsageInfo {
  return {
    account_id: "a1",
    plan_type: "pro",
    primary_used_percent: 30,
    primary_window_minutes: 300,
    primary_resets_at: unix("2026-11-01T09:10:00Z"),
    secondary_used_percent: 14,
    secondary_window_minutes: 10_080,
    secondary_resets_at: unix("2026-11-08T05:09:00Z"),
    has_credits: false,
    unlimited_credits: false,
    credits_balance: null,
    error: null,
    ...over,
  };
}

function account(over: Partial<AccountWithUsage> = {}): AccountWithUsage {
  return {
    id: "a1",
    name: "work",
    email: "work@example.com",
    plan_type: "pro",
    subscription_expires_at: null,
    auth_mode: "chat_g_p_t",
    is_active: false,
    created_at: "2026-10-01T00:00:00Z",
    last_used_at: null,
    usage: usage(),
    usageCheckedAt: NOW,
    ...over,
  };
}

function row(over: Partial<UseNextRow> = {}): UseNextRow {
  return {
    position: 1,
    account_id: "a1",
    lane_id: "codex-seat-0123456789abcdef",
    status: "clean",
    availability_reason: "host_not_admitted",
    plan_class: "pro",
    remaining_percent: 70,
    back_at: null,
    subscription_expires_at: "2026-11-23T14:22:58Z",
    running: false,
    ...over,
  };
}

test("formatWhen gives the date, time and zone, and follows daylight time", () => {
  assert.equal(formatWhen(Date.parse("2026-11-02T19:00:00Z"), ET), "Nov 2, 2:00 PM EST");
  assert.equal(formatWhen(Date.parse("2026-10-31T19:00:00Z"), ET), "Oct 31, 3:00 PM EDT");
  assert.equal(formatWhen(null, ET), NONE);
});

test("formatDay adds the year only outside the current one", () => {
  assert.equal(formatDay(Date.parse("2026-11-23T14:22:58Z"), NOW, ET), "Nov 23");
  assert.equal(formatDay(Date.parse("2027-01-05T14:00:00Z"), NOW, ET), "Jan 5, 2027");
  assert.equal(formatDay(null, NOW, ET), NONE);
});

test("windowLabel names the usual windows", () => {
  assert.equal(windowLabel(300), "5h");
  assert.equal(windowLabel(10_080), "weekly");
  assert.equal(windowLabel(43_200), "30d");
  assert.equal(windowLabel(null), "window");
});

test("usageWindows sorts readings into the short and long window", () => {
  const both = usageWindows(usage());
  assert.equal(both.short?.minutes, 300);
  assert.equal(both.short?.resetsAt, Date.parse("2026-11-01T09:10:00Z"));
  assert.equal(both.long?.minutes, 10_080);
  assert.equal(windowUsageText(both.short), "5h 30% used");
  assert.equal(windowUsageText(both.long), "weekly 14% used");

  // A free plan sends its only, monthly window as the primary one.
  const free = usageWindows(
    usage({
      primary_used_percent: 96,
      primary_window_minutes: 43_200,
      secondary_used_percent: null,
      secondary_window_minutes: null,
      secondary_resets_at: null,
    })
  );
  assert.equal(free.short, null);
  assert.equal(free.long?.minutes, 43_200);

  assert.deepEqual(usageWindows(usage({ error: "401" })), { short: null, long: null });
  assert.deepEqual(usageWindows(undefined), { short: null, long: null });
  assert.equal(windowUsageText(null), NONE);
});

test("statusBadge covers every status", () => {
  assert.deepEqual(statusBadge("clean"), { label: "Clean", tone: "ok" });
  assert.deepEqual(statusBadge("busy"), { label: "Busy", tone: "warn" });
  assert.deepEqual(statusBadge("exhausted"), { label: "Exhausted", tone: "bad" });
  assert.deepEqual(statusBadge("expired"), { label: "Expired", tone: "muted" });
  assert.deepEqual(statusBadge("refresh_failed"), { label: "Refresh failed", tone: "bad" });
  assert.deepEqual(statusBadge("no_usage"), { label: "No reading", tone: "muted" });
});

test("reasonLine explains each row's place in one line", () => {
  assert.equal(
    reasonLine({ row: row(), account: account() }, NOW, ET),
    "Use first: plan ends Nov 23 · 30% used · 5h resets Nov 1, 4:10 AM EST"
  );
  assert.equal(
    reasonLine({ row: row({ position: 2, subscription_expires_at: null }), account: account() }, NOW, ET),
    "no plan end date · 30% used · 5h resets Nov 1, 4:10 AM EST"
  );
  assert.equal(
    reasonLine(
      {
        row: row({ status: "busy", remaining_percent: 86, availability_reason: "lane_running" }),
        account: account({ usage: usage({ primary_used_percent: 2 }) }),
      },
      NOW,
      ET
    ),
    "In use now · 86% left · weekly resets Nov 8, 12:09 AM EST"
  );
  assert.equal(
    reasonLine({ row: row({ status: "exhausted", back_at: "2026-11-07T20:30:26Z" }), account: account() }, NOW, ET),
    "Used up · back Nov 7, 3:30 PM EST"
  );
  assert.equal(
    reasonLine({ row: row({ status: "refresh_failed" }), account: account() }, NOW, ET),
    "Usage check failed · refresh or sign in again"
  );
  assert.equal(
    reasonLine({ row: row({ status: "expired", subscription_expires_at: "2026-09-05T19:00:48Z" }), account: account() }, NOW, ET),
    "Plan ended Sep 5 · renew to use"
  );
  assert.equal(reasonLine({ row: row({ status: "no_usage" }), account: account() }, NOW, ET), "No usage reading yet");
});

test("planText shows the plan and its end date", () => {
  assert.equal(planText(row(), NOW, ET), "Pro · ends Nov 23");
  assert.equal(planText(row({ subscription_expires_at: "2026-09-05T19:00:48Z", plan_class: "free" }), NOW, ET), "Free · ended Sep 5");
  assert.equal(planText(row({ subscription_expires_at: null, plan_class: "unknown" }), NOW, ET), "Plan unknown");
});

test("planEntries keeps the plan's order and drops rows for removed accounts", () => {
  const plan: UseNextPlan = {
    schema: "codex-switcher.use-next.v1",
    observed_at: "2026-11-01T07:00:00Z",
    selection_rule: "router_plan_codex_order_then_soonest_back",
    rows: [row({ account_id: "b", position: 1 }), row({ account_id: "gone", position: 2 }), row({ account_id: "a", position: 3 })],
  };
  const entries = planEntries(plan, [account({ id: "a" }), account({ id: "b" })]);
  assert.deepEqual(
    entries.map((entry) => [entry.row.position, entry.account.id]),
    [
      [1, "b"],
      [3, "a"],
    ]
  );
  assert.deepEqual(planEntries(null, [account()]), []);
});

test("usagesForPlan and planInputKey follow the loaded readings", () => {
  const withUsage = account({ id: "a" });
  const without = account({ id: "b", usage: undefined, usageCheckedAt: undefined });
  assert.deepEqual(
    usagesForPlan([withUsage, without]).map((item) => item.account_id),
    ["a1"]
  );
  const before = planInputKey([withUsage, without]);
  assert.equal(planInputKey([withUsage, without]), before);
  assert.notEqual(planInputKey([{ ...withUsage, usageCheckedAt: NOW + 60_000 }, without]), before);
  assert.notEqual(planInputKey([{ ...withUsage, is_active: true }, without]), before);
  assert.notEqual(planInputKey([withUsage, { ...without, subscription_expires_at: "2026-12-01T00:00:00Z" }]), before);
});
