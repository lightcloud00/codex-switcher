import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  accountSubtitle,
  accountTitle,
  buildClaudeSeats,
  formatPct,
  formatTokens,
  hasLiveWindow,
  hostLabel,
  KNOWN_SEATS,
  lastKnownLine,
  lastReadLabel,
  limitBarNotes,
  NEAR_LIMIT_PCT,
  noReadingLine,
  overlayPrometheus,
  planLabel,
  resetCountdown,
  seatStatus,
  seatStatusLabel,
  seatSubtitle,
  seatTitle,
  stateLabel,
  unknownReason,
  updatedAgo,
  windowTone,
} from "../src/lib/claudeUsage.ts";
import type {
  ClaudePromSeat,
  ClaudePromSnapshot,
  ClaudeSeat,
  ClaudeSeatRegistryEntry,
  ClaudeUsageAccount,
  ClaudeUsageSummary,
  ClaudeUsageWindow,
} from "../src/types/index.ts";

function win(partial: Partial<ClaudeUsageWindow>): ClaudeUsageWindow {
  return {
    used_pct: 41,
    last_used_pct: 41,
    resets_at: "2026-10-14T20:00:00Z",
    observed_at: "2026-10-11T17:00:00Z",
    age_s: 60,
    state: "current",
    source: "usage",
    ...partial,
  };
}

const NOW = Date.parse("2026-10-11T17:00:00Z");

test("formatPct rounds and shows a dash for missing or reset windows", () => {
  assert.equal(formatPct(win({ used_pct: 82.6 })), "83%");
  assert.equal(formatPct(win({ used_pct: 0 })), "0%");
  assert.equal(formatPct(win({ used_pct: null, state: "reset" })), "—");
  assert.equal(formatPct(null), "—");
});

test("resetCountdown covers minutes, hours, days, past and unknown", () => {
  assert.equal(resetCountdown("2026-10-11T17:00:30Z", NOW), "in 1m");
  assert.equal(resetCountdown("2026-10-11T18:18:00Z", NOW), "in 1h 18m");
  assert.equal(resetCountdown("2026-10-14T19:00:00Z", NOW), "in 3d 2h");
  assert.equal(resetCountdown(null, NOW), "");
  assert.equal(resetCountdown("not a date", NOW), "");
});

test("resetCountdown says 'now' only within 2 minutes past the reset, and nothing for an old one", () => {
  assert.equal(resetCountdown("2026-10-11T17:00:00Z", NOW), "now");
  assert.equal(resetCountdown("2026-10-11T16:58:30Z", NOW), "now");
  assert.equal(resetCountdown("2026-10-11T16:58:00Z", NOW), "now");
  assert.equal(resetCountdown("2026-10-11T16:57:59Z", NOW), "");
  assert.equal(resetCountdown("2026-10-11T16:00:00Z", NOW), "");
  // 2026-10-13T03:10Z seen on 2026-10-30: 17 days ago is not "now".
  assert.equal(resetCountdown("2026-10-13T03:10:00Z", Date.parse("2026-10-30T12:22:00Z")), "");
});

test("windowTone thresholds", () => {
  assert.equal(windowTone(79.9), "ok");
  assert.equal(windowTone(80), "warn");
  assert.equal(windowTone(94), "warn");
  assert.equal(windowTone(95), "danger");
  assert.equal(windowTone(null), "none");
});

test("stateLabel explains non-current readings", () => {
  assert.equal(stateLabel(win({})), "");
  assert.equal(stateLabel(win({ state: "stale", age_s: 2 * 3600 + 5 })), "stale · 2h ago");
  assert.equal(stateLabel(win({ state: "reset", used_pct: null })), "reset since seen");
  assert.equal(stateLabel(undefined), "no data");
});

test("stateLabel does not call a long-forgotten reading 'reset since seen'", () => {
  const reset = (age_s: number) => win({ state: "reset", used_pct: null, age_s });
  assert.equal(stateLabel(reset(6 * 3600)), "reset since seen");
  assert.equal(stateLabel(reset(6 * 3600 + 1)), "no reading for 6h");
  assert.equal(stateLabel(reset(11 * 86400 + 3600)), "no reading for 11d");
});

test("lastReadLabel says when a window was last read and what it showed", () => {
  const now = Date.parse("2026-10-30T12:22:00Z");
  const old = win({ state: "reset", used_pct: null, last_used_pct: 40, observed_at: "2026-10-13T03:10:00Z" });
  assert.equal(lastReadLabel(old, now), "last read 17d ago, was 40%");
  const hours = win({ state: "reset", used_pct: null, last_used_pct: 8.4, observed_at: "2026-10-30T09:00:00Z" });
  assert.equal(lastReadLabel(hours, now), "last read 3h ago, was 8%");
  // A window that still shows its percentage does not repeat it.
  const stale = win({ state: "stale", used_pct: 41, observed_at: "2026-10-30T10:00:00Z" });
  assert.equal(lastReadLabel(stale, now), "last read 2h ago");
  // Without an observation time it falls back to the CLI's own age, and without either to nothing.
  const noTime = win({ state: "reset", used_pct: null, last_used_pct: 5, observed_at: "", age_s: 7200 });
  assert.equal(lastReadLabel(noTime, now), "last read 2h ago, was 5%");
  assert.equal(lastReadLabel(win({ observed_at: "", age_s: Number.NaN }), now), "");
  assert.equal(lastReadLabel(null, now), "");
  assert.equal(lastReadLabel(win({ observed_at: "2026-10-30T12:21:40Z" }), now), "last read just now");
});

test("limitBarNotes keeps the reset countdown for a stale window that still has a percentage", () => {
  const now = Date.parse("2026-10-30T12:51:00Z");
  // The live case: an exhausted pool seat, read 2.4 days ago, resetting on 2026-11-02.
  const stale = win({
    state: "stale",
    source: "pool",
    used_pct: 100,
    resets_at: "2026-11-02T14:00:00Z",
    observed_at: "2026-10-28T03:15:00Z",
    age_s: 2.4 * 86400,
  });
  assert.deepEqual(limitBarNotes(stale, now), { countdown: "in 3d 1h", lastRead: "last read 2d ago" });
  // A current reading counts down and needs no last-read note.
  const current = win({ used_pct: 41, resets_at: "2026-10-30T14:09:00Z", observed_at: "2026-10-30T12:50:00Z" });
  assert.deepEqual(limitBarNotes(current, now), { countdown: "in 1h 18m", lastRead: "" });
});

test("limitBarNotes never claims a window without a percentage resets, or that an old reset is now", () => {
  const now = Date.parse("2026-10-30T12:22:00Z");
  // reset since read: no percentage, so no countdown, but it says when it was last read.
  const reset = win({
    state: "reset",
    used_pct: null,
    last_used_pct: 40,
    resets_at: "2026-10-13T03:10:00Z",
    observed_at: "2026-10-13T03:00:00Z",
  });
  assert.deepEqual(limitBarNotes(reset, now), { countdown: "", lastRead: "last read 17d ago, was 40%" });
  // A stale percentage whose reset time is long past says nothing about "now".
  const pastStale = win({
    state: "stale",
    used_pct: 100,
    resets_at: "2026-10-29T00:00:00Z",
    observed_at: "2026-10-28T03:00:00Z",
  });
  assert.deepEqual(limitBarNotes(pastStale, now), { countdown: "", lastRead: "last read 2d ago" });
  // Within 2 minutes of the reset "now" is still honest.
  const justReset = win({ resets_at: "2026-10-30T12:21:00Z", observed_at: "2026-10-30T12:20:00Z" });
  assert.equal(limitBarNotes(justReset, now).countdown, "now");
  // No window at all: nothing to print.
  assert.deepEqual(limitBarNotes(null, now), { countdown: "", lastRead: "" });
  assert.deepEqual(limitBarNotes(undefined, now), { countdown: "", lastRead: "" });
});

test("formatTokens and updatedAgo", () => {
  assert.equal(formatTokens(2_565_300_000), "2.6B");
  assert.equal(formatTokens(5_480_000), "5.5M");
  assert.equal(formatTokens(12_300), "12.3K");
  assert.equal(formatTokens(42), "42");
  assert.equal(formatTokens(undefined), "—");
  assert.equal(updatedAgo("2026-10-11T16:55:00Z", NOW), "5m ago");
  assert.equal(updatedAgo(undefined, NOW), "");
});

test("the CLI fixture matches the summary contract", () => {
  const raw = readFileSync(new URL("./fixtures/claude-usage-summary.json", import.meta.url), "utf8");
  const s = JSON.parse(raw) as ClaudeUsageSummary;
  assert.equal(s.schema, "claude-usage.summary.v1");
  assert.ok(s.accounts.length >= 1);
  for (const a of s.accounts) {
    assert.equal(typeof a.account, "string");
    for (const w of [a.five_hour, a.seven_day]) {
      if (w) assert.ok(["current", "stale", "reset"].includes(w.state));
    }
  }
  assert.equal(typeof s.workers.runs, "number");
});

test("accountTitle shows the plan's email, falling back to the account id", () => {
  assert.equal(accountTitle({ account: "mac-max", email: "gus@example.com" }), "gus@example.com");
  assert.equal(accountTitle({ account: "wsl-max", email: null }), "wsl-max");
  assert.equal(accountTitle({ account: "wsl-max", email: "  " }), "wsl-max");
  assert.equal(accountTitle({ account: "wsl-max" }), "wsl-max");
});

test("accountSubtitle names the machine under an email title", () => {
  assert.equal(accountSubtitle({ account: "mac-max", email: "a@b.c" }), "mac-max · Mac");
  assert.equal(accountSubtitle({ account: "windows-max", email: "a@b.c" }), "windows-max · Windows");
  assert.equal(accountSubtitle({ account: "wsl-max", email: "a@b.c" }), "wsl-max · WSL");
  assert.equal(accountSubtitle({ account: "spare", email: "a@b.c" }), "spare");
  assert.equal(accountSubtitle({ account: "mac-max", email: null }), "");
});

test("fixture carries emails for probed accounts only", () => {
  const summary = JSON.parse(
    readFileSync(new URL("./fixtures/claude-usage-summary.json", import.meta.url), "utf8"),
  ) as ClaudeUsageSummary;
  assert.deepEqual(
    summary.accounts.map(accountTitle),
    ["mac-gustavo-max@example.com", "windows-max@example.com", "wsl-max"],
  );
});

// ---- Claude seats ----------------------------------------------------------------------------

function usageFixture(): ClaudeUsageSummary {
  return JSON.parse(
    readFileSync(new URL("./fixtures/claude-usage-summary.json", import.meta.url), "utf8"),
  ) as ClaudeUsageSummary;
}

/** Claude rows of the registry fixture, shaped like the get_claude_seats payload (no 096 yet). */
function registryFixture(): ClaudeSeatRegistryEntry[] {
  const raw = JSON.parse(
    readFileSync(new URL("./fixtures/subscription-accounts.json", import.meta.url), "utf8"),
  ) as {
    accounts: Array<{ id: string; host: string; cli: string; expected_plan: string; usage_account?: string }>;
  };
  return raw.accounts
    .filter((a) => a.cli === "claude")
    .map((a) => ({ id: a.id, host: a.host, plan: a.expected_plan, usage_account: a.usage_account ?? null }));
}

function account(label: string, five: number | null, seven: number | null, extra: Partial<ClaudeUsageAccount> = {}) {
  return {
    account: label,
    five_hour: five === null ? null : win({ used_pct: five }),
    seven_day: seven === null ? null : win({ used_pct: seven }),
    pool_spend_today_usd: null,
    ...extra,
  } satisfies ClaudeUsageAccount;
}

test("seatStatus: ok below 95% weekly, near limit from 95%, exhausted at 100% in either window", () => {
  assert.equal(NEAR_LIMIT_PCT, 95);
  assert.equal(seatStatus(account("a", 10, 94.9)), "ok");
  assert.equal(seatStatus(account("a", 10, 95)), "near_limit");
  assert.equal(seatStatus(account("a", 10, 99.4)), "near_limit");
  assert.equal(seatStatus(account("a", 10, 100)), "exhausted");
  assert.equal(seatStatus(account("a", 100, 40)), "exhausted");
  assert.equal(seatStatus(account("a", 100, null)), "exhausted");
});

test("seatStatus: no account is 'no usage yet'; a missing weekly reading is unknown", () => {
  assert.equal(seatStatus(null), "no_usage_yet");
  assert.equal(seatStatus(undefined), "no_usage_yet");
  assert.equal(seatStatus(account("a", null, null)), "no_usage_yet");
  assert.equal(seatStatus(account("a", null, null, { probe_error: "claude timed out" })), "unknown");
  assert.equal(seatStatus(account("a", 12, null)), "unknown");
  const reset = { ...account("a", null, null), seven_day: win({ used_pct: null, state: "reset" }) };
  assert.equal(seatStatus(reset), "unknown");
});

test("seatStatusLabel, hostLabel, planLabel", () => {
  assert.equal(seatStatusLabel("no_usage_yet"), "No usage yet");
  assert.equal(seatStatusLabel("near_limit"), "Near limit");
  assert.equal(hostLabel("win"), "Windows");
  assert.equal(hostLabel("mac"), "Mac");
  assert.equal(hostLabel("wsl"), "WSL");
  assert.equal(hostLabel("linux"), "linux");
  assert.equal(hostLabel(null), "");
  assert.equal(planLabel("max"), "Max");
  assert.equal(planLabel(null), "");
});

test("the known-seat table carries the launcher for every fleet seat", () => {
  const launchers = Object.fromEntries(KNOWN_SEATS.map((k) => [k.id, k.launcher]));
  assert.deepEqual(launchers, {
    "claude-mac-gustavo": "claude-gustavo",
    "claude-mac-main": "claude-main",
    "claude-mac-096": "claude-096",
    "claude-windows": "fleet-summon win claude sonnet",
    "claude-wsl": "fleet-summon wsl claude sonnet --account claude-wsl",
  });
});

test("seats merge the registry with usage by usage label, in fleet order", () => {
  const seats = buildClaudeSeats(registryFixture(), usageFixture().accounts);
  assert.deepEqual(
    seats.map((s) => s.id),
    ["claude-mac-gustavo", "claude-mac-main", "claude-mac-096", "claude-windows", "claude-wsl"],
  );
  const byId = Object.fromEntries(seats.map((s) => [s.id, s]));

  const gustavo = byId["claude-mac-gustavo"];
  assert.equal(gustavo.usageAccount, "mac-gustavo-max");
  assert.equal(gustavo.email, "mac-gustavo-max@example.com");
  assert.equal(gustavo.host, "mac");
  assert.equal(gustavo.plan, "max");
  assert.equal(gustavo.fiveHour?.used_pct, 59);
  assert.equal(gustavo.sevenDay?.used_pct, 41);
  assert.equal(gustavo.status, "ok");
  assert.equal(gustavo.launcher, "claude-gustavo");
  assert.equal(gustavo.inRegistry, true);

  assert.equal(byId["claude-windows"].usageAccount, "windows-max");
  assert.equal(byId["claude-windows"].sevenDay?.used_pct, 83);
  assert.equal(byId["claude-wsl"].email, null);
  assert.equal(byId["claude-wsl"].status, "ok");
});

test("a seat with no usage yet still shows, including one the registry does not list", () => {
  const seats = buildClaudeSeats(registryFixture(), usageFixture().accounts);
  const main = seats.find((s) => s.id === "claude-mac-main");
  const s096 = seats.find((s) => s.id === "claude-mac-096");
  assert.ok(main && s096);
  for (const s of [main, s096]) {
    assert.equal(s.status, "no_usage_yet");
    assert.equal(s.usageAccount, null);
    assert.equal(s.fiveHour, null);
    assert.equal(s.sevenDay, null);
    assert.equal(s.email, null);
  }
  assert.equal(main.inRegistry, true);
  assert.equal(s096.inRegistry, false);
  assert.equal(s096.host, "mac");
  assert.equal(s096.plan, "max");
  assert.equal(s096.launcher, "claude-096");
  assert.equal(seatTitle(s096), "claude-mac-096");
  assert.equal(seatSubtitle(s096), "Mac");
  assert.equal(seatStatusLabel(s096.status), "No usage yet");
});

test("claude-096 picks up usage under either its seat id or its claude-usage label", () => {
  for (const label of ["mac-096-max", "claude-096", "claude-mac-096"]) {
    const seats = buildClaudeSeats(registryFixture(), [account(label, 3, 12, { email: "seat@example.com" })]);
    const seat = seats.find((s) => s.id === "claude-mac-096");
    assert.equal(seat?.status, "ok", label);
    assert.equal(seat?.email, "seat@example.com", label);
    assert.equal(seat?.usageAccount, label, label);
    assert.equal(seats.length, 5, label);
  }
});

test("near-limit and exhausted seats are flagged from their usage", () => {
  const seats = buildClaudeSeats(registryFixture(), [
    account("mac-gustavo-max", 20, 96),
    account("mac-main-max", 100, 40),
    account("windows-max", 5, 100),
    account("wsl-max", 5, 94),
  ]);
  const status = Object.fromEntries(seats.map((s) => [s.id, s.status]));
  assert.deepEqual(status, {
    "claude-mac-gustavo": "near_limit",
    "claude-mac-main": "exhausted",
    "claude-mac-096": "no_usage_yet",
    "claude-windows": "exhausted",
    "claude-wsl": "ok",
  });
});

test("the registry's usage_account is the primary label and beats legacy aliases", () => {
  const registry = registryFixture().map((e) =>
    e.id === "claude-mac-gustavo" ? { ...e, usage_account: "gus-renamed-max" } : e,
  );
  const both = [account("mac-gustavo-max", 70, 80), account("gus-renamed-max", 9, 61, { email: "gus@example.com" })];
  // Both labels have a reading: the registry's wins, whatever order the CLI lists them in.
  for (const accounts of [both, [...both].reverse()]) {
    const seats = buildClaudeSeats(registry, accounts, null, NOW);
    assert.equal(seats.length, 5);
    assert.equal(seats[0].id, "claude-mac-gustavo");
    assert.equal(seats[0].usageAccount, "gus-renamed-max");
    assert.equal(seats[0].sevenDay?.used_pct, 61);
    assert.equal(seats[0].email, "gus@example.com");
  }
  // The table's fallback label still joins when the primary has no reading.
  const fallback = buildClaudeSeats(registry, [account("mac-gustavo-max", 70, 80), account("gus-renamed-max", null, null)], null, NOW);
  assert.equal(fallback[0].usageAccount, "mac-gustavo-max");
  assert.equal(fallback[0].sevenDay?.used_pct, 80);
  // With no reading anywhere the primary label's account stands for the seat.
  const none = buildClaudeSeats(registry, [account("mac-gustavo-max", null, null), account("gus-renamed-max", null, null)], null, NOW);
  assert.equal(none[0].usageAccount, "gus-renamed-max");
  assert.equal(none[0].status, "no_usage_yet");
  assert.equal(none.length, 5);
});

test("a registry seat the table does not know joins usage through its usage_account", () => {
  const registry = [...registryFixture(), { id: "claude-lab-1", host: "wsl", plan: "pro", usage_account: "lab-spare-max" }];
  const seats = buildClaudeSeats(registry, [account("lab-spare-max", 4, 8)], null, NOW);
  assert.equal(seats.length, 6);
  const lab = seats[5];
  assert.equal(lab.id, "claude-lab-1");
  assert.equal(lab.usageAccount, "lab-spare-max");
  assert.equal(lab.status, "ok");
});

test("a retired alias is no longer an alias of the gustavo seat", () => {
  assert.deepEqual(KNOWN_SEATS.find((k) => k.id === "claude-mac-gustavo")?.usage_labels, ["mac-gustavo-max"]);
  const seats = buildClaudeSeats(registryFixture(), [account("claude-gustavo", null, null)], null, NOW);
  assert.equal(seats[0].usageAccount, null);
  assert.equal(seats[0].status, "no_usage_yet");
});

test("a usage account that matches no seat is kept as an extra card", () => {
  const seats = buildClaudeSeats(registryFixture(), [account("lab-spare-max", 1, 2)]);
  assert.equal(seats.length, 6);
  const extra = seats[5];
  assert.equal(extra.id, "lab-spare-max");
  assert.equal(extra.launcher, null);
  assert.equal(extra.inRegistry, false);
  assert.equal(extra.status, "ok");
});

test("a registry seat this build does not know is listed after the known seats, without a launcher", () => {
  const registry = [...registryFixture(), { id: "claude-lab-1", host: "wsl", plan: "pro", usage_account: null }];
  const seats = buildClaudeSeats(registry, usageFixture().accounts);
  assert.equal(seats.length, 6);
  const lab = seats[5];
  assert.equal(lab.id, "claude-lab-1");
  assert.equal(lab.host, "wsl");
  assert.equal(lab.plan, "pro");
  assert.equal(lab.launcher, null);
  assert.equal(lab.inRegistry, true);
  assert.equal(lab.status, "no_usage_yet");
});

test("registry host and plan win over the known-seat table", () => {
  const registry = registryFixture().map((e) => (e.id === "claude-wsl" ? { ...e, plan: "team" } : e));
  const wsl = buildClaudeSeats(registry, []).find((s) => s.id === "claude-wsl");
  assert.equal(wsl?.plan, "team");
});

test("without a registry the tab is usage-only, one card per usage account", () => {
  for (const missing of [null, undefined]) {
    const seats = buildClaudeSeats(missing, usageFixture().accounts);
    assert.deepEqual(seats.map((s) => s.id), ["mac-gustavo-max", "windows-max", "wsl-max"]);
    assert.deepEqual(seats.map(seatTitle), ["mac-gustavo-max@example.com", "windows-max@example.com", "wsl-max"]);
    assert.deepEqual(seats.map((s) => s.host), ["mac", "win", "wsl"]);
    assert.ok(seats.every((s) => !s.inRegistry && s.plan === null));
    assert.equal(seats[0].launcher, "claude-gustavo");
  }
  assert.deepEqual(buildClaudeSeats(null, []), []);
});

test("seatTitle and seatSubtitle follow the email-or-id convention", () => {
  const withEmail = { id: "claude-mac-gustavo", email: "gus@example.com", host: "mac" };
  assert.equal(seatTitle(withEmail), "gus@example.com");
  assert.equal(seatSubtitle(withEmail), "claude-mac-gustavo · Mac");
  const noEmail = { id: "claude-wsl", email: null, host: "wsl" };
  assert.equal(seatTitle(noEmail), "claude-wsl");
  assert.equal(seatSubtitle(noEmail), "WSL");
  assert.equal(seatSubtitle({ id: "x", email: "  ", host: null }), "");
});

test("the default ~/.claude login is named as a login, not shown as a second seat", () => {
  const login = { id: "mac-max", email: "gus@example.com", host: "mac" };
  assert.equal(seatSubtitle(login), "default ~/.claude login, not a fleet seat · Mac");
  assert.equal(seatSubtitle({ ...login, email: null }), "default ~/.claude login, not a fleet seat · Mac");
});

// ---- The live-shaped summary (2026-10-30) ----------------------------------------------------

const LIVE_NOW = Date.parse("2026-10-30T12:22:00Z");

/** The retired claude-gustavo probe: both windows reset long ago, no error. */
function retiredAccount(extra: Partial<ClaudeUsageAccount> = {}): ClaudeUsageAccount {
  const old = { used_pct: null, last_used_pct: 40, resets_at: "2026-10-13T03:10:00Z", state: "reset" as const };
  return {
    account: "claude-gustavo",
    five_hour: win({ ...old, observed_at: "2026-10-13T00:29:11Z", age_s: 17 * 86400 }),
    seven_day: win({ ...old, observed_at: "2026-10-13T00:29:11Z", age_s: 17 * 86400 }),
    pool_spend_today_usd: null,
    probe_error: null,
    ...extra,
  };
}

/** mac-gustavo-max as the probe reads it: 9% of 5h, 61% of 7d, read two minutes ago. */
function liveGustavo(): ClaudeUsageAccount {
  const fresh = { observed_at: "2026-10-30T12:20:00Z", age_s: 120, state: "current" as const };
  return {
    account: "mac-gustavo-max",
    email: "gus@example.com",
    five_hour: win({ ...fresh, used_pct: 9, last_used_pct: 9, resets_at: "2026-10-30T12:30:00Z" }),
    seven_day: win({ ...fresh, used_pct: 61, last_used_pct: 61, resets_at: "2026-11-04T20:00:00Z" }),
    pool_spend_today_usd: null,
    probe_error: null,
  };
}

/** The default ~/.claude login: signed in with an API key, so /usage has no limit lines. */
function apiKeyLogin(): ClaudeUsageAccount {
  return {
    account: "mac-max",
    five_hour: null,
    seven_day: null,
    pool_spend_today_usd: null,
    probe_error: "usage output had no limit lines",
  };
}

function ids(seats: ClaudeSeat[]): string[] {
  return seats.map((s) => s.id);
}

test("live shape: the gustavo seat reads mac-gustavo-max and no duplicate card appears", () => {
  const accounts = [retiredAccount(), liveGustavo(), apiKeyLogin()];
  const seats = buildClaudeSeats(registryFixture(), accounts, null, LIVE_NOW);

  const gustavo = seats.find((s) => s.id === "claude-mac-gustavo");
  assert.ok(gustavo);
  assert.equal(gustavo.usageAccount, "mac-gustavo-max");
  assert.equal(gustavo.fiveHour?.used_pct, 9);
  assert.equal(gustavo.sevenDay?.used_pct, 61);
  assert.equal(gustavo.status, "ok");
  assert.equal(gustavo.email, "gus@example.com");
  assert.equal(gustavo.unknownReason, null);

  // The five fleet seats come first; the only extra is the API-key login with its honest error.
  assert.deepEqual(ids(seats).slice(0, 5), [
    "claude-mac-gustavo",
    "claude-mac-main",
    "claude-mac-096",
    "claude-windows",
    "claude-wsl",
  ]);
  assert.deepEqual(ids(seats).slice(5), ["mac-max"]);
  assert.equal(seats[5].status, "unknown");
  assert.equal(seats[5].probeError, "usage output had no limit lines");
  assert.ok(!ids(seats).includes("mac-gustavo-max"));
  assert.ok(!ids(seats).includes("claude-gustavo"));
});

test("live shape: the same result whatever order the CLI lists the accounts in", () => {
  const accounts = [retiredAccount(), liveGustavo(), apiKeyLogin()];
  for (const order of [accounts, [...accounts].reverse(), [accounts[1], accounts[2], accounts[0]]]) {
    const seats = buildClaudeSeats(registryFixture(), order, null, LIVE_NOW);
    assert.equal(seats[0].sevenDay?.used_pct, 61);
    assert.deepEqual(ids(seats).slice(5), ["mac-max"]);
  }
});

test("a retired login (only old reset windows, no probe error) is not an extra card", () => {
  const seatIds = KNOWN_SEATS.map((k) => k.id);
  const extras = (accounts: ClaudeUsageAccount[], registry: ClaudeSeatRegistryEntry[] | null = registryFixture()) =>
    ids(buildClaudeSeats(registry, accounts, null, LIVE_NOW)).filter((id) => !seatIds.includes(id));

  assert.deepEqual(extras([retiredAccount()]), []);
  // Also in usage-only mode, where every account is a card.
  assert.deepEqual(extras([retiredAccount()], null), []);
  // A probe error says something is wrong now, so the card stays.
  assert.deepEqual(extras([retiredAccount({ probe_error: "claude timed out" })]), ["claude-gustavo"]);
  // A reset window younger than 24 h is just a window that rolled over.
  const recent = retiredAccount();
  recent.five_hour = win({ state: "reset", used_pct: null, observed_at: "2026-10-30T06:00:00Z", age_s: 6 * 3600 });
  recent.seven_day = null;
  assert.deepEqual(extras([recent]), ["claude-gustavo"]);
  // Any window that is not reset keeps the card.
  const mixed = retiredAccount();
  mixed.seven_day = win({ observed_at: "2026-10-13T00:29:11Z", state: "stale", used_pct: 30 });
  assert.deepEqual(extras([mixed]), ["claude-gustavo"]);
  // Nothing to age: no windows at all is not proof of retirement.
  assert.deepEqual(extras([account("lab-spare-max", null, null)]), ["lab-spare-max"]);
  // A known seat's own label is a seat without a reading, not a retired login.
  assert.deepEqual(extras([forgottenGustavo()], null), ["mac-gustavo-max"]);
});

// ---- Prometheus overlay ----------------------------------------------------------------------

const QUERIED_AT = "2026-10-30T12:22:00Z";

function promWindow(partial: Partial<ClaudePromSeat["windows"]["5h"]> = {}): ClaudePromSeat["windows"]["5h"] {
  return { used_pct: null, resets_at: null, age_s: null, known: false, ...partial };
}

function promSeat(partial: Partial<ClaudePromSeat> = {}, windows: Partial<ClaudePromSeat["windows"]> = {}): ClaudePromSeat {
  return {
    state: "ok",
    usable: true,
    lock_orphaned: false,
    ...partial,
    windows: { "5h": promWindow(), "7d": promWindow(), ...windows },
  };
}

function prom(seats: Record<string, ClaudePromSeat>, found = true): ClaudePromSnapshot {
  return { found, error: found ? null : "Prometheus is not reachable at 127.0.0.1:9090", queried_at: QUERIED_AT, seats };
}

/** Prometheus vouching for 9% / 61%, read 30 s before it was queried. */
const PROM_GUSTAVO: ClaudePromSeat = promSeat(
  { state: "broken", usable: false, lock_orphaned: true },
  {
    "5h": promWindow({ used_pct: 9, resets_at: "2026-10-30T13:10:00Z", age_s: 30, known: true }),
    "7d": promWindow({ used_pct: 61, resets_at: "2026-11-04T19:59:00Z", age_s: 30, known: true }),
  },
);

/** claude-mac-gustavo with only a long-reset reading, as the summary has it when the probe is down. */
function forgottenGustavo(): ClaudeUsageAccount {
  const old = { used_pct: null, last_used_pct: 40, resets_at: "2026-10-13T03:10:00Z", state: "reset" as const };
  return {
    account: "mac-gustavo-max",
    five_hour: win({ ...old, observed_at: "2026-10-13T00:29:11Z", age_s: 17 * 86400 }),
    seven_day: win({ ...old, observed_at: "2026-10-13T00:29:11Z", age_s: 17 * 86400 }),
    pool_spend_today_usd: null,
    probe_error: null,
  };
}

test("Prometheus fills a seat whose usage windows have reset, and says where the numbers came from", () => {
  const seats = buildClaudeSeats(
    registryFixture(),
    [forgottenGustavo()],
    prom({ "claude-mac-gustavo": PROM_GUSTAVO }),
    LIVE_NOW,
  );
  const gustavo = seats[0];
  assert.equal(gustavo.usageAccount, "mac-gustavo-max");
  assert.equal(gustavo.fiveHour?.used_pct, 9);
  assert.equal(gustavo.fiveHour?.source, "prometheus");
  assert.equal(gustavo.fiveHour?.state, "current");
  assert.equal(gustavo.fiveHour?.resets_at, "2026-10-30T13:10:00Z");
  assert.equal(gustavo.fiveHour?.observed_at, "2026-10-30T12:21:30.000Z");
  assert.equal(gustavo.fiveHour?.age_s, 30);
  assert.equal(gustavo.sevenDay?.used_pct, 61);
  assert.equal(gustavo.status, "ok");
  assert.equal(gustavo.promState, "broken");
  assert.equal(gustavo.lockOrphaned, true);
  assert.equal(gustavo.unknownReason, null);
  assert.equal(gustavo.lastReadAgeS, 30);
  // Without Prometheus the same seat is unknown, which is the bug being fixed.
  const without = buildClaudeSeats(registryFixture(), [forgottenGustavo()], null, LIVE_NOW);
  assert.equal(without[0].status, "unknown");
  assert.equal(without[0].sevenDay?.used_pct, null);
});

test("Prometheus fills a seat that has no usage account at all", () => {
  const seats = buildClaudeSeats(registryFixture(), [], prom({ "claude-windows": PROM_GUSTAVO }), LIVE_NOW);
  const windows = seats.find((s) => s.id === "claude-windows");
  assert.equal(windows?.status, "ok");
  assert.equal(windows?.usageAccount, null);
  assert.equal(windows?.sevenDay?.used_pct, 61);
});

test("Prometheus does not override a fresher usage reading, but replaces an older one", () => {
  const usage = liveGustavo(); // read 2 minutes before LIVE_NOW
  const olderProm = promSeat({}, {
    "5h": promWindow({ used_pct: 50, resets_at: "2026-10-30T13:10:00Z", age_s: 600, known: true }),
    "7d": promWindow({ used_pct: 70, resets_at: "2026-11-04T19:59:00Z", age_s: 600, known: true }),
  });
  const kept = buildClaudeSeats(registryFixture(), [usage], prom({ "claude-mac-gustavo": olderProm }), LIVE_NOW)[0];
  assert.equal(kept.fiveHour?.used_pct, 9);
  assert.equal(kept.fiveHour?.source, "usage");
  assert.equal(kept.sevenDay?.used_pct, 61);

  const newerProm = promSeat({}, {
    "5h": promWindow({ used_pct: 12, resets_at: "2026-10-30T13:10:00Z", age_s: 10, known: true }),
    "7d": promWindow({ used_pct: 62, resets_at: "2026-11-04T19:59:00Z", age_s: 10, known: true }),
  });
  const replaced = buildClaudeSeats(registryFixture(), [usage], prom({ "claude-mac-gustavo": newerProm }), LIVE_NOW)[0];
  assert.equal(replaced.fiveHour?.used_pct, 12);
  assert.equal(replaced.fiveHour?.source, "prometheus");
  assert.equal(replaced.sevenDay?.used_pct, 62);
  // A tie keeps the local reading.
  const tie = promSeat({}, { "7d": promWindow({ used_pct: 99, resets_at: "2026-11-04T19:59:00Z", age_s: 120, known: true }) });
  const tied = buildClaudeSeats(registryFixture(), [usage], prom({ "claude-mac-gustavo": tie }), LIVE_NOW)[0];
  assert.equal(tied.sevenDay?.used_pct, 61);
});

test("Prometheus numbers are used only when vouched for, dated, and not reset since", () => {
  const base = forgottenGustavo();
  const sevenDay = (w: Partial<ClaudePromSeat["windows"]["7d"]>) =>
    buildClaudeSeats(
      registryFixture(),
      [base],
      prom({ "claude-mac-gustavo": promSeat({}, { "7d": promWindow({ resets_at: "2026-11-04T19:59:00Z", age_s: 30, ...w }) }) }),
      LIVE_NOW,
    )[0].sevenDay?.used_pct;

  assert.equal(sevenDay({ used_pct: 61, known: true }), 61);
  assert.equal(sevenDay({ used_pct: 61, known: false }), null); // the exporter does not vouch for it
  assert.equal(sevenDay({ used_pct: null, known: true }), null);
  assert.equal(sevenDay({ used_pct: 61, known: true, age_s: null }), null); // undated
  assert.equal(sevenDay({ used_pct: 61, known: true, age_s: 1e300 }), null); // absurd, must not throw
  assert.equal(sevenDay({ used_pct: 61, known: true, age_s: 7 * 3600 }), null); // not a fresh reading
  assert.equal(sevenDay({ used_pct: 61, known: true, resets_at: "2026-10-30T12:00:00Z" }), null); // reset since
  assert.equal(sevenDay({ used_pct: 250, known: true }), 100);
  assert.equal(sevenDay({ used_pct: 61, known: true, resets_at: null }), 61);
});

test("overlayPrometheus leaves a seat alone without a usable snapshot or a matching seat", () => {
  const [seat] = buildClaudeSeats(registryFixture(), [forgottenGustavo()], null, LIVE_NOW);
  assert.equal(overlayPrometheus(seat, null, LIVE_NOW), seat);
  assert.equal(overlayPrometheus(seat, undefined, LIVE_NOW), seat);
  assert.equal(overlayPrometheus(seat, prom({ "claude-mac-gustavo": PROM_GUSTAVO }, false), LIVE_NOW), seat);
  assert.equal(overlayPrometheus(seat, prom({ "claude-wsl": PROM_GUSTAVO }), LIVE_NOW), seat);
  // A snapshot from an older backend without windows must not throw.
  const bare = { ...promSeat(), windows: undefined } as unknown as ClaudePromSeat;
  assert.equal(overlayPrometheus(seat, prom({ "claude-mac-gustavo": bare }), LIVE_NOW).fiveHour, seat.fiveHour);
});

test("seat-health state and the orphaned lock land on the seat even when nothing is filled", () => {
  const broken = promSeat({ state: "broken", usable: false, lock_orphaned: true });
  const seats = buildClaudeSeats(registryFixture(), [liveGustavo()], prom({ "claude-mac-gustavo": broken }), LIVE_NOW);
  assert.equal(seats[0].promState, "broken");
  assert.equal(seats[0].lockOrphaned, true);
  assert.equal(seats[0].status, "ok"); // its numbers are fine; the badge carries the health
  assert.equal(seats[1].promState, null);
  assert.equal(seats[1].lockOrphaned, false);
});

test("a usage-only card is matched to its Prometheus seat through the usage label", () => {
  const seats = buildClaudeSeats(null, [forgottenGustavo()], prom({ "claude-mac-gustavo": PROM_GUSTAVO }), LIVE_NOW);
  assert.equal(seats[0].id, "mac-gustavo-max");
  assert.equal(seats[0].sevenDay?.used_pct, 61);
});

// ---- Seats without numbers --------------------------------------------------------------------

test("unknownReason: probe error, then orphaned lock, then seat-health, then how long ago", () => {
  const base = { probeError: null, lockOrphaned: false, promState: null, lastReadAgeS: 11 * 86400 + 100 };
  assert.equal(unknownReason(base), "no reading for 11d");
  assert.equal(unknownReason({ ...base, lastReadAgeS: null }), null);
  assert.equal(unknownReason({ ...base, promState: "ok" }), "no reading for 11d");
  assert.equal(unknownReason({ ...base, promState: "at_limit" }), "no reading for 11d");
  for (const state of ["broken", "held", "failed"]) {
    assert.equal(unknownReason({ ...base, promState: state }), `seat-health: ${state}`);
  }
  assert.equal(
    unknownReason({ ...base, promState: "broken", lockOrphaned: true }),
    "fleet-summon lock for this seat is orphaned, release it",
  );
  assert.equal(
    unknownReason({ ...base, promState: "broken", lockOrphaned: true, probeError: "usage output had no limit lines" }),
    "usage output had no limit lines",
  );
});

test("noReadingLine: 'No reading for <age>' plus the specific cause, if there is one", () => {
  const base = { probeError: null, lockOrphaned: false, promState: null, lastReadAgeS: 5.4 * 86400 };
  assert.equal(noReadingLine(base), "No reading for 5d");
  assert.equal(noReadingLine({ ...base, lastReadAgeS: null }), "No reading yet");
  assert.equal(noReadingLine({ ...base, lastReadAgeS: 7200 }), "No reading for 2h");
  assert.equal(noReadingLine({ ...base, promState: "broken" }), "No reading for 5d · seat-health: broken");
  assert.equal(
    noReadingLine({ ...base, probeError: "not signed in to a Claude subscription" }),
    "No reading for 5d · not signed in to a Claude subscription",
  );
});

test("signed-out seats (main, wsl) are unknown with a reason and an honest age", () => {
  const signedOut = (account: string, ageDays: number): ClaudeUsageAccount => {
    const observed = new Date(LIVE_NOW - ageDays * 86400_000).toISOString();
    const w = win({ state: "reset", used_pct: null, last_used_pct: 33, observed_at: observed, age_s: ageDays * 86400 });
    return { account, five_hour: w, seven_day: w, pool_spend_today_usd: null, probe_error: "usage output had no limit lines" };
  };
  const health = promSeat({ state: "broken", usable: false }, {
    "5h": promWindow({ age_s: 11.05 * 86400 }),
    "7d": promWindow({ age_s: 11.05 * 86400 }),
  });
  const seats = buildClaudeSeats(
    registryFixture(),
    [liveGustavo(), signedOut("mac-main-max", 11), signedOut("wsl-max", 5.4)],
    prom({ "claude-mac-main": health, "claude-wsl": { ...health, windows: { "5h": promWindow({ age_s: 5.4 * 86400 }), "7d": promWindow({ age_s: 5.4 * 86400 }) } } }),
    LIVE_NOW,
  );
  const byId = Object.fromEntries(seats.map((s) => [s.id, s]));
  assert.equal(byId["claude-mac-gustavo"].status, "ok");
  for (const [id, age] of [["claude-mac-main", "11d"], ["claude-wsl", "5d"]]) {
    const seat = byId[id];
    assert.equal(seat.status, "unknown", id);
    assert.equal(hasLiveWindow(seat), false, id);
    assert.equal(seat.promState, "broken", id);
    assert.equal(seat.unknownReason, "usage output had no limit lines", id);
    assert.equal(noReadingLine(seat), `No reading for ${age} · usage output had no limit lines`, id);
    assert.equal(
      lastKnownLine(seat, LIVE_NOW),
      `5-hour last read ${age} ago, was 33% · Week last read ${age} ago, was 33%`,
      id,
    );
  }
  // Once the probe error is fixed the cause that remains is the seat-health state.
  const cleared = buildClaudeSeats(
    registryFixture(),
    [{ ...signedOut("mac-main-max", 11), probe_error: null }],
    prom({ "claude-mac-main": health }),
    LIVE_NOW,
  );
  assert.equal(cleared[1].unknownReason, "seat-health: broken");
  assert.equal(noReadingLine(cleared[1]), "No reading for 11d · seat-health: broken");
});

test("unknownReason is only set for an unknown seat, and hasLiveWindow looks at the percentages", () => {
  const seats = buildClaudeSeats(registryFixture(), usageFixture().accounts, null, Date.parse("2026-10-11T17:30:00Z"));
  assert.ok(seats.every((s) => s.unknownReason === null));
  assert.equal(hasLiveWindow({ fiveHour: win({}), sevenDay: null }), true);
  assert.equal(hasLiveWindow({ fiveHour: win({ used_pct: null, state: "reset" }), sevenDay: null }), false);
  assert.equal(hasLiveWindow({ fiveHour: null, sevenDay: null }), false);
  assert.equal(lastKnownLine({ fiveHour: null, sevenDay: null }, LIVE_NOW), "");
});
