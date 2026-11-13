import assert from "node:assert/strict";
import test from "node:test";

import { statusBadges, type ProviderStatus } from "../src/lib/providerStatus.ts";
import { formatResetCountdown } from "../src/lib/resetCountdown.ts";

const row = (over: Partial<ProviderStatus>): ProviderStatus => ({
  id: "openai",
  label: "OpenAI",
  indicator: "minor",
  description: "Partial System Degradation",
  pageUrl: "https://status.openai.com",
  ...over,
});

test("only providers in trouble get a badge", () => {
  const badges = statusBadges([
    row({ id: "openai", indicator: "minor" }),
    row({ id: "claude", label: "Claude", indicator: "none", description: "All Systems Operational" }),
    row({ id: "cursor", label: "Cursor", indicator: "unknown" }),
    row({ id: "factory", label: "Factory", indicator: "major", description: "" }),
    row({ id: "copilot", label: "GitHub Copilot", indicator: "critical" }),
    row({ id: "x", label: "X", indicator: "maintenance" }),
  ]);
  assert.deepEqual(
    badges.map((b) => [b.id, b.word, b.tone]),
    [
      ["openai", "degraded", "warn"],
      ["factory", "outage", "bad"],
      ["copilot", "major outage", "bad"],
      ["x", "maintenance", "info"],
    ],
  );
});

test("badge tooltip uses the page summary or falls back to the word", () => {
  const [a, b] = statusBadges([row({}), row({ id: "f", label: "Factory", indicator: "major", description: " " })]);
  assert.equal(a.title, "OpenAI: Partial System Degradation");
  assert.equal(b.title, "Factory: outage");
});

test("malformed or missing status data shows nothing", () => {
  assert.deepEqual(statusBadges(null), []);
  assert.deepEqual(statusBadges(undefined), []);
  assert.deepEqual(statusBadges("nope" as never), []);
  assert.deepEqual(statusBadges([null as never, row({ label: "" }), row({ indicator: "purple" as never })]), []);
});

test("reset countdown wording", () => {
  const now = 1_000_000;
  assert.equal(formatResetCountdown(null, now), null);
  assert.equal(formatResetCountdown(undefined, now), null);
  assert.equal(formatResetCountdown(0, now), null);
  assert.equal(formatResetCountdown(now - 1, now), "now");
  assert.equal(formatResetCountdown(now, now), "now");
  assert.equal(formatResetCountdown(now + 45, now), "45s");
  assert.equal(formatResetCountdown(now + 12 * 60 + 30, now), "12m");
  assert.equal(formatResetCountdown(now + 4 * 3600 + 55 * 60, now), "4h 55m");
  assert.equal(formatResetCountdown(now + 4 * 86_400 + 18 * 3600, now), "4d 18h");
});
