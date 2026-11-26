import type { AccountWithUsage, UsageInfo } from "../types";
import { describeAuthFailure } from "./accountAuth.ts";

export const USAGE_FRESHNESS_MS = 5 * 60_000;

export type AccountHealthState = "ready" | "exhausted" | "expired" | "auth_required" | "stale" | "unknown" | "unsupported";
export type AccountHealthTone = "ok" | "warn" | "bad" | "muted";

export interface AccountHealth {
  state: AccountHealthState;
  label: string;
  detail: string;
  tone: AccountHealthTone;
}

export interface UsageAssessment {
  state: "current" | "stale" | "unknown";
  /** Whether the numeric reading can be shown, even if its age is unknown. */
  valid: boolean;
  detail: string;
}

export function validDate(timestamp: string | null | undefined): Date | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function validUsedPercent(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function assessUsage(
  usage: UsageInfo | undefined, checkedAt: number | undefined, nowMs: number,
): UsageAssessment {
  if (!usage || usage.error) return { state: "unknown", valid: false, detail: "Usage has not been verified." };
  const windows = [
    { used: usage.primary_used_percent, reset: usage.primary_resets_at },
    { used: usage.secondary_used_percent, reset: usage.secondary_resets_at },
  ].filter((window) => window.used !== null && window.used !== undefined);
  if (windows.length === 0) return { state: "unknown", valid: false, detail: "No rate limit data." };
  if (windows.some(({ used, reset }) => !validUsedPercent(used)
    || (reset !== null && reset !== undefined && (!Number.isFinite(reset) || reset <= 0 || !Number.isFinite(new Date(reset * 1000).getTime()))))) {
    return { state: "unknown", valid: false, detail: "The usage reading is invalid. Refresh to check again." };
  }
  if (!Number.isFinite(nowMs) || !Number.isFinite(checkedAt) || checkedAt! <= 0 || checkedAt! > nowMs) {
    return { state: "unknown", valid: true, detail: "Reading age unknown. Refresh to verify current limits." };
  }
  if (windows.some(({ reset }) => reset !== null && reset !== undefined && reset * 1000 <= nowMs)) {
    return { state: "stale", valid: true, detail: "A reported reset has passed. Refresh to verify current limits." };
  }
  if (nowMs - checkedAt! > USAGE_FRESHNESS_MS) {
    return { state: "stale", valid: true, detail: "Usage is stale. Refresh to verify current limits." };
  }
  return { state: "current", valid: true, detail: "Usage checked within the last 5 minutes." };
}

/** Display evidence only; this does not decide whether an account may be selected or routed. */
export function accountHealth(account: AccountWithUsage, nowMs: number): AccountHealth {
  if (account.auth_mode === "api_key") {
    return { state: "unsupported", label: "Quota unsupported", detail: "ChatGPT subscription quota is unavailable for API-key accounts.", tone: "muted" };
  }
  const authFailure = describeAuthFailure(account.usage?.error);
  if (authFailure) {
    return {
      state: authFailure.kind === "expired" ? "expired" : "auth_required",
      label: authFailure.kind === "expired" ? "Session expired" : "Authentication required",
      detail: authFailure.message,
      tone: "bad",
    };
  }
  const expiry = validDate(account.subscription_expires_at);
  if (expiry && expiry.getTime() <= nowMs) {
    return { state: "expired", label: "Subscription expired", detail: "The recorded subscription end date has passed. Sign-in status is separate.", tone: "bad" };
  }
  if (account.subscription_expires_at && !expiry) {
    return { state: "unknown", label: "Status unknown", detail: "The subscription expiry is invalid. Refresh to check account details.", tone: "warn" };
  }
  if (account.usage?.error) {
    return { state: "unknown", label: "Usage unavailable", detail: "The usage check failed without establishing that sign-in is required.", tone: "warn" };
  }
  const reading = assessUsage(account.usage, account.usageCheckedAt, nowMs);
  if (reading.state !== "current") {
    return { state: reading.state, label: reading.state === "stale" ? "Usage stale" : "Usage unknown", detail: reading.detail, tone: reading.state === "stale" ? "warn" : "muted" };
  }
  const exhausted = [account.usage?.primary_used_percent, account.usage?.secondary_used_percent].some((used) => used === 100);
  return exhausted
    ? { state: "exhausted", label: "Quota exhausted", detail: "At least one reported usage window has no allowance remaining.", tone: "bad" }
    : { state: "ready", label: "Ready", detail: reading.detail, tone: "ok" };
}

/** The backend check timestamp, never a component mount or render timestamp. */
export function lastCheckedText(checkedAt: number | undefined, nowMs: number): string {
  if (!Number.isFinite(nowMs) || !Number.isFinite(checkedAt) || checkedAt! <= 0 || checkedAt! > nowMs) return "Unknown";
  const date = new Date(checkedAt!);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  const seconds = Math.floor((nowMs - checkedAt!) / 1000);
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return date.toLocaleDateString();
}
