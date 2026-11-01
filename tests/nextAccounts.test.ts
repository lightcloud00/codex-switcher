import assert from "node:assert/strict";
import test from "node:test";
import {
  dayKey,
  formatAgo,
  formatClock,
  formatCountdown,
  formatDay,
  formatDuration,
  formatIn,
  formatWhen,
  heroPick,
  lastChecked,
  leftText,
  NONE,
  planEntries,
  planInputKey,
  planText,
  rowLine,
  statusBadge,
  stripDays,
  stripEvents,
  trayUseNext,
  usageWindows,
  usagesForPlan,
  whyText,
  windowLabel,
  windowUsageText,
  type UseNextEntry,
  type WhenFormat,
} from "../src/lib/nextAccounts.ts";
import type { AccountWithUsage, UsageInfo, UseNextPlan, UseNextRow } from "../src/types/index.ts";

const ET: WhenFormat = { locale: "en-US", timeZone: "America/New_York" };
// Sun Nov 1, 2:00 AM EST: an hour after daylight time ended.
const NOW = Date.parse("2026-11-01T07:00:00Z");
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
// Some ICU builds put a narrow no-break space before AM/PM.
const plain = (text: string) => text.replace(/ /g, " ");

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

const entry = (rowOver: Partial<UseNextRow> = {}, accountOver: Partial<AccountWithUsage> = {}): UseNextEntry => ({
  row: row(rowOver),
  account: account(accountOver),
});

test("formatWhen gives the date, time and zone, and follows daylight time", () => {
  assert.equal(plain(formatWhen(Date.parse("2026-11-02T19:00:00Z"), ET)), "Nov 2, 2:00 PM EST");
  assert.equal(plain(formatWhen(Date.parse("2026-10-31T19:00:00Z"), ET)), "Oct 31, 3:00 PM EDT");
  assert.equal(formatWhen(null, ET), NONE);
});

test("formatDay adds the year only outside the current one", () => {
  assert.equal(formatDay(Date.parse("2026-11-23T14:22:58Z"), NOW, ET), "Nov 23");
  assert.equal(formatDay(Date.parse("2027-01-05T14:00:00Z"), NOW, ET), "Jan 5, 2027");
  assert.equal(formatDay(null, NOW, ET), NONE);
});

test("formatClock names the weekday this week and adds the date further out", () => {
  assert.equal(plain(formatClock(Date.parse("2026-11-03T22:00:00Z"), NOW, ET)), "Tue 5 PM EST");
  assert.equal(plain(formatClock(Date.parse("2026-11-03T22:30:00Z"), NOW, ET)), "Tue 5:30 PM EST");
  assert.equal(plain(formatClock(Date.parse("2026-11-07T20:30:00Z"), NOW, ET)), "Sat, Nov 7, 3:30 PM EST");
  assert.equal(plain(formatClock(Date.parse("2026-11-03T22:00:00Z"), NOW, ET, true)), "Tue, Nov 3, 5 PM EST");
  assert.equal(plain(formatClock(Date.parse("2026-10-30T22:00:00Z"), NOW, ET)), "Fri, Oct 30, 6 PM EDT");
});

test("formatDuration and formatCountdown say how long in words", () => {
  assert.equal(formatDuration(42 * 60_000), "42 min");
  assert.equal(formatDuration(20_000), "1 min");
  assert.equal(formatDuration(60 * 60_000), "1 hour");
  assert.equal(formatDuration((5 * 60 + 10) * 60_000), "5 hours 10 min");
  assert.equal(formatDuration(24 * 60 * 60_000), "1 day");
  assert.equal(formatDuration((2 * 24 + 4) * 60 * 60_000), "2 days 4 hours");
  assert.equal(
    plain(formatCountdown(Date.parse("2026-11-03T22:00:00Z"), NOW, ET)),
    "in 2 days 15 hours, Tue 5 PM EST"
  );
  assert.equal(plain(formatCountdown(Date.parse("2026-11-01T06:30:00Z"), NOW, ET)), "due now (Sun 1:30 AM EST)");
  assert.equal(formatCountdown(null, NOW, ET), NONE);
  assert.equal(formatIn(NOW + 3 * 60 * 60_000, NOW), "in 3 hours");
  assert.equal(formatIn(NOW - 1, NOW), "due now");
});

test("formatAgo and lastChecked tell how fresh the readings are", () => {
  assert.equal(formatAgo(NOW - 10_000, NOW), "just now");
  assert.equal(formatAgo(NOW - 4 * 60_000, NOW), "4 min ago");
  assert.equal(formatAgo(NOW - 2 * 60 * 60_000, NOW), "2 hours ago");
  assert.equal(lastChecked([account({ usageCheckedAt: NOW - 5 }), account({ usageCheckedAt: NOW })]), NOW);
  assert.equal(lastChecked([account({ usageCheckedAt: undefined })]), null);
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

test("statusBadge puts a word on every status", () => {
  assert.deepEqual(statusBadge("clean"), { label: "Ready", tone: "ok" });
  assert.deepEqual(statusBadge("busy"), { label: "Busy", tone: "warn" });
  assert.deepEqual(statusBadge("exhausted"), { label: "Empty", tone: "bad" });
  assert.deepEqual(statusBadge("expired"), { label: "Expired", tone: "muted" });
  assert.deepEqual(statusBadge("refresh_failed"), { label: "Refresh failed", tone: "muted" });
  assert.deepEqual(statusBadge("no_usage"), { label: "No reading", tone: "muted" });
});

test("rowLine says what happens to each account next, in one line", () => {
  assert.equal(plain(rowLine(entry(), NOW, ET)), "5h resets in 2 hours 10 min, Sun 4:10 AM EST");
  assert.equal(
    plain(rowLine(entry({ status: "busy" }, { usage: usage({ primary_used_percent: 2 }) }), NOW, ET)),
    "In use now · weekly resets in 6 days 22 hours, Sun, Nov 8, 12:09 AM EST"
  );
  assert.equal(
    plain(rowLine(entry({ status: "exhausted", back_at: "2026-11-03T22:00:00Z" }), NOW, ET)),
    "Back in 2 days 15 hours, Tue 5 PM EST"
  );
  assert.equal(rowLine(entry({ status: "refresh_failed" }), NOW, ET), "Couldn't check usage · refresh or sign in again");
  assert.equal(
    rowLine(entry({ status: "expired", subscription_expires_at: "2026-09-05T19:00:48Z" }), NOW, ET),
    "Plan ended Sep 5 · renew to use"
  );
  assert.equal(rowLine(entry({ status: "no_usage" }), NOW, ET), "No usage reading yet");
  assert.equal(rowLine(entry({}, { usage: undefined }), NOW, ET), "Ready to use");
  assert.match(whyText(row()), /router_plan/);
  assert.equal(leftText(row({ remaining_percent: 85.6 })), "86% left");
  assert.equal(leftText(row({ remaining_percent: null })), null);
});

test("planText shows the plan and its end date", () => {
  assert.equal(planText(row(), NOW, ET), "Pro · ends Nov 23");
  assert.equal(planText(row({ subscription_expires_at: "2026-09-05T19:00:48Z", plan_class: "free" }), NOW, ET), "Free · ended Sep 5");
  assert.equal(planText(row({ subscription_expires_at: null, plan_class: "unknown" }), NOW, ET), "Plan unknown");
});

test("heroPick points at the first ready account, else the one in use, else the first one back", () => {
  const ready = entry({ account_id: "b", position: 2 }, { id: "b" });
  const busy = entry({ status: "busy", position: 1, remaining_percent: 40 }, { id: "a", is_active: true });
  const later = entry({ status: "exhausted", back_at: "2026-11-08T05:09:21Z", position: 1 }, { id: "c" });
  const sooner = entry({ status: "exhausted", back_at: "2026-11-07T20:30:26Z", position: 2 }, { id: "d" });
  const ended = entry({ status: "expired", position: 3 }, { id: "e" });

  assert.deepEqual(heroPick([busy, ready]), { kind: "ready", entry: ready });
  assert.deepEqual(heroPick([busy, later, ended]), { kind: "keep", entry: busy });
  assert.deepEqual(heroPick([later, sooner, ended]), {
    kind: "empty",
    entry: sooner,
    backAt: Date.parse("2026-11-07T20:30:26Z"),
  });
  assert.deepEqual(heroPick([ended]), { kind: "none" });
  assert.deepEqual(heroPick([entry({ status: "busy", remaining_percent: 0 })]), { kind: "none" });
});

test("trayUseNext gives the tray a ready-made line and short title, names only", () => {
  assert.deepEqual(trayUseNext({ kind: "ready", entry: entry() }, NOW, ET), {
    accountId: "a1",
    menuLabel: "Use next: work · 70% left",
    title: "work 70%",
  });
  assert.deepEqual(trayUseNext({ kind: "keep", entry: entry({ status: "busy", remaining_percent: 86 }) }, NOW, ET), {
    accountId: "a1",
    menuLabel: "Keep using: work · 86% left",
    title: "work 86%",
  });
  const empty = trayUseNext({ kind: "empty", entry: entry(), backAt: Date.parse("2026-11-07T20:30:26Z") }, NOW, ET);
  assert.deepEqual(
    { ...empty, menuLabel: plain(empty.menuLabel), title: plain(empty.title) },
    { accountId: null, menuLabel: "Codex empty until Sat, Nov 7, 3:30 PM EST", title: "Empty → Nov 7 3:30 PM" }
  );
  assert.equal(
    trayUseNext({ kind: "ready", entry: entry({}, { name: "a-very-long-account-name" }) }, NOW, ET).title,
    "a-very-long-a… 70%"
  );
  assert.equal(
    plain(trayUseNext({ kind: "empty", entry: entry(), backAt: Date.parse("2026-11-03T22:00:00Z") }, NOW, ET).title),
    "Empty → Tue 5 PM"
  );
  // More than six days out, the menu bar names the date, not just a weekday.
  assert.equal(
    plain(trayUseNext({ kind: "empty", entry: entry(), backAt: Date.parse("2026-11-13T20:00:00Z") }, NOW, ET).title),
    "Empty → Nov 13 3 PM"
  );
  // Truncation counts characters, so an emoji is never split into a lone surrogate.
  const emoji = trayUseNext({ kind: "ready", entry: entry({}, { name: "personal-wor\u{1F600}k-long" }) }, NOW, ET).title;
  assert.equal(emoji, "personal-wor\u{1F600}… 70%");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(emoji)));
  assert.doesNotMatch(JSON.stringify(emoji), /\\ud83d/i);
  assert.deepEqual(trayUseNext({ kind: "none" }, NOW, ET), {
    accountId: null,
    menuLabel: "No Codex account is ready",
    title: "Codex —",
  });
  const serialized = JSON.stringify(trayUseNext({ kind: "ready", entry: entry() }, NOW, ET));
  assert.doesNotMatch(serialized, /@|token/i);
});

test("stripDays steps calendar days through the daylight time change and marks the show", () => {
  const days = stripDays(NOW, 10, ET);
  assert.deepEqual(
    days.map((day) => day.key),
    [
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
    ]
  );
  assert.equal(days[0].isToday, true);
  assert.equal(days[0].weekday, "Sun");
  assert.equal(days[6].weekday, "Sat");
  assert.deepEqual(
    days.filter((day) => day.marked).map((day) => day.day),
    [4, 5, 6, 7, 8]
  );
  // Starting before the 2 AM fall-back (12:30 AM EDT), 24-hour steps would land on Nov 1 twice.
  assert.deepEqual(
    stripDays(Date.parse("2026-11-01T04:30:00Z"), 3, ET).map((day) => day.key),
    ["2026-11-01", "2026-11-02", "2026-11-03"]
  );
  // 11:30 PM EST on Nov 1 is still Nov 1 there, though it is Nov 2 in UTC.
  assert.equal(dayKey(Date.parse("2026-11-02T04:30:00Z"), ET), "2026-11-01");
});

test("stripEvents places back, weekly reset and plan end on their days", () => {
  const days = stripDays(NOW, 10, ET);
  const exhausted = stripEvents(
    entry(
      { status: "exhausted", back_at: "2026-11-08T05:09:00Z", subscription_expires_at: "2026-11-06T01:00:00Z" },
      { usage: usage({ secondary_used_percent: 100 }) }
    ),
    days,
    ET
  );
  // The weekly reset is the same moment it comes back, so it shows once.
  assert.deepEqual(
    [...exhausted.entries()].map(([key, events]) => [key, events.map((event) => `${event.kind} ${plain(event.time)}`)]),
    [
      ["2026-11-08", ["back 12:09 AM"]],
      ["2026-11-05", ["ends 8 PM"]],
    ]
  );
  const ended = stripEvents(entry({ status: "expired", subscription_expires_at: "2026-09-05T19:00:48Z" }), days, ET);
  assert.equal(ended.size, 0);
  const later = stripEvents(entry({ subscription_expires_at: "2026-11-30T00:00:00Z" }), days, ET);
  assert.deepEqual([...later.keys()], ["2026-11-08"]);
  assert.equal(later.get("2026-11-08")?.[0].window, "weekly");
  // A free plan's monthly window is labelled as such, not as a weekly reset.
  const monthly = stripEvents(
    entry(
      { plan_class: "free", subscription_expires_at: null },
      {
        usage: usage({
          primary_used_percent: 40,
          primary_window_minutes: 43_200,
          primary_resets_at: unix("2026-11-06T15:00:00Z"),
          secondary_used_percent: null,
          secondary_window_minutes: null,
          secondary_resets_at: null,
        }),
      }
    ),
    days,
    ET
  );
  assert.deepEqual(monthly.get("2026-11-06")?.map((event) => [event.kind, event.window]), [["reset", "30d"]]);
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
    entries.map((item) => [item.row.position, item.account.id]),
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
