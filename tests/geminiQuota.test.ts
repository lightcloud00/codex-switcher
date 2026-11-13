import assert from "node:assert/strict";
import test from "node:test";

import { geminiStatusText, tierLine, tierTone, type GeminiQuota } from "../src/lib/geminiQuota.ts";

const NOW = 1_800_000_000;
const iso = (secondsFromNow: number) => new Date((NOW + secondsFromNow) * 1000).toISOString();

test("tier line shows percent left and a reset countdown", () => {
  assert.equal(
    tierLine({ id: "pro", label: "Pro", percentLeft: 82.4, resetsAt: iso(3 * 3600 + 5 * 60) }, NOW),
    "Pro · 82% left · resets in 3h 5m",
  );
  assert.equal(tierLine({ id: "flash", label: "Flash", percentLeft: 0, resetsAt: iso(-5) }, NOW), "Flash · 0% left · resets now");
});

test("tier line leaves out a missing or unreadable reset and clamps odd percents", () => {
  assert.equal(tierLine({ id: "p", label: "Pro", percentLeft: 50, resetsAt: null }, NOW), "Pro · 50% left");
  assert.equal(tierLine({ id: "p", label: "Pro", percentLeft: 50, resetsAt: "garbage" }, NOW), "Pro · 50% left");
  assert.equal(tierLine({ id: "p", label: "Pro", percentLeft: 140, resetsAt: null }, NOW), "Pro · 100% left");
  assert.equal(tierLine({ id: "p", label: "Pro", percentLeft: Number.NaN, resetsAt: null }, NOW), "Pro · unknown");
});

test("tone cut-offs", () => {
  assert.equal(tierTone(80), "good");
  assert.equal(tierTone(30), "warn");
  assert.equal(tierTone(10), "bad");
  assert.equal(tierTone(0), "bad");
});

test("status text per state", () => {
  const q = (state: GeminiQuota["state"], plan: string | null = null): GeminiQuota => ({ state, message: "", plan, tiers: [], checkedAt: "" });
  assert.equal(geminiStatusText(null), "checking");
  assert.equal(geminiStatusText(q("ok", "Free")), "Free");
  assert.equal(geminiStatusText(q("ok")), "signed in");
  assert.equal(geminiStatusText(q("sign_in_needed")), "sign in again");
  assert.equal(geminiStatusText(q("not_installed")), "not signed in");
  assert.equal(geminiStatusText(q("unsupported_auth")), "no OAuth quota");
  assert.equal(geminiStatusText(q("unavailable")), "unavailable");
});
