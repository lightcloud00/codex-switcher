import test from "node:test";
import assert from "node:assert/strict";
import { dateStatus, hasUnsavedDates, mergeRefresh, pendingDateLabel, signInLabel, type PlanDates, type PlanView } from "../src/lib/providerAccess.ts";
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
test("a pending probe says checking, but never overrides an observed answer", () => {
  assert.equal(signInLabel("unknown", true), "checking sign-in…");
  assert.equal(signInLabel("yes", true), "signed in");
  assert.equal(signInLabel("no", true), "not signed in");
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
const planRow = (id: string, over: Partial<PlanDates> = {}): PlanDates => ({ id, billingRenewsOn: null, creditExpiresOn: null, credentialExpiresOn: null, ...over });
type Access = { checkedAt: string; providers: string[]; plans: PlanDates[] };
const access = (plans: PlanDates[], checkedAt = "later"): Access => ({ checkedAt, providers: ["fresh"], plans });
test("a refresh over clean dates adopts the file and takes its own copy as the saved baseline", () => {
  const next = access([planRow("x-subscription", { billingRenewsOn: "2026-11-13" })]);
  const view: PlanView<Access> = { data: access([planRow("x-subscription")], "before"), saved: [planRow("x-subscription")] };
  const merged = mergeRefresh(view, next);
  assert.equal(merged.data, next);
  assert.deepEqual(merged.saved, next.plans);
  assert.notEqual(merged.saved[0], next.plans[0]);
  assert.deepEqual(mergeRefresh({ data: null, saved: [] }, next).data, next);
});
test("a refresh never overwrites a date typed and not yet saved", () => {
  const typed = [planRow("x-subscription", { billingRenewsOn: "2026-10-30" })];
  const saved = [planRow("x-subscription")];
  const merged = mergeRefresh({ data: access(typed, "before"), saved }, access([planRow("x-subscription")]));
  assert.deepEqual(merged.data?.plans, typed);
  assert.deepEqual(merged.data?.providers, ["fresh"]);
  assert.equal(merged.data?.checkedAt, "later");
  assert.equal(merged.saved, saved);
  assert.equal(hasUnsavedDates(merged.data!.plans, merged.saved), true);
});
test("a cleared saved date is also unsaved work that a refresh keeps", () => {
  const saved = [planRow("anthropic-api", { creditExpiresOn: "2026-11-13" })];
  const merged = mergeRefresh({ data: access([planRow("anthropic-api")]), saved }, access(saved.map(p => ({ ...p }))));
  assert.equal(merged.data?.plans[0].creditExpiresOn, null);
  assert.equal(merged.saved, saved);
});
