import { useState } from "react";
import type { ClaudeSeat } from "../types";
import type { PlanDates } from "../lib/providerAccess";
import { invokeBackend } from "../lib/platform";
import { BlurredText } from "./AccountCard";

const fieldClass = "w-full rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-700 dark:bg-gray-900";
const blank = (id: string): PlanDates => ({ id, billingRenewsOn: null, creditExpiresOn: null, credentialExpiresOn: null });

export function ClaudeAccountManager({ seats, hidden, plans, masked, onChange, onClose }: {
  seats: ClaudeSeat[]; hidden: string[]; plans: PlanDates[]; masked: boolean;
  onChange: () => Promise<void>; onClose: () => void;
}) {
  const [editing, setEditing] = useState<PlanDates | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const entries = [...seats.map(s => ({ id: s.id, title: s.email || s.id })),
    ...hidden.filter(id => !seats.some(s => s.id === id)).map(id => ({ id, title: id }))];
  const perform = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await action();
      await onChange();
      window.dispatchEvent(new Event("claude-seats-changed"));
      setNotice(message);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <section aria-label="Manage Claude accounts" className="rounded-2xl border border-gray-200 p-4 dark:border-gray-700">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h3 className="font-semibold">Manage accounts</h3>
      <button onClick={onClose} disabled={busy} className="rounded-lg border px-3 py-1 text-sm">Done</button>
    </div>
    <p className="mb-3 text-xs text-gray-500">Archive hides an account from Switcher and its capacity feed. It keeps the login and subscription.</p>
    {error && <p role="alert" className="mb-2 text-sm text-red-600">{error}</p>}
    {notice && <p role="status" className="mb-2 text-sm text-emerald-700">{notice}</p>}
    <div className="space-y-3">{entries.map(entry => {
      const archived = hidden.includes(entry.id);
      const plan = plans.find(p => p.id === entry.id);
      return <div key={entry.id} className="rounded-xl border border-gray-200 p-3 dark:border-gray-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 break-all text-sm font-medium"><BlurredText blur={masked}>{entry.title}</BlurredText>{archived && <span className="ml-2 text-xs text-gray-500">Archived</span>}</div>
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => setEditing({ ...blank(entry.id), ...plan })} className="rounded-lg border px-3 py-1 text-xs">Edit dates</button>
            <button disabled={busy} onClick={() => void perform(() => invokeBackend("set_claude_seat_archived", { id: entry.id, archived: !archived }), archived ? "Account restored." : "Account archived.")} className="rounded-lg border px-3 py-1 text-xs">{archived ? "Restore" : "Archive"}</button>
          </div>
        </div>
        <p className="mt-1 text-xs text-gray-500">{plan?.billingInterval && plan.billingInterval !== "unknown" ? `${plan.billingInterval} billing · ` : ""}Last verified: {plan?.lastVerifiedOn || "Not recorded"}{plan?.evidenceSource ? ` · ${plan.evidenceSource}` : ""}</p>
        {editing?.id === entry.id && <form className="mt-4 space-y-3" onSubmit={e => { e.preventDefault(); void perform(() => invokeBackend("update_provider_plan", { plan: editing }), "Account dates saved."); }}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="text-xs">Billing interval<select className={fieldClass} value={editing.billingInterval || "unknown"} onChange={e => setEditing({ ...editing, billingInterval: e.target.value as PlanDates["billingInterval"] })}><option value="unknown">Not verified</option><option value="monthly">Monthly</option><option value="annual">Annual</option><option value="none">Free / no paid subscription</option></select></label>
            <label className="text-xs">Renewal date<input type="date" className={fieldClass} value={editing.billingRenewsOn || ""} onChange={e => setEditing({ ...editing, billingRenewsOn: e.target.value || null })} /></label>
            <label className="text-xs">Subscription ends<input type="date" className={fieldClass} value={editing.subscriptionExpiresOn || ""} onChange={e => setEditing({ ...editing, subscriptionExpiresOn: e.target.value || null })} /></label>
            <label className="text-xs">Last verified<input type="date" className={fieldClass} value={editing.lastVerifiedOn || ""} onChange={e => setEditing({ ...editing, lastVerifiedOn: e.target.value || null })} /></label>
          </div>
          <label className="block text-xs">Evidence source<input maxLength={160} placeholder="For example: Claude billing page or App Store receipt" className={fieldClass} value={editing.evidenceSource || ""} onChange={e => setEditing({ ...editing, evidenceSource: e.target.value || null })} /></label>
          <p className="text-xs text-gray-500">A date is labeled confirmed only when you record its source and verification date. Subscription-start estimates stay separate.</p>
          <div className="flex gap-2"><button disabled={busy} type="submit" className="rounded-lg bg-gray-900 px-3 py-2 text-sm text-white dark:bg-gray-700">{busy ? "Saving…" : "Save dates"}</button><button disabled={busy} type="button" onClick={() => setEditing(null)} className="rounded-lg border px-3 py-2 text-sm">Cancel</button></div>
        </form>}
      </div>;
    })}</div>
  </section>;
}
