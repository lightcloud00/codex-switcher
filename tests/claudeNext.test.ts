import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeNextRow,
  claudeNextRows,
  claudePlanEnd,
  claudeResets,
  claudeRowLine,
  claudeStripEvents,
} from "../src/lib/claudeNext.ts";
import { withSeatSubscriptions, type SeatSubscriptions } from "../src/lib/claudeSubscription.ts";
import { seatStatusLabel } from "../src/lib/claudeUsage.ts";
import { planLine, stripDays } from "../src/lib/nextAccounts.ts";
import type { PlanDates } from "../src/lib/providerAccess.ts";
import type { ClaudeSeat, ClaudeUsageWindow, UseNextRow } from "../src/types/index.ts";

const FORMAT = { locale: "en-US", timeZone: "America/New_York" };
// Wed Nov 11 2026, 9:50 AM EST.
const NOW = Date.parse("2026-11-11T14:50:00Z");

function win(used: number | null, resetsAt: string | null, state: ClaudeUsageWindow["state"] = "current", age_s = 60): ClaudeUsageWindow {
  return { used_pct: used, last_used_pct: used ?? 0, resets_at: resetsAt, observed_at: "2026-11-11T14:49:00Z", age_s, state, source: "usage" };
}

function seat(overrides: Partial<ClaudeSeat> = {}): ClaudeSeat {
  return {
    id: "claude-mac-main",
    host: "mac",
    plan: "max",
    email: "main@example.com",
    subscriptionCreatedAt: null,
    billingType: "stripe_subscription",
    usageAccount: null,
    fiveHour: null,
    sevenDay: null,
    modelWeeks: {},
    poolSpendTodayUsd: null,
    probeError: null,
    status: "ok",
    launcher: null,
    inRegistry: true,
    promState: null,
    lockOrphaned: false,
    lastReadAgeS: 60,
    unknownReason: null,
    ...overrides,
  };
}

function dates(id: string, overrides: Partial<PlanDates> = {}): PlanDates {
  return { id, billingRenewsOn: null, creditExpiresOn: null, credentialExpiresOn: null, ...overrides };
}

const OVERLAY: SeatSubscriptions = {
  found: true,
  seats: { "claude-mac-main": { subscriptionExpiresOn: "2026-11-14", planNote: "Apple-billed monthly" } },
  ignored: 0,
  error: null,
};

test("the seat file fills a seat with nothing saved, and only as a recorded date", () => {
  const merged = withSeatSubscriptions([dates("claude-mac-main"), dates("deepseek-api")], OVERLAY);
  assert.equal(merged.find((d) => d.id === "claude-mac-main")?.subscriptionExpiresOn, "2026-11-14");
  assert.equal(merged.find((d) => d.id === "claude-mac-main")?.evidenceSource, null);
  assert.equal(merged.find((d) => d.id === "deepseek-api")?.subscriptionExpiresOn, undefined);
});

test("dates saved under Providers win over the seat file", () => {
  const saved = [dates("claude-mac-main", { subscriptionExpiresOn: "2026-12-01" })];
  assert.equal(withSeatSubscriptions(saved, OVERLAY)[0].subscriptionExpiresOn, "2026-12-01");
  const annual = [dates("claude-mac-main", { billingInterval: "annual" })];
  assert.equal(withSeatSubscriptions(annual, OVERLAY)[0].subscriptionExpiresOn, undefined);
  const renewal = [dates("claude-mac-main", { billingRenewsOn: "2026-11-20" })];
  assert.equal(withSeatSubscriptions(renewal, OVERLAY)[0].subscriptionExpiresOn, undefined);
});

test("a seat file seat missing from the saved list is added; no file changes nothing", () => {
  const merged = withSeatSubscriptions([], OVERLAY);
  assert.deepEqual(merged.map((d) => [d.id, d.subscriptionExpiresOn]), [["claude-mac-main", "2026-11-14"]]);
  const plans = [dates("claude-mac-main")];
  assert.equal(withSeatSubscriptions(plans, null), plans);
  assert.equal(withSeatSubscriptions(plans, { found: false, seats: {}, ignored: 0, error: null }), plans);
});

test("plan end: a recorded end date, a past one, a confirmed one, a renewal, free and unknown", () => {
  const s = seat();
  const recorded = claudePlanEnd(s, dates(s.id, { subscriptionExpiresOn: "2026-11-14" }), NOW, FORMAT);
  assert.equal(recorded.text, "Plan ends Nov 14");
  assert.equal(recorded.kind, "recorded");
  assert.equal(recorded.isEnd, true);
  assert.equal(recorded.ended, false);

  const today = claudePlanEnd(s, dates(s.id, { subscriptionExpiresOn: "2026-11-11" }), NOW, FORMAT);
  assert.equal(today.ended, false, "the plan runs through its end day");

  const past = claudePlanEnd(s, dates(s.id, { subscriptionExpiresOn: "2026-11-10" }), NOW, FORMAT);
  assert.equal(past.text, "Plan ended Nov 10 · check it");
  assert.equal(past.ended, true);

  const confirmed = claudePlanEnd(
    s,
    dates(s.id, { subscriptionExpiresOn: "2026-11-14", evidenceSource: "App Store receipt", lastVerifiedOn: "2026-11-10" }),
    NOW,
    FORMAT,
  );
  assert.equal(confirmed.kind, "confirmed");

  const renews = claudePlanEnd(s, dates(s.id, { billingRenewsOn: "2026-11-20" }), NOW, FORMAT);
  assert.equal(renews.text, "Renews Nov 20");
  assert.equal(renews.isEnd, false);

  assert.equal(claudePlanEnd(seat({ billingType: "none" }), undefined, NOW, FORMAT).text, "Free · no end date");
  assert.equal(claudePlanEnd(s, dates(s.id, { billingInterval: "annual" }), NOW, FORMAT).text, "Yearly plan · end date not saved");
  assert.equal(claudePlanEnd(s, undefined, NOW, FORMAT).text, "End date not saved");
  assert.equal(claudePlanEnd(s, dates(s.id, { subscriptionExpiresOn: "2026-02-30" }), NOW, FORMAT).text, "End date not saved");
});

test("plan end: without a saved date, a monthly guess from the start date, labeled as an estimate", () => {
  // The estimate counts on this machine's calendar: the start is the 15th or 16th depending on the zone.
  const start = "2026-09-15T12:00:00Z";
  const end = claudePlanEnd(seat({ subscriptionCreatedAt: start }), undefined, NOW, FORMAT);
  assert.equal(end.kind, "estimate");
  assert.equal(end.isEnd, false);
  assert.equal(end.text, `Renews about Nov ${new Date(start).getDate()} (estimate)`);
});

test("a saved day reads as written in any display zone", () => {
  for (const timeZone of ["America/New_York", "UTC", "Asia/Tokyo", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
    const format = { locale: "en-US", timeZone };
    const end = claudePlanEnd(seat(), dates("claude-mac-main", { subscriptionExpiresOn: "2026-11-14" }), NOW, format);
    assert.equal(end.text, "Plan ends Nov 14", timeZone);
    const row = claudeNextRow(seat({ sevenDay: win(10, null) }), dates("claude-mac-main", { subscriptionExpiresOn: "2026-11-14" }), NOW, format);
    const ends = claudeStripEvents(row, stripDays(NOW, 10, format), format).get("2026-11-14") ?? [];
    assert.deepEqual(ends.map((e) => [e.kind, e.time]), [["ends", ""]], timeZone);
  }
});

test("resets: each window with a reading and a reset still ahead, soonest first", () => {
  const s = seat({
    fiveHour: win(40, "2026-11-11T17:00:00Z"),
    sevenDay: win(60, "2026-11-14T22:00:00Z"),
  });
  assert.deepEqual(
    claudeResets(s, NOW, FORMAT).map((r) => r.text),
    ["5-hour resets in 2 hours 10 min, Wed 12 PM EST", "Week resets in 3 days 7 hours, Sat 5 PM EST"],
  );
  const past = seat({ fiveHour: win(0, "2026-11-11T01:00:00Z", "stale", 50_000), sevenDay: win(null, "2026-11-14T22:00:00Z", "reset") });
  assert.deepEqual(claudeResets(past, NOW, FORMAT), [], "a long-past reset and a window without a reading say nothing");
});

test("a near-limit seat read 14 hours ago keeps its week reset and says how old the reading is", () => {
  const row = claudeNextRow(
    seat({
      id: "claude-mac-gustavo",
      status: "near_limit",
      fiveHour: win(0, "2026-11-11T01:00:00Z", "stale", 50_400),
      sevenDay: win(99, "2026-11-11T20:00:00Z", "stale", 50_400),
      lastReadAgeS: 50_400,
    }),
    undefined,
    NOW,
    FORMAT,
  );
  assert.equal(row.badge.label, "Almost empty");
  assert.equal(row.leftPercent, 1);
  assert.equal(row.oldReading, "14 hours ago");
  assert.equal(claudeRowLine(row, NOW, FORMAT), "Week resets in 5 hours 10 min, Wed 3 PM EST");
});

test("an empty seat says when it is back, and the strip marks that day and its end date", () => {
  const row = claudeNextRow(
    seat({ status: "exhausted", sevenDay: win(100, "2026-11-14T22:00:00Z", "stale", 90_000), lastReadAgeS: 90_000 }),
    dates("claude-mac-main", { subscriptionExpiresOn: "2026-11-14" }),
    NOW,
    FORMAT,
  );
  assert.equal(row.badge.label, "Empty");
  assert.equal(row.leftPercent, 0);
  assert.equal(row.backAt, Date.parse("2026-11-14T22:00:00Z"));
  assert.equal(claudeRowLine(row, NOW, FORMAT), "Back in 3 days 7 hours, Sat 5 PM EST");

  const events = claudeStripEvents(row, stripDays(NOW, 10, FORMAT), FORMAT);
  const sat = events.get("2026-11-14") ?? [];
  assert.deepEqual(sat.map((e) => e.kind).sort(), ["back", "ends"]);
  assert.equal(sat.find((e) => e.kind === "back")?.time, "5 PM");
});

test("an estimated renewal stays off the strip", () => {
  const row = claudeNextRow(
    seat({ subscriptionCreatedAt: "2026-10-15T12:00:00Z", sevenDay: win(10, null) }),
    undefined,
    NOW,
    FORMAT,
  );
  assert.equal(row.planEnd.kind, "estimate");
  assert.equal(claudeStripEvents(row, stripDays(NOW, 10, FORMAT), FORMAT).size, 0);
});

test("a broken seat with no reading says so instead of inventing numbers", () => {
  const row = claudeNextRow(seat({ id: "claude-mac-096", status: "unknown", promState: "broken", lastReadAgeS: null }), undefined, NOW, FORMAT);
  assert.equal(row.badge.label, "Not working");
  assert.equal(row.leftPercent, null);
  // An old 0% reading on a broken seat must not read as "100% left".
  const stale = claudeNextRow(
    seat({ id: "claude-mac-096", status: "unknown", promState: "broken", fiveHour: win(0, "2026-11-05T01:00:00Z", "stale", 560_000), lastReadAgeS: 560_000 }),
    undefined,
    NOW,
    FORMAT,
  );
  assert.equal(stale.leftPercent, null);
  assert.equal(claudeRowLine(row, NOW, FORMAT), "No reset time known");
});

test("a passed end date marks a seat ended only while nothing reads it now", () => {
  const passed = dates("claude-mac-main", { subscriptionExpiresOn: "2026-11-01" });
  const idle = claudeNextRow(seat({ sevenDay: win(10, null, "stale", 90_000), lastReadAgeS: 90_000 }), passed, NOW, FORMAT);
  assert.equal(idle.badge.label, "Plan ended");
  assert.equal(idle.badge.tone, "muted");
  assert.equal(idle.leftPercent, null);
  assert.equal(idle.backAt, null);
  assert.deepEqual(idle.resets, []);
  assert.equal(claudeRowLine(idle, NOW, FORMAT), "Renew to use it again");
  // Still read now: a renewal the seat file has not caught up with. Keep the usage badge; the plan line asks to check.
  const live = claudeNextRow(seat({ sevenDay: win(30, "2026-11-14T22:00:00Z") }), passed, NOW, FORMAT);
  assert.equal(live.badge.label, "Ready");
  assert.equal(live.planEnd.text, "Plan ended Nov 1 · check it");
});

test("a stale or reset 100% window does not make a seat with a current lower reading Empty", () => {
  const row = claudeNextRow(
    seat({ status: "ok", fiveHour: win(100, "2026-11-10T00:00:00Z", "stale", 90_000), sevenDay: win(30, "2026-11-14T22:00:00Z") }),
    undefined,
    NOW,
    FORMAT,
  );
  assert.equal(row.badge.label, "Ready");
  assert.equal(row.backAt, null);
  assert.equal(row.leftPercent, 70);
});

test("a saved credit or key expiry leaves the seat file's end date in place", () => {
  const merged = withSeatSubscriptions([dates("claude-mac-main", { credentialExpiresOn: "2027-01-01" })], OVERLAY);
  assert.equal(merged[0].subscriptionExpiresOn, "2026-11-14");
  assert.equal(merged[0].credentialExpiresOn, "2027-01-01");
});

test("seats sort ready first by most left, then almost empty, then empty by when they are back", () => {
  const rows = claudeNextRows(
    [
      seat({ id: "a", email: "a@example.com", status: "exhausted", sevenDay: win(100, "2026-11-16T00:00:00Z") }),
      seat({ id: "b", email: "b@example.com", status: "ok", sevenDay: win(70, "2026-11-15T00:00:00Z") }),
      seat({ id: "c", email: "c@example.com", status: "exhausted", sevenDay: win(100, "2026-11-12T00:00:00Z") }),
      seat({ id: "d", email: "d@example.com", status: "ok", sevenDay: win(20, "2026-11-15T00:00:00Z") }),
      seat({ id: "e", email: "e@example.com", status: "near_limit", sevenDay: win(95, "2026-11-15T00:00:00Z") }),
      seat({ id: "f", email: "f@example.com", status: "unknown" }),
    ],
    [],
    NOW,
    FORMAT,
  );
  assert.deepEqual(rows.map((r) => r.id), ["d", "b", "e", "c", "a", "f"]);
});

test("Codex rows show their plan end on the row; an ended plan's row already says it", () => {
  const row = {
    position: 1,
    account_id: "x",
    status: "clean",
    plan_class: "pro",
    remaining_percent: 80,
    back_at: null,
    subscription_expires_at: "2026-11-23T14:22:58Z",
  } as unknown as UseNextRow;
  assert.equal(planLine(row, NOW, FORMAT), "Pro · ends Nov 23");
  assert.equal(planLine({ ...row, status: "expired" } as UseNextRow, NOW, FORMAT), null);
});

test("the Use next badge words are the shared seat status words", () => {
  const now = Date.parse("2026-11-11T15:00:00Z");
  const label = (over: Partial<ClaudeSeat>) => claudeNextRow(seat(over), undefined, now).badge.label;
  assert.equal(label({ status: "near_limit", sevenDay: win(96, "2026-11-14T00:00:00Z") }), seatStatusLabel("near_limit"));
  assert.equal(label({ status: "no_usage_yet" }), seatStatusLabel("no_usage_yet"));
  assert.equal(label({ status: "unknown" }), seatStatusLabel("unknown"));
  assert.equal(label({ status: "ok", sevenDay: win(10, "2026-11-14T00:00:00Z") }), seatStatusLabel("ok"));
  assert.equal(seatStatusLabel("exhausted"), "Empty");
});
