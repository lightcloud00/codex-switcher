import assert from "node:assert/strict";
import test from "node:test";
import { describeAuthFailure, needsRelogin } from "../src/lib/accountAuth.ts";
import { needsRelogin as usageNeedsRelogin } from "../src/lib/usageError.ts";

test("access and usage failures do not establish a terminal refresh failure", () => {
  for (const message of [
    null, undefined, "", "API error: 401 Unauthorized", "HTTP 401", "invalid_token",
    "token_expired", "token_revoked", "token_invalidated",
    "Your authentication token has been invalidated", "API error: 403 Forbidden",
    "429 Too Many Requests", "usage_limit_exceeded", "Network timeout", "invalid JSON",
    "Token refresh returned an invalid or expired id_token",
    "Token refresh failed: 401 Unauthorized - ",
    "request ID 40123 failed", "not_invalid_grant", "refresh_token_expired_later",
  ]) {
    assert.equal(describeAuthFailure(message), null, String(message));
    assert.equal(needsRelogin(message), false, String(message));
    assert.equal(usageNeedsRelogin(message), false, String(message));
  }
});

test("all UI callers agree on explicit terminal renewal evidence", () => {
  const cases = {
    ended: ["refresh_token_invalidated", "refresh_token_revoked", "Your session has ended",
      'Token refresh failed: 401 - {"code":"token_revoked"}'],
    expired: ["refresh_token_expired"],
    reused: ["refresh_token_reused"],
    unauthorized: ["invalid_grant", "Missing refresh token for account"],
  };
  for (const [kind, messages] of Object.entries(cases)) {
    for (const message of messages) {
      assert.equal(describeAuthFailure(message)?.kind, kind, message);
      assert.match(describeAuthFailure(message)!.message, /Re-login in Switcher/);
      assert.equal(needsRelogin(message), true, message);
      assert.equal(usageNeedsRelogin(message), true, message);
    }
  }
});
