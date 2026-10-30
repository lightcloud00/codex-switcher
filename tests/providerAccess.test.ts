import test from "node:test";
import assert from "node:assert/strict";
import { dateStatus, hasUnsavedDates, pendingDateLabel, signInLabel, type PlanDates } from "../src/lib/providerAccess.ts";
test("unknown and invalid dates never imply renewal or capacity", () => {
  for (const v of [null, "", "2026-02-30", "not a date"]) assert.equal(dateStatus(v), "Unknown");
});
test("date-only expiry warns before day starts and never claims a paid renewal", () => {
  assert.equal(dateStatus("2026-11-13", new Date(2026,10,12)), "Due tomorrow");
  assert.equal(dateStatus("2026-11-13", new Date(2026,10,13)), "Due today · verify");
  assert.equal(dateStatus("2026-11-13", new Date(2026,10,14)), "Date passed · verify");
});
test("sign-in label claims only what the CLI status proved", () => {
  assert.equal(signInLabel("yes"), "signed in");
  assert.equal(signInLabel("no"), "not signed in");
  assert.equal(signInLabel("unknown"), "sign-in unverified");
});
test("a date that is not saved reads as unsaved and keeps the normal status", () => {
  const today = new Date(2026, 9, 30);
  assert.equal(pendingDateLabel("2026-10-30", null, today), "Unsaved · Due today · verify");
  assert.equal(pendingDateLabel("2026-10-30", "", today), "Unsaved · Due today · verify");
  assert.equal(pendingDateLabel("2026-11-20", "2026-11-13", today), `Unsaved · ${dateStatus("2026-11-20", today)}`);
  assert.equal(pendingDateLabel(null, "2026-11-13", today), "Unsaved · Unknown");
});
test("unchanged dates keep the existing dateStatus output", () => {
  const today = new Date(2026, 9, 30);
  assert.equal(pendingDateLabel("2026-10-30", "2026-10-30", today), dateStatus("2026-10-30", today));
  assert.equal(pendingDateLabel(null, null, today), "Unknown");
  assert.equal(pendingDateLabel("", null, today), "Unknown");
});
test("save stays disabled until some date differs from the saved plans", () => {
  const row = (id: string, over: Partial<PlanDates> = {}): PlanDates => ({ id, billingRenewsOn: null, creditExpiresOn: null, credentialExpiresOn: null, ...over });
  const saved = [row("x-subscription"), row("anthropic-api", { creditExpiresOn: "2026-11-13" })];
  assert.equal(hasUnsavedDates(saved.map(p => ({ ...p })), saved), false);
  assert.equal(hasUnsavedDates([row("x-subscription", { billingRenewsOn: "2026-10-30" }), saved[1]], saved), true);
  assert.equal(hasUnsavedDates([saved[0], row("anthropic-api")], saved), true);
});
