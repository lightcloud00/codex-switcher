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
    id: "grok-mac", computer: "Mac", bot: "Grok Bot", plan: "SuperGrok Ultra", renews: "Ends 2026-11-23 (renewal off)",
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
});

test("Grok shows the hand reading with its age and flags it stale after a day", () => {
  const [fresh, stale] = buildGrokRows(
    [
      grok({ used_percent: 40, used_observed_at: "2026-10-30T12:30:00Z" }),
      grok({ used_percent: 1, used_observed_at: "2026-10-28T05:30:00Z" }),
    ],
    NOW,
  );
  assert.equal(fresh.left, "60% (read 4h ago)");
  assert.equal(fresh.tone, "ok");
  assert.equal(stale.left, "99% (read 2d ago, stale)");
  assert.equal(stale.tone, "warn");
  assert.equal(stale.type, "Grok SuperGrok Ultra");
  assert.equal(stale.renews, "Ends 2026-11-23 (renewal off)");
});

test("Grok without a reading never invents a percent; unreachable and signed-out computers say so", () => {
  const [none, down, out] = buildGrokRows(
    [
      grok({ id: "grok-windows", computer: "Windows main", bot: "Kiwi", plan: null, renews: null, cli_signed_in: false }),
      grok({ id: "grok-miguel", bot: "Pip", signed_in: null, error: "unreachable" }),
      grok({ signed_in: false }),
    ],
    NOW,
  );
  assert.equal(none.left, "not recorded");
  assert.equal(none.type, "Grok (plan not recorded)");
  assert.equal(none.renews, "—");
  assert.match(none.detail ?? "", /Grok CLI signed out/);
  assert.equal(down.status, "unreachable");
  assert.equal(out.status, "signed out");
  assert.equal(out.tone, "bad");
});
