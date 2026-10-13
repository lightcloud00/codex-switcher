import type { ClaudeUsageAccount, ClaudeUsageWindow } from "../types";

export type WindowTone = "ok" | "warn" | "danger" | "none";

/** "41%" for a live window; "—" when there is no reading or the window has reset since it was seen. */
export function formatPct(w: ClaudeUsageWindow | null | undefined): string {
  if (!w || w.used_pct === null || w.used_pct === undefined) return "—";
  return `${Math.round(w.used_pct)}%`;
}

/** "in 1h 18m", "in 3d 2h", "now"; "" when unknown. */
export function resetCountdown(resetsAt: string | null | undefined, nowMs: number): string {
  if (!resetsAt) return "";
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return "";
  const s = Math.floor((t - nowMs) / 1000);
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${Math.max(m, 1)}m`;
}

export function windowTone(pct: number | null | undefined): WindowTone {
  if (pct === null || pct === undefined) return "none";
  if (pct >= 95) return "danger";
  if (pct >= 80) return "warn";
  return "ok";
}

function ago(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}

/** Badge text for a window that is not a fresh reading; "" when current. */
export function stateLabel(w: ClaudeUsageWindow | null | undefined): string {
  if (!w) return "no data";
  if (w.state === "reset") return "reset since seen";
  if (w.state === "stale") return `stale · ${ago(w.age_s)}`;
  return "";
}

/** 2_565_300_000 -> "2.6B", 5_480_000 -> "5.5M", 12_300 -> "12.3K". */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const units: Array<[number, string]> = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, suffix] of units) {
    if (Math.abs(n) >= size) return `${(n / size).toFixed(1)}${suffix}`;
  }
  return `${Math.round(n)}`;
}

export function updatedAgo(generatedAt: string | null | undefined, nowMs: number): string {
  if (!generatedAt) return "";
  const t = Date.parse(generatedAt);
  return Number.isNaN(t) ? "" : ago(Math.max(0, (nowMs - t) / 1000));
}

const MACHINES: Array<[string, string]> = [["mac-", "Mac"], ["windows-", "Windows"], ["wsl-", "WSL"]];

/** Card title: the plan's email when known, otherwise its pool account id ("mac-max"). */
export function accountTitle(a: Pick<ClaudeUsageAccount, "account" | "email">): string {
  return a.email?.trim() || a.account;
}

/** "mac-max · Mac" under an email title; "" when the title is already the account id. */
export function accountSubtitle(a: Pick<ClaudeUsageAccount, "account" | "email">): string {
  if (!a.email?.trim()) return "";
  const machine = MACHINES.find(([prefix]) => a.account.startsWith(prefix))?.[1];
  return machine ? `${a.account} · ${machine}` : a.account;
}
