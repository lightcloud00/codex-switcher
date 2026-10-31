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

// Fixed widths so the columns line up from one section to the next.
const COLUMNS = [
  { label: "Account (email)", width: "25%" },
  { label: "Type", width: "12%" },
  { label: "Left", width: "11%" },
  { label: "Resets", width: "18%" },
  { label: "Renews / expires", width: "20%" },
  { label: "Status", width: "14%" },
] as const;

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
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <table className="w-full min-w-[880px] table-fixed text-left text-sm">
            <colgroup>
              {COLUMNS.map((c) => (
                <col key={c.label} style={{ width: c.width }} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
                {COLUMNS.map((c) => (
                  <th key={c.label} scope="col" className="px-3 py-2 font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {rows.map((row) => (
                <OverviewTableRow key={row.id} row={row} blur={isMasked(row)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note && rows.length > 0 && <p className="mt-1 text-xs italic text-gray-500 dark:text-gray-400">{note}</p>}
    </section>
  );
}

function OverviewTableRow({ row, blur }: { row: OverviewRow; blur: boolean }) {
  const text = "text-gray-900 dark:text-gray-100";
  const sub = "text-gray-500 dark:text-gray-400";
  // An expired or empty free account stays readable but recedes.
  return (
    <tr className={`align-top ${row.inactive ? "opacity-60" : ""}`} data-inactive={row.inactive || undefined}>
      <td className="px-3 py-2">
        {row.account ? (
          <div className={`break-words font-medium ${text}`}>
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
      </td>
      <td className="px-3 py-2">
        {/* The type badge may wrap: tool and plan names are longer than the status words. */}
        <span className={`${BADGE_BASE} ${TONE_BADGE.muted} max-w-full whitespace-normal break-words`}>{row.type}</span>
      </td>
      <td className={`px-3 py-2 font-medium tabular-nums ${text}`}>{row.left}</td>
      <td className={`px-3 py-2 ${sub}`}>{row.resets}</td>
      <td className={`px-3 py-2 text-xs ${sub}`}>{row.renews}</td>
      <td className="px-3 py-2">
        <span className={`${BADGE_BASE} ${TONE_BADGE[row.tone]}`}>{row.status}</span>
      </td>
    </tr>
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
    const [usage, seats, snapshot, access] = await Promise.all([
      invokeBackend<ClaudeUsageSummary>("get_claude_usage").catch(() => null),
      invokeBackend<ClaudeSeatRegistry>("get_claude_seats").catch(() => null),
      invokeBackend<ClaudePromSnapshot>("get_claude_prometheus").catch(() => null),
      invokeBackend<{ plans: PlanDates[] }>("get_provider_access").catch(() => null),
    ]);
    if (run !== latestClaude.current) return;
    if (usage) setSummary(usage);
    setRegistry(seats);
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

  const seats = useMemo(() => claudeSeatsFromSources(summary, registry, prom, now), [summary, registry, prom, now]);
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
  const subscriptionsNote = accountsLoading
    ? "Loading Codex accounts…"
    : accountsError
      ? `Could not load Codex accounts: ${accountsError}`
      : "";
  const clientEmpty = !desktop
    ? "Tool and Grok status is checked from the desktop app only."
    : clientError || (clientLoading ? "Checking clients and the three Grok Bots…" : "No status reported.");
  const prepaidEmpty = !desktop
    ? "API credits are checked from the desktop app only."
    : creditsError || (creditsLoading ? "Checking providers through CredVault…" : "No providers reported.");

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
        empty={subscriptionsNote || "No subscription accounts yet."}
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
        Left is the Codex window with the least remaining, the 7-day window for Claude, and the provider balance for
        prepaid APIs. Grok has no quota API, so its Left is the last hand reading from grok.com with its age. Expired
        accounts and free accounts with nothing left sort last and are dimmed.
      </p>
    </div>
  );
}
