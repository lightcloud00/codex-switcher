import assert from "node:assert/strict";
import test from "node:test";
import { describeAuthFailure, needsRelogin } from "../src/lib/accountAuth.ts";

test("re-login is offered for authentication failures, not quota or network errors", () => {
  for (const message of [
    "API error: 401 Unauthorized", "HTTP 401", "invalid_grant",
    "refresh_token_reused", "refresh_token_expired", "token_invalidated",
    "Missing refresh token for account", "Your authentication token has been invalidated",
  ]) assert.equal(needsRelogin(message), true, message);
  for (const message of [null, undefined, "", "API error: 403 Forbidden", "429 Too Many Requests",
    "usage_limit_exceeded", "Network timeout", "invalid JSON", "request ID 40123 failed"])
    assert.equal(needsRelogin(message), false, String(message));
});

test("auth failures are described by what happened to the login", () => {
  const body = (code: string) =>
    `Token refresh failed: 401 Unauthorized - {"error":{"code":"${code}"}}`;
  assert.deepEqual(describeAuthFailure(body("refresh_token_invalidated")), {
    kind: "ended",
    message: "Session ended \u2014 you were signed out in Codex or elsewhere. Re-login to renew.",
  });
  assert.deepEqual(describeAuthFailure(body("refresh_token_expired")), {
    kind: "expired",
    message: "Session expired. Re-login to renew.",
  });
  assert.deepEqual(describeAuthFailure(body("refresh_token_reused")), {
    kind: "reused",
    message: "This login was renewed by another app. Re-login to renew.",
  });
  for (const message of ["API error: 401 Unauthorized", "invalid_grant", "Missing refresh token for account"])
    assert.deepEqual(
      describeAuthFailure(message),
      { kind: "unauthorized", message: "Your login needs renewing." },
      message,
    );
  assert.equal(describeAuthFailure("Your session has ended")?.kind, "ended");
  assert.equal(describeAuthFailure("token_revoked")?.kind, "ended");
  for (const message of [null, undefined, "", "API error: 403 Forbidden", "Network timeout"])
    assert.equal(describeAuthFailure(message), null, String(message));
});

test("needsRelogin follows describeAuthFailure", () => {
  for (const message of [
    "Token refresh failed: 401 Unauthorized - {\"error\":{\"code\":\"refresh_token_invalidated\"}}",
    "Your session has ended",
  ]) assert.equal(needsRelogin(message), true, message);
});
