import test from "node:test";
import assert from "node:assert/strict";
import { CheckTimeoutError, failedCheckText, withTimeout } from "../src/lib/withTimeout.ts";

test("a promise that settles in time passes through", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 1000), /boom/);
});

test("a promise that never settles rejects with a timeout", async () => {
  const started = Date.now();
  await assert.rejects(withTimeout(new Promise(() => {}), 30), (e) => e instanceof CheckTimeoutError);
  assert.ok(Date.now() - started < 1000);
});

test("a late rejection after the timeout is swallowed", async () => {
  let fail: (e: Error) => void = () => {};
  const slow = new Promise<number>((_, reject) => { fail = reject; });
  await assert.rejects(withTimeout(slow, 10), CheckTimeoutError);
  fail(new Error("late"));
  await new Promise((r) => setTimeout(r, 20));
});

test("failed text is short and plain", () => {
  assert.equal(failedCheckText(new CheckTimeoutError(60000)), "Couldn't check · timed out after 60 s");
  assert.equal(failedCheckText("Error: API credit check timed out"), "Couldn't check · API credit check timed out");
  assert.equal(failedCheckText(""), "Couldn't check");
});
