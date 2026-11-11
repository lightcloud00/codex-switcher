import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeBackend } from "../lib/platform";
import { withSeatSubscriptions, type SeatSubscriptions } from "../lib/claudeSubscription";
import type { PlanDates } from "../lib/providerAccess";
import type { ClaudePromSnapshot, ClaudeSeatRegistry, ClaudeUsageSummary } from "../types";

const REFRESH_MS = 60_000;

interface Loaded {
  at: number;
  summary: ClaudeUsageSummary | null;
  registry: ClaudeSeatRegistry | null;
  registryError: boolean;
  prom: ClaudePromSnapshot | null | undefined;
  saved: PlanDates[];
  overlay: SeatSubscriptions | null;
}

// The last answer, shared by every tab that shows Claude seats: a tab switch draws it at once while a fresh
// load runs, instead of an empty "Checking..." for as long as claude-usage takes.
let lastLoaded: Loaded | null = null;

export interface ClaudeSources {
  summary: ClaudeUsageSummary | null;
  registry: ClaudeSeatRegistry | null;
  /** The last registry read failed; `registry` keeps the previous answer (and its hidden seats). */
  registryError: boolean;
  /** undefined until the first answer; null when the Prometheus call itself failed. */
  prom: ClaudePromSnapshot | null | undefined;
  /** Dates saved under Providers, with seat end dates from the fleet seat file where none is saved. Display only. */
  plans: PlanDates[];
  loading: boolean;
  /** Time of the last finished load (0 before the first), so a clock can follow the data. */
  loadedAt: number;
  reload: () => Promise<void>;
}

/**
 * Claude seats, their saved plan dates and the fleet seat file, refreshed every minute and whenever the
 * Claude tab changes a seat. Each source is optional on its own: a failed one leaves the rest in place.
 */
export function useClaudeSources(): ClaudeSources {
  const [summary, setSummary] = useState<ClaudeUsageSummary | null>(() => lastLoaded?.summary ?? null);
  const [registry, setRegistry] = useState<ClaudeSeatRegistry | null>(() => lastLoaded?.registry ?? null);
  const [registryError, setRegistryError] = useState(() => lastLoaded?.registryError ?? false);
  const [prom, setProm] = useState<ClaudePromSnapshot | null | undefined>(() => lastLoaded?.prom);
  const [saved, setSaved] = useState<PlanDates[]>(() => lastLoaded?.saved ?? []);
  const [overlay, setOverlay] = useState<SeatSubscriptions | null>(() => lastLoaded?.overlay ?? null);
  const [loading, setLoading] = useState(() => lastLoaded === null);
  const [loadedAt, setLoadedAt] = useState(() => lastLoaded?.at ?? 0);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const run = ++latest.current;
    setLoading(true);
    const [usage, seatResult, snapshot, access, seatFile] = await Promise.all([
      invokeBackend<ClaudeUsageSummary>("get_claude_usage").catch(() => null),
      invokeBackend<ClaudeSeatRegistry>("get_claude_seats")
        .then((value) => ({ value, error: false }))
        .catch(() => ({ value: null, error: true })),
      invokeBackend<ClaudePromSnapshot>("get_claude_prometheus").catch(() => null),
      invokeBackend<{ plans: PlanDates[] }>("get_provider_access").catch(() => null),
      invokeBackend<SeatSubscriptions>("get_claude_seat_subscriptions").catch(() => null),
    ]);
    if (run !== latest.current) return;
    const prior = lastLoaded;
    // A failed source keeps its previous answer; a failed registry read keeps the hidden seats hidden.
    const next: Loaded = {
      at: Date.now(),
      summary: usage ?? prior?.summary ?? null,
      registry: seatResult.value ?? prior?.registry ?? null,
      registryError: seatResult.error,
      prom: snapshot,
      saved: access?.plans ?? prior?.saved ?? [],
      overlay: seatFile ?? prior?.overlay ?? null,
    };
    lastLoaded = next;
    setSummary(next.summary);
    setRegistryError(next.registryError);
    setRegistry(next.registry);
    setProm(next.prom);
    setSaved(next.saved);
    setOverlay(next.overlay);
    setLoading(false);
    setLoadedAt(next.at);
  }, []);

  useEffect(() => {
    void reload();
    const id = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [reload]);

  useEffect(() => {
    const refresh = () => void reload();
    window.addEventListener("claude-seats-changed", refresh);
    return () => window.removeEventListener("claude-seats-changed", refresh);
  }, [reload]);

  const plans = useMemo(() => withSeatSubscriptions(saved, overlay), [saved, overlay]);
  return { summary, registry, registryError, prom, plans, loading, loadedAt, reload };
}
