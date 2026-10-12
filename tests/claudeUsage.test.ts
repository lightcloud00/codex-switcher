import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  accountSubtitle,
  accountTitle,
  formatPct,
  formatTokens,
  resetCountdown,
  stateLabel,
  updatedAgo,
  windowTone,
} from "../src/lib/claudeUsage.ts";
import type { ClaudeUsageSummary, ClaudeUsageWindow } from "../src/types/index.ts";

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
