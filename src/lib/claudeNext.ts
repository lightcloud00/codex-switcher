import type { ClaudeSeat, ClaudeUsageWindow } from "../types";
import { estimatedMonthlyRenewal } from "./claudeSubscription.ts";
import { planLabel, SEAT_NOT_WORKING, SEAT_PLAN_ENDED, seatStatusLabel, seatSubtitle, seatTitle } from "./claudeUsage.ts";
import {
  dayKey,
  eventsOnDays,
  formatAgo,
  formatCountdown,
  formatDay,
  type StripDay,
  type StripEvent,
  type StripItem,
  type UseNextTone,
  type WhenFormat,
} from "./nextAccounts.ts";
import type { PlanDates } from "./providerAccess";

/** A reading older than this is called out under the row (the Claude tab calls it stale from the same age). */
const OLD_READING_S = 1800;
/** A reset this recent still reads as "due now"; an older one says nothing about the window today. */
const RESET_GRACE_MS = 2 * 60_000;

export type ClaudeWindowLabel = "5-hour" | "Week";

export interface ClaudeNextReset {
  label: ClaudeWindowLabel;
  /** ms since epoch. */
  at: number;
  /** "Week resets in 3 days 7 hours, Sat 5 PM EST". */
  text: string;
}

/** Where an end date comes from: saved and verified, saved or in the seat file, or a guess from the start date. */
export type ClaudePlanEndKind = "confirmed" | "recorded" | "estimate" | "none";

export interface ClaudePlanEnd {
  /** "Plan ends Nov 14", "Renews about Nov 30 (estimate)", "End date not saved". */
  text: string;
  /** For ordering only: noon UTC on a saved day, or the estimate's moment; null when there is no date. */
  at: number | null;
  /** The saved calendar day ("2026-11-14") for a date-only value, placed on the strip as written. */
  day: string | null;
  kind: ClaudePlanEndKind;
  /** The date is when the plan stops (not a renewal), so the strip marks it. */
  isEnd: boolean;
  ended: boolean;
}

export interface ClaudeNextRow {
  id: string;
  title: string;
  subtitle: string;
  /** "Max", or "" when the plan is unknown. */
  plan: string;
  badge: { label: string; tone: UseNextTone };
  /** What is left of the fullest window; null without a reading. */
  leftPercent: number | null;
  /** The full windows all reset by then; null unless the seat is empty and every full window has a reset time. */
  backAt: number | null;
  /** Upcoming resets, soonest first. */
  resets: ClaudeNextReset[];
  /** "14 hours ago" when the newest reading is old; null when current. */
  oldReading: string | null;
  planEnd: ClaudePlanEnd;
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Noon UTC on a valid `YYYY-MM-DD` day, or null. A date-only value is a calendar day, not a moment, so it is
 * formatted in UTC and compared as text: it reads as the same day whatever zone the screen uses. */
function dayMs(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const ms = Date.UTC(year, month - 1, day, 12);
  const date = new Date(ms);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? ms : null;
}

const windowsOf = (seat: ClaudeSeat): Array<[ClaudeWindowLabel, ClaudeUsageWindow | null]> => [
  ["5-hour", seat.fiveHour],
  ["Week", seat.sevenDay],
];

/** The end date shown for a seat: a saved or seat-file date first, then an estimate, then "not saved". */
export function claudePlanEnd(
  seat: Pick<ClaudeSeat, "subscriptionCreatedAt" | "billingType">,
  dates: PlanDates | undefined,
  now: number,
  format: WhenFormat = {},
): ClaudePlanEnd {
  // A saved day prints as written; only the year check uses the screen's zone.
  const day = (ms: number) => formatDay(ms, now, { ...format, timeZone: "UTC" });
  const ends = dayMs(dates?.subscriptionExpiresOn);
  if (ends !== null) {
    const saved = dates?.subscriptionExpiresOn as string;
    // The plan runs through its end day, so it has ended only once that day is behind today.
    const ended = saved < dayKey(now, format);
    return {
      text: ended ? `Plan ended ${day(ends)} · check it` : `Plan ends ${day(ends)}`,
      at: ends,
      day: saved,
      kind: dates?.evidenceSource && dates.lastVerifiedOn ? "confirmed" : "recorded",
      isEnd: true,
      ended,
    };
  }
  const renews = dayMs(dates?.billingRenewsOn);
  if (renews !== null) {
    return { text: `Renews ${day(renews)}`, at: renews, day: dates?.billingRenewsOn ?? null, kind: "recorded", isEnd: false, ended: false };
  }
  if (dates?.billingInterval === "none" || seat.billingType === "none") {
    return { text: "Free · no end date", at: null, day: null, kind: "none", isEnd: false, ended: false };
  }
  if (dates?.billingInterval === "annual") return { text: "Yearly plan · end date not saved", at: null, day: null, kind: "none", isEnd: false, ended: false };
  const guess = seat.billingType?.endsWith("_subscription") ? estimatedMonthlyRenewal(seat.subscriptionCreatedAt, now) : null;
  if (guess) {
    // estimatedMonthlyRenewal counts days on this machine's calendar, so the day prints in the machine's zone.
    const text = `Renews about ${formatDay(guess.getTime(), now, { locale: format.locale })} (estimate)`;
    return { text, at: guess.getTime(), day: null, kind: "estimate", isEnd: false, ended: false };
  }
  return { text: "End date not saved", at: null, day: null, kind: "none", isEnd: false, ended: false };
}

/** Resets still ahead (or just due), soonest first, for every window that has a reading. */
export function claudeResets(seat: ClaudeSeat, now: number, format: WhenFormat = {}): ClaudeNextReset[] {
  return windowsOf(seat)
    .flatMap(([label, w]) => {
      const at = w && w.used_pct != null ? toMs(w.resets_at) : null;
      if (at === null || at < now - RESET_GRACE_MS) return [];
      return [{ label, at, text: `${label} resets ${formatCountdown(at, now, format)}` }];
    })
    .sort((a, b) => a.at - b.at);
}

function badgeFor(seat: ClaudeSeat, empty: boolean, ended: boolean, used: number | null): ClaudeNextRow["badge"] {
  // A passed end date with no current reading: the seat is likely gone. A seat still being read keeps its
  // usage badge, and the plan line asks to check the date (a renewal the seat file has not caught up with).
  if (ended) return { label: SEAT_PLAN_ENDED, tone: "muted" };
  if (seat.promState === "broken") return { label: SEAT_NOT_WORKING, tone: "bad" };
  if (empty || seat.status === "exhausted") return { label: seatStatusLabel("exhausted"), tone: "bad" };
  if (seat.status === "near_limit") return { label: seatStatusLabel("near_limit"), tone: "warn" };
  if (seat.status === "ok" && used !== null) return { label: seatStatusLabel("ok"), tone: "ok" };
  if (seat.status === "no_usage_yet") return { label: seatStatusLabel("no_usage_yet"), tone: "muted" };
  return { label: seatStatusLabel("unknown"), tone: "muted" };
}

/** One Use next row per seat: what is left, when each window resets, and when the plan ends. */
export function claudeNextRow(seat: ClaudeSeat, dates: PlanDates | undefined, now: number, format: WhenFormat = {}): ClaudeNextRow {
  const read = windowsOf(seat).flatMap(([, w]) => (w && w.used_pct != null ? [w] : []));
  const current = read.filter((w) => w.state === "current");
  const usable = current.length > 0 ? current : read;
  const used = usable.length > 0 ? Math.max(...usable.map((w) => w.used_pct as number)) : null;
  // Full is judged on the windows that count now, so an old 100% from a reset window cannot make the seat Empty.
  const full = usable.filter((w) => (w.used_pct as number) >= 100);
  const empty = full.length > 0 || seat.status === "exhausted";
  const fullResets = full.map((w) => toMs(w.resets_at));
  const backAt =
    full.length > 0 && fullResets.every((at) => at !== null && at >= now - RESET_GRACE_MS)
      ? Math.max(...(fullResets as number[]))
      : null;
  const planEnd = claudePlanEnd(seat, dates, now, format);
  // A seat whose plan ended and that nothing reads now shows no usage: any percent or reset would be stale.
  const planEnded = planEnd.ended && current.length === 0;
  const resets = planEnded ? [] : claudeResets(seat, now, format);
  const old = read.some((w) => w.state !== "current") && seat.lastReadAgeS !== null && seat.lastReadAgeS > OLD_READING_S;
  return {
    id: seat.id,
    title: seatTitle(seat),
    subtitle: seatSubtitle(seat),
    plan: planLabel(seat.plan),
    badge: badgeFor(seat, empty, planEnded, used),
    // A seat that refuses to run has nothing left to use, whatever its last reading said.
    leftPercent: used === null || seat.promState === "broken" || planEnded ? null : Math.max(0, Math.round(100 - used)),
    backAt: planEnded ? null : backAt,
    resets,
    oldReading: old ? formatAgo(now - (seat.lastReadAgeS as number) * 1000, now) : null,
    planEnd,
  };
}

const TONE_RANK: Record<UseNextTone, number> = { ok: 0, warn: 1, bad: 2, muted: 3 };

/** Seats in the order to use them: ready, then almost empty, then empty by when they come back, then the rest. */
export function claudeNextRows(
  seats: ClaudeSeat[],
  plans: PlanDates[],
  now: number,
  format: WhenFormat = {},
): ClaudeNextRow[] {
  const rows = seats.map((seat) => claudeNextRow(seat, plans.find((dates) => dates.id === seat.id), now, format));
  const soonest = (row: ClaudeNextRow) => row.backAt ?? row.resets[0]?.at ?? Number.POSITIVE_INFINITY;
  return rows.sort(
    (a, b) =>
      TONE_RANK[a.badge.tone] - TONE_RANK[b.badge.tone] ||
      (a.badge.tone === "bad" ? soonest(a) - soonest(b) : (b.leftPercent ?? -1) - (a.leftPercent ?? -1)) ||
      a.title.localeCompare(b.title),
  );
}

/** The line under a seat row: when it is back, or its resets; "No reset time" without one. */
export function claudeRowLine(row: ClaudeNextRow, now: number, format: WhenFormat = {}): string {
  if (row.badge.label === "Plan ended") return "Renew to use it again";
  if (row.badge.label === "Empty" && row.backAt !== null) return `Back ${formatCountdown(row.backAt, now, format)}`;
  if (row.resets.length === 0) return "No reset time known";
  return row.resets.map((reset) => reset.text).join(" · ");
}

/** A seat on the strip: when it comes back, each reset, and a saved plan end. Estimates stay off the strip. */
export function claudeStripEvents(row: ClaudeNextRow, days: StripDay[], format: WhenFormat = {}): Map<string, StripEvent[]> {
  const items: StripItem[] = [];
  if (row.backAt !== null) items.push({ kind: "back", at: row.backAt });
  for (const reset of row.resets) items.push({ kind: "reset", at: reset.at, window: reset.label === "Week" ? "weekly" : "5h" });
  if (row.planEnd.isEnd) items.push({ kind: "ends", at: row.planEnd.at, day: row.planEnd.day ?? undefined });
  return eventsOnDays(items, days, format);
}
