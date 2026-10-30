import test from "node:test";
import assert from "node:assert/strict";
import { asOfLabel, balanceLine, statusLabel, type ApiCreditRow } from "../src/lib/apiCredits.ts";
const row = (over: Partial<ApiCreditRow> = {}): ApiCreditRow => ({ id: "deepseek", label: "DeepSeek API", credential: "deepseek_api_key", dashboard: "https://platform.deepseek.com/usage", observed_at: "2026-10-30T13:30:16Z", ...over });
test("a USD balance reads with a dollar sign and its granted and topped-up split", () => {
  const balance = { currency: "USD", total: "55.95", granted: "3.96", topped_up: "51.98" };
  assert.equal(balanceLine(row({ available: true, balance })), "$55.95 left (granted $3.96 + topped up $51.98)");
});
test("another currency shows its code and a missing split is left out", () => {
  const balance = { currency: "CNY", total: "12.00", granted: "2.00", topped_up: "10.00" };
  assert.equal(balanceLine(row({ balance })), "CNY 12.00 left (granted CNY 2.00 + topped up CNY 10.00)");
  assert.equal(balanceLine(row({ balance: { currency: "USD", total: "5.00" } })), "$5.00 left");
  // Kimi, OpenRouter and treg send numbers: two decimals, and an overdrawn account reads -$0.20.
  assert.equal(balanceLine(row({ balance: { currency: "USD", total: 13.2837 } })), "$13.28 left");
  assert.equal(balanceLine(row({ balance: { currency: "USD", total: -0.2, topped_up: 100 } })), "-$0.20 left (topped up $100.00)");
  assert.equal(balanceLine(row({ balance: { currency: "USD", total: "5.00", granted: "0.00", topped_up: null } })), "$5.00 left (granted $0.00)");
});
test("no balance falls back to the provider note, and a failed row shows nothing", () => {
  assert.equal(balanceLine(row({ balance: null, balance_note: "Fireworks has no balance API; check the billing page." })), "Fireworks has no balance API; check the billing page.");
  assert.equal(balanceLine(row({ balance: null })), "");
  assert.equal(balanceLine(row({ error: "timeout", balance_note: "ignored" })), "");
  assert.equal(balanceLine(row({ error: "http_500", balance: { currency: "USD", total: "1.00" } })), "");
});
test("an available account is ready and an unavailable one says so", () => {
  assert.equal(statusLabel(row({ available: true })), "ready");
  assert.equal(statusLabel(row({ available: false })), "unavailable");
  assert.equal(statusLabel(row()), "unavailable");
});
test("each probe error maps to a short action label", () => {
  const label = (error: string) => statusLabel(row({ error }));
  assert.equal(label("credential_broker_unavailable"), "CredVault busy, retry");
  assert.equal(label("credential_missing"), "key not in CredVault");
  assert.equal(label("timeout"), "timed out");
  assert.equal(label("http_401"), "key rejected");
  assert.equal(label("http_403"), "key rejected");
  assert.equal(label("http_429"), "provider error 429");
  assert.equal(label("http_500"), "provider down (500)");
  assert.equal(label("URLError"), "check failed");
  assert.equal(label("http_"), "check failed");
});
test("an error wins over a stale available flag", () => {
  assert.equal(statusLabel(row({ available: true, error: "timeout" })), "timed out");
});
test("as-of reads just now under a minute and minutes under an hour", () => {
  const at = "2026-10-30T13:30:00Z";
  const later = (s: number) => new Date(Date.parse(at) + s * 1000);
  assert.equal(asOfLabel(at, later(0)), "just now");
  assert.equal(asOfLabel(at, later(59)), "just now");
  assert.equal(asOfLabel(at, later(-30)), "just now");
  assert.equal(asOfLabel(at, later(60)), "1 min ago");
  assert.equal(asOfLabel(at, later(125)), "2 min ago");
  assert.equal(asOfLabel(at, later(3599)), "59 min ago");
});
test("as-of falls back to a local time from an hour on, and tolerates a bad stamp", () => {
  const at = "2026-10-30T13:30:00Z";
  assert.equal(asOfLabel(at, new Date(Date.parse(at) + 3600 * 1000)), new Date(at).toLocaleString());
  assert.equal(asOfLabel(at, new Date(Date.parse(at) + 86400 * 1000)), new Date(at).toLocaleString());
  assert.equal(asOfLabel("not a time"), "time unknown");
});
