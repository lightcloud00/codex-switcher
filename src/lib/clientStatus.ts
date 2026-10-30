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

/** Grok rows: the last hand reading with its age, never an invented percent; "not recorded" without one. */
export function buildGrokRows(rows: GrokBotRow[], nowMs: number): OverviewRow[] {
  return rows.map((g) => {
    const reading = g.used_percent !== null && g.used_observed_at;
    const stale = reading ? nowMs - Date.parse(g.used_observed_at as string) > STALE_MS : false;
    const left = reading
      ? `${leftText(g.used_percent)} (read ${ageText(g.used_observed_at as string, nowMs)}${stale ? ", stale" : ""})`
      : "not recorded";
    const detail = [
      g.account && g.bot,
      g.computer,
      g.app_version && `app v${g.app_version}`,
      g.cli_signed_in === false ? "Grok CLI signed out" : g.cli_signed_in ? "Grok CLI signed in" : null,
      !g.plan && "plan not recorded",
    ].filter(Boolean);
    const status = g.error === "unreachable" ? "unreachable" : g.error ? "not checked" : g.signed_in ? "signed in" : "signed out";
    return {
      id: `grok:${g.id}`,
      account: g.account?.trim() || g.bot,
      detail: detail.join(" · "),
      type: g.plan || "Grok",
      left,
      resets: "Weekly pool",
      renews: g.renews || NONE,
      status,
      tone: status === "signed in" ? (stale || !reading ? "warn" : "ok") : status === "signed out" ? "bad" : "warn",
      inactive: false,
    };
  });
}
