import assert from "node:assert/strict";
import test from "node:test";
import { buildInfoCopyText, buildInfoSummary, parseBuildInfo } from "../src/lib/buildInfo.ts";

const commit = "f6277aacfea16a606c89e3f8a45b556665fb8382";
const tree = "5b781c587326a538e62643bb84510db8b028815f";
const fixture = { version: "0.2.20", commit, tree, dirty: false, target: "aarch64-apple-darwin" };

test("copied build details contain only the build contract", () => {
  const info = parseBuildInfo({ ...fixture, token: "fixture-only", account: "person@example.com", source_path: "/private/build" });
  assert.deepEqual(info, fixture);
  assert.deepEqual(JSON.parse(buildInfoCopyText(info!)), fixture);
  assert.equal(buildInfoSummary(info!), "0.2.20 · f6277aac");
});

test("incomplete and malformed identities never look like a clean source build", () => {
  const incomplete = parseBuildInfo({ version: "0.2.20" });
  assert.deepEqual(incomplete, { version: "0.2.20", commit: null, tree: null, dirty: null, target: null });
  assert.equal(buildInfoSummary(incomplete!), "0.2.20 · source unknown");
  const malformed = parseBuildInfo({ ...fixture, commit: "not-a-commit", target: "/private/build/target.json" });
  assert.equal(malformed?.commit, null);
  assert.equal(malformed?.dirty, null);
  assert.equal(malformed?.target, null);
  for (const value of [null, [], { version: "secret data" }, { version: 20 }]) {
    assert.equal(parseBuildInfo(value), null);
  }
});

test("modified and unverified source states stay distinct", () => {
  assert.match(buildInfoSummary(parseBuildInfo({ ...fixture, dirty: true })!), /modified sources/);
  assert.match(buildInfoSummary(parseBuildInfo({ ...fixture, dirty: null })!), /source state unknown/);
  const sha256 = "ab".repeat(32);
  assert.equal(parseBuildInfo({ ...fixture, commit: sha256 })?.commit, sha256);
});
