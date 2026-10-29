import test from "node:test";
import assert from "node:assert/strict";
import { dateStatus } from "../src/lib/providerAccess.ts";
test("unknown and invalid dates never imply renewal or capacity", () => {
  for (const v of [null, "", "2026-02-30", "not a date"]) assert.equal(dateStatus(v), "Unknown");
});
test("date-only expiry warns before day starts and never claims a paid renewal", () => {
  assert.equal(dateStatus("2026-11-13", new Date(2026,10,12)), "Due tomorrow");
  assert.equal(dateStatus("2026-11-13", new Date(2026,10,13)), "Due today · verify");
  assert.equal(dateStatus("2026-11-13", new Date(2026,10,14)), "Date passed · verify");
});
