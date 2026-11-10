import type { ClaudeSeat } from "../types";

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
