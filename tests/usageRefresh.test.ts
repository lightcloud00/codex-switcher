import assert from "node:assert/strict";
import test from "node:test";
import {
  createUsageRefresher,
  UsageRefreshSupersededError,
  type UsageRefreshResult,
} from "../src/lib/usageRefresh.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("overlapping bulk and row callers share one read and one completion", async () => {
  const read = deferred<number>();
  const starts: string[] = [];
  const results: UsageRefreshResult<number>[] = [];
  let requests = 0;
  const usage = createUsageRefresher(
    async () => { requests++; return read.promise; },
    { onStart: (id) => starts.push(id), onResult: (result) => results.push(result), now: () => 123 },
  );
  usage.setAccountIds(["a"]);

  const bulk = usage.refresh("a");
  const row = usage.refresh("a");
  assert.equal(bulk, row);
  await Promise.resolve();
  assert.equal(requests, 1);
  assert.deepEqual(starts, ["a"]);

  read.resolve(42);
  assert.deepEqual(await Promise.all([bulk, row]), [42, 42]);
  assert.deepEqual(results, [{ accountId: "a", ok: true, value: 42, checkedAt: 123 }]);
});

test("a healthy account publishes before a slow account with its own completion time", async () => {
  const fast = deferred<number>();
  const slow = deferred<number>();
  const results: UsageRefreshResult<number>[] = [];
  let now = 100;
  const usage = createUsageRefresher(
    (id) => id === "fast" ? fast.promise : slow.promise,
    { onResult: (result) => results.push(result), now: () => now },
  );
  usage.setAccountIds(["fast", "slow"]);
  const first = usage.refresh("fast");
  const second = usage.refresh("slow");

  fast.resolve(10);
  assert.equal(await first, 10);
  assert.deepEqual(results, [{ accountId: "fast", ok: true, value: 10, checkedAt: 100 }]);
  now = 900;
  slow.resolve(20);
  await second;
  assert.deepEqual(results, [
    { accountId: "fast", ok: true, value: 10, checkedAt: 100 },
    { accountId: "slow", ok: true, value: 20, checkedAt: 900 },
  ]);
});

test("a failed shared read publishes one failure and a later retry starts a new read", async () => {
  const failed = deferred<number>();
  const retry = deferred<number>();
  const results: UsageRefreshResult<number>[] = [];
  let requests = 0;
  const usage = createUsageRefresher(
    () => ++requests === 1 ? failed.promise : retry.promise,
    { onResult: (result) => results.push(result), now: () => 10 },
  );
  usage.setAccountIds(["a"]);
  const first = usage.refresh("a");
  const second = usage.refresh("a");
  const waiting = Promise.allSettled([first, second]);
  const failure = new Error("temporarily unavailable");
  failed.reject(failure);
  const settled = await waiting;
  assert.equal(settled[0].status, "rejected");
  assert.equal(settled[1].status, "rejected");
  assert.equal(requests, 1);
  assert.deepEqual(results, [{ accountId: "a", ok: false, error: failure, checkedAt: 10 }]);

  const next = usage.refresh("a");
  retry.resolve(80);
  assert.equal(await next, 80);
  assert.equal(requests, 2);
  assert.equal(results.length, 2);
  assert.equal(results[1].ok, true);
});

test("a removed and re-added account rejects old success without clearing its new pending read", async () => {
  const old = deferred<number>();
  const replacement = deferred<number>();
  const results: UsageRefreshResult<number>[] = [];
  let requests = 0;
  const usage = createUsageRefresher(
    () => ++requests === 1 ? old.promise : replacement.promise,
    { onResult: (result) => results.push(result), now: () => 20 },
  );
  usage.setAccountIds(["a"]);
  const first = usage.refresh("a");
  const superseded = assert.rejects(first, UsageRefreshSupersededError);
  await Promise.resolve();

  usage.setAccountIds([]);
  usage.setAccountIds(["a"]);
  const next = usage.refresh("a");
  await Promise.resolve();
  old.resolve(1);
  await superseded;
  assert.deepEqual(results, []);
  assert.equal(usage.refresh("a"), next);

  replacement.resolve(90);
  assert.equal(await next, 90);
  assert.deepEqual(results, [{ accountId: "a", ok: true, value: 90, checkedAt: 20 }]);
});

test("a late failure from an old login cannot replace a newer successful reading", async () => {
  const old = deferred<number>();
  const next = deferred<number>();
  const results: UsageRefreshResult<number>[] = [];
  let requests = 0;
  const usage = createUsageRefresher(
    () => ++requests === 1 ? old.promise : next.promise,
    { onResult: (result) => results.push(result), now: () => 50 },
  );
  usage.setAccountIds(["a"]);
  const first = usage.refresh("a");
  const superseded = assert.rejects(first, UsageRefreshSupersededError);
  await Promise.resolve();

  usage.setAccountIds([]);
  usage.setAccountIds(["a"]);
  const current = usage.refresh("a");
  next.resolve(75);
  await current;
  old.reject(new Error("expired old login"));
  await superseded;
  assert.deepEqual(results, [{ accountId: "a", ok: true, value: 75, checkedAt: 50 }]);
});

test("a metadata-only account list refresh retains the current usage request", async () => {
  const read = deferred<number>();
  let requests = 0;
  const usage = createUsageRefresher(
    async () => { requests++; return read.promise; },
    { onResult: () => {} },
  );
  usage.setAccountIds(["a"]);
  const first = usage.refresh("a");
  usage.setAccountIds(["a", "b"]);
  assert.equal(usage.refresh("a"), first);
  read.resolve(7);
  await first;
  assert.equal(requests, 1);
});

test("unmount before a queued read starts does not issue a request or publish a result", async () => {
  let requests = 0;
  const results: UsageRefreshResult<number>[] = [];
  const usage = createUsageRefresher(
    async () => { requests++; return 1; },
    { onResult: (result) => results.push(result) },
  );
  usage.setAccountIds(["a"]);
  const pending = usage.refresh("a");
  usage.setAccountIds([]);
  await assert.rejects(pending, UsageRefreshSupersededError);
  await assert.rejects(usage.refresh("a"), UsageRefreshSupersededError);
  assert.equal(requests, 0);
  assert.deepEqual(results, []);
});

test("synchronous request failure releases the pending entry for retry", async () => {
  let requests = 0;
  const results: UsageRefreshResult<number>[] = [];
  const usage = createUsageRefresher(
    () => {
      if (++requests === 1) throw new Error("invoke unavailable");
      return Promise.resolve(2);
    },
    { onResult: (result) => results.push(result) },
  );
  usage.setAccountIds(["a"]);
  await assert.rejects(usage.refresh("a"), /invoke unavailable/);
  assert.equal(await usage.refresh("a"), 2);
  assert.deepEqual(results.map((result) => result.ok), [false, true]);
});
