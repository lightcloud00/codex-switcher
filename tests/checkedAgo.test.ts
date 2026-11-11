import assert from "node:assert/strict";
import test from "node:test";
import { checkedLine, newestSeatReadingAgeS, usageStatsMessage } from "../src/lib/checkedAgo.ts";

const NOW = Date.parse("2026-11-11T15:00:00Z");
const iso = (agoS: number) => new Date(NOW - agoS * 1000).toISOString();

test("a fresh check with fresh readings says only when it was checked", () => {
  assert.equal(checkedLine("Checked", iso(10), 120, NOW), "Checked just now");
  assert.equal(checkedLine("Checked", iso(10), 1800, NOW), "Checked just now");
  assert.equal(checkedLine("Checked", iso(10), null, NOW), "Checked just now");
});

test("an old newest reading is named next to the time of the check", () => {
  assert.equal(
    checkedLine("Checked", iso(5), 15 * 3600, NOW),
    "Checked just now · newest seat reading 15 hours ago",
  );
  assert.equal(
    checkedLine("Claude usage checked", iso(300), 2 * 86400, NOW),
    "Claude usage checked 5m ago · newest seat reading 2 days ago",
  );
  assert.equal(checkedLine("Checked", iso(5), 1801, NOW), "Checked just now · newest seat reading 30 min ago");
});

test("a missing check time leaves out the time", () => {
  assert.equal(checkedLine("Checked", null, null, NOW), "Checked");
});

test("the newest reading is the smallest age across seats", () => {
  assert.equal(newestSeatReadingAgeS([{ lastReadAgeS: 900 }, { lastReadAgeS: null }, { lastReadAgeS: 60 }]), 60);
  assert.equal(newestSeatReadingAgeS([{ lastReadAgeS: null }]), null);
  assert.equal(newestSeatReadingAgeS([]), null);
});

test("usage stats read Loading until the call has run, then Unavailable", () => {
  assert.equal(usageStatsMessage(undefined, false), "Loading usage stats…");
  assert.equal(usageStatsMessage(null, true), "Usage stats unavailable.");
  assert.equal(usageStatsMessage("Not a ChatGPT account", true), "Not a ChatGPT account");
});
