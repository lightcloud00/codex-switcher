import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  accountSubtitle,
  accountTitle,
  buildClaudeSeats,
  formatPct,
  formatTokens,
  hostLabel,
  KNOWN_SEATS,
  NEAR_LIMIT_PCT,
  planLabel,
  resetCountdown,
  seatStatus,
  seatStatusLabel,
  seatSubtitle,
  seatTitle,
  stateLabel,
  updatedAgo,
  windowTone,
} from "../src/lib/claudeUsage.ts";
import type {
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
  assert.equal(resetCountdown("2026-10-11T16:00:00Z", NOW), "now");
  assert.equal(resetCountdown(null, NOW), "");
  assert.equal(resetCountdown("not a date", NOW), "");
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
    ["mac-max@example.com", "windows-max@example.com", "wsl-max"],
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
  ) as { accounts: Array<{ id: string; host: string; cli: string; expected_plan: string }> };
  return raw.accounts
    .filter((a) => a.cli === "claude")
    .map((a) => ({ id: a.id, host: a.host, plan: a.expected_plan }));
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
  assert.equal(gustavo.usageAccount, "mac-max");
  assert.equal(gustavo.email, "mac-max@example.com");
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
    account("mac-max", 20, 96),
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

test("two usage labels for one seat resolve to the one with a reading", () => {
  const seats = buildClaudeSeats(registryFixture(), [
    account("claude-gustavo", null, null),
    account("mac-max", 17, 6, { email: "gus@example.com" }),
  ]);
  assert.equal(seats.length, 5);
  const gustavo = seats[0];
  assert.equal(gustavo.id, "claude-mac-gustavo");
  assert.equal(gustavo.usageAccount, "mac-max");
  assert.equal(gustavo.sevenDay?.used_pct, 6);

  // Reversed order gives the same pick, and a reading-less alias alone still counts as the seat's account.
  const reversed = buildClaudeSeats(registryFixture(), [
    account("mac-max", 17, 6),
    account("claude-gustavo", null, null),
  ]);
  assert.equal(reversed[0].usageAccount, "mac-max");
  const aliasOnly = buildClaudeSeats(registryFixture(), [account("claude-gustavo", null, null)]);
  assert.equal(aliasOnly[0].usageAccount, "claude-gustavo");
  assert.equal(aliasOnly[0].status, "no_usage_yet");
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
  const registry = [...registryFixture(), { id: "claude-lab-1", host: "wsl", plan: "pro" }];
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
    assert.deepEqual(seats.map((s) => s.id), ["mac-max", "windows-max", "wsl-max"]);
    assert.deepEqual(seats.map(seatTitle), ["mac-max@example.com", "windows-max@example.com", "wsl-max"]);
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
