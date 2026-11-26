import type { ClaudeSeat } from "../types";

const DAY_MS = 86_400_000;
const STALE_MS = 30 * 60_000;
const FUTURE_GRACE_MS = 60_000;

/** Require an explicit timezone and reject dates JS would silently roll into another month. */
function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  const millis = Date.parse(value);
  return Number.isFinite(millis) && Number.isFinite(date.getTime())
    && date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day) ? millis : null;
}

function dateLabel(millis: number): string {
  return new Date(millis).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

function ageLabel(millis: number): string {
  const minutes = Math.floor(Math.max(0, millis) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export interface ClaudeLoginExpiryView {
  label: string;
  observation: string;
  warning: boolean;
  historical: boolean;
}

/** Informational only: an expected sign-in end is not a usage reset or proof of authentication loss. */
export function claudeLoginExpiry(
  seat: Pick<ClaudeSeat, "loginExpiresAt" | "loginObservedAt" | "signedIn">,
  nowMs: number,
): ClaudeLoginExpiryView {
  const end = timestamp(seat.loginExpiresAt);
  const observed = timestamp(seat.loginObservedAt);
  const knownObservation = observed !== null && Number.isFinite(nowMs) && observed <= nowMs + FUTURE_GRACE_MS;
  const historical = !knownObservation || nowMs - observed! > STALE_MS;
  const observation = knownObservation
    ? `${historical ? "Historical · last" : "Login"} checked ${ageLabel(nowMs - observed!)}`
    : "Login check time unavailable";
  if (end === null || seat.signedIn === false || !Number.isFinite(nowMs)) {
    return { label: "Sign-in expiry unknown", observation, warning: false, historical };
  }
  // Claude reports the latest expected end; the login can end up to three days earlier.
  // https://code.claude.com/docs/en/authentication#check-when-a-stored-login-ends
  const earliest = end - 3 * DAY_MS;
  const range = `${dateLabel(earliest)} – ${dateLabel(end)} (UTC)`;
  if (historical) {
    return { label: `Last reported sign-in end: ${range}`, observation, warning: false, historical };
  }
  const label = nowMs >= end
    ? `Sign-in may have ended by ${dateLabel(end)} (UTC)`
    : nowMs >= earliest
      ? `Sign-in may end any day, by ${dateLabel(end)} (UTC)`
      : `Sign-in may end ${range}`;
  return { label, observation, warning: end - nowMs <= 10 * DAY_MS, historical };
}
