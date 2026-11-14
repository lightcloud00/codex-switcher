import type { ClaudeUsageWindow } from "../types";
import { lastReadLabel } from "./claudeUsage.ts";
import { formatCountdown, type WhenFormat } from "./nextAccounts.ts";

export interface ClaudeWindowMetrics {
  usedPct: number | null;
  remainingText: string;
  resetText: string;
  observationText: string;
}

/** Display one reported window without guessing its next reset or reviving an expired percentage. */
export function claudeWindowMetrics(
  window: ClaudeUsageWindow | null | undefined,
  now: number,
  format: WhenFormat = {},
): ClaudeWindowMetrics {
  const parsedReset = window?.resets_at ? Date.parse(window.resets_at) : NaN;
  const resetAt = Number.isFinite(parsedReset) ? parsedReset : null;
  const expired = window?.state === "reset" || (resetAt !== null && resetAt <= now);
  const usedPct = !expired && typeof window?.used_pct === "number" && Number.isFinite(window.used_pct)
    ? Math.min(100, Math.max(0, window.used_pct))
    : null;

  return {
    usedPct,
    remainingText: usedPct === null ? "" : `${Math.round(100 - usedPct)}% left`,
    resetText: expired
      ? "Reset passed · waiting for a fresh reading"
      : resetAt !== null
        ? `Resets ${formatCountdown(resetAt, now, format)}`
        : "Reset time not reported",
    observationText: lastReadLabel(window, now),
  };
}
