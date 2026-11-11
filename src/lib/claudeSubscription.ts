import type { ClaudeSeat } from "../types";
import type { PlanDates } from "./providerAccess";

/** An anniversary estimate, never a verified billing/expiry date or evidence of an active plan. */
export function estimatedMonthlyRenewal(start: string | null | undefined, nowMs: number): Date | null {
  if (!start) return null;
  const began = new Date(start);
  const now = new Date(nowMs);
  if (!Number.isFinite(began.getTime()) || !Number.isFinite(now.getTime()) || began > now) return null;
  const anniversary = (year: number, month: number) => new Date(year, month,
    Math.min(began.getDate(), new Date(year, month + 1, 0).getDate()));
  let next = anniversary(now.getFullYear(), now.getMonth());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (next < today) next = anniversary(now.getFullYear(), now.getMonth() + 1);
  return next;
}

export function claudeSubscriptionText(
  seat: Pick<ClaudeSeat, "subscriptionCreatedAt" | "billingType">, nowMs: number,
): string {
  if (seat.billingType === "none") return "Free · no paid expiry";
  if (!seat.billingType?.endsWith("_subscription")) return "Expiry not recorded";
  const date = estimatedMonthlyRenewal(seat.subscriptionCreatedAt, nowMs);
  return date
    ? `Estimated monthly renewal ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date)}`
    : "Expiry not recorded";
}

/** One seat in the fleet seat file (`~/.config/aos/claude-seat-subscriptions.json`). */
export interface SeatSubscription {
  /** `YYYY-MM-DD`; the plan runs through this day. */
  subscriptionExpiresOn: string;
  planNote: string | null;
}

/** The `get_claude_seat_subscriptions` payload. */
export interface SeatSubscriptions {
  found: boolean;
  seats: Record<string, SeatSubscription>;
  /** Entries the backend left out because they were malformed. */
  ignored: number;
  error: string | null;
}

/** A saved choice that decides the plan end: an end or renewal date, or annual or free billing. Credit and key
 * expiry dates are other things and leave the seat file's end date in place. */
function hasSavedPlanEnd(dates: PlanDates | undefined): boolean {
  if (!dates) return false;
  return Boolean(
    dates.subscriptionExpiresOn || dates.billingRenewsOn || dates.billingInterval === "annual" || dates.billingInterval === "none",
  );
}

/**
 * Plan dates for display: what the user saved under Providers wins, and a seat with nothing saved takes its end
 * date from the fleet seat file (the one the Switcher MCP reports), shown as recorded, never as confirmed.
 * Never pass the result back to `save_provider_dates`: the seat file stays the source of its own dates.
 */
export function withSeatSubscriptions(plans: PlanDates[], overlay: SeatSubscriptions | null | undefined): PlanDates[] {
  const seats = overlay?.seats;
  if (!seats || Object.keys(seats).length === 0) return plans;
  const merged = plans.map((dates) => {
    const seat = seats[dates.id];
    if (!seat || hasSavedPlanEnd(dates)) return dates;
    return { ...dates, subscriptionExpiresOn: seat.subscriptionExpiresOn, evidenceSource: null, lastVerifiedOn: null };
  });
  for (const [id, seat] of Object.entries(seats)) {
    if (merged.some((dates) => dates.id === id)) continue;
    merged.push({
      id,
      billingRenewsOn: null,
      creditExpiresOn: null,
      credentialExpiresOn: null,
      subscriptionExpiresOn: seat.subscriptionExpiresOn,
      evidenceSource: null,
      lastVerifiedOn: null,
    });
  }
  return merged;
}
