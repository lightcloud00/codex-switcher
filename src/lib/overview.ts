import type {
  AccountWithUsage,
  ClaudePromSnapshot,
  ClaudeSeat,
  ClaudeSeatRegistry,
  ClaudeSeatStatus,
  ClaudeUsageSummary,
  UsageInfo,
} from "../types";
// Runtime imports carry the .ts extension so the node test runner can load this file.
import { needsRelogin } from "./accountAuth.ts";
import { balanceLine, statusLabel, type ApiCreditRow } from "./apiCredits.ts";
import {
  buildClaudeSeats,
  limitBarNotes,
  planLabel,
  resetCountdown,
  seatStatusLabel,
  seatSubtitle,
  seatTitle,
} from "./claudeUsage.ts";
import { dateStatus, type PlanDates } from "./providerAccess.ts";

export const NONE = "—";
export const SEE_BILLING = "see billing";
export const PREPAID_RESETS = "No reset (prepaid)";

export type OverviewTone = "ok" | "warn" | "bad" | "muted";

/**
 * One table row. Every section (Subscriptions, Prepaid APIs, Grok, Tools) renders this same shape,
 * so a new data source only has to map its accounts onto these columns.
 */
export interface OverviewRow {
  id: string;
  /** Email, or the account name when there is no email; null when the source has no account label yet. */
  account: string | null;
  /** Second, smaller line under the account (account name, seat id and host). */
  detail?: string;
  /** Codex account id, so the per-account mask applies to this row. */
  maskId?: string;
  /** Product and plan, e.g. "Codex Pro", "Claude Max", "DeepSeek API". */
  type: string;
  /** "62%", "$55.94", "see billing" or "—". */
  left: string;
  /** "in 3d 2h", "No reset (prepaid)" or "—". */
  resets: string;
  /** Renewal or expiry text, or "—". */
  renews: string;
  status: string;
  tone: OverviewTone;
  /** Expired, or free with nothing left: sorts last in its section and renders muted. */
  inactive: boolean;
}

/** Used percent in, percent left out (clamped to 0-100); null without a reading. */
export function percentLeft(usedPct: number | null | undefined): number | null {
  if (usedPct === null || usedPct === undefined || !Number.isFinite(usedPct)) return null;
  return Math.min(Math.max(100 - usedPct, 0), 100);
}

/** "62%" left for a used percent; "—" without a reading. */
export function leftText(usedPct: number | null | undefined): string {
  const left = percentLeft(usedPct);
  return left === null ? NONE : `${Math.round(left)}%`;
}

/** The provider's balance ("$55.94"), or "see billing" when the probe has none or the row failed. */
export function apiLeftText(row: ApiCreditRow): string {
  const b = row.balance;
  if (row.error || !b) return SEE_BILLING;
  // balanceLine owns the money format; the granted/topped-up split is left out of this column.
  const line = balanceLine({ ...row, balance: { currency: b.currency, total: b.total } });
  return line.replace(/ left$/, "") || SEE_BILLING;
}

/** True once an ISO timestamp is at or before now (as the capacity exporter reads subscription_expires_at). */
export function isSubscriptionExpired(expiresAt: string | null | undefined, nowMs: number): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return !Number.isNaN(t) && t <= nowMs;
}

/**
 * Codex tab "Inactive accounts": the subscription date has passed. A free plan that still carries an
 * expired subscription date is covered by the same test.
 */
export function isCodexAccountInactive(
  account: Pick<AccountWithUsage, "subscription_expires_at">,
  nowMs: number,
): boolean {
  return isSubscriptionExpired(account.subscription_expires_at, nowMs);
}

const SUBSCRIPTION_DATE = { month: "short", day: "numeric", year: "numeric" } as const;

/** "Until Nov 4, 2026" or "Expired Oct 20, 2026" (the Codex card's wording); "—" without a valid date. */
export function codexExpiryText(expiresAt: string | null | undefined, nowMs: number): string {
  if (!expiresAt) return NONE;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return NONE;
  const date = new Intl.DateTimeFormat(undefined, SUBSCRIPTION_DATE).format(new Date(t));
  return t <= nowMs ? `Expired ${date}` : `Until ${date}`;
}

const PLAN_DATE_FIELDS = [
  ["billingRenewsOn", "Renews"],
  ["creditExpiresOn", "Credits expire"],
  ["credentialExpiresOn", "Key expires"],
] as const;

/** "Renews: 11/13/2026 · Key expires: Due in 3 days" from the saved plan dates; "" when none is set. */
export function planDatesText(dates: PlanDates | null | undefined, now = new Date()): string {
  if (!dates) return "";
  return PLAN_DATE_FIELDS.flatMap(([key, label]) => {
    const value = dates[key];
    const status = value ? dateStatus(value, now) : "Unknown";
    return status === "Unknown" ? [] : [`${label}: ${status}`];
  }).join(" · ");
}

/** A credit or key expiry date has passed. A passed renewal date alone only says "verify", never expired. */
export function planDatesExpired(dates: PlanDates | null | undefined, now = new Date()): boolean {
  if (!dates) return false;
  return (["creditExpiresOn", "credentialExpiresOn"] as const).some((key) => {
    const value = dates[key];
    return Boolean(value) && dateStatus(value, now).startsWith("Date passed");
  });
}

function isFree(plan: string | null | undefined): boolean {
  return plan?.trim().toLowerCase() === "free";
}

/** Expired, or a free plan with nothing left. */
function isInactive(expired: boolean, plan: string | null | undefined, usedPct: number | null): boolean {
  return expired || (isFree(plan) && percentLeft(usedPct) === 0);
}

interface TightestWindow {
  used: number;
  resetsAt: number | null;
}

/** The Codex window with the least left (the one that stops work first); the primary window wins a tie. */
function tightestWindow(usage: UsageInfo | undefined): TightestWindow | null {
  if (!usage || usage.error) return null;
  const windows = [
    { used: usage.primary_used_percent, resetsAt: usage.primary_resets_at },
    { used: usage.secondary_used_percent, resetsAt: usage.secondary_resets_at },
  ].filter((w): w is TightestWindow => w.used !== null && w.used !== undefined);
  return windows.reduce<TightestWindow | null>((best, w) => (!best || w.used > best.used ? w : best), null);
}

function unixResetText(resetsAt: number | null | undefined, nowMs: number): string {
  if (resetsAt === null || resetsAt === undefined) return NONE;
  const date = new Date(resetsAt * 1000);
  return (Number.isNaN(date.getTime()) ? "" : resetCountdown(date.toISOString(), nowMs)) || NONE;
}

/** Expired wins; then a login only a fresh sign-in can fix; any other usage error is not called a broken login. */
function codexStatus(expired: boolean, error: string | null | undefined): Pick<OverviewRow, "status" | "tone"> {
  if (expired) return { status: "expired", tone: "bad" };
  if (error) return needsRelogin(error) ? { status: "login broken", tone: "bad" } : { status: "usage error", tone: "warn" };
  return { status: "active", tone: "ok" };
}

/** One row per Codex account: email (or name), plan, least-remaining window, its reset, expiry, status. */
export function buildCodexRows(accounts: AccountWithUsage[], nowMs: number): OverviewRow[] {
  return accounts.map((a) => {
    const window = tightestWindow(a.usage);
    const expired = isSubscriptionExpired(a.subscription_expires_at, nowMs);
    const error = a.usage?.error;
    const email = a.email?.trim();
    const plan = a.plan_type ? planLabel(a.plan_type) : a.auth_mode === "api_key" ? "API Key" : "Unknown";
    return {
      id: `codex:${a.id}`,
      account: email || a.name,
      detail: email && a.name !== email ? a.name : undefined,
      maskId: a.id,
      type: `Codex ${plan}`,
      left: leftText(window?.used),
      resets: window ? unixResetText(window.resetsAt, nowMs) : NONE,
      renews: codexExpiryText(a.subscription_expires_at, nowMs),
      ...codexStatus(expired, error),
      inactive: isInactive(expired, a.plan_type, window?.used ?? null),
    };
  });
}

const SEAT_TONE: Record<ClaudeSeatStatus, OverviewTone> = {
  ok: "ok",
  near_limit: "warn",
  exhausted: "bad",
  unknown: "muted",
  no_usage_yet: "muted",
};

/** The seats the Claude tab shows, from the same three sources it reads. */
export function claudeSeatsFromSources(
  summary: ClaudeUsageSummary | null,
  registry: ClaudeSeatRegistry | null,
  prom: ClaudePromSnapshot | null | undefined,
  nowMs: number,
): ClaudeSeat[] {
  const haveData = summary !== null || registry?.found === true || prom?.found === true;
  if (!haveData) return [];
  // Without claude-usage there is no usage-only mode: fall back to the known seats.
  const entries = registry?.found ? registry.seats : summary ? null : [];
  return buildClaudeSeats(entries, summary?.accounts ?? [], prom, nowMs);
}

/** One row per Claude seat: email (or seat id), plan, 7-day left and reset, plan dates saved for the seat. */
export function buildClaudeRows(seats: ClaudeSeat[], plans: PlanDates[], nowMs: number): OverviewRow[] {
  const now = new Date(nowMs);
  return seats.map((seat) => {
    const dates = plans.find((p) => p.id === seat.id);
    const expired = planDatesExpired(dates, now);
    const week = seat.sevenDay;
    const used = week?.used_pct ?? null;
    const plan = planLabel(seat.plan);
    const left = leftText(used);
    return {
      id: `claude:${seat.id}`,
      account: seatTitle(seat),
      detail: seatSubtitle(seat) || undefined,
      type: plan ? `Claude ${plan}` : "Claude",
      left: used !== null && week?.state === "stale" ? `${left} (stale)` : left,
      resets: (used !== null && limitBarNotes(week, nowMs).countdown) || NONE,
      renews: planDatesText(dates, now) || NONE,
      status: expired ? "expired" : seatStatusLabel(seat.status),
      tone: expired ? "bad" : SEAT_TONE[seat.status],
      inactive: isInactive(expired, seat.plan, used),
    };
  });
}

/** The plan-dates id for a probe provider: "deepseek" is "deepseek-api". */
export function apiPlanId(providerId: string): string {
  return providerId.endsWith("-api") ? providerId : `${providerId}-api`;
}

/** One row per probe provider (any provider the probe returns, Kimi included). */
export function buildApiCreditRows(providers: ApiCreditRow[], plans: PlanDates[], nowMs: number): OverviewRow[] {
  const now = new Date(nowMs);
  return providers.map((p) => {
    const dates = plans.find((d) => d.id === apiPlanId(p.id));
    const expired = planDatesExpired(dates, now);
    const status = statusLabel(p);
    const email = p.email?.trim();
    const name = p.account_name?.trim();
    return {
      id: `api:${p.id}`,
      account: email || name || null,
      detail: email && name ? name : undefined,
      type: p.label || p.id,
      left: apiLeftText(p),
      resets: PREPAID_RESETS,
      renews: planDatesText(dates, now) || NONE,
      status: expired ? "expired" : status,
      tone: expired ? "bad" : status === "ready" ? "ok" : "warn",
      inactive: expired,
    };
  });
}

/** Inactive rows last; every other row keeps its order. */
export function sortOverviewRows(rows: OverviewRow[]): OverviewRow[] {
  return [...rows].sort((a, b) => Number(a.inactive) - Number(b.inactive));
}
