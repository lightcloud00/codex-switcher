// Runtime imports carry the .ts extension so the node test runner can load this file.
import { NONE, leftText, type OverviewRow } from "./overview.ts";

/** One coding client from `fleet-client-status` (Codex, Claude Code, Hermes, DeepSeek Harness). */
export interface ClientToolRow {
  id: string;
  label: string;
  kind: "cli" | "ide";
  version: string | null;
  /** null when the client has no sign-in of its own (IDE extensions share the CLI's). */
  signed_in: boolean | null;
  account: string | null;
  account_type: string | null;
  model: string | null;
  note: string | null;
}

/** One Grok Bot app, one per computer. Usage is only ever the last hand-typed reading. */
export interface GrokBotRow {
  id: string;
  computer: string;
  bot: string;
  plan: string | null;
  /** The Grok account email, when it has been read off the app. */
  account?: string | null;
  renews?: string | null;
  signed_in: boolean | null;
  app_version: string | null;
  cli_signed_in: boolean | null;
  used_percent: number | null;
  used_observed_at: string | null;
  reset_note?: string;
  error?: string;
}

export interface ClientStatusSnapshot {
  schema: string;
  source_host?: "mac";
  observed_at: string;
  tools: ClientToolRow[];
  grok: GrokBotRow[];
}

/** A hand reading older than this is shown as stale. */
const STALE_MS = 24 * 60 * 60 * 1000;

function ageText(iso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const hours = Math.floor(ms / 3_600_000);
  return hours < 1 ? "<1h ago" : hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * Tools rows: account is the client's email when it reports one, otherwise the active Codex email for Codex,
 * otherwise how it signs in. Version and default model go on the detail line.
 */
export function buildToolRows(tools: ClientToolRow[], activeCodexEmail?: string | null): OverviewRow[] {
  return tools.map((t) => {
    const email = t.account?.trim() || (t.id.startsWith("codex") ? activeCodexEmail?.trim() : "") || "";
    const detail = [
      t.version && (/^\d/.test(t.version) ? `v${t.version}` : t.version),
      t.model && `model ${t.model}`,
      email && t.account_type,
      t.note,
    ].filter(Boolean);
    const missing = t.kind === "ide" && !t.version;
    const status =
      t.signed_in === true ? "signed in" : t.signed_in === false ? "signed out" : missing ? "not installed" : "installed";
    return {
      id: `tool:${t.id}`,
      account: email || t.account_type || null,
      detail: detail.join(" · ") || undefined,
      type: t.label,
      left: NONE,
      resets: NONE,
      renews: NONE,
      status,
      tone: status === "signed out" ? "bad" : missing ? "muted" : "ok",
      inactive: missing,
    };
  });
}

/** These labels identify the fleet's bot/host associations, not authenticated accounts. */
const GROK_BOTS = [
  { id: "grok-mac", bot: "Pebble", computer: "Mac" },
  { id: "grok-windows", bot: "Kiwi", computer: "Windows main" },
  { id: "grok-miguel", bot: "Pip", computer: "Miguel’s Windows" },
] as const;

/** Show each known bot even when the optional metadata helper is unavailable. */
export function buildGrokRows(rows: GrokBotRow[], nowMs: number): OverviewRow[] {
  return GROK_BOTS.map((bot) => {
    const g = rows.find(row => row.id === bot.id);
    const observed = g?.used_observed_at ? Date.parse(g.used_observed_at) : NaN;
    const pct = g?.used_percent;
    const valid = typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct <= 100
      && Number.isFinite(observed) && observed <= nowMs;
    const stale = valid && nowMs - observed > STALE_MS;
    return {
      id: `grok:${bot.id}`,
      account: bot.bot,
      detail: `${bot.computer} · cloud account and app sign-in unverified`,
      type: "Grok Bot",
      left: valid ? `${leftText(pct)} (manual reading ${ageText(g!.used_observed_at!, nowMs)}${stale ? ", stale" : ""})` : "not recorded",
      resets: NONE,
      renews: NONE,
      status: g?.error === "unreachable" ? "host unreachable" : "unverified",
      tone: "warn",
      inactive: false,
    };
  });
}
