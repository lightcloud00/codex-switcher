import { formatResetCountdown } from "./resetCountdown.ts";

export type GeminiState =
  | "ok"
  | "not_installed"
  | "unsupported_auth"
  | "sign_in_needed"
  | "client_not_found"
  | "unavailable";

export interface GeminiTier {
  id: string;
  label: string;
  percentLeft: number;
  resetsAt: string | null;
}

export interface GeminiQuota {
  state: GeminiState;
  message: string;
  plan: string | null;
  tiers: GeminiTier[];
  checkedAt: string;
}

/** "Pro · 82% left · resets in 3h 5m"; the reset part is left out when Google gave none. */
export function tierLine(tier: GeminiTier, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const percent = Number.isFinite(tier.percentLeft) ? Math.max(0, Math.min(100, tier.percentLeft)) : null;
  const parts = [tier.label, percent === null ? "unknown" : `${Math.round(percent)}% left`];
  const resetAt = tier.resetsAt ? Math.floor(Date.parse(tier.resetsAt) / 1000) : NaN;
  const countdown = Number.isFinite(resetAt) ? formatResetCountdown(resetAt, nowSeconds) : null;
  if (countdown) parts.push(countdown === "now" ? "resets now" : `resets in ${countdown}`);
  return parts.join(" · ");
}

/** Green above 30% left, amber to 10%, red below; same cut-offs as the account bars. */
export function tierTone(percentLeft: number): "good" | "warn" | "bad" {
  if (percentLeft <= 10) return "bad";
  if (percentLeft <= 30) return "warn";
  return "good";
}

/** One short status for the card header. */
export function geminiStatusText(quota: GeminiQuota | null): string {
  if (!quota) return "checking";
  if (quota.state === "ok") return quota.plan ? quota.plan : "signed in";
  if (quota.state === "sign_in_needed") return "sign in again";
  if (quota.state === "not_installed") return "not signed in";
  if (quota.state === "unsupported_auth") return "no OAuth quota";
  return "unavailable";
}
