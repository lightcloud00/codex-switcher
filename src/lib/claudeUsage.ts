import type {
  ClaudePromSeat,
  ClaudePromSnapshot,
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

/** A reset this recent still counts as "now"; an older one says nothing about the window today. */
const RESET_NOW_GRACE_S = 120;

/** "in 1h 18m", "in 3d 2h", "now" (within 2 minutes past the reset); "" when unknown or long past. */
export function resetCountdown(resetsAt: string | null | undefined, nowMs: number): string {
  if (!resetsAt) return "";
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return "";
  const s = Math.floor((t - nowMs) / 1000);
  if (s <= 0) return s >= -RESET_NOW_GRACE_S ? "now" : "";
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

/** "5m", "3h", "11d"; "<1m" under a minute. */
function ageShort(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

function ago(seconds: number): string {
  const short = ageShort(seconds);
  return short === "<1m" ? "just now" : `${short} ago`;
}

/** Past this age a "reset" window is a forgotten reading, not a window that just rolled over. */
const RESET_STALE_AFTER_S = 6 * 3600;

/** Seconds since the window was read, as of nowMs; falls back to the CLI's own age_s. */
function windowAgeS(w: ClaudeUsageWindow | null | undefined, nowMs: number): number | null {
  if (!w) return null;
  const t = Date.parse(w.observed_at);
  if (!Number.isNaN(t)) return Math.max(0, (nowMs - t) / 1000);
  return Number.isFinite(w.age_s) ? w.age_s : null;
}

/** Badge text for a window that is not a fresh reading; "" when current. */
export function stateLabel(w: ClaudeUsageWindow | null | undefined): string {
  if (!w) return "no data";
  if (w.state === "reset") {
    return w.age_s > RESET_STALE_AFTER_S ? `no reading for ${ageShort(w.age_s)}` : "reset since seen";
  }
  if (w.state === "stale") return `stale · ${ago(w.age_s)}`;
  return "";
}

/** "last read 11d ago, was 40%" for a window that is no longer current; "" without an observation time. */
export function lastReadLabel(w: ClaudeUsageWindow | null | undefined, nowMs: number): string {
  const age = windowAgeS(w, nowMs);
  if (!w || age === null) return "";
  // A window that still shows its percentage does not need it repeated.
  const was =
    w.used_pct == null && Number.isFinite(w.last_used_pct) ? `, was ${Math.round(w.last_used_pct)}%` : "";
  return `last read ${ago(age)}${was}`;
}

/**
 * The two notes a limit bar prints next to its percentage. The reset countdown goes with any window
 * that still carries a percentage, current or stale, since a stale 100% is exactly when the reset time
 * matters; resetCountdown itself returns "" (or "now" within 2 minutes) once the time has passed, so a
 * forgotten reading cannot claim to reset "now". The last-read label goes with every window that is
 * not a current reading (stale or reset).
 */
export function limitBarNotes(
  w: ClaudeUsageWindow | null | undefined,
  nowMs: number,
): { countdown: string; lastRead: string } {
  return {
    countdown: w?.used_pct != null ? resetCountdown(w.resets_at, nowMs) : "",
    lastRead: w && w.state !== "current" ? lastReadLabel(w, nowMs) : "",
  };
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

/** Plain names for usage labels that are logins, not seats (the default ~/.claude login). */
const LOGIN_NAMES: Readonly<Record<string, string>> = seatTable.login_names;

/**
 * "claude-mac-096 · Mac" under an email title; just the host under a seat-id title. A login that is
 * not a seat shows its plain name in place of the label, so it does not read as a second seat.
 */
export function seatSubtitle(seat: Pick<ClaudeSeat, "id" | "email" | "host">): string {
  const host = hostLabel(seat.host);
  const name = LOGIN_NAMES[seat.id];
  if (name) return [name, host].filter(Boolean).join(" · ");
  return (seat.email?.trim() ? [seat.id, host] : [host]).filter(Boolean).join(" · ");
}

/** "Max" for "max"; "" when the plan is unknown. */
export function planLabel(plan: string | null | undefined): string {
  const p = plan?.trim();
  return p ? p.charAt(0).toUpperCase() + p.slice(1) : "";
}

/**
 * The usage account that stands for a seat. `labels` is best first (the registry's usage_account
 * before the table's fallbacks), so among several matches the one with a reading and the best label
 * wins, and with no reading anywhere the best-labelled account stands in.
 */
function pickUsage(matches: ClaudeUsageAccount[], labels: string[]): ClaudeUsageAccount | null {
  const hasReading = (a: ClaudeUsageAccount) =>
    a.five_hour?.used_pct != null || a.seven_day?.used_pct != null;
  const ranked = [...matches].sort((a, b) => labels.indexOf(a.account) - labels.indexOf(b.account));
  return ranked.find(hasReading) ?? ranked[0] ?? null;
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
    promState: null,
    lockOrphaned: false,
    lastReadAgeS: null,
    unknownReason: null,
  };
}

/** A login nothing reads any more stops being a card after this long without a reading. */
const RETIRED_AFTER_S = 24 * 3600;

/**
 * A usage account claude-usage still lists although nothing reads it: every window it has is "reset",
 * there is no probe error to explain, and its newest reading is over 24 h old (an old login alias).
 * A label of a known seat is never retired: that seat is still on the fleet, just without a reading.
 */
function isRetiredLogin(a: ClaudeUsageAccount, nowMs: number): boolean {
  if (a.probe_error || KNOWN_SEATS.some((k) => k.usage_labels.includes(a.account))) return false;
  const windows = [a.five_hour, a.seven_day].filter((w): w is ClaudeUsageWindow => Boolean(w));
  if (windows.length === 0 || !windows.every((w) => w.state === "reset")) return false;
  const newest = Math.min(...windows.map((w) => windowAgeS(w, nowMs) ?? Infinity));
  return Number.isFinite(newest) && newest > RETIRED_AFTER_S;
}

function uniqueLabels(labels: Array<string | null | undefined>): string[] {
  return [...new Set(labels.filter((l): l is string => Boolean(l)))];
}

/** The seat's entry in the Prometheus snapshot; a usage-only card is keyed by its usage label. */
function promSeatFor(seat: ClaudeSeat, prom: ClaudePromSnapshot | null | undefined): ClaudePromSeat | null {
  if (!prom?.found) return null;
  const knownId = KNOWN_SEATS.find((k) => k.usage_labels.includes(seat.id))?.id;
  return prom.seats?.[seat.id] ?? (knownId ? prom.seats?.[knownId] : undefined) ?? null;
}

/** Age of a Prometheus reading as of nowMs: its age when queried plus the time since the query. */
function promAgeS(
  age: number | null | undefined,
  prom: ClaudePromSnapshot,
  nowMs: number,
): number | null {
  if (age == null || !Number.isFinite(age) || age < 0) return null;
  const queried = Date.parse(prom.queried_at);
  return age + (Number.isNaN(queried) ? 0 : Math.max(0, (nowMs - queried) / 1000));
}

/**
 * A Prometheus window as a usage window, or null when it is not a number to show: the exporter must
 * vouch for it (known), it must carry a recent age, and the window must not have reset since.
 */
function promWindowAsUsage(
  w: ClaudePromSeat["windows"]["5h"] | undefined,
  prom: ClaudePromSnapshot,
  nowMs: number,
): ClaudeUsageWindow | null {
  if (!w?.known || w.used_pct == null || !Number.isFinite(w.used_pct)) return null;
  const age = promAgeS(w.age_s, prom, nowMs);
  // A vouched reading is minutes old; anything older is not one (and could not be dated sanely).
  if (age === null || age > RESET_STALE_AFTER_S) return null;
  const resetMs = w.resets_at ? Date.parse(w.resets_at) : NaN;
  if (!Number.isNaN(resetMs) && resetMs <= nowMs) return null;
  const pct = Math.min(Math.max(w.used_pct, 0), 100);
  return {
    used_pct: pct,
    last_used_pct: pct,
    resets_at: w.resets_at,
    observed_at: new Date(nowMs - age * 1000).toISOString(),
    age_s: age,
    state: "current",
    source: "prometheus",
  };
}

/** The window to show: Prometheus's when the local one has no percentage or is older, else the local one. */
function fresherWindow(
  local: ClaudeUsageWindow | null,
  fromProm: ClaudeUsageWindow | null,
  nowMs: number,
): ClaudeUsageWindow | null {
  if (!fromProm) return local;
  if (local?.used_pct == null) return fromProm;
  const localAge = windowAgeS(local, nowMs) ?? Infinity;
  return localAge <= fromProm.age_s ? local : fromProm;
}

/**
 * Overlay the Prometheus snapshot on a seat. A window with no current local percentage takes
 * Prometheus's when it has a vouched, fresh one (source "prometheus"); when both have one, the fresher
 * wins. Seat-health state and the orphaned-lock flag are copied on, and the status is recomputed.
 * A seat Prometheus does not know, or a missing/failed snapshot, comes back unchanged.
 */
export function overlayPrometheus(
  seat: ClaudeSeat,
  prom: ClaudePromSnapshot | null | undefined,
  nowMs: number,
): ClaudeSeat {
  const promSeat = promSeatFor(seat, prom);
  if (!prom || !promSeat) return seat;
  const fiveHour = fresherWindow(seat.fiveHour, promWindowAsUsage(promSeat.windows?.["5h"], prom, nowMs), nowMs);
  const sevenDay = fresherWindow(seat.sevenDay, promWindowAsUsage(promSeat.windows?.["7d"], prom, nowMs), nowMs);
  return {
    ...seat,
    fiveHour,
    sevenDay,
    promState: promSeat.state ?? null,
    lockOrphaned: promSeat.lock_orphaned === true,
    status: seatStatus({ five_hour: fiveHour, seven_day: sevenDay, probe_error: seat.probeError }),
  };
}

/** Seat-health states that mean the seat cannot take work right now (claude_seat_state). */
export const SEAT_HEALTH_PROBLEM_STATES: readonly string[] = ["broken", "held", "failed"];

/** The most specific known cause for a seat without numbers; null when nothing beyond its age explains it. */
function seatIssue(seat: Pick<ClaudeSeat, "probeError" | "lockOrphaned" | "promState">): string | null {
  if (seat.probeError) return seat.probeError;
  if (seat.lockOrphaned) return "fleet-summon lock for this seat is orphaned, release it";
  if (seat.promState && SEAT_HEALTH_PROBLEM_STATES.includes(seat.promState)) {
    return `seat-health: ${seat.promState}`;
  }
  return null;
}

/**
 * Why an "unknown" seat shows no numbers. Priority: the probe error verbatim, an orphaned fleet-summon
 * lock, a broken/held/failed seat-health state, then how long ago it was last read.
 */
export function unknownReason(
  seat: Pick<ClaudeSeat, "probeError" | "lockOrphaned" | "promState" | "lastReadAgeS">,
): string | null {
  const issue = seatIssue(seat);
  if (issue) return issue;
  return seat.lastReadAgeS == null ? null : `no reading for ${ageShort(seat.lastReadAgeS)}`;
}

/** True when either window carries a percentage. */
export function hasLiveWindow(seat: Pick<ClaudeSeat, "fiveHour" | "sevenDay">): boolean {
  return seat.fiveHour?.used_pct != null || seat.sevenDay?.used_pct != null;
}

/** The one line that replaces the limit bars of a seat with no numbers: "No reading for 11d · <cause>". */
export function noReadingLine(
  seat: Pick<ClaudeSeat, "probeError" | "lockOrphaned" | "promState" | "lastReadAgeS">,
): string {
  const head = seat.lastReadAgeS == null ? "No reading yet" : `No reading for ${ageShort(seat.lastReadAgeS)}`;
  const issue = seatIssue(seat);
  return issue ? `${head} · ${issue}` : head;
}

/** "5-hour last read 17d ago, was 40% · Week last read 17d ago, was 40%"; "" when no window was ever read. */
export function lastKnownLine(seat: Pick<ClaudeSeat, "fiveHour" | "sevenDay">, nowMs: number): string {
  return [
    ["5-hour", seat.fiveHour],
    ["Week", seat.sevenDay],
  ]
    .map(([label, w]) => {
      const read = lastReadLabel(w as ClaudeUsageWindow | null, nowMs);
      return read ? `${label} ${read}` : "";
    })
    .filter(Boolean)
    .join(" · ");
}

/** Newest reading across both windows and the Prometheus entry, in seconds as of nowMs. */
function newestReadingAgeS(
  seat: ClaudeSeat,
  prom: ClaudePromSnapshot | null | undefined,
  nowMs: number,
): number | null {
  const promSeat = promSeatFor(seat, prom);
  const ages = [
    windowAgeS(seat.fiveHour, nowMs),
    windowAgeS(seat.sevenDay, nowMs),
    prom && promSeat ? promAgeS(promSeat.windows?.["5h"]?.age_s, prom, nowMs) : null,
    prom && promSeat ? promAgeS(promSeat.windows?.["7d"]?.age_s, prom, nowMs) : null,
  ].filter((age): age is number => age !== null);
  return ages.length ? Math.min(...ages) : null;
}

/**
 * Merge the fleet seat registry with claude-usage accounts (and, when given, the Prometheus snapshot)
 * into one list of seats.
 *
 * With a registry: every registry seat plus every known seat (so a seat the registry does not list
 * yet, like claude-mac-096, still shows), each joined to its usage account by seat id, the registry's
 * usage_account, or a table fallback label, in that order of preference. A seat with no usage account
 * is "no usage yet". Usage accounts that match no seat are kept as extra cards, so nothing the CLI
 * reported disappears, except a retired login (only old reset windows, no probe error). Without a
 * registry (null): one seat per usage account.
 */
export function buildClaudeSeats(
  registry: ClaudeSeatRegistryEntry[] | null | undefined,
  accounts: ClaudeUsageAccount[],
  prom?: ClaudePromSnapshot | null,
  nowMs: number = Date.now(),
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
        labels: uniqueLabels([known.id, entry?.usage_account, ...known.usage_labels]),
      });
    }
    for (const entry of registry) {
      if (KNOWN_SEATS.some((k) => k.id === entry.id)) continue;
      defs.push({
        base: { id: entry.id, host: entry.host, plan: entry.plan, launcher: null, inRegistry: true },
        labels: uniqueLabels([entry.id, entry.usage_account]),
      });
    }
    for (const def of defs) {
      const matches = accounts.filter((a) => def.labels.includes(a.account) && !claimed.has(a.account));
      matches.forEach((m) => claimed.add(m.account));
      seats.push(seatFromUsage(def.base, pickUsage(matches, def.labels)));
    }
  }

  for (const a of accounts) {
    if (claimed.has(a.account) || isRetiredLogin(a, nowMs)) continue;
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

  return seats.map((seat) => {
    const merged = overlayPrometheus(seat, prom, nowMs);
    const lastReadAgeS = newestReadingAgeS(merged, prom, nowMs);
    const withAge = { ...merged, lastReadAgeS };
    return { ...withAge, unknownReason: merged.status === "unknown" ? unknownReason(withAge) : null };
  });
}
