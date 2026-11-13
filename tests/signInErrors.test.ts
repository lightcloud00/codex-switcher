import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { needsRelogin } from "../src/lib/accountAuth.ts";

// Same cases as the Rust classifier test in src-tauri/src/commands/credential_alerts.rs, so the two
// lists cannot drift apart unnoticed.
const cases = JSON.parse(
  readFileSync(new URL("./fixtures/sign-in-errors.json", import.meta.url), "utf8"),
) as { failures: string[]; others: string[] };

test("the TypeScript classifier agrees with the shared sign-in error cases", () => {
  for (const error of cases.failures) assert.equal(needsRelogin(error), true, error);
  for (const error of cases.others) assert.equal(needsRelogin(error), false, error);
});
