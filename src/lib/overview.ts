import { claudeSubscriptionText } from "./claudeSubscription.ts";
import type {
  AccountWithUsage,
  ClaudePromSnapshot,
  ClaudeSeat,
  ClaudeSeatRegistry,
  ClaudeSeatStatus,
  ClaudeUsageAccount,
  ClaudeUsageSummary,
  UsageInfo,
} from "../types";
// Runtime imports carry the .ts extension so the node test runner can load this file.
import { needsRelogin } from "./accountAuth.ts";
import { balanceLine, statusLabel, type ApiCreditRow } from "./apiCredits.ts";
import {
  buildClaudeSeats,
  claudeAuthenticationRequired,
  KNOWN_SEATS,
  limitBarNotes,
  planLabel,
  resetCountdown,
  SEAT_NOT_WORKING,
  SEAT_PLAN_ENDED,
  SEAT_SIGN_IN_REQUIRED,
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
  activeLogin?: boolean;
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
  /**
   * Subscriptions only: a paid plan that is still running (or was at its last known date). The
   * Overview splits Subscriptions into "Paying now" and "Free or ended" on this flag.
   */
  paying?: boolean;
}

/** Overview status words, kept in one place so the badge reads the same everywhere. */
export const SIGN_IN_AGAIN = "sign in again";
export const CODEX_EMPTY = "Empty";

const CODEX_PLAN_NAMES: Record<string, string> = {
  promax: "Pro Max",
  pro_max: "Pro Max",
  "pro-max": "Pro Max",
  pro: "Pro",
  plus: "Plus",
  free: "Free",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

/** "Pro Max" for "promax"; known ChatGPT plan words get their real names, others are capitalised. */
export function codexPlanLabel(plan: string | null | undefined): string {
  const key = plan?.trim().toLowerCase();
  if (!key) return "";
  return CODEX_PLAN_NAMES[key] ?? planLabel(plan);
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
  if (dates.subscriptionExpiresOn) {
    const confirmed = Boolean(dates.evidenceSource && dates.lastVerifiedOn);
    const status = dateStatus(dates.subscriptionExpiresOn, now);
    return `${confirmed ? "Confirmed" : "Recorded"} expiry: ${status}`;
  }
  const recorded = PLAN_DATE_FIELDS.flatMap(([key, label]) => {
    const value = dates[key];
    const status = value ? dateStatus(value, now) : "Unknown";
    return status === "Unknown" ? [] : [`${dates.evidenceSource && dates.lastVerifiedOn ? "Confirmed" : "Recorded"} ${label.toLowerCase()}: ${status}`];
  }).join(" · ");
  return recorded || (dates.billingInterval === "annual" ? "Annual billing · no monthly estimate" : dates.billingInterval === "none" ? "No subscription renewal" : "");
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

function isPaidPlan(plan: string | null | undefined): boolean {
  const key = plan?.trim().toLowerCase();
  return Boolean(key) && key !== "free" && key !== "api_key" && key !== "unknown";
}

function shortDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, SUBSCRIPTION_DATE).format(new Date(ms));
}

/**
 * The Codex row's plan line in plain words: "Paid until Dec 6, 2026", "Ended Oct 1, 2026", "Free plan",
 * or, when only the date saved at the last good sign-in is known, the same words marked "(last known)".
 * A free plan never shows a paid date, even if an old one is still saved.
 */
export function codexPlanText(
  account: Pick<AccountWithUsage, "plan_type" | "auth_mode" | "subscription_expires_at" | "last_known_subscription_expires_at">,
  nowMs: number,
): string {
  if (account.auth_mode === "api_key") return "API key · billed by usage";
  if (isFree(account.plan_type)) return "Free plan";
  const live = account.subscription_expires_at ? Date.parse(account.subscription_expires_at) : NaN;
  if (!Number.isNaN(live)) return live <= nowMs ? `Ended ${shortDate(live)}` : `Paid until ${shortDate(live)}`;
  const known = account.last_known_subscription_expires_at ? Date.parse(account.last_known_subscription_expires_at) : NaN;
  if (!Number.isNaN(known)) {
    return known <= nowMs ? `Ended ${shortDate(known)} (last known)` : `Paid until ${shortDate(known)} (last known)`;
  }
  return isPaidPlan(account.plan_type) ? "Paid plan · end date not known yet" : NONE;
}

/**
 * Still paying for this Codex account: a paid plan whose live end date (or, without one, the date saved at
 * the last good sign-in) has not passed. A paid plan with no date at all counts as paying.
 */
export function isCodexPaying(
  account: Pick<AccountWithUsage, "plan_type" | "auth_mode" | "subscription_expires_at" | "last_known_subscription_expires_at">,
  nowMs: number,
): boolean {
  if (account.auth_mode === "api_key" || !isPaidPlan(account.plan_type)) return false;
  const end = account.subscription_expires_at ?? account.last_known_subscription_expires_at ?? null;
  return !isSubscriptionExpired(end, nowMs);
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

/**
 * Expired wins; then a login only a fresh sign-in can fix ("sign in again"); any other usage error is not
 * called a signed-out login. A window at 100% reads "Empty", the same word the Claude rows use.
 */
function codexStatus(expired: boolean, error: string | null | undefined, window: TightestWindow | null, stale: boolean): Pick<OverviewRow, "status" | "tone"> {
  if (expired) return { status: "expired", tone: "bad" };
  if (error) return needsRelogin(error) ? { status: SIGN_IN_AGAIN, tone: "bad" } : { status: "usage error", tone: "warn" };
  if (!window) return { status: "usage unknown", tone: "muted" };
  if (stale) return { status: "usage stale", tone: "warn" };
  if (window.used >= 100) return { status: CODEX_EMPTY, tone: "bad" };
  return { status: "available", tone: "ok" };
}

/** One row per Codex account: email (or name), plan, least-remaining window, its reset, expiry, status. */
export function buildCodexRows(accounts: AccountWithUsage[], nowMs: number): OverviewRow[] {
  return accounts.map((a) => {
    const window = tightestWindow(a.usage);
    const expired = isSubscriptionExpired(a.subscription_expires_at, nowMs);
    const error = a.usage?.error;
    const stale = Boolean(window) && (!Number.isFinite(a.usageCheckedAt) || nowMs - a.usageCheckedAt! > 5 * 60_000
      || (window!.resetsAt !== null && window!.resetsAt * 1000 <= nowMs));
    const email = a.email?.trim();
    const plan = a.plan_type ? codexPlanLabel(a.plan_type) : a.auth_mode === "api_key" ? "API Key" : "Unknown";
    const signedOut = Boolean(error) && needsRelogin(error);
    return {
      id: `codex:${a.id}`,
      account: email || a.name,
      detail: email && a.name !== email ? a.name : undefined,
      maskId: a.id,
      activeLogin: a.is_active,
      type: `Codex ${plan}`,
      left: `${leftText(window?.used)}${stale ? " (stale)" : ""}`,
      // An ended plan has no next reset to count down to.
      resets: window && !expired ? unixResetText(window.resetsAt, nowMs) : NONE,
      renews: `${codexPlanText(a, nowMs)}${signedOut ? " · sign in again on the Codex tab" : ""}`,
      ...codexStatus(expired, error, window, stale),
      inactive: isInactive(expired, a.plan_type, window?.used ?? null),
      paying: isCodexPaying(a, nowMs),
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
  if (!haveData || !registry) return [];
  // Without claude-usage there is no usage-only mode: fall back to the known seats.
  const entries = registry?.found ? registry.seats : summary ? null : [];
  return buildClaudeSeats(entries, summary?.accounts ?? [], prom, nowMs, registry?.hidden_seat_ids);
}

/** One row per Claude seat: email (or seat id), plan, 7-day left and reset, plan dates saved for the seat. */
export function buildClaudeRows(seats: ClaudeSeat[], plans: PlanDates[], nowMs: number): OverviewRow[] {
  const now = new Date(nowMs);
  return seats.map((seat) => {
    const dates = plans.find((p) => p.id === seat.id);
    const keyOrCreditExpired = planDatesExpired(dates, now);
    const planEndPassed = Boolean(dates?.subscriptionExpiresOn && dateStatus(dates.subscriptionExpiresOn, now).startsWith("Date passed"));
    const recordedEnded = keyOrCreditExpired || planEndPassed;
    // The plan runs through its recorded end day (local time).
    const planEndMs = dates?.subscriptionExpiresOn ? Date.parse(`${dates.subscriptionExpiresOn}T23:59:59`) : NaN;
    const signInRequired = claudeAuthenticationRequired(seat.loginError ?? seat.probeError, seat.signedIn);
    const windows = signInRequired ? [] : [seat.fiveHour, seat.sevenDay].filter((w) => w?.used_pct != null);
    const current = windows.filter((w) => w?.state === "current");
    const usable = current.length ? current : windows;
    const limiting = usable.reduce<(typeof usable)[number] | null>(
      (best, w) => !best || w!.used_pct! > best.used_pct! ? w : best,
      null,
    );
    const used = limiting?.used_pct ?? null;
    const stale = windows.some(w => w?.state !== "current");
    const exhaustedNow = current.some(w => w!.used_pct! >= 100);
    // A passed plan end date is wrong when the seat still answered after that day: a current reading observed
    // after the end proves the plan runs. A reading from before the end proves nothing, and a passed key or
    // credit expiry is a different thing that this never overrides.
    const stillWorking = planEndPassed && !keyOrCreditExpired && Number.isFinite(planEndMs)
      && current.some((w) => Date.parse(w!.observed_at) > planEndMs);
    const expired = recordedEnded && !stillWorking;
    // Same short words as Use next (seatStatusLabel); a broken seat or an ended plan says so first.
    const broken = seat.promState === "broken";
    const status = broken ? SEAT_NOT_WORKING : exhaustedNow ? seatStatusLabel("exhausted") : stale ? "Stale" : used === null ? seatStatusLabel(seat.status === "no_usage_yet" ? "no_usage_yet" : "unknown") : seatStatusLabel(seat.status);
    const tone: OverviewTone = broken ? "bad" : exhaustedNow ? "bad" : stale ? "warn" : used === null ? "muted" : SEAT_TONE[seat.status];
    // A login with no paid billing is a free Claude account, whatever plan the seat was set up for.
    const freeLogin = seat.billingType === "none";
    const plan = freeLogin ? "Free" : planLabel(seat.plan);
    const left = leftText(used);
    const renewsText = planDatesText(dates, now) || claudeSubscriptionText(seat, nowMs);
    return {
      id: `claude:${seat.id}`,
      account: seatTitle(seat),
      detail: seatSubtitle(seat) || undefined,
      type: plan ? `Claude ${plan}` : "Claude",
      left: seat.promState === "broken" ? NONE : used !== null && limiting?.state === "stale" ? `${left} (stale)` : used === null ? "Unknown" : stale && !exhaustedNow ? `${left} (partial)` : left,
      resets: (used !== null && limitBarNotes(limiting, nowMs).countdown) || NONE,
      renews: stillWorking ? "Still working · the recorded end date has passed and needs updating" : renewsText,
      status: signInRequired ? SEAT_SIGN_IN_REQUIRED : expired ? SEAT_PLAN_ENDED : status,
      tone: signInRequired ? "warn" : expired ? "bad" : tone,
      inactive: isInactive(expired, freeLogin ? "free" : seat.plan, used),
      paying: !expired && !freeLogin && isPaidPlan(seat.plan),
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

/** A Claude login the Claude tab hides (a retired seat), listed on the Overview so no account is forgotten. */
export interface HiddenClaudeLogin {
  seatId: string;
  email: string | null;
  /** "Ended Nov 10, 2026" from the seat's recorded end date, or null when none is recorded. */
  ended: string | null;
}

/**
 * The hidden Claude seats with their email (from claude-usage, joined through the registry's usage account or the
 * known seat table) and the recorded end date. Display only.
 */
export function hiddenClaudeLogins(
  registry: ClaudeSeatRegistry | null | undefined,
  accounts: ClaudeUsageAccount[],
  plans: PlanDates[],
  nowMs: number,
): HiddenClaudeLogin[] {
  const hidden = registry?.hidden_seat_ids ?? [];
  return hidden.map((seatId) => {
    const entry = registry?.seats.find((s) => s.id === seatId);
    const known = KNOWN_SEATS.find((k) => k.id === seatId);
    const labels = [entry?.usage_account, seatId, ...(known?.usage_labels ?? [])].filter(Boolean) as string[];
    const usage = labels.map((label) => accounts.find((a) => a.account === label)).find(Boolean);
    const end = plans.find((p) => p.id === seatId)?.subscriptionExpiresOn;
    const endMs = end ? Date.parse(`${end}T23:59:59`) : NaN;
    const ended = Number.isNaN(endMs) ? null : endMs <= nowMs ? `Ended ${shortDate(endMs)}` : `Paid until ${shortDate(endMs)}`;
    return { seatId, email: usage?.email?.trim() || null, ended };
  });
}
