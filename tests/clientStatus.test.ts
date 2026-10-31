import assert from "node:assert/strict";
import test from "node:test";
import { buildGrokRows, buildToolRows, type ClientToolRow, type GrokBotRow } from "../src/lib/clientStatus.ts";

const NOW = Date.parse("2026-10-30T16:30:00Z");

function tool(over: Partial<ClientToolRow>): ClientToolRow {
  return {
    id: "claude-cli", label: "Claude Code CLI", kind: "cli", version: "2.1.314", signed_in: true,
    account: null, account_type: null, model: null, note: null, ...over,
  };
}

function grok(over: Partial<GrokBotRow>): GrokBotRow {
  return {
    id: "grok-mac", computer: "Mac", bot: "Grok Bot", plan: "Grok Ultra", renews: "Ends 2026-11-23 (renewal off)",
    signed_in: true, app_version: "0.78.1", cli_signed_in: true, used_percent: null, used_observed_at: null, ...over,
  };
}

test("a tool with its own email shows it, with version, model and sign-in type on the detail line", () => {
  const [row] = buildToolRows([
    tool({ account: "me@example.com", account_type: "Claude subscription", model: "opus" }),
  ]);
  assert.equal(row.account, "me@example.com");
  assert.equal(row.detail, "v2.1.314 · model opus · Claude subscription");
  assert.equal(row.type, "Claude Code CLI");
  assert.equal(row.status, "signed in");
  assert.equal(row.tone, "ok");
});

test("Codex rows borrow the active Codex email; other tools fall back to how they sign in", () => {
  const rows = buildToolRows(
    [
      tool({ id: "codex-cli", label: "Codex CLI", account_type: "ChatGPT sign-in" }),
      tool({ id: "hermes", label: "Hermes", account_type: "profile swarm, via litellm-local" }),
    ],
    "pro@example.com",
  );
  assert.equal(rows[0].account, "pro@example.com");
  assert.match(rows[0].detail ?? "", /ChatGPT sign-in/);
  assert.equal(rows[1].account, "profile swarm, via litellm-local");
});

test("signed-out tools are bad; a missing IDE extension is muted and sorts as inactive", () => {
  const [out, missing, shared] = buildToolRows([
    tool({ signed_in: false }),
    tool({ id: "codex-ide", kind: "ide", version: null, signed_in: null }),
    tool({ id: "claude-ide", kind: "ide", version: "VS Code 2.1.285", signed_in: null }),
  ]);
  assert.equal(out.status, "signed out");
  assert.equal(out.tone, "bad");
  assert.equal(missing.status, "not installed");
  assert.equal(missing.inactive, true);
  assert.equal(shared.status, "installed");
  // IDE versions already name the editor, so they get no "v" prefix.
  assert.match(shared.detail ?? "", /^VS Code 2\.1\.285/);
});

test("three named bots remain visible without a helper and never claim account status or reset", () => {
  const rows = buildGrokRows([], NOW);
  assert.deepEqual(rows.map(r => r.account), ["Pebble", "Kiwi", "Pip"]);
  for (const row of rows) {
    assert.equal(row.status, "unverified");
    assert.equal(row.left, "not recorded");
    assert.equal(row.resets, "—");
    assert.equal(row.renews, "—");
  }
});
test("valid manual readings carry age and stale indication; invalid and future readings stay unknown", () => {
  const rows = buildGrokRows([
    grok({ used_percent: 40, used_observed_at: "2026-10-30T12:30:00Z" }),
    grok({ id: "grok-windows", used_percent: 1, used_observed_at: "2026-10-28T05:30:00Z" }),
    grok({ id: "grok-miguel", used_percent: 200, used_observed_at: "2026-10-30T12:30:00Z" }),
  ], NOW);
  assert.equal(rows[0].left, "60% (manual reading 4h ago)");
  assert.equal(rows[1].left, "99% (manual reading 2d ago, stale)");
  assert.equal(rows[2].left, "not recorded");
  assert.equal(buildGrokRows([grok({used_percent: 10, used_observed_at: "2026-10-31T12:00:00Z"})], NOW)[0].left, "not recorded");
  assert.equal(buildGrokRows([grok({used_percent: 10, used_observed_at: "invalid"})], NOW)[0].left, "not recorded");
});
test("old helper account, plan and sign-in fields are not presented as current proof", () => {
  const [row] = buildGrokRows([grok({ account: "old@example.com", signed_in: true, cli_signed_in: true })], NOW);
  assert.equal(row.account, "Pebble");
  assert.equal(row.status, "unverified");
  assert.equal(row.type, "Grok Bot");
  assert.equal(row.renews, "—");
  assert.match(row.detail ?? "", /unverified/);
  assert.equal(buildGrokRows([grok({error: "unreachable"})], NOW)[0].status, "host unreachable");
});
