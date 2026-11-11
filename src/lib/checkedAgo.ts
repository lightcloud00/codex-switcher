// Runtime imports carry the .ts extension so the node test runner can load this file.
import { updatedAgo } from "./claudeUsage.ts";
import { formatAgo } from "./nextAccounts.ts";

/** A newest seat reading older than this gets called out next to the time of the check. */
export const OLD_SEAT_READING_S = 1800;

/** The age in seconds of the newest reading across seats; null when no seat has one. */
export function newestSeatReadingAgeS(seats: ReadonlyArray<{ lastReadAgeS: number | null }>): number | null {
  const ages = seats.flatMap((s) => (s.lastReadAgeS != null && Number.isFinite(s.lastReadAgeS) ? [s.lastReadAgeS] : []));
  return ages.length === 0 ? null : Math.min(...ages);
}

/**
 * "Checked just now", plus "· newest seat reading 15 hours ago" once the newest reading is over 30 minutes old.
 * The check time says when the app asked; the reading age says how old the numbers are.
 */
export function checkedLine(
  label: string,
  generatedAt: string | null | undefined,
  newestReadingAgeS: number | null,
  nowMs: number,
): string {
  const checked = updatedAgo(generatedAt, nowMs);
  const head = checked ? `${label} ${checked}` : label;
  if (newestReadingAgeS === null || !(newestReadingAgeS > OLD_SEAT_READING_S)) return head;
  return `${head} · newest seat reading ${formatAgo(nowMs - newestReadingAgeS * 1000, nowMs)}`;
}

/** What the active account's stats box says when it has no numbers. */
export function usageStatsMessage(error: string | null | undefined, attempted: boolean): string {
  if (error) return error;
  return attempted ? "Usage stats unavailable." : "Loading usage stats…";
}
