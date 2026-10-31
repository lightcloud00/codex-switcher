import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const tauriConf = JSON.parse(read("src-tauri/tauri.conf.json"));

// Fleet build: an upstream (Lampese) release must never be installable from the app.
test("tauri.conf.json carries no updater endpoint, key or artifacts", () => {
  assert.equal(tauriConf.plugins?.updater, undefined);
  assert.equal(tauriConf.bundle.createUpdaterArtifacts, false);
  assert.doesNotMatch(JSON.stringify(tauriConf), /github\.com\/Lampese|latest\.json|pubkey|endpoints/i);
});

test("the updater plugin is neither registered nor permitted", () => {
  assert.doesNotMatch(read("src-tauri/src/lib.rs"), /tauri_plugin_updater/);
  assert.doesNotMatch(read("src-tauri/capabilities/default.json"), /updater/);
});

test("the app never renders the update checker", () => {
  assert.doesNotMatch(read("src/App.tsx"), /UpdateChecker/);
});

test("the release workflow publishes no updater manifest", () => {
  assert.doesNotMatch(read(".github/workflows/build.yml"), /includeUpdaterJson:\s*true/);
});
