import type {
  ClaudeSeat,
  ClaudeSeatRegistryEntry,
  ClaudeSeatStatus,
  ClaudeUsageAccount,
  ClaudeUsageWindow,
} from "../types";
import seatTable from "./claudeSeatTable.json" with { type: "json" };

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

/** A seat at or above this 7-day use is "near limit"; at 100% in either window it is "exhausted". */
export const NEAR_LIMIT_PCT: number = seatTable.near_limit_pct;

interface KnownSeat {
  id: string;
  host: string;
  plan: string;
  usage_labels: string[];
  launcher: string;
}

/** Seats the fleet runs today, from the table the capacity exporter shares. */
export const KNOWN_SEATS: readonly KnownSeat[] = seatTable.seats;

/**
 * Seat health from one usage account's two limit windows (null = no usage account for the seat yet).
 * Exhausted: either window at 100%. Near limit: 7-day at 95% or more. Ok needs a 7-day reading.
 */
export function seatStatus(
  usage: Pick<ClaudeUsageAccount, "five_hour" | "seven_day" | "probe_error"> | null | undefined,
): ClaudeSeatStatus {
  if (!usage) return "no_usage_yet";
  const five = usage.five_hour?.used_pct ?? null;
  const seven = usage.seven_day?.used_pct ?? null;
  if ((five ?? 0) >= 100 || (seven ?? 0) >= 100) return "exhausted";
  if (seven !== null && seven >= NEAR_LIMIT_PCT) return "near_limit";
  if (seven !== null) return "ok";
  if (!usage.five_hour && !usage.seven_day && !usage.probe_error) return "no_usage_yet";
  return "unknown";
}

const SEAT_STATUS_LABELS: Record<ClaudeSeatStatus, string> = {
  ok: "OK",
  near_limit: "Near limit",
  exhausted: "Exhausted",
  unknown: "Unknown",
  no_usage_yet: "No usage yet",
};

export function seatStatusLabel(status: ClaudeSeatStatus): string {
  return SEAT_STATUS_LABELS[status];
}

// Registry host id, display name, and the prefix claude-usage puts on that host's account labels.
const HOSTS = [
  { id: "mac", label: "Mac", prefix: "mac-" },
  { id: "win", label: "Windows", prefix: "windows-" },
  { id: "wsl", label: "WSL", prefix: "wsl-" },
];

/** "Mac", "Windows", "WSL"; the raw value for a host this build does not know; "" when absent. */
export function hostLabel(host: string | null | undefined): string {
  if (!host) return "";
  return HOSTS.find((h) => h.id === host)?.label ?? host;
}

/** Card title: the seat's email when known, otherwise its seat id. */
export function seatTitle(seat: Pick<ClaudeSeat, "id" | "email">): string {
  return seat.email?.trim() || seat.id;
}

/** "claude-mac-096 · Mac" under an email title; just the host under a seat-id title. */
export function seatSubtitle(seat: Pick<ClaudeSeat, "id" | "email" | "host">): string {
  const host = hostLabel(seat.host);
  return (seat.email?.trim() ? [seat.id, host] : [host]).filter(Boolean).join(" · ");
}

/** "Max" for "max"; "" when the plan is unknown. */
export function planLabel(plan: string | null | undefined): string {
  const p = plan?.trim();
  return p ? p.charAt(0).toUpperCase() + p.slice(1) : "";
}

function pickUsage(matches: ClaudeUsageAccount[]): ClaudeUsageAccount | null {
  const hasReading = (a: ClaudeUsageAccount) =>
    a.five_hour?.used_pct != null || a.seven_day?.used_pct != null;
  return matches.find(hasReading) ?? matches[0] ?? null;
}

function seatFromUsage(
  base: Pick<ClaudeSeat, "id" | "host" | "plan" | "launcher" | "inRegistry">,
  usage: ClaudeUsageAccount | null,
): ClaudeSeat {
  return {
    ...base,
    email: usage?.email?.trim() || null,
    usageAccount: usage?.account ?? null,
    fiveHour: usage?.five_hour ?? null,
    sevenDay: usage?.seven_day ?? null,
    modelWeeks: usage?.model_weeks ?? {},
    poolSpendTodayUsd: usage?.pool_spend_today_usd ?? null,
    probeError: usage?.probe_error ?? null,
    status: seatStatus(usage),
  };
}

/**
 * Merge the fleet seat registry with claude-usage accounts into one list of seats.
 *
 * With a registry: every registry seat plus every known seat (so a seat the registry does not list
 * yet, like claude-mac-096, still shows), each joined to its usage account by seat id or usage label.
 * A seat with no usage account is "no usage yet". Usage accounts that match no seat are kept as extra
 * cards, so nothing the CLI reported disappears. Without a registry (null): one seat per usage account.
 */
export function buildClaudeSeats(
  registry: ClaudeSeatRegistryEntry[] | null | undefined,
  accounts: ClaudeUsageAccount[],
): ClaudeSeat[] {
  const claimed = new Set<string>();
  const seats: ClaudeSeat[] = [];

  if (registry) {
    const defs: Array<{ base: Parameters<typeof seatFromUsage>[0]; labels: string[] }> = [];
    for (const known of KNOWN_SEATS) {
      const entry = registry.find((r) => r.id === known.id);
      defs.push({
        base: {
          id: known.id,
          host: entry?.host ?? known.host,
          plan: entry?.plan ?? known.plan,
          launcher: known.launcher,
          inRegistry: Boolean(entry),
        },
        labels: [known.id, ...known.usage_labels],
      });
    }
    for (const entry of registry) {
      if (KNOWN_SEATS.some((k) => k.id === entry.id)) continue;
      defs.push({
        base: { id: entry.id, host: entry.host, plan: entry.plan, launcher: null, inRegistry: true },
        labels: [entry.id],
      });
    }
    for (const def of defs) {
      const matches = accounts.filter((a) => def.labels.includes(a.account) && !claimed.has(a.account));
      matches.forEach((m) => claimed.add(m.account));
      seats.push(seatFromUsage(def.base, pickUsage(matches)));
    }
  }

  for (const a of accounts) {
    if (claimed.has(a.account)) continue;
    seats.push(
      seatFromUsage(
        {
          id: a.account,
          host: HOSTS.find((h) => a.account.startsWith(h.prefix))?.id ?? null,
          plan: null,
          launcher: KNOWN_SEATS.find((k) => k.usage_labels.includes(a.account))?.launcher ?? null,
          inRegistry: false,
        },
        a,
      ),
    );
  }
  return seats;
}
