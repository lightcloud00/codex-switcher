import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeBackend, isTauriRuntime } from "../lib/platform";
import { BlurredText } from "./AccountCard";
import type { ApiCreditsSnapshot } from "../lib/apiCredits";
import { buildGrokRows, buildToolRows, type ClientStatusSnapshot } from "../lib/clientStatus";
import { updatedAgo } from "../lib/claudeUsage";
import {
  buildApiCreditRows,
  buildClaudeRows,
  buildCodexRows,
  claudeSeatsFromSources,
  sortOverviewRows,
  type OverviewRow,
  type OverviewTone,
} from "../lib/overview";
import type { PlanDates } from "../lib/providerAccess";
import type {
  AccountWithUsage,
  ClaudePromSnapshot,
  ClaudeSeatRegistry,
  ClaudeUsageSummary,
} from "../types";

const REFRESH_MS = 60_000;
// The credit probe runs CredVault and takes seconds, so a tab switch reuses a recent answer.
const CREDITS_TTL_MS = 5 * 60_000;
let creditsCache: { at: number; data: ApiCreditsSnapshot } | null = null;
// Same cache for tools and Grok: the status script makes two ssh reads, so tab switches reuse the last answer.
let clientCache: { at: number; data: ClientStatusSnapshot } | null = null;

const NO_IDS: ReadonlySet<string> = new Set();

// Same classes as the badges on the Claude seat cards (ClaudeUsagePanel), so a status reads the same here.
const TONE_BADGE: Record<OverviewTone, string> = {
  ok: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  warn: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  bad: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  muted: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};
const BADGE_BASE = "inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium";

interface OverviewPanelProps {
  /** The Codex accounts App already loads (list_accounts plus usage). */
  accounts: AccountWithUsage[];
  accountsLoading?: boolean;
  accountsError?: string | null;
  /** The "hide all" privacy toggle. */
  masked?: boolean;
  /** Codex accounts masked one by one. */
  maskedAccountIds?: ReadonlySet<string>;
}

function Section({
  title,
  rows,
  isMasked,
  empty,
  note = "",
}: {
  title: string;
  rows: OverviewRow[];
  isMasked: (row: OverviewRow) => boolean;
  /** The one muted line shown when the section has no rows. */
  empty: string;
  /** A muted line under the table, e.g. a source that failed or is still loading. */
  note?: string;
}) {
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="mb-2 text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs italic text-gray-500 dark:text-gray-400">{empty}</p>
      ) : (
        <div className="min-w-0 divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
          {rows.map((row) => <OverviewCompactRow key={row.id} row={row} blur={isMasked(row)} />)}
        </div>
      )}
      {note && <details className="mt-1 text-xs text-gray-500 dark:text-gray-400"><summary className="cursor-pointer">Details</summary><p className="break-words">{note}</p></details>}
    </section>
  );
}

function OverviewCompactRow({ row, blur }: { row: OverviewRow; blur: boolean }) {
  const text = "text-gray-900 dark:text-gray-100";
  const sub = "text-gray-500 dark:text-gray-400";
  // An expired or empty free account stays readable but recedes.
  return (
    <article className={`min-w-0 p-3 ${row.inactive ? "opacity-60" : ""}`} data-inactive={row.inactive || undefined}>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
        {row.account ? (
          <div className={`break-all font-medium ${text}`}>
            <BlurredText blur={blur}>{row.account}</BlurredText>
          </div>
        ) : (
          <div className={`text-xs italic ${sub}`}>email not given by provider</div>
        )}
        {row.detail && (
          <div className={`break-words text-xs ${sub}`}>
            <BlurredText blur={blur}>{row.detail}</BlurredText>
          </div>
        )}
          <span className={`${BADGE_BASE} ${TONE_BADGE.muted} mt-1 inline-block max-w-full whitespace-normal break-words`}>{row.type}</span>
          {row.activeLogin && <span className="ml-2 text-xs text-gray-500">Current login</span>}
        </div>
        <span className={`${BADGE_BASE} ${TONE_BADGE[row.tone]}`}>{row.status}</span>
      </div>
      <div className="mt-2 grid min-w-0 grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <div><span className={sub}>Left </span><span className={`font-medium tabular-nums ${text}`}>{row.left}</span></div>
        <div className={sub}>Resets {row.resets}</div>
        <div className={`col-span-2 break-words ${sub}`}>{row.renews}</div>
      </div>
    </article>
  );
}

export function OverviewPanel({
  accounts,
  accountsLoading = false,
  accountsError = null,
  masked = false,
  maskedAccountIds = NO_IDS,
}: OverviewPanelProps) {
  const desktop = isTauriRuntime();
  const [summary, setSummary] = useState<ClaudeUsageSummary | null>(null);
  const [registry, setRegistry] = useState<ClaudeSeatRegistry | null>(null);
  const [registryError, setRegistryError] = useState(false);
  // undefined until the first answer; null when the Prometheus call itself failed.
  const [prom, setProm] = useState<ClaudePromSnapshot | null | undefined>(undefined);
  const [claudeLoading, setClaudeLoading] = useState(true);
  const [credits, setCredits] = useState<ApiCreditsSnapshot | null>(creditsCache?.data ?? null);
  const [creditsError, setCreditsError] = useState("");
  const [creditsLoading, setCreditsLoading] = useState(false);
  const [client, setClient] = useState<ClientStatusSnapshot | null>(clientCache?.data ?? null);
  const [clientError, setClientError] = useState("");
  const [clientLoading, setClientLoading] = useState(false);
  const [plans, setPlans] = useState<PlanDates[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const latestClaude = useRef(0);
  const latestCredits = useRef(0);
  const latestClient = useRef(0);

  // Claude seats and the saved plan dates. Each source is optional on its own, as on the Claude tab: a failed
  // one leaves the rest in place.
  const loadLocal = useCallback(async () => {
    const run = ++latestClaude.current;
    setClaudeLoading(true);
    const [usage, seatResult, snapshot, access] = await Promise.all([
      invokeBackend<ClaudeUsageSummary>("get_claude_usage").catch(() => null),
      invokeBackend<ClaudeSeatRegistry>("get_claude_seats").then((value) => ({ value, error: false })).catch(() => ({ value: null, error: true })),
      invokeBackend<ClaudePromSnapshot>("get_claude_prometheus").catch(() => null),
      invokeBackend<{ plans: PlanDates[] }>("get_provider_access").catch(() => null),
    ]);
    if (run !== latestClaude.current) return;
    if (usage) setSummary(usage);
    // A failed read returns null; keep the prior registry (including hidden IDs) so seats stay hidden.
    setRegistryError(seatResult.error);
    if (seatResult.value) setRegistry(seatResult.value);
    setProm(snapshot);
    if (access) setPlans(access.plans);
    setClaudeLoading(false);
    setNow(Date.now());
  }, []);

  const loadCredits = useCallback(async (force: boolean) => {
    if (!isTauriRuntime()) return;
    if (!force && creditsCache && Date.now() - creditsCache.at < CREDITS_TTL_MS) return;
    const run = ++latestCredits.current;
    setCreditsLoading(true);
    setCreditsError("");
    try {
      const next = await invokeBackend<ApiCreditsSnapshot>("get_api_credits");
      creditsCache = { at: Date.now(), data: next };
      if (run === latestCredits.current) setCredits(next);
    } catch (e) {
      if (run === latestCredits.current) setCreditsError(String(e));
    } finally {
      if (run === latestCredits.current) setCreditsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLocal();
    const id = window.setInterval(() => void loadLocal(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [loadLocal]);

  useEffect(() => {
    const refresh = () => void loadLocal();
    window.addEventListener("claude-seats-changed", refresh);
    return () => window.removeEventListener("claude-seats-changed", refresh);
  }, [loadLocal]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = window.setInterval(tick, 15_000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, []);
  const loadClient = useCallback(async (force: boolean) => {
    if (!isTauriRuntime()) return;
    if (!force && clientCache && Date.now() - clientCache.at < CREDITS_TTL_MS) return;
    const run = ++latestClient.current;
    setClientLoading(true);
    setClientError("");
    try {
      const next = await invokeBackend<ClientStatusSnapshot>("get_client_status");
      clientCache = { at: Date.now(), data: next };
      if (run === latestClient.current) setClient(next);
    } catch (e) {
      if (run === latestClient.current) setClientError(String(e));
    } finally {
      if (run === latestClient.current) setClientLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCredits(false);
    void loadClient(false);
  }, [loadCredits, loadClient]);

  const seats = useMemo(
    () => registryError && !registry ? [] : claudeSeatsFromSources(summary, registry, prom, now),
    [summary, registry, prom, now, registryError],
  );
  const subscriptionRows = useMemo(
    () => sortOverviewRows([...buildCodexRows(accounts, now), ...buildClaudeRows(seats, plans, now)]),
    [accounts, seats, plans, now],
  );
  const prepaidRows = useMemo(
    () => sortOverviewRows(buildApiCreditRows(credits?.providers ?? [], plans, now)),
    [credits, plans, now],
  );
  const activeCodexEmail = accounts.find((a) => a.is_active)?.email ?? null;
  const grok = useMemo(() => sortOverviewRows(buildGrokRows(client?.grok ?? [], now)), [client, now]);
  const tools = useMemo(
    () => sortOverviewRows(buildToolRows(client?.tools ?? [], client?.source_host === "mac" ? null : activeCodexEmail)),
    [client, activeCodexEmail],
  );

  const isMasked = (row: OverviewRow) => masked || (row.maskId !== undefined && maskedAccountIds.has(row.maskId));
  const busy = claudeLoading || creditsLoading || clientLoading;
  const subscriptionsNote = [accountsError && `Could not load Codex accounts: ${accountsError}`, registryError && !registry && "Claude seat visibility is unavailable; retry refresh."].filter(Boolean).join(" · ");
  const subscriptionsEmpty = accountsLoading ? "Loading Codex accounts…" : accountsError ? "Account data unavailable." : registryError && !registry ? "Claude seats unavailable until visibility registry responds." : "No subscription accounts yet.";
  const clientEmpty = !desktop
    ? "Tool and Grok status is checked from the desktop app only."
    : clientLoading ? "Checking clients and the three Grok Bots…" : "No status reported.";
  const prepaidEmpty = !desktop
    ? "API credits are checked from the desktop app only."
    : creditsLoading ? "Checking providers through CredVault…" : "No providers reported.";

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Overview</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {summary ? `Claude usage updated ${updatedAgo(summary.generated_at, now)}` : "Every account and quota in one place"}
          </p>
          {(summary?.source_host === "mac" || client?.source_host === "mac" || credits?.source_host === "mac") &&
            <p className="text-xs text-gray-500">
              {[summary?.source_host === "mac" && "Claude usage", credits?.source_host === "mac" && "API balances",
                client?.source_host === "mac" && "tool status"].filter(Boolean).join(", ")} from Mac.
              {" "}Codex accounts are local to this computer.
            </p>}
        </div>
        <button
          onClick={() => {
            void loadLocal();
            void loadCredits(true);
            void loadClient(true);
          }}
          disabled={busy}
          className="h-9 rounded-lg bg-gray-900 px-4 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50 dark:bg-black dark:hover:bg-neutral-900"
        >
          {busy ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <Section
        title="Subscriptions"
        rows={subscriptionRows}
        isMasked={isMasked}
        empty={subscriptionsEmpty}
        note={subscriptionsNote}
      />
      <Section
        title="Prepaid APIs"
        rows={prepaidRows}
        isMasked={isMasked}
        empty={prepaidEmpty}
        note={creditsError}
      />
      <Section title="Grok Bots" rows={grok} isMasked={isMasked} empty={clientEmpty} note={clientError} />
      <Section title="Tools (IDE / CLI)" rows={tools} isMasked={isMasked} empty={clientEmpty} note={clientError} />

      <p className="text-xs text-gray-400 dark:text-gray-500">
        Left is the Codex window with the least remaining, the limiting current 5-hour or weekly window for Claude, and the provider balance for
        prepaid APIs. Grok has no quota API, so its Left is the last hand reading from grok.com with its age. Expired
        accounts and free accounts with nothing left sort last and are dimmed.
      </p>
    </div>
  );
}
