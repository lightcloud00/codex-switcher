import { useEffect, useMemo, useState } from "react";
import { BlurredText } from "./AccountCard";
import {
  formatAgo,
  formatClock,
  formatCountdown,
  formatIn,
  heroPick,
  lastChecked,
  leftText,
  MARKED_DAYS,
  NONE,
  planEntries,
  planText,
  rowLine,
  statusBadge,
  stripDays,
  stripEvents,
  usageWindows,
  whyText,
  windowUsageText,
  type HeroPick,
  type StripEventKind,
  type UseNextEntry,
  type UseNextTone,
} from "../lib/nextAccounts";
import type { AccountWithUsage, UseNextPlan, UseNextStatus } from "../types";

const NO_IDS: ReadonlySet<string> = new Set();
// Redraws the countdowns; the data itself only changes when the window's usual refresh lands.
const CLOCK_TICK_MS = 30_000;

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-blue-400 dark:focus-visible:ring-offset-gray-950";

// Strong text on a pale fill in light mode, pale text on a deep fill in dark mode: readable either way.
const CHIP: Record<UseNextTone, { chip: string; dot: string }> = {
  ok: {
    chip: "bg-emerald-100 text-emerald-900 ring-emerald-300 dark:bg-emerald-900/60 dark:text-emerald-100 dark:ring-emerald-700",
    dot: "bg-emerald-600 dark:bg-emerald-400",
  },
  warn: {
    chip: "bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-900/60 dark:text-amber-100 dark:ring-amber-700",
    dot: "bg-amber-500 dark:bg-amber-300",
  },
  bad: {
    chip: "bg-red-100 text-red-900 ring-red-300 dark:bg-red-900/60 dark:text-red-100 dark:ring-red-700",
    dot: "bg-red-600 dark:bg-red-400",
  },
  muted: {
    chip: "bg-gray-100 text-gray-800 ring-gray-300 dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-600",
    dot: "bg-gray-500 dark:bg-gray-400",
  },
};

const HERO: Record<"ready" | "keep", { box: string; eyebrow: string; title: string }> = {
  ready: {
    box: "border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/50",
    eyebrow: "text-emerald-800 dark:text-emerald-300",
    title: "Use this one now",
  },
  keep: {
    box: "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/50",
    eyebrow: "text-amber-900 dark:text-amber-300",
    title: "Keep using this one",
  },
};

const STRIP_EVENT: Record<StripEventKind, { glyph: string; word: string; className: string }> = {
  back: { glyph: "✓", word: "Back", className: "font-semibold text-emerald-800 dark:text-emerald-300" },
  reset: { glyph: "↻", word: "Usage reset", className: "text-gray-700 dark:text-gray-300" },
  ends: { glyph: "✕", word: "Plan ends", className: "font-semibold text-red-800 dark:text-red-300" },
};

const PRIMARY_BUTTON = `inline-flex items-center justify-center whitespace-nowrap rounded-xl bg-emerald-700 px-6 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const SECONDARY_BUTTON = `inline-flex items-center justify-center whitespace-nowrap rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-900 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700 ${FOCUS}`;

interface NextAccountsPanelProps {
  /** The Codex accounts App already loads (list_accounts plus usage). */
  accounts: AccountWithUsage[];
  /** App's Use next plan (useNextPlan), shared with the tray. */
  plan: UseNextPlan | null;
  planError: string;
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
  /** App's usual "refresh all usage" path. */
  onRefresh: () => void;
  refreshing: boolean;
}

export function NextAccountsPanel({
  accounts,
  plan,
  planError,
  accountsLoading = false,
  masked = false,
  maskedAccountIds = NO_IDS,
  onOpen,
  openingId = null,
  disabled = false,
  canOpenCodex,
  onRefresh,
  refreshing,
}: NextAccountsPanelProps) {
  const [now, setNow] = useState(() => Date.now());
  const [openDetails, setOpenDetails] = useState<ReadonlySet<string>>(NO_IDS);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  // A new plan or reading moves the clock too, so a countdown never lags the data it explains.
  useEffect(() => setNow(Date.now()), [plan, accounts]);

  const entries = useMemo(() => planEntries(plan, accounts), [plan, accounts]);
  const pick = useMemo(() => heroPick(entries), [entries]);
  const blurFor = (accountId: string) => masked || maskedAccountIds.has(accountId);
  const busy = disabled || openingId !== null;

  if (accounts.length === 0) {
    return (
      <p className="py-10 text-center text-base text-gray-600 dark:text-gray-400">
        {accountsLoading ? "Loading accounts..." : "No Codex accounts yet. Add one on the Codex tab."}
      </p>
    );
  }

  const toggleDetails = (accountId: string) =>
    setOpenDetails((current) => {
      const next = new Set(current);
      if (!next.delete(accountId)) next.add(accountId);
      return next;
    });

  return (
    <section aria-label="Use next" className="min-w-0 space-y-6">
      {(pick.kind === "empty" || pick.kind === "none") && plan && (
        <EmptyBanner
          pick={pick}
          now={now}
          blur={pick.kind === "empty" && blurFor(pick.entry.account.id)}
          onOpen={onOpen}
          opening={pick.kind === "empty" && openingId === pick.entry.account.id}
          disabled={busy}
          canOpenCodex={canOpenCodex}
        />
      )}

      {planError && (
        <p role="alert" className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-100">
          Could not rank the accounts: {planError}
        </p>
      )}

      {!plan && !planError ? (
        <p className="py-10 text-center text-base text-gray-600 dark:text-gray-400">
          {lastChecked(accounts) === null ? "Checking usage..." : "Ranking accounts..."}
        </p>
      ) : (
        <>
          {(pick.kind === "ready" || pick.kind === "keep") && (
            <HeroCard
              pick={pick}
              now={now}
              blur={blurFor(pick.entry.account.id)}
              onOpen={onOpen}
              opening={openingId === pick.entry.account.id}
              disabled={busy}
              canOpenCodex={canOpenCodex}
            />
          )}

          <RefreshRow accounts={accounts} now={now} onRefresh={onRefresh} refreshing={refreshing} />

          <section aria-labelledby="use-next-list-heading" className="space-y-3">
            <h3 id="use-next-list-heading" className="text-base font-semibold text-gray-900 dark:text-gray-100">
              All accounts, in the order to use them
            </h3>
            <ol className="divide-y divide-gray-200 overflow-hidden rounded-2xl border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
              {entries.map((entry) => (
                <AccountRow
                  key={entry.account.id}
                  entry={entry}
                  now={now}
                  blur={blurFor(entry.account.id)}
                  onOpen={onOpen}
                  opening={openingId === entry.account.id}
                  disabled={busy}
                  canOpenCodex={canOpenCodex}
                  expanded={openDetails.has(entry.account.id)}
                  onToggleDetails={() => toggleDetails(entry.account.id)}
                />
              ))}
            </ol>
          </section>

          <WeekStrip entries={entries} now={now} blurFor={blurFor} />

          <p className="text-sm text-gray-600 dark:text-gray-400">
            Order: ready accounts first, the plan that ends soonest first (router_plan's order). Then the one in
            use, empty ones by when they come back, failed readings, and ended plans.
          </p>
        </>
      )}
    </section>
  );
}

function StatusChip({ status }: { status: UseNextStatus }) {
  const badge = statusBadge(status);
  const tone = CHIP[badge.tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${tone.chip}`}
    >
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${tone.dot}`} />
      {badge.label}
    </span>
  );
}

function ActiveChip() {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-900 ring-1 ring-inset ring-blue-300 dark:bg-blue-900/60 dark:text-blue-100 dark:ring-blue-700">
      Active
    </span>
  );
}

function openLabel(active: boolean, opening: boolean, canOpenCodex: boolean): { label: string; title: string } {
  if (opening) return { label: "Opening...", title: "Opening Codex" };
  if (active) {
    return canOpenCodex
      ? { label: "Open Codex", title: "Open the Codex app on this account" }
      : { label: "Open Codex", title: "Open Codex from the desktop app" };
  }
  return canOpenCodex
    ? { label: "Switch & open", title: "Switch Codex to this account, then open it" }
    : { label: "Switch", title: "Switch Codex to this account" };
}

// Nothing has room: one banner with when Codex is back and which account comes back first.
function EmptyBanner({
  pick,
  now,
  blur,
  onOpen,
  opening,
  disabled,
  canOpenCodex,
}: {
  pick: Extract<HeroPick, { kind: "empty" | "none" }>;
  now: number;
  blur: boolean;
  onOpen: (accountId: string) => void;
  opening: boolean;
  disabled: boolean;
  canOpenCodex: boolean;
}) {
  return (
    <section
      aria-labelledby="use-next-empty-heading"
      className="rounded-2xl border-2 border-red-300 bg-red-50 p-6 text-red-950 dark:border-red-800 dark:bg-red-950/60 dark:text-red-50"
    >
      {pick.kind === "empty" ? (
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="min-w-0">
            <h3 id="use-next-empty-heading" className="text-xl font-semibold">
              Codex is empty until {formatClock(pick.backAt, now, {}, true)}
            </h3>
            <p className="mt-3 text-4xl font-bold">{formatIn(pick.backAt, now)}</p>
            <p className="mt-2 text-base">
              <BlurredText blur={blur}>{pick.entry.account.name}</BlurredText> comes back first.
            </p>
          </div>
          {/* Already the active account: nothing to switch to, and opening Codex on it would not help yet. */}
          {!pick.entry.account.is_active && (
            <button
              type="button"
              onClick={() => onOpen(pick.entry.account.id)}
              disabled={disabled}
              title="Switch to it now, so Codex works the moment it comes back"
              className={SECONDARY_BUTTON}
            >
              {opening ? "Opening..." : canOpenCodex ? "Switch now" : "Switch"}
            </button>
          )}
        </div>
      ) : (
        <>
          <h3 id="use-next-empty-heading" className="text-xl font-semibold">
            No Codex account is ready
          </h3>
          <p className="mt-2 text-base">Refresh to check again, or renew a plan.</p>
        </>
      )}
    </section>
  );
}

function HeroCard({
  pick,
  now,
  blur,
  onOpen,
  opening,
  disabled,
  canOpenCodex,
}: {
  pick: Extract<HeroPick, { kind: "ready" | "keep" }>;
  now: number;
  blur: boolean;
  onOpen: (accountId: string) => void;
  opening: boolean;
  disabled: boolean;
  canOpenCodex: boolean;
}) {
  const { row, account } = pick.entry;
  const style = HERO[pick.kind];
  const active = account.is_active;
  const button = openLabel(active, opening, canOpenCodex);
  const left = row.remaining_percent === null ? NONE : `${Math.round(row.remaining_percent)}%`;

  return (
    <section aria-labelledby="use-next-hero-heading" className={`rounded-2xl border-2 p-6 ${style.box}`}>
      <h3 id="use-next-hero-heading" className={`text-sm font-semibold uppercase tracking-wider ${style.eyebrow}`}>
        {style.title}
      </h3>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <p className="break-words text-2xl font-semibold text-gray-900 dark:text-white">
              <BlurredText blur={blur}>{account.name}</BlurredText>
            </p>
            <StatusChip status={row.status} />
            {active && <ActiveChip />}
          </div>
          <p className="mt-3 flex items-baseline gap-2">
            <span className="text-6xl font-bold tabular-nums text-gray-900 dark:text-white">{left}</span>
            <span className="text-lg text-gray-700 dark:text-gray-300">left</span>
          </p>
          <p className="mt-2 text-base text-gray-700 dark:text-gray-300">{rowLine(pick.entry, now)}</p>
        </div>
        <button
          type="button"
          onClick={() => onOpen(account.id)}
          disabled={disabled || (active && !canOpenCodex)}
          title={button.title}
          className={PRIMARY_BUTTON}
        >
          {button.label}
        </button>
      </div>
    </section>
  );
}

function RefreshRow({
  accounts,
  now,
  onRefresh,
  refreshing,
}: {
  accounts: AccountWithUsage[];
  now: number;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const checked = lastChecked(accounts);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {checked === null
          ? "No usage reading yet"
          : `Updated ${formatAgo(checked, now)} · ${formatClock(checked, now)}`}
      </p>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-busy={refreshing}
        className={SECONDARY_BUTTON}
      >
        <span aria-hidden="true" className={`mr-1.5 ${refreshing ? "inline-block animate-spin" : ""}`}>
          ↻
        </span>
        {refreshing ? "Refreshing..." : "Refresh now"}
      </button>
    </div>
  );
}

function AccountRow({
  entry,
  now,
  blur,
  onOpen,
  opening,
  disabled,
  canOpenCodex,
  expanded,
  onToggleDetails,
}: {
  entry: UseNextEntry;
  now: number;
  blur: boolean;
  onOpen: (accountId: string) => void;
  opening: boolean;
  disabled: boolean;
  canOpenCodex: boolean;
  expanded: boolean;
  onToggleDetails: () => void;
}) {
  const { row, account } = entry;
  const active = account.is_active;
  const button = openLabel(active, opening, canOpenCodex);
  const held = row.status === "expired" || row.status === "no_usage" || row.status === "refresh_failed";
  const line = rowLine(entry, now);
  const detailsId = `use-next-details-${row.position}`;

  return (
    <li className="px-5 py-4" data-status={row.status}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="w-6 text-lg font-semibold tabular-nums text-gray-500 dark:text-gray-400">{row.position}</span>
        <div className="min-w-[12rem] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-words text-base font-semibold text-gray-900 dark:text-gray-100">
              <BlurredText blur={blur}>{account.name}</BlurredText>
            </span>
            <StatusChip status={row.status} />
            {active && <ActiveChip />}
          </div>
          <p className="mt-1 truncate text-sm text-gray-700 dark:text-gray-300" title={line}>
            {line}
          </p>
        </div>
        <p
          className={`w-24 text-right tabular-nums ${held ? "text-gray-500 dark:text-gray-400" : "text-gray-900 dark:text-gray-100"}`}
        >
          {row.remaining_percent === null || held ? (
            <span className="text-2xl font-bold">{NONE}</span>
          ) : (
            <>
              <span className="text-2xl font-bold">{Math.round(row.remaining_percent)}%</span>{" "}
              <span className="text-sm">left</span>
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onOpen(account.id)}
            disabled={disabled || (active && !canOpenCodex)}
            title={button.title}
            className={SECONDARY_BUTTON}
          >
            {button.label}
          </button>
          <button
            type="button"
            onClick={onToggleDetails}
            aria-expanded={expanded}
            aria-controls={detailsId}
            className={`inline-flex items-center gap-1 rounded-lg px-2 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 ${FOCUS}`}
          >
            Details
            <span aria-hidden="true" className={`transition-transform ${expanded ? "rotate-180" : ""}`}>
              ▾
            </span>
          </button>
        </div>
      </div>
      {expanded && <AccountDetails id={detailsId} entry={entry} now={now} blur={blur} />}
    </li>
  );
}

function AccountDetails({ id, entry, now, blur }: { id: string; entry: UseNextEntry; now: number; blur: boolean }) {
  const { row, account } = entry;
  const { short, long } = usageWindows(account.usage);
  const checked = account.usageCheckedAt ?? null;
  const windows = [short, long].filter((window) => window !== null);
  const left = leftText(row);

  return (
    <dl
      id={id}
      className="mt-3 grid gap-x-6 gap-y-1.5 rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-800 sm:ml-10 sm:grid-cols-[8rem_1fr] dark:bg-gray-800/60 dark:text-gray-200"
    >
      {account.email && account.email !== account.name && (
        <>
          <dt className="font-medium text-gray-600 dark:text-gray-400">Email</dt>
          <dd className="break-words">
            <BlurredText blur={blur}>{account.email}</BlurredText>
          </dd>
        </>
      )}
      <dt className="font-medium text-gray-600 dark:text-gray-400">Usage</dt>
      <dd>
        {windows.length === 0 ? (
          NONE
        ) : (
          windows.map((window, index) => (
            <div key={index}>
              {windowUsageText(window)}
              {window.resetsAt !== null && ` · resets ${formatCountdown(window.resetsAt, now)}`}
            </div>
          ))
        )}
        {left && <div>{left} overall</div>}
      </dd>
      <dt className="font-medium text-gray-600 dark:text-gray-400">Plan</dt>
      <dd>{planText(row, now)}</dd>
      <dt className="font-medium text-gray-600 dark:text-gray-400">Checked</dt>
      <dd>{checked === null ? NONE : `${formatAgo(checked, now)} · ${formatClock(checked, now)}`}</dd>
      <dt className="font-medium text-gray-600 dark:text-gray-400">Why here</dt>
      <dd>{whyText(row)}</dd>
    </dl>
  );
}

function WeekStrip({
  entries,
  now,
  blurFor,
}: {
  entries: UseNextEntry[];
  now: number;
  blurFor: (accountId: string) => boolean;
}) {
  const days = useMemo(() => stripDays(now), [now]);
  const events = useMemo(() => entries.map((entry) => stripEvents(entry, days)), [entries, days]);
  const showsMarked = days.some((day) => day.marked);
  const markedCell = "bg-violet-50 dark:bg-violet-950/50";

  return (
    <section
      aria-labelledby="use-next-strip-heading"
      className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="use-next-strip-heading" className="text-base font-semibold text-gray-900 dark:text-gray-100">
          Next {days.length} days
        </h3>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-700 dark:text-gray-300">
          {(Object.keys(STRIP_EVENT) as StripEventKind[]).map((kind) => (
            <span key={kind} className={STRIP_EVENT[kind].className}>
              {STRIP_EVENT[kind].glyph} {STRIP_EVENT[kind].word}
            </span>
          ))}
          {showsMarked && (
            <span className={`rounded px-1.5 ${markedCell} text-violet-900 dark:text-violet-200`}>
              {MARKED_DAYS.label} days
            </span>
          )}
        </p>
      </div>
      {/* relative: keeps the cells' screen-reader labels inside the scroll box instead of widening the page. */}
      <div className="relative mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] table-fixed border-collapse text-xs">
          <caption className="sr-only">
            When each Codex account comes back, has a usage reset, or its plan ends, over the next {days.length} days
          </caption>
          <colgroup>
            <col className="w-44" />
            {days.map((day) => (
              <col key={day.key} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="px-2 py-2 text-left font-medium text-gray-600 dark:text-gray-400">
                Account
              </th>
              {days.map((day) => (
                <th
                  key={day.key}
                  scope="col"
                  className={`px-1 py-2 text-center font-medium ${day.marked ? markedCell : ""} ${
                    day.isToday ? "text-blue-800 dark:text-blue-300" : "text-gray-700 dark:text-gray-300"
                  }`}
                >
                  <div className={day.isToday ? "font-bold" : ""}>{day.isToday ? "Today" : day.weekday}</div>
                  <div>
                    {day.month} {day.day}
                  </div>
                  {day.marked && <div className="font-semibold text-violet-900 dark:text-violet-200">{MARKED_DAYS.label}</div>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr key={entry.account.id} className="border-t border-gray-100 dark:border-gray-800">
                <th
                  scope="row"
                  className="truncate px-2 py-2 text-left font-medium text-gray-900 dark:text-gray-100"
                  title={blurFor(entry.account.id) ? undefined : entry.account.name}
                >
                  <BlurredText blur={blurFor(entry.account.id)}>{entry.account.name}</BlurredText>
                </th>
                {days.map((day) => (
                  <td key={day.key} className={`px-1 py-2 text-center align-top ${day.marked ? markedCell : ""}`}>
                    {(events[index].get(day.key) ?? []).map((event) => (
                      <div key={`${event.kind}-${event.at}`} className={`whitespace-nowrap ${STRIP_EVENT[event.kind].className}`}>
                        <span aria-hidden="true">{STRIP_EVENT[event.kind].glyph} </span>
                        <span className="sr-only">
                          {event.window ? `${event.window} reset` : STRIP_EVENT[event.kind].word} at{" "}
                        </span>
                        {event.time}
                      </div>
                    ))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
