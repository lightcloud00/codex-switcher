import { useEffect, useState } from "react";
import { invokeBackend, isTauriRuntime, openExternalUrl } from "../lib/platform";
import { dateStatus, PLAN_LABELS, type PlanDates } from "../lib/providerAccess";
interface Provider { id: string; label: string; installed: boolean; authentication: string }
interface Access { checkedAt: string; providers: Provider[]; plans: PlanDates[] }
const DETAILS: Record<string, { text: string; command: string; url: string }> = {
  grok: { text: "X Subscription. Grok 4.7 for daily work; Extra High for difficult coding. Coding MCP: grok_code with a project directory.", command: "grok --model grok-4.7", url: "https://grok.com" },
  cursor: { text: "Shares the X weekly allowance with Grok. Composer 2.5 for value; Grok 4.7 Extra High for hard tasks. Other providers may bill separately.", command: "cursor-agent", url: "https://cursor.com" },
  credvault: { text: "Credentials stay in CredVault. Switcher stores plan dates and uses native sign-ins; no API keys or session tokens are imported.", command: "credvault status", url: "https://platform.claude.com/settings/billing" },
};
export function ProviderAccessPanel() {
  const [data, setData] = useState<Access | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() { setBusy(true); setError(""); try { setData(await invokeBackend<Access>("get_provider_access")); } catch(e) { setError(String(e)); } finally { setBusy(false); } }
  useEffect(() => { void refresh(); }, []);
  function edit(id: string, key: keyof Omit<PlanDates, "id">, value: string) {
    setData(old => old && ({...old, plans: old.plans.map(p => p.id === id ? {...p, [key]: value || null} : p)})); setMessage("");
  }
  async function save() { if (!data) return; setBusy(true); setError(""); try { await invokeBackend("save_provider_dates", {plans: data.plans}); setMessage("Dates saved on this computer."); } catch(e) { setError(String(e)); } finally { setBusy(false); } }
  async function launch(id: string) { setError(""); try { await invokeBackend("launch_provider", {provider: id}); setMessage(id === "credvault" ? "CredVault status check completed." : "Opened provider. Tool access depends on its active client and permissions."); } catch(e) { setError(String(e)); } }
  return <section aria-label="Provider access" className="space-y-5">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Providers & plan dates</h2><button onClick={() => void refresh()} disabled={busy} className="rounded-lg border px-3 py-2 text-sm">{busy ? "Checking…" : "Refresh local status"}</button></div>
    {error && <p role="alert" className="text-red-600 dark:text-red-300">{error}</p>}
    {message && <p role="status" className="text-sm text-green-700 dark:text-green-300">{message}</p>}
    <div className="grid gap-3 md:grid-cols-3">{data?.providers.map(p => <article key={p.id} className="rounded-xl border border-gray-200 p-4 dark:border-gray-700 space-y-3">
      <h3 className="font-semibold">{p.label}</h3><p className="text-xs text-gray-500">{p.installed ? "CLI found" : "CLI not found in checked locations"} · sign-in unverified</p>
      <p className="text-sm">{DETAILS[p.id]?.text}</p><code className="block break-all text-xs">{DETAILS[p.id]?.command}</code>
      <div className="flex flex-wrap gap-2">{isTauriRuntime() && <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => void launch(p.id)}>{p.id === "credvault" ? "Check CredVault" : `Open ${p.label}`}</button>}
      {p.id !== "credvault" && <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => void openExternalUrl(DETAILS[p.id].url)}>Account</button>}
      <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => void navigator.clipboard.writeText(DETAILS[p.id].command).then(() => setMessage("CLI command copied.")).catch(() => setError("Clipboard unavailable"))}>Copy CLI</button></div>
    </article>)}</div>
    <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700 space-y-4"><h3 className="font-semibold">Renewal & expiry</h3>
      <p className="text-sm text-gray-500">Enter dates confirmed in the account. Weekly allowance resets are shown in the Claude tab; a reset does not renew billing. Unknown stays unknown. Dates save locally.</p>
      {data?.plans.map(p => <fieldset key={p.id} className="border-t border-gray-200 pt-3 dark:border-gray-700"><legend className="pr-2 text-sm font-medium">{PLAN_LABELS[p.id] ?? p.id}</legend><div className="grid gap-3 sm:grid-cols-3">
        {([["billingRenewsOn", "Billing renewal"], ["creditExpiresOn", "Credit expiry"], ["credentialExpiresOn", "Credential expiry"]] as const).map(([key, label]) => <label key={key} className="min-w-0 text-xs text-gray-500">{label}<input type="date" aria-label={`${PLAN_LABELS[p.id]} ${label}`} value={p[key] ?? ""} onChange={e => edit(p.id, key, e.target.value)} className="mt-1 block w-full min-w-0 rounded-md border bg-transparent p-2 text-sm text-gray-900 dark:text-gray-100"/><span className="mt-1 block">{dateStatus(p[key])}</span></label>)}
      </div></fieldset>)}<button disabled={busy || !data} onClick={() => void save()} className="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white dark:bg-gray-100 dark:text-gray-900">Save dates</button>
    </div>
    {data && <p className="text-xs text-gray-500">Local check: {new Date(data.checkedAt).toLocaleString()}. CLI discovery does not prove model, shell, MCP or file access.</p>}
  </section>;
}
