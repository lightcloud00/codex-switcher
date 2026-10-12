import { useCallback, useEffect, useState } from "react";
import { invokeBackend } from "../lib/platform";
import { BlurredText } from "./AccountCard";
import {
  accountSubtitle,
  accountTitle,
  formatPct,
  formatTokens,
  resetCountdown,
  stateLabel,
  updatedAgo,
  windowTone,
  type WindowTone,
} from "../lib/claudeUsage";
import type { ClaudeUsageAccount, ClaudeUsageSummary, ClaudeUsageWindow } from "../types";

const REFRESH_MS = 60_000;

const TONE_BAR: Record<WindowTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  danger: "bg-red-500",
  none: "bg-gray-300 dark:bg-gray-700",
};

function LimitBar({ label, w, now }: { label: string; w: ClaudeUsageWindow | null; now: number }) {
  const pct = w?.used_pct ?? null;
  const badge = stateLabel(w);
  const countdown = resetCountdown(w?.resets_at, now);
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span>
          {label}
          {badge && (
            <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {badge}
            </span>
          )}
        </span>
        <span>
          <span className="font-medium text-gray-700 dark:text-gray-200">{formatPct(w)} used</span>
          {countdown && ` • resets ${countdown}`}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
        <div
          className={`h-full transition-all duration-300 ${TONE_BAR[windowTone(pct)]}`}
          style={{ width: `${Math.min(Math.max(pct ?? 0, 0), 100)}%` }}
        />
      </div>
    </div>
  );
}

function AccountCardClaude({ a, now, masked }: { a: ClaudeUsageAccount; now: number; masked: boolean }) {
  const modelWeeks = Object.entries(a.model_weeks ?? {});
  const subtitle = accountSubtitle(a);
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-gray-900 dark:text-gray-100">
            <BlurredText blur={masked}>{accountTitle(a)}</BlurredText>
          </h3>
          {subtitle && <div className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</div>}
        </div>
        {a.pool_spend_today_usd ? (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Pool spend today ${a.pool_spend_today_usd.toFixed(2)}
          </span>
        ) : null}
      </div>
      <div className="space-y-2">
        <LimitBar label="5-hour" w={a.five_hour} now={now} />
        <LimitBar label="Week" w={a.seven_day} now={now} />
      </div>
      {modelWeeks.length > 0 && (
        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {modelWeeks.map(([label, w]) => `${label} week ${formatPct(w)}`).join(" · ")}
        </div>
      )}
      {a.probe_error && (
        <div className="mt-2 text-xs italic text-amber-600 dark:text-amber-400">{a.probe_error}</div>
      )}
    </div>
  );
}

export function ClaudeUsagePanel({ masked = false }: { masked?: boolean }) {
  const [summary, setSummary] = useState<ClaudeUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await invokeBackend<ClaudeUsageSummary>("get_claude_usage"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const tokens = summary?.local_tokens;
  const workers = summary?.workers;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Claude plans</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {summary ? `Updated ${updatedAgo(summary.generated_at, now)}` : "Reading Claude usage..."}
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="h-9 rounded-lg bg-gray-900 px-4 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50 dark:bg-black dark:hover:bg-neutral-900"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          <div className="font-medium">Could not read Claude usage</div>
          <div className="mt-1">{error}</div>
          <div className="mt-1 text-xs opacity-80">Run `claude-usage` in Terminal to see the details.</div>
        </div>
      )}

      {!summary && !error && (
        <div className="py-12 text-center text-sm italic text-gray-400 animate-pulse">Reading Claude usage...</div>
      )}

      {summary && (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {summary.accounts.map((a) => (
              <AccountCardClaude key={a.account} a={a} now={now} masked={masked} />
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-gray-200 p-4 text-sm dark:border-gray-800">
              <div className="mb-1 font-medium text-gray-900 dark:text-gray-100">Workers today (UTC)</div>
              <div className="text-gray-600 dark:text-gray-300">
                {workers?.runs ?? 0} runs · ${(workers?.cost_usd ?? 0).toFixed(2)}
                {workers?.held ? ` · ${workers.held} held` : ""}
              </div>
              {(workers?.by_route ?? []).map((r) => (
                <div key={r.route} className="text-xs text-gray-500 dark:text-gray-400">
                  {r.route} ×{r.runs}
                  {r.held ? ` (${r.held} held)` : ""}
                  {r.failed ? ` (${r.failed} failed)` : ""}
                  {r.cost_usd ? ` · $${r.cost_usd.toFixed(2)}` : ""}
                </div>
              ))}
            </div>
            <div className="rounded-2xl border border-gray-200 p-4 text-sm dark:border-gray-800">
              <div className="mb-1 font-medium text-gray-900 dark:text-gray-100">Local tokens today (this Mac)</div>
              {tokens?.total_tokens ? (
                <div className="text-gray-600 dark:text-gray-300">
                  {formatTokens(tokens.total_tokens)} total · {formatTokens(tokens.output_tokens)} output ·{" "}
                  {formatTokens(tokens.cache_read_tokens)} cache reads
                  {tokens.refreshing ? " · refreshing" : ""}
                </div>
              ) : (
                <div className="text-xs italic text-gray-500 dark:text-gray-400">
                  {tokens?.error ?? "No local token data yet"}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <p className="text-xs text-gray-400 dark:text-gray-500">
        Read-only: the numbers come from Claude Code's own /usage on each machine. No Claude credentials are
        read or switched.
      </p>
    </div>
  );
}
