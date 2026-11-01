import type { AccountWithUsage, UsageInfo, UseNextPlan, UseNextRow, UseNextStatus } from "../types";

export const NONE = "—";

export type UseNextTone = "ok" | "warn" | "bad" | "muted";

/** Locale and zone overrides, so tests read the same everywhere; the app passes neither. */
export interface WhenFormat {
  locale?: string;
  timeZone?: string;
}

export interface UsageWindow {
  usedPercent: number | null;
  /** ms since epoch, or null without a reset time. */
  resetsAt: number | null;
  minutes: number | null;
}

export interface UseNextEntry {
  row: UseNextRow;
  account: AccountWithUsage;
}

const STATUS: Record<UseNextStatus, { label: string; tone: UseNextTone }> = {
  clean: { label: "Clean", tone: "ok" },
  busy: { label: "Busy", tone: "warn" },
  exhausted: { label: "Exhausted", tone: "bad" },
  expired: { label: "Expired", tone: "muted" },
  refresh_failed: { label: "Refresh failed", tone: "bad" },
  no_usage: { label: "No reading", tone: "muted" },
};

export function statusBadge(status: UseNextStatus): { label: string; tone: UseNextTone } {
  return STATUS[status] ?? STATUS.no_usage;
}

function toMs(value: string | number | null | undefined, unixSeconds = false): number | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "number" ? (unixSeconds ? value * 1000 : value) : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** "Nov 8, 12:09 AM EST": a date, a time and the zone, so a reset reads the same on any screen. */
export function formatWhen(ms: number | null, format: WhenFormat = {}): string {
  if (ms === null) return NONE;
  return new Intl.DateTimeFormat(format.locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: format.timeZone,
  }).format(new Date(ms));
}

/** "Nov 23", with the year only when it is not the current one. */
export function formatDay(ms: number | null, now: number, format: WhenFormat = {}): string {
  if (ms === null) return NONE;
  const year = (value: number) =>
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: format.timeZone }).format(new Date(value));
  return new Intl.DateTimeFormat(format.locale, {
    month: "short",
    day: "numeric",
    year: year(ms) === year(now) ? undefined : "numeric",
    timeZone: format.timeZone,
  }).format(new Date(ms));
}

/** "5h", "weekly", or the length in days or hours for any other window. */
export function windowLabel(minutes: number | null): string {
  if (minutes === 10_080) return "weekly";
  if (minutes === null) return "window";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  return `${Math.round(minutes / 60)}h`;
}

/**
 * The short (5h) and long (weekly) windows. A window up to six hours is the short one; without a length,
 * the primary window is short and the secondary long, as the usage API sends them.
 */
export function usageWindows(usage: UsageInfo | undefined): { short: UsageWindow | null; long: UsageWindow | null } {
  const result: { short: UsageWindow | null; long: UsageWindow | null } = { short: null, long: null };
  if (!usage || usage.error) return result;
  const windows: Array<[UsageWindow, "short" | "long"]> = [];
  const read = (used: number | null, minutes: number | null, resetsAt: number | null, fallback: "short" | "long") => {
    if (used === null && resetsAt === null) return;
    const window = { usedPercent: used, resetsAt: toMs(resetsAt, true), minutes };
    windows.push([window, minutes === null ? fallback : minutes <= 360 ? "short" : "long"]);
  };
  read(usage.primary_used_percent, usage.primary_window_minutes, usage.primary_resets_at, "short");
  read(usage.secondary_used_percent, usage.secondary_window_minutes, usage.secondary_resets_at, "long");
  for (const [window, slot] of windows) {
    if (result[slot] === null) result[slot] = window;
    else result[slot === "short" ? "long" : "short"] ??= window;
  }
  return result;
}

function usedText(window: UsageWindow | null): string {
  if (!window || window.usedPercent === null) return NONE;
  return `${Math.round(window.usedPercent)}% used`;
}

export function windowUsageText(window: UsageWindow | null): string {
  if (!window) return NONE;
  return `${windowLabel(window.minutes)} ${usedText(window)}`;
}

/** The fuller window, the one that runs out first; the weekly one on a tie. */
function bindingWindow(usage: UsageInfo | undefined): UsageWindow | null {
  const { short, long } = usageWindows(usage);
  if (!short || short.usedPercent === null) return long;
  if (!long || long.usedPercent === null) return short;
  return short.usedPercent > long.usedPercent ? short : long;
}

/** The one-line reason for a row's place. */
export function reasonLine(entry: UseNextEntry, now: number, format: WhenFormat = {}): string {
  const { row, account } = entry;
  const ends = toMs(row.subscription_expires_at);
  const window = bindingWindow(account.usage);
  const resets =
    window && window.resetsAt !== null
      ? `${windowLabel(window.minutes)} resets ${formatWhen(window.resetsAt, format)}`
      : null;
  const used = window && window.usedPercent !== null ? `${Math.round(window.usedPercent)}% used` : null;
  switch (row.status) {
    case "clean": {
      const plan = ends === null ? "no plan end date" : `plan ends ${formatDay(ends, now, format)}`;
      const first = row.position === 1 ? "Use first: " : "";
      return [`${first}${plan}`, used, resets].filter(Boolean).join(" · ");
    }
    case "busy": {
      const left = row.remaining_percent === null ? null : `${Math.round(row.remaining_percent)}% left`;
      return ["In use now", left, resets].filter(Boolean).join(" · ");
    }
    case "exhausted":
      return `Used up · back ${formatWhen(toMs(row.back_at), format)}`;
    case "refresh_failed":
      return "Usage check failed · refresh or sign in again";
    case "expired":
      return `Plan ended ${formatDay(ends, now, format)} · renew to use`;
    default:
      return "No usage reading yet";
  }
}

/** The usage readings to rank, from the accounts the window already loaded. */
export function usagesForPlan(accounts: AccountWithUsage[]): UsageInfo[] {
  return accounts.flatMap((account) => (account.usage ? [account.usage] : []));
}

/** Changes whenever a ranking input changes, so the panel asks again only then. */
export function planInputKey(accounts: AccountWithUsage[]): string {
  return accounts
    .map((account) =>
      [account.id, account.usageCheckedAt ?? 0, account.is_active ? 1 : 0, account.subscription_expires_at ?? ""].join(":")
    )
    .join("|");
}

/** The plan's rows joined to their accounts; a row for an account no longer listed is dropped. */
export function planEntries(plan: UseNextPlan | null, accounts: AccountWithUsage[]): UseNextEntry[] {
  if (!plan) return [];
  const byId = new Map(accounts.map((account) => [account.id, account]));
  return plan.rows.flatMap((row) => {
    const account = byId.get(row.account_id);
    return account ? [{ row, account }] : [];
  });
}

/** "Pro · ends Nov 30", "Free", or "Pro · ended Sep 5". */
export function planText(row: UseNextRow, now: number, format: WhenFormat = {}): string {
  const plan = row.plan_class === "unknown" ? "Plan unknown" : row.plan_class.charAt(0).toUpperCase() + row.plan_class.slice(1);
  const ends = toMs(row.subscription_expires_at);
  if (ends === null) return plan;
  return `${plan} · ${ends <= now ? "ended" : "ends"} ${formatDay(ends, now, format)}`;
}
