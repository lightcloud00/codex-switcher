import { useEffect, useRef, useState } from "react";
import { invokeBackend, isTauriRuntime, openExternalUrl } from "../lib/platform";
import { asOfLabel, balanceLine, statusLabel, type ApiCreditRow, type ApiCreditsSnapshot } from "../lib/apiCredits";
const EMAIL_HINT = "email not set (add it to ~/.config/codex-switcher/api-accounts.json)";
const BADGE_TONE = { ready: "text-green-700 dark:text-green-300", other: "text-amber-700 dark:text-amber-300" };
// The probe runs CredVault and takes a few seconds, and only the desktop app can start it, so the LAN web route shows a note instead.
export function ApiCreditsPanel() {
  const [data, setData] = useState<ApiCreditsSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  // A newer refresh supersedes an older one; a failed refresh keeps the last cards on screen.
  async function refresh() {
    if (!isTauriRuntime()) return;
    const run = ++latest.current;
    const current = () => run === latest.current;
    setLoading(true); setError("");
    try {
      const next = await invokeBackend<ApiCreditsSnapshot>("get_api_credits");
      if (current()) setData(next);
    } catch(e) { if (current()) setError(String(e)); } finally { if (current()) setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  const desktop = isTauriRuntime();
  return <section aria-label="API credits" className="space-y-5">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">API credits</h2>{desktop && <button onClick={() => void refresh()} disabled={loading} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">{loading ? "Checking…" : "Refresh"}</button>}</div>
    {!desktop && <p className="text-sm text-gray-500">API credits are checked from the desktop app only.</p>}
    {error && <p role="alert" className="text-red-600 dark:text-red-300">{error}</p>}
    {loading && !data && <p role="status" className="text-sm text-gray-500">Checking providers through CredVault…</p>}
    <div className="grid gap-3 md:grid-cols-2">{data?.providers.map(p => <CreditCard key={p.id} row={p} />)}</div>
  </section>;
}
function CreditCard({ row: p }: { row: ApiCreditRow }) {
  const status = statusLabel(p);
  const balance = balanceLine(p);
  return <article className="rounded-xl border border-gray-200 p-4 dark:border-gray-700 space-y-3">
    <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">{p.label}</h3><span className={`rounded-full border px-2 py-0.5 text-xs ${status === "ready" ? BADGE_TONE.ready : BADGE_TONE.other}`}>{status}</span></div>
    {p.email ? <p className="break-all text-sm">{p.email}</p> : <p className="text-xs text-gray-500">{EMAIL_HINT}</p>}
    {p.account_name && <p className="text-sm">{p.account_name}</p>}
    {balance && <p className="text-sm font-medium">{balance}</p>}
    {p.reset_note && <p className="text-xs text-gray-500">{p.reset_note}</p>}
    {p.price_windows && <p className="text-xs text-gray-500">{p.price_windows}</p>}
    {p.rate_limit_tier != null && <p className="text-xs text-gray-500">rate limit tier {p.rate_limit_tier}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-gray-500">as of {asOfLabel(p.observed_at)}</span>
      {p.dashboard?.startsWith("https://") && <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => void openExternalUrl(p.dashboard)}>Open billing</button>}</div>
  </article>;
}
