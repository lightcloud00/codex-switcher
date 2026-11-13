import { useEffect, useRef, useState } from "react";
import { invokeBackend, isTauriRuntime } from "../lib/platform";
import { CHECK_LIMITS_MS, failedCheckText, withTimeout } from "../lib/withTimeout.ts";
import { geminiStatusText, tierLine, tierTone, type GeminiQuota } from "../lib/geminiQuota.ts";

const BAR = { good: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500" } as const;

// Gemini CLI quota from its own local sign-in. Desktop only: the LAN web route never reads local login files.
export function GeminiQuotaCard() {
  const [quota, setQuota] = useState<GeminiQuota | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  async function refresh(force: boolean) {
    if (!isTauriRuntime()) return;
    const run = ++latest.current;
    setLoading(true); setError("");
    try {
      const next = await withTimeout(invokeBackend<GeminiQuota>("get_gemini_quota", { force }), CHECK_LIMITS_MS.credits);
      if (run === latest.current) setQuota(next);
    } catch (e) { if (run === latest.current) setError(failedCheckText(e)); } finally { if (run === latest.current) setLoading(false); }
  }
  useEffect(() => { void refresh(false); }, []);
  if (!isTauriRuntime()) return null;
  return <article className="rounded-xl border border-gray-200 p-4 dark:border-gray-700 space-y-3" aria-label="Gemini CLI quota">
    <div className="flex items-center justify-between gap-2">
      <h3 className="font-semibold">Gemini CLI quota</h3>
      <div className="flex items-center gap-2"><span className="text-xs text-gray-500">{geminiStatusText(quota)}</span>
        <button onClick={() => void refresh(true)} disabled={loading} className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50">{loading ? "Checking…" : "Refresh"}</button></div>
    </div>
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
    {quota && quota.state !== "ok" && <p className="text-sm text-amber-700 dark:text-amber-300">{quota.message}</p>}
    {quota?.state === "ok" && <ul className="space-y-2">{quota.tiers.map(t => <li key={t.id}>
      <p className="text-sm">{tierLine(t)}</p>
      <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"><span className={`block h-full rounded-full ${BAR[tierTone(t.percentLeft)]}`} style={{ width: `${Math.max(0, Math.min(100, t.percentLeft))}%` }} /></span>
    </li>)}</ul>}
    <p className="text-xs text-gray-500">Uses the Gemini CLI's own local sign-in. The login is read only for this check and is never shown or saved.</p>
  </article>;
}
