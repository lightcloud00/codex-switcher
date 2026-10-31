import { useCallback, useEffect, useMemo, useState } from "react";
import { invokeBackend } from "../lib/platform";
import { BlurredText } from "./AccountCard";
import {
  buildClaudeSeats,
  formatPct,
  formatTokens,
  hasLiveWindow,
  hostLabel,
  lastKnownLine,
  limitBarNotes,
  noReadingLine,
  planLabel,
  SEAT_HEALTH_PROBLEM_STATES,
  seatStatusLabel,
  seatSubtitle,
  seatTitle,
  stateLabel,
  updatedAgo,
  windowTone,
  type WindowTone,
} from "../lib/claudeUsage";
import type {
  ClaudePromSnapshot,
  ClaudeSeat,
  ClaudeSeatRegistry,
  ClaudeSeatStatus,
  ClaudeUsageSummary,
  ClaudeUsageWindow,
} from "../types";

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
  // "resets in ..." goes with any window that still has a percentage (a stale 100% says when it comes
  // back); a window that is not a current reading also says when it was last read.
  const { countdown, lastRead } = limitBarNotes(w, now);
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
          {lastRead && ` • ${lastRead}`}
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

const BADGE_NEUTRAL = "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
const BADGE_WARN = "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300";

const STATUS_BADGE: Record<ClaudeSeatStatus, string> = {
  ok: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  near_limit: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  exhausted: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  unknown: BADGE_NEUTRAL,
  no_usage_yet: BADGE_NEUTRAL,
};

function CopyLauncherButton({ command }: { command: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = () => {
    void navigator.clipboard
      .writeText(command)
      .then(() => setState("copied"))
      .catch(() => setState("failed"))
      .finally(() => window.setTimeout(() => setState("idle"), 2000));
  };
  return (
    <button
      onClick={copy}
      title={command}
      className="h-7 rounded-lg border border-gray-200 px-2.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-neutral-900"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Clipboard unavailable" : "Copy launcher command"}
    </button>
  );
}

function SeatCard({
  seat,
  now,
  masked,
  usageUnavailable,
}: {
  seat: ClaudeSeat;
  now: number;
  masked: boolean;
  usageUnavailable: boolean;
}) {
  const modelWeeks = Object.entries(seat.modelWeeks);
  const subtitle = seatSubtitle(seat);
  const plan = planLabel(seat.plan);
  const noUsage = seat.status === "no_usage_yet";
  // An unknown seat with nothing to draw gets one honest line instead of two empty bars.
  const noReading = seat.status === "unknown" && !hasLiveWindow(seat);
  const lastKnown = noReading ? lastKnownLine(seat, now) : "";
  const showHealth = Boolean(seat.promState) && seat.promState !== "ok";
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-gray-900 dark:text-gray-100">
            <BlurredText blur={masked}>{seatTitle(seat)}</BlurredText>
          </h3>
          {subtitle && (
            <div className="text-xs text-gray-500 dark:text-gray-400" title={seat.usageAccount ?? undefined}>
              {subtitle}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-1.5">
            {plan && (
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${BADGE_NEUTRAL}`}>{plan}</span>
            )}
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[seat.status]}`}>
              {seatStatusLabel(seat.status)}
            </span>
          </div>
          {(showHealth || seat.lockOrphaned) && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {showHealth && seat.promState && (
                <span
                  title="Seat health from Prometheus (claude_seat_state)"
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    SEAT_HEALTH_PROBLEM_STATES.includes(seat.promState) ? BADGE_WARN : BADGE_NEUTRAL
                  }`}
                >
                  seat-health: {seat.promState}
                </span>
              )}
              {seat.lockOrphaned && (
                <span
                  title="The fleet-summon lock outlived its owner; release it to put the seat back in rotation"
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${BADGE_WARN}`}
                >
                  lock orphaned
                </span>
              )}
            </div>
          )}
          {seat.poolSpendTodayUsd ? (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Pool spend today ${seat.poolSpendTodayUsd.toFixed(2)}
            </span>
          ) : null}
        </div>
      </div>
      {noUsage ? (
        <div className="text-xs italic text-gray-500 dark:text-gray-400">
          {usageUnavailable
            ? "claude-usage did not answer, so this seat has no reading."
            : `No usage recorded for this seat yet${seat.host ? ` on ${hostLabel(seat.host)}` : ""}.`}
        </div>
      ) : noReading ? (
        <div className="space-y-1">
          <div className="text-xs italic text-amber-600 dark:text-amber-400">{noReadingLine(seat)}</div>
          {lastKnown && <div className="text-[11px] text-gray-400 dark:text-gray-500">{lastKnown}</div>}
        </div>
      ) : (
        <div className="space-y-2">
          <LimitBar label="5-hour" w={seat.fiveHour} now={now} />
          <LimitBar label="Week" w={seat.sevenDay} now={now} />
        </div>
      )}
      {modelWeeks.length > 0 && (
        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {modelWeeks.map(([label, w]) => `${label} week ${formatPct(w)}`).join(" · ")}
        </div>
      )}
      {seat.probeError && !noReading && (
        <div className="mt-2 text-xs italic text-amber-600 dark:text-amber-400">{seat.probeError}</div>
      )}
      {seat.launcher && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <code className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400">{seat.launcher}</code>
          <CopyLauncherButton command={seat.launcher} />
        </div>
      )}
    </div>
  );
}

export function ClaudeUsagePanel({ masked = false }: { masked?: boolean }) {
  const [summary, setSummary] = useState<ClaudeUsageSummary | null>(null);
  const [registry, setRegistry] = useState<ClaudeSeatRegistry | null>(null);
  // undefined until the first answer; null when the Prometheus call itself failed.
  const [prom, setProm] = useState<ClaudePromSnapshot | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    // Each source is optional on its own: a failed claude-usage run, a missing registry or an
    // unreachable Prometheus leaves the rest of the tab (and the previous numbers) in place.
    const [usage, seats, snapshot] = await Promise.all([
      invokeBackend<ClaudeUsageSummary>("get_claude_usage").then(
        (value) => ({ value, error: null as string | null }),
        (e: unknown) => ({ value: null, error: e instanceof Error ? e.message : String(e) }),
      ),
      invokeBackend<ClaudeSeatRegistry>("get_claude_seats").catch(() => null),
      invokeBackend<ClaudePromSnapshot>("get_claude_prometheus").catch(() => null),
    ]);
    if (usage.value) setSummary(usage.value);
    setRegistry(seats);
    setProm(snapshot);
    setError(usage.error);
    setLoading(false);
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = window.setInterval(tick, 15_000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, []);

  const haveData = summary !== null || registry?.found === true || prom?.found === true;
  const seats = useMemo(() => {
    if (!haveData) return [];
    // Without claude-usage there is no usage-only mode: fall back to the known seats.
    const entries = registry?.found ? registry.seats : summary ? null : [];
    return buildClaudeSeats(entries, summary?.accounts ?? [], prom, now);
  }, [haveData, summary, registry, prom, now]);
  const tokens = summary?.local_tokens;
  const workers = summary?.workers;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Claude seats</h2>
          {summary?.source_host === "mac" && <p className="text-xs text-gray-500">Fleet usage from Mac</p>}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {summary
              ? `Updated ${updatedAgo(summary.generated_at, now)}`
              : error || haveData
                ? "claude-usage unavailable"
                : "Reading Claude usage..."}
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
          {haveData && (
            <div className="mt-1 text-xs opacity-80">
              Showing the seats from the registry and Prometheus; numbers may be missing or old.
            </div>
          )}
        </div>
      )}

      {!haveData && !error && (
        <div className="py-12 text-center text-sm italic text-gray-400 animate-pulse">Reading Claude usage...</div>
      )}

      {haveData && (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {seats.map((seat) => (
              <SeatCard key={seat.id} seat={seat} now={now} masked={masked} usageUnavailable={!summary} />
            ))}
          </div>
          {summary && registry && !registry.found && (
            <p className="text-xs italic text-gray-500 dark:text-gray-400">
              {registry.error ?? "Seat registry not found"}. Showing the accounts claude-usage reports.
            </p>
          )}

          {summary && (
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
          )}
        </>
      )}

      <p className="text-xs text-gray-400 dark:text-gray-500">
        Read-only: seats come from the fleet seat registry and the numbers from Claude Code's own /usage on
        each machine. No Claude credentials are read or switched.
        {prom !== undefined && (
          <span title={prom?.error ?? undefined}>
            {" "}
            Prometheus: {prom?.found ? "reachable" : "not reachable (using claude-usage only)"}.
          </span>
        )}
      </p>
    </div>
  );
}
