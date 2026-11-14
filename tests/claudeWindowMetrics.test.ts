import assert from "node:assert/strict";
import test from "node:test";
import { claudeWindowMetrics } from "../src/lib/claudeWindowMetrics.ts";
import type { ClaudeUsageWindow } from "../src/types/index.ts";

const NOW = Date.parse("2026-11-14T04:20:00Z");
const EASTERN = { locale: "en-US", timeZone: "America/New_York" };

function window(partial: Partial<ClaudeUsageWindow> = {}): ClaudeUsageWindow {
  return {
    used_pct: 25,
    last_used_pct: 25,
    resets_at: "2026-11-14T06:20:00Z",
    observed_at: "2026-11-14T04:19:30Z",
    age_s: 30,
    state: "current",
    source: "usage",
    ...partial,
  };
}

test("an observed zero remains zero without inventing the next reset", () => {
  assert.deepEqual(claudeWindowMetrics(window({ used_pct: 0, resets_at: null }), NOW, EASTERN), {
    usedPct: 0,
    remainingText: "100% left",
    resetText: "Reset time not reported",
    observationText: "last read just now",
  });
});

test("missing windows and invalid percentages never become zero usage", () => {
  for (const missing of [null, undefined]) {
    assert.deepEqual(claudeWindowMetrics(missing, NOW, EASTERN), {
      usedPct: null,
      remainingText: "",
      resetText: "Reset time not reported",
      observationText: "",
    });
  }
  for (const used_pct of [null, Number.NaN, Infinity, -Infinity]) {
    const result = claudeWindowMetrics(window({ used_pct }), NOW, EASTERN);
    assert.equal(result.usedPct, null);
    assert.equal(result.remainingText, "");
    assert.match(result.resetText, /^Resets in 2 hours,/);
  }
});

test("finite percentages are clamped and remaining allowance is rounded", () => {
  for (const [used_pct, expected, remaining] of [[-2, 0, "100% left"], [120, 100, "0% left"], [25.2, 25.2, "75% left"]] as const) {
    const result = claudeWindowMetrics(window({ used_pct }), NOW, EASTERN);
    assert.equal(result.usedPct, expected);
    assert.equal(result.remainingText, remaining);
  }
});

test("missing and malformed reset timestamps are explicitly unknown", () => {
  for (const resets_at of [null, "", "not a timestamp"]) {
    const result = claudeWindowMetrics(window({ resets_at }), NOW, EASTERN);
    assert.equal(result.resetText, "Reset time not reported");
    assert.equal(result.usedPct, 25);
  }
});

test("five-hour and weekly windows retain their independent reset clocks", () => {
  const five = claudeWindowMetrics(window({ resets_at: "2026-11-14T06:20:00Z" }), NOW, EASTERN);
  const week = claudeWindowMetrics(window({ used_pct: 100, resets_at: "2026-11-16T14:20:00Z" }), NOW, EASTERN);
  assert.equal(five.resetText, "Resets in 2 hours, Sat 1:20 AM EST");
  assert.equal(week.resetText, "Resets in 2 days 10 hours, Mon 9:20 AM EST");
  assert.equal(week.remainingText, "0% left");
});

test("a model-specific weekly window uses the same reported reset and allowance", () => {
  const modelWeek = window({ used_pct: 61, resets_at: "2026-11-15T20:00:00Z", source: "pool" });
  const result = claudeWindowMetrics(modelWeek, NOW, EASTERN);
  assert.equal(result.remainingText, "39% left");
  assert.equal(result.resetText, "Resets in 1 day 15 hours, Sun 3 PM EST");
});

test("the reset boundary expires retained percentages even before normalization", () => {
  const source = Object.freeze(window({ used_pct: 100, resets_at: new Date(NOW).toISOString() }));
  const before = claudeWindowMetrics(source, NOW - 1, EASTERN);
  assert.equal(before.usedPct, 100);
  assert.match(before.resetText, /^Resets in 1 min,/);
  for (const now of [NOW, NOW + 1, NOW + 11 * 86_400_000]) {
    const result = claudeWindowMetrics(source, now, EASTERN);
    assert.equal(result.usedPct, null);
    assert.equal(result.remainingText, "");
    assert.equal(result.resetText, "Reset passed · waiting for a fresh reading");
  }
  assert.equal(source.used_pct, 100);
  assert.equal(source.state, "current");
});

test("an explicitly reset window cannot be revived by a missing or future timestamp", () => {
  for (const resets_at of [null, "not a timestamp", "2026-11-20T16:00:00Z"]) {
    const result = claudeWindowMetrics(window({ state: "reset", used_pct: 25, resets_at }), NOW, EASTERN);
    assert.equal(result.usedPct, null);
    assert.equal(result.remainingText, "");
    assert.equal(result.resetText, "Reset passed · waiting for a fresh reading");
  }
});

test("the next window is not fabricated when a reset passes but weekly quota remains exhausted", () => {
  const five = claudeWindowMetrics(window({ used_pct: 100, resets_at: new Date(NOW).toISOString() }), NOW, EASTERN);
  const week = claudeWindowMetrics(window({ used_pct: 100, resets_at: "2026-11-16T14:20:00Z" }), NOW, EASTERN);
  assert.equal(five.usedPct, null);
  assert.equal(week.usedPct, 100);
  assert.equal(week.remainingText, "0% left");
  assert.match(week.resetText, /Mon 9:20 AM EST$/);
});

test("fresh and stale observations both reveal their actual reading age", () => {
  assert.equal(claudeWindowMetrics(window(), NOW, EASTERN).observationText, "last read just now");
  const stale = window({ state: "stale", observed_at: "2026-11-13T23:20:00Z", age_s: 18_000 });
  const result = claudeWindowMetrics(stale, NOW, EASTERN);
  assert.equal(result.observationText, "last read 5h ago");
  assert.equal(result.usedPct, 25);
  assert.equal(result.resetText, "Resets in 2 hours, Sat 1:20 AM EST");
});

test("Eastern clock labels disambiguate the repeated hour at the daylight-saving boundary", () => {
  const now = Date.parse("2026-11-01T04:30:00Z");
  const first = claudeWindowMetrics(window({ resets_at: "2026-11-01T05:30:00Z" }), now, EASTERN);
  const second = claudeWindowMetrics(window({ resets_at: "2026-11-01T06:30:00Z" }), now, EASTERN);
  assert.equal(first.resetText, "Resets in 1 hour, Sun 1:30 AM EDT");
  assert.equal(second.resetText, "Resets in 2 hours, Sun 1:30 AM EST");
});
