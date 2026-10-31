import { useEffect, useRef, useState } from "react";
import { invokeBackend, isTauriRuntime, openExternalUrl } from "../lib/platform";
import { buildGrokRows } from "../lib/clientStatus";
import { planDatesText } from "../lib/overview";
import { dateChanged, hasUnsavedDates, mergeRefresh, pendingDateLabel, PLAN_LABELS, signInLabel, type PlanDates, type PlanView, type SignIn } from "../lib/providerAccess";
interface Provider { id: string; label: string; installed: boolean; signedIn: SignIn; signInDetail: string; signInCheckedAt: string | null }
interface Access { checkedAt: string; providers: Provider[]; plans: PlanDates[] }
const DETAILS: Record<string, { text: string; command: string; url: string }> = {
  grok: { text: "X Subscription. Grok 4.7 for daily work; Extra High for difficult coding. Coding MCP: grok_code with a project directory.", command: "grok --model grok-4.7", url: "https://grok.com" },
  cursor: { text: "Shares the X weekly allowance with Grok. Composer 2.5 for value; Grok 4.7 Extra High for hard tasks. Other providers may bill separately.", command: "cursor-agent", url: "https://cursor.com" },
  credvault: { text: "Credentials stay in CredVault. Switcher stores plan dates and uses native sign-ins; no API keys or session tokens are imported.", command: "credvault status", url: "https://platform.claude.com/settings/billing" },
};
const SIGN_IN_TONE: Record<SignIn, string> = { yes: "text-green-700 dark:text-green-300", no: "text-amber-700 dark:text-amber-300", unknown: "text-gray-500" };
const copyPlans = (plans: PlanDates[]) => plans.map(p => ({ ...p }));
export function ProviderAccessPanel() {
  const [view, setView] = useState<PlanView<Access>>({ data: null, saved: [] });
  const { data, saved } = view;
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const latest = useRef(0);
  // Dates and installed state come back at once; the slower sign-in probes fill in afterwards. A newer refresh supersedes an older one.
  async function refresh() {
    const run = ++latest.current;
    const current = () => run === latest.current;
    setBusy(true); setChecking(false); setError("");
    try {
      const next = await invokeBackend<Access>("get_provider_access");
      if (!current()) return;
      setView(old => mergeRefresh(old, next));
    } catch(e) { if (current()) setError(String(e)); return; } finally { if (current()) setBusy(false); }
    if (!isTauriRuntime()) return;
    setChecking(true);
    try {
      const { providers } = await invokeBackend<{ providers: Provider[] }>("check_provider_sign_in");
      if (current()) setView(old => old.data ? { ...old, data: { ...old.data, providers } } : old);
    } catch(e) { if (current()) setError(String(e)); } finally { if (current()) setChecking(false); }
  }
  useEffect(() => { void refresh(); }, []);
  function edit(id: string, key: keyof Omit<PlanDates, "id">, value: string) {
    setView(old => old.data ? { ...old, data: { ...old.data, plans: old.data.plans.map(p => p.id === id ? {...p, [key]: value || null} : p) } } : old); setMessage("");
  }
  async function save() { if (!data) return; const plans = data.plans; setBusy(true); setError(""); try { await invokeBackend("save_provider_dates", {plans}); setView(old => ({ ...old, saved: copyPlans(plans) })); setMessage("Dates saved on this computer."); } catch(e) { setError(String(e)); } finally { setBusy(false); } }
  async function launch(id: string) { setError(""); try { await invokeBackend("launch_provider", {provider: id}); setMessage(id === "credvault" ? "CredVault status check completed." : "Opened provider. Tool access depends on its active client and permissions."); } catch(e) { setError(String(e)); } }
  const unsavedDates = !!data && hasUnsavedDates(data.plans, saved);
  // One line per plan that has any date set, shown while the editor is closed.
  const dateSummaries = (data?.plans ?? []).map(p => ({ id: p.id, text: planDatesText(p) })).filter(s => s.text);
  return <section aria-label="Provider access" className="space-y-5">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Providers & plan dates</h2><button onClick={() => void refresh()} disabled={busy || checking} className="rounded-lg border px-3 py-2 text-sm">{busy ? "Refreshing…" : checking ? "Checking sign-in…" : "Refresh local status"}</button></div>
    {error && <p role="alert" className="text-red-600 dark:text-red-300">{error}</p>}
    {message && <p role="status" className="text-sm text-green-700 dark:text-green-300">{message}</p>}
    <div className="grid gap-3 md:grid-cols-3">{data?.providers.map(p => <article key={p.id} className="rounded-xl border border-gray-200 p-4 dark:border-gray-700 space-y-3">
      <h3 className="font-semibold">{p.label}</h3><p className="text-xs text-gray-500">{p.installed ? "CLI found" : "CLI not found in checked locations"} · <span title={p.signInDetail} className={SIGN_IN_TONE[p.signedIn] ?? SIGN_IN_TONE.unknown}>{signInLabel(p.signedIn, checking && p.installed)}</span></p>
      {p.signInDetail && <p className="text-[11px] text-gray-400">{p.signInDetail}</p>}
      <p className="text-sm">{DETAILS[p.id]?.text}</p><code className="block break-all text-xs">{DETAILS[p.id]?.command}</code>
      <div className="flex flex-wrap gap-2">{isTauriRuntime() && <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => void launch(p.id)}>{p.id === "credvault" ? "Check CredVault" : `Open ${p.label}`}</button>}
      {p.id !== "credvault" && <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => void openExternalUrl(DETAILS[p.id].url)}>Account</button>}
      <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => void navigator.clipboard.writeText(DETAILS[p.id].command).then(() => setMessage("CLI command copied.")).catch(() => setError("Clipboard unavailable"))}>Copy CLI</button></div>
    </article>)}</div>
    <div className="space-y-2" aria-label="Grok Bot accounts">
      <h3 className="font-semibold">Grok Bots</h3>
      <p className="text-xs text-gray-500">Bot and computer associations: Fleet Atlas, verified October 30, 2026. These are cloud bots, separate from the Grok CLI. Account identity, sign-in, plan, reset and renewal require a current account check.</p>
      <div className="grid gap-3 md:grid-cols-3">{buildGrokRows([], Date.now()).map(row => <article key={row.id} className="rounded-xl border border-gray-200 p-4 dark:border-gray-700 space-y-1">
        <h4 className="font-semibold">{row.account}</h4><p className="text-sm">{row.detail}</p>
        <p className="text-xs text-gray-500">Usage left: {row.left} · {row.status}</p>
        <p className="text-xs text-gray-500">Plan and renewal: unknown · Reset source unavailable</p>
      </article>)}</div>
      <p className="text-xs text-gray-500">Usage is not checked here. The Overview can show dated manual readings from the optional status helper.</p>
    </div>
    <article className="rounded-xl border border-gray-200 p-4 dark:border-gray-700 space-y-2" aria-label="MiniMax lightcloud007">
      <h3 className="font-semibold">MiniMax · lightcloud007</h3>
      <p className="text-sm">CredVault logical credential: <code className="break-all">minimaxlightcloud007expiressept18th50plan</code>. Switcher does not read or store its value.</p>
      <p className="text-xs text-gray-500">Availability is not checked by Switcher. Verify through the configured client; the name does not establish a renewal or expiry date.</p>
    </article>
    <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700 space-y-3"><h3 className="font-semibold">Renewal & expiry</h3>
      {dateSummaries.length ? <ul className="space-y-1 text-sm">{dateSummaries.map(d => <li key={d.id}><span className="font-medium">{PLAN_LABELS[d.id] ?? d.id}</span> <span className="text-gray-500">· {d.text}</span></li>)}</ul> : <p className="text-sm text-gray-500">No plan dates set.</p>}
      <details><summary className="cursor-pointer text-sm font-medium">Edit plan dates{unsavedDates && <span className="ml-2 text-amber-700 dark:text-amber-300">Unsaved changes</span>}</summary>
      <div className="mt-3 space-y-4">
      <p className="text-sm text-gray-500">Enter dates confirmed in the account. Weekly allowance resets are shown in the Claude tab; a reset does not renew billing. Unknown stays unknown. Dates save locally. Arrow keys on an empty date field fill today; press Clear if unintended.</p>
      {data?.plans.map(p => <fieldset key={p.id} className="border-t border-gray-200 pt-3 dark:border-gray-700"><legend className="pr-2 text-sm font-medium">{PLAN_LABELS[p.id] ?? p.id}</legend><div className="grid gap-3 sm:grid-cols-3">
        {([["billingRenewsOn", "Billing renewal"], ["creditExpiresOn", "Credit expiry"], ["credentialExpiresOn", "Credential expiry"]] as const).map(([key, label]) => {
          const savedValue = saved.find(x => x.id === p.id)?.[key] ?? null;
          const unsaved = dateChanged(p[key], savedValue);
          return <div key={key} className="min-w-0 text-xs text-gray-500">
            <label className="block">{label}<input type="date" aria-label={`${PLAN_LABELS[p.id]} ${label}`} value={p[key] ?? ""} data-empty={p[key] ? undefined : ""} onChange={e => edit(p.id, key, e.target.value)} className="mt-1 block w-full min-w-0 rounded-md border bg-transparent p-2 text-sm text-gray-900 dark:text-gray-100"/></label>
            <div className="mt-1 flex items-center justify-between gap-2"><span className={unsaved ? "text-amber-700 dark:text-amber-300" : ""}>{pendingDateLabel(p[key], savedValue)}</span>
              {p[key] && <button type="button" aria-label={`Clear ${PLAN_LABELS[p.id]} ${label}`} onClick={() => edit(p.id, key, "")} className="rounded border px-1.5 py-0.5">Clear</button>}</div>
          </div>;
        })}
      </div></fieldset>)}<div className="flex items-center gap-3"><button disabled={busy || !data || !unsavedDates} onClick={() => void save()} className="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900">Save dates</button>{unsavedDates && <span className="text-sm text-amber-700 dark:text-amber-300">Unsaved changes</span>}</div>
      </div></details>
    </div>
    {data && <p className="text-xs text-gray-500">Local check: {new Date(data.checkedAt).toLocaleString()}. CLI discovery does not prove model, shell, MCP or file access.</p>}
  </section>;
}
