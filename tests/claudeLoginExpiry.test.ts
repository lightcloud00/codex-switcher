import assert from "node:assert/strict";
import test from "node:test";
import { claudeLoginExpiry } from "../src/lib/claudeLoginExpiry.ts";

const NOW = Date.parse("2026-11-26T12:00:00Z");
const observed = "2026-11-26T11:59:00Z";
const valid = { loginExpiresAt: "2026-12-12T07:23:40.831Z", loginObservedAt: observed };

test("shows the expected UTC sign-in range and its independent check age", () => {
  assert.deepEqual(claudeLoginExpiry(valid, NOW), {
    label: "Sign-in may end Dec 9, 2026 – Dec 12, 2026 (UTC)",
    observation: "Login checked 1m ago", warning: false, historical: false,
  });
});

test("keeps older schemas, nulls, malformed dates and impossible dates unknown", () => {
  for (const expiry of [undefined, null, "", "invalid", "2026-12-12", "2026-12-12T12:00:00", "2026-02-30T12:00:00Z", "2026-12-12T24:00:00Z"]) {
    assert.equal(claudeLoginExpiry({ loginExpiresAt: expiry, loginObservedAt: observed }, NOW).label, "Sign-in expiry unknown");
  }
  assert.equal(claudeLoginExpiry({}, NOW).observation, "Login check time unavailable");
});

test("a timestamp with an offset is displayed in UTC including a cross-year window", () => {
  const view = claudeLoginExpiry({ ...valid, loginExpiresAt: "2027-01-02T01:00:00+02:00" }, NOW);
  assert.equal(view.label, "Sign-in may end Dec 29, 2026 – Jan 1, 2027 (UTC)");
});

test("warns before the expected range without declaring the login expired", () => {
  const view = claudeLoginExpiry({ ...valid, loginExpiresAt: "2026-12-02T12:00:00Z" }, NOW);
  assert.equal(view.warning, true);
  assert.match(view.label, /^Sign-in may end Nov 29, 2026/);
  const during = claudeLoginExpiry({ ...valid, loginExpiresAt: "2026-11-28T12:00:00Z" }, NOW);
  assert.equal(during.label, "Sign-in may end any day, by Nov 28, 2026 (UTC)");
  const passed = claudeLoginExpiry({ ...valid, loginExpiresAt: "2026-11-25T12:00:00Z" }, NOW);
  assert.equal(passed.label, "Sign-in may have ended by Nov 25, 2026 (UTC)");
});

test("retained metadata ages to historical even without a successful refresh", () => {
  const stale = claudeLoginExpiry(valid, NOW + 30 * 60_000);
  assert.equal(stale.historical, true);
  assert.match(stale.label, /^Last reported sign-in end:/);
  assert.equal(stale.observation, "Historical · last checked 31m ago");
  assert.equal(stale.warning, false);
});

test("missing, invalid or future check times never imply a fresh verified expiry", () => {
  for (const at of [undefined, null, "bad", "2026-11-26", "2026-11-27T12:00:00Z"]) {
    const view = claudeLoginExpiry({ ...valid, loginObservedAt: at }, NOW);
    assert.equal(view.historical, true);
    assert.equal(view.observation, "Login check time unavailable");
    assert.match(view.label, /^Last reported sign-in end:/);
  }
});

test("explicit signed-out evidence does not keep an old date as an active login", () => {
  assert.equal(claudeLoginExpiry({ ...valid, signedIn: false }, NOW).label, "Sign-in expiry unknown");
});
