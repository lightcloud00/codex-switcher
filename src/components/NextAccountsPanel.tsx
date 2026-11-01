import { useEffect, useMemo, useRef, useState } from "react";
import { invokeBackend } from "../lib/platform";
import { BlurredText } from "./AccountCard";
import {
  formatWhen,
  NONE,
  planEntries,
  planInputKey,
  planText,
  reasonLine,
  statusBadge,
  usageWindows,
  usagesForPlan,
  windowLabel,
  windowUsageText,
  type UseNextEntry,
  type UseNextTone,
} from "../lib/nextAccounts";
import type { AccountWithUsage, UseNextPlan } from "../types";

const NO_IDS: ReadonlySet<string> = new Set();
const RANK_DEBOUNCE_MS = 400;

// Same badge classes as the Overview and Claude tabs, so a status reads the same everywhere.
const TONE_BADGE: Record<UseNextTone, string> = {
  ok: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  warn: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  bad: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  muted: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};
const BADGE_BASE = "inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium";

const COLUMNS = [
  { label: "#", width: "5%" },
  { label: "Account", width: "19%" },
  { label: "Status", width: "10%" },
  { label: "Usage", width: "13%" },
  { label: "Dates", width: "22%" },
  { label: "Why", width: "19%" },
  { label: "", width: "12%" },
] as const;

interface NextAccountsPanelProps {
  /** The Codex accounts App already loads (list_accounts plus usage). */
  accounts: AccountWithUsage[];
  accountsLoading?: boolean;
  masked?: boolean;
  maskedAccountIds?: ReadonlySet<string>;
  /** Opens Codex on the account: a switch through App's usual path first when it is not the active one. */
  onOpen: (accountId: string) => void;
  /** The account a switch or open is running for; every button waits while one runs. */
  openingId?: string | null;
  disabled?: boolean;
  /** Opening the Codex app works in the desktop app only; the web page can still switch. */
  canOpenCodex: boolean;
}

export function NextAccountsPanel({
  accounts,
  accountsLoading = false,
  masked = false,
  maskedAccountIds = NO_IDS,
  onOpen,
  openingId = null,
  disabled = false,
  canOpenCodex,
}: NextAccountsPanelProps) {
  const [plan, setPlan] = useState<UseNextPlan | null>(null);
  const [error, setError] = useState("");
  const latest = useRef(0);
  const inputKey = useMemo(() => planInputKey(accounts), [accounts]);
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  // Rank again whenever a reading, the active account or a plan date changes; no usage calls of its own.
  // A refresh lands account by account, so a short wait turns that burst into one call.
  useEffect(() => {
    if (accountsRef.current.length === 0) return;
    const run = ++latest.current;
    const timer = setTimeout(() => {
      invokeBackend<UseNextPlan>("get_use_next_plan", { usages: usagesForPlan(accountsRef.current) })
        .then((next) => {
          if (run !== latest.current) return;
          setPlan(next);
          setError("");
        })
        .catch((err) => {
          if (run !== latest.current) return;
          setError(err instanceof Error ? err.message : String(err));
        });
    }, plan ? RANK_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
    // The plan only picks the delay; ranking again when it arrives would loop.
  }, [inputKey]);

  const entries = useMemo(() => planEntries(plan, accounts), [plan, accounts]);
  const now = plan ? new Date(plan.observed_at).getTime() : Date.now();

  if (accounts.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
        {accountsLoading ? "Loading accounts..." : "No Codex accounts yet. Add one on the Codex tab."}
      </p>
    );
  }

  return (
    <section aria-label="Use next" className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Codex accounts in the order to use them
        </h3>
        {plan && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Ranked {formatWhen(new Date(plan.observed_at).getTime())}
          </span>
        )}
      </div>
      {error && (
        <p className="text-xs text-red-600 dark:text-red-300">Could not rank the accounts: {error}</p>
      )}
      {!plan && !error ? (
        <p className="text-xs italic text-gray-500 dark:text-gray-400">Ranking accounts...</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <table className="w-full min-w-[960px] table-fixed text-left text-sm">
            <colgroup>
              {COLUMNS.map((c, index) => (
                <col key={index} style={{ width: c.width }} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
                {COLUMNS.map((c, index) => (
                  <th key={index} scope="col" className="px-3 py-2 font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {entries.map((entry) => (
                <NextAccountRow
                  key={entry.row.account_id}
                  entry={entry}
                  now={now}
                  blur={masked || maskedAccountIds.has(entry.account.id)}
                  onOpen={onOpen}
                  opening={openingId === entry.account.id}
                  disabled={disabled || openingId !== null}
                  canOpenCodex={canOpenCodex}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs italic text-gray-500 dark:text-gray-400">
        Clean accounts follow router_plan's Codex order: the plan that ends soonest first, then the lane id.
        Then the account in use now, used-up accounts soonest back, failed readings and ended plans.
        router_plan only hands out lanes on its own after host admission; a switch here needs none.
      </p>
    </section>
  );
}

function NextAccountRow({
  entry,
  now,
  blur,
  onOpen,
  opening,
  disabled,
  canOpenCodex,
}: {
  entry: UseNextEntry;
  now: number;
  blur: boolean;
  onOpen: (accountId: string) => void;
  opening: boolean;
  disabled: boolean;
  canOpenCodex: boolean;
}) {
  const { row, account } = entry;
  const text = "text-gray-900 dark:text-gray-100";
  const sub = "text-gray-500 dark:text-gray-400";
  const badge = statusBadge(row.status);
  const { short, long } = usageWindows(account.usage);
  const held = row.status === "expired" || row.status === "no_usage";
  const checked = account.usageCheckedAt ?? null;
  const active = account.is_active;
  const label = opening ? "Opening..." : active ? "Open Codex" : canOpenCodex ? "Switch & open" : "Switch";
  const title = active
    ? canOpenCodex
      ? "Open the Codex app on this account"
      : "Open Codex from the desktop app"
    : canOpenCodex
      ? "Switch Codex to this account, then open it"
      : "Switch Codex to this account";

  return (
    <tr className={`align-top ${held ? "opacity-60" : ""}`} data-status={row.status}>
      <td className={`px-3 py-2 font-semibold tabular-nums ${text}`}>{row.position}</td>
      <td className="px-3 py-2">
        <div className={`break-words font-medium ${text}`}>
          <BlurredText blur={blur}>{account.name}</BlurredText>
        </div>
        {account.email && account.email !== account.name && (
          <div className={`break-words text-xs ${sub}`}>
            <BlurredText blur={blur}>{account.email}</BlurredText>
          </div>
        )}
        {active && (
          <span className={`${BADGE_BASE} mt-1 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300`}>
            Active
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <span className={`${BADGE_BASE} ${TONE_BADGE[badge.tone]}`}>{badge.label}</span>
      </td>
      <td className={`px-3 py-2 text-xs tabular-nums ${text}`}>
        {short && <div>{windowUsageText(short)}</div>}
        {long && <div>{windowUsageText(long)}</div>}
        {!short && !long && <div>{NONE}</div>}
        {row.remaining_percent !== null && (
          <div className={sub}>{Math.round(row.remaining_percent)}% left</div>
        )}
      </td>
      <td className={`px-3 py-2 text-xs ${sub}`}>
        <div>Checked {checked === null ? NONE : formatWhen(checked)}</div>
        {short && (
          <div>
            {windowLabel(short.minutes)} resets {formatWhen(short.resetsAt)}
          </div>
        )}
        {long && (
          <div>
            {windowLabel(long.minutes)} resets {formatWhen(long.resetsAt)}
          </div>
        )}
        <div className={text}>{planText(row, now)}</div>
      </td>
      <td className={`px-3 py-2 text-xs ${text}`}>{reasonLine(entry, now)}</td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          onClick={() => onOpen(account.id)}
          disabled={disabled || (active && !canOpenCodex)}
          title={title}
          className="inline-flex items-center whitespace-nowrap rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-800 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
        >
          {label}
        </button>
      </td>
    </tr>
  );
}
