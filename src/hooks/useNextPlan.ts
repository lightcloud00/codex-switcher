import { useEffect, useMemo, useRef, useState } from "react";
import { invokeBackend } from "../lib/platform";
import { planInputKey, usagesForPlan } from "../lib/nextAccounts";
import type { AccountWithUsage, UseNextPlan } from "../types";

const RANK_DEBOUNCE_MS = 400;

/**
 * The Use next order for the accounts the window already loaded. It asks the backend again only when a
 * reading, the active account or a plan date changes, and makes no usage calls of its own.
 */
export function useNextPlan(accounts: AccountWithUsage[]): { plan: UseNextPlan | null; error: string } {
  const [plan, setPlan] = useState<UseNextPlan | null>(null);
  const [error, setError] = useState("");
  const latest = useRef(0);
  const ranked = useRef(false);
  const inputKey = useMemo(() => planInputKey(accounts), [accounts]);
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  // A refresh lands account by account, so after the first plan a short wait turns that burst into one call.
  // Before the first reading comes back every account would rank as "no reading", so it waits for one.
  useEffect(() => {
    if (usagesForPlan(accountsRef.current).length === 0) return;
    const run = ++latest.current;
    const timer = setTimeout(() => {
      invokeBackend<UseNextPlan>("get_use_next_plan", { usages: usagesForPlan(accountsRef.current) })
        .then((next) => {
          if (run !== latest.current) return;
          ranked.current = true;
          setPlan(next);
          setError("");
        })
        .catch((err) => {
          if (run !== latest.current) return;
          setError(err instanceof Error ? err.message : String(err));
        });
    }, ranked.current ? RANK_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [inputKey]);

  return { plan, error };
}
