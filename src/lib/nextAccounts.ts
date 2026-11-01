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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A word on every chip, so a status never rests on its color alone.
const STATUS: Record<UseNextStatus, { label: string; tone: UseNextTone }> = {
  clean: { label: "Ready", tone: "ok" },
  busy: { label: "Busy", tone: "warn" },
  exhausted: { label: "Empty", tone: "bad" },
  expired: { label: "Expired", tone: "muted" },
  refresh_failed: { label: "Refresh failed", tone: "muted" },
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

// "5:00 PM" reads as "5 PM"; the space before AM/PM may be a narrow no-break one.
const dropZeroMinutes = (text: string) => text.replace(/:00(?=\s?[AP]M)/g, "");

/** "Sat 5 PM EST" within the coming week; "Sat, Nov 14, 5:30 PM EST" further out, in the past, or on request. */
export function formatClock(ms: number, now: number, format: WhenFormat = {}, withDate = false): string {
  const near = !withDate && ms >= now - HOUR && ms - now < 6 * DAY;
  const date = new Date(ms);
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(format.locale, { ...options, timeZone: format.timeZone }).format(date);
  // Built from parts: with a zone name, Intl would put a comma after the weekday.
  const weekday = part({ weekday: "short" });
  const time = dropZeroMinutes(part({ hour: "numeric", minute: "2-digit", timeZoneName: "short" }));
  return near ? `${weekday} ${time}` : `${weekday}, ${part({ month: "short", day: "numeric" })}, ${time}`;
}

/** "Sat 3:30 PM": weekday and time, no zone, for the narrow menu bar. */
function formatShortClock(ms: number, format: WhenFormat = {}): string {
  const date = new Date(ms);
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(format.locale, { ...options, timeZone: format.timeZone }).format(date);
  return `${part({ weekday: "short" })} ${dropZeroMinutes(part({ hour: "numeric", minute: "2-digit" }))}`;
}

/** Time left as words: "42 min", "5 hours 10 min", "2 days 4 hours". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? plural(hours, "hour") : `${plural(hours, "hour")} ${rest} min`;
  }
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  return hours === 0 ? plural(days, "day") : `${plural(days, "day")} ${plural(hours, "hour")}`;
}

/** "in 2 days 4 hours", or "due now" once the time has passed. */
export function formatIn(ms: number, now: number): string {
  return ms > now ? `in ${formatDuration(ms - now)}` : "due now";
}

/** "in 2 days 4 hours, Sat 5 PM EST", or "due now (Sat 5 PM EST)" once the time has passed. */
export function formatCountdown(ms: number | null, now: number, format: WhenFormat = {}): string {
  if (ms === null) return NONE;
  const clock = formatClock(ms, now, format);
  return ms > now ? `${formatIn(ms, now)}, ${clock}` : `due now (${clock})`;
}

/** "just now", "4 min ago", "2 hours ago". */
export function formatAgo(ms: number, now: number): string {
  const elapsed = now - ms;
  if (elapsed < MINUTE) return "just now";
  return `${formatDuration(elapsed)} ago`;
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

/** "86% left", or null without a reading. */
export function leftText(row: UseNextRow): string | null {
  return row.remaining_percent === null ? null : `${Math.round(row.remaining_percent)}% left`;
}

/** The one line under a row: what happens to this account next. */
export function rowLine(entry: UseNextEntry, now: number, format: WhenFormat = {}): string {
  const { row, account } = entry;
  const window = bindingWindow(account.usage);
  const resets =
    window && window.resetsAt !== null
      ? `${windowLabel(window.minutes)} resets ${formatCountdown(window.resetsAt, now, format)}`
      : null;
  switch (row.status) {
    case "clean":
      return resets ?? "Ready to use";
    case "busy":
      return ["In use now", resets].filter(Boolean).join(" · ");
    case "exhausted":
      return `Back ${formatCountdown(toMs(row.back_at), now, format)}`;
    case "refresh_failed":
      return "Couldn't check usage · refresh or sign in again";
    case "expired":
      return `Plan ended ${formatDay(toMs(row.subscription_expires_at), now, format)} · renew to use`;
    default:
      return "No usage reading yet";
  }
}

/** Why the row sits where it does, for the Details section. */
export function whyText(row: UseNextRow): string {
  switch (row.status) {
    case "clean":
      return "Ready: ready accounts go first, the plan that ends soonest first, as router_plan orders them.";
    case "busy":
      return "Busy: Codex is running on it now, so the router hands it to nobody else.";
    case "exhausted":
      return "Empty: a usage window is used up. Empty accounts follow by when they come back.";
    case "refresh_failed":
      return "The last usage check failed, so it can't be ranked.";
    case "expired":
      return "The plan has ended, so it goes last.";
    default:
      return "No usage reading yet, so it can't be ranked.";
  }
}

/** "Pro · ends Nov 30", "Free", or "Pro · ended Sep 5". */
export function planText(row: UseNextRow, now: number, format: WhenFormat = {}): string {
  const plan = row.plan_class === "unknown" ? "Plan unknown" : row.plan_class.charAt(0).toUpperCase() + row.plan_class.slice(1);
  const ends = toMs(row.subscription_expires_at);
  if (ends === null) return plan;
  return `${plan} · ${ends <= now ? "ended" : "ends"} ${formatDay(ends, now, format)}`;
}

/** The usage readings to rank, from the accounts the window already loaded. */
export function usagesForPlan(accounts: AccountWithUsage[]): UsageInfo[] {
  return accounts.flatMap((account) => (account.usage ? [account.usage] : []));
}

/** Changes whenever a ranking input changes, so the plan is asked for again only then. */
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

/** When the newest usage reading came back, or null before the first one. */
export function lastChecked(accounts: AccountWithUsage[]): number | null {
  const times = accounts.flatMap((account) => (account.usageCheckedAt === undefined ? [] : [account.usageCheckedAt]));
  return times.length === 0 ? null : Math.max(...times);
}

export type HeroPick =
  /** The first ready account: the one to use now. */
  | { kind: "ready"; entry: UseNextEntry }
  /** Nothing else is ready, but the account in use still has room. */
  | { kind: "keep"; entry: UseNextEntry }
  /** Nothing has room; this account comes back first. */
  | { kind: "empty"; entry: UseNextEntry; backAt: number }
  /** Nothing has room and no reset time is known. */
  | { kind: "none" };

/** The one account the top card points at, straight from the plan's order. */
export function heroPick(entries: UseNextEntry[]): HeroPick {
  const ready = entries.find((entry) => entry.row.status === "clean");
  if (ready) return { kind: "ready", entry: ready };
  const busy = entries.find((entry) => entry.row.status === "busy" && (entry.row.remaining_percent ?? 1) > 0);
  if (busy) return { kind: "keep", entry: busy };
  let first: { entry: UseNextEntry; backAt: number } | null = null;
  for (const entry of entries) {
    const backAt = entry.row.status === "exhausted" ? toMs(entry.row.back_at) : null;
    if (backAt !== null && (first === null || backAt < first.backAt)) first = { entry, backAt };
  }
  return first ? { kind: "empty", ...first } : { kind: "none" };
}

/** What the tray shows: pre-formatted, names only. The tray never ranks on its own. */
export interface TrayUseNext {
  /** Account the tray line switches to; null when no account is ready. */
  accountId: string | null;
  menuLabel: string;
  title: string;
}

const TRAY_NAME_MAX = 14;
const shortName = (name: string) => (name.length > TRAY_NAME_MAX ? `${name.slice(0, TRAY_NAME_MAX - 1)}…` : name);

/** Times only, never countdowns: the tray text must not go stale between readings. */
export function trayUseNext(pick: HeroPick, now: number, format: WhenFormat = {}): TrayUseNext {
  switch (pick.kind) {
    case "ready":
    case "keep": {
      const { row, account } = pick.entry;
      const percent = row.remaining_percent === null ? "" : ` ${Math.round(row.remaining_percent)}%`;
      const verb = pick.kind === "ready" ? "Use next" : "Keep using";
      return {
        accountId: account.id,
        menuLabel: [`${verb}: ${account.name}`, leftText(row)].filter(Boolean).join(" · "),
        title: `${shortName(account.name)}${percent}`,
      };
    }
    case "empty":
      return {
        accountId: null,
        menuLabel: `Codex empty until ${formatClock(pick.backAt, now, format, true)}`,
        title: `Empty → ${formatShortClock(pick.backAt, format)}`,
      };
    default:
      return { accountId: null, menuLabel: "No Codex account is ready", title: "Codex —" };
  }
}

/** Days the strip marks, e.g. a stretch of filming. Shown only while they fall inside the strip. */
export const MARKED_DAYS = { first: "2026-11-04", last: "2026-11-08", label: "Show" } as const;

export interface StripDay {
  /** "2026-11-04" in the display zone. */
  key: string;
  weekday: string;
  day: number;
  month: string;
  isToday: boolean;
  marked: boolean;
}

/** "2026-11-04" for the calendar day `ms` falls on in the display zone. */
export function dayKey(ms: number, format: WhenFormat = {}): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: format.timeZone,
  }).format(new Date(ms));
}

/** `count` calendar days from today. Steps whole dates, so a daylight-saving change never skips a day. */
export function stripDays(now: number, count = 10, format: WhenFormat = {}): StripDay[] {
  const [year, month, day] = dayKey(now, format).split("-").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1, day + index, 12));
    const key = date.toISOString().slice(0, 10);
    const label = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(format.locale, { ...options, timeZone: "UTC" }).format(date);
    return {
      key,
      weekday: label({ weekday: "short" }),
      day: date.getUTCDate(),
      month: label({ month: "short" }),
      isToday: index === 0,
      marked: key >= MARKED_DAYS.first && key <= MARKED_DAYS.last,
    };
  });
}

export type StripEventKind = "back" | "reset" | "ends";

export interface StripEvent {
  kind: StripEventKind;
  at: number;
  /** "3:30 PM" in the display zone. */
  time: string;
}

/** What happens to an account on each strip day: when it comes back, its weekly reset, and its plan end. */
export function stripEvents(entry: UseNextEntry, days: StripDay[], format: WhenFormat = {}): Map<string, StripEvent[]> {
  const keys = new Set(days.map((day) => day.key));
  const events = new Map<string, StripEvent[]>();
  const add = (kind: StripEventKind, at: number | null) => {
    if (at === null) return;
    const key = dayKey(at, format);
    if (!keys.has(key)) return;
    const list = events.get(key) ?? [];
    if (list.some((event) => event.at === at)) return;
    const time = dropZeroMinutes(
      new Intl.DateTimeFormat(format.locale, { hour: "numeric", minute: "2-digit", timeZone: format.timeZone }).format(
        new Date(at)
      )
    );
    list.push({ kind, at, time });
    events.set(key, list);
  };
  const { row, account } = entry;
  if (row.status === "exhausted") add("back", toMs(row.back_at));
  if (row.status !== "expired") add("reset", usageWindows(account.usage).long?.resetsAt ?? null);
  add("ends", toMs(row.subscription_expires_at));
  return events;
}
