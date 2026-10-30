export interface PlanDates {
  id: string;
  billingRenewsOn: string | null;
  creditExpiresOn: string | null;
  credentialExpiresOn: string | null;
}
export const PLAN_LABELS: Record<string, string> = {
  "x-subscription": "X Subscription · Grok + Cursor (shared allowance)",
  "anthropic-api": "Anthropic API credits",
  "claude-mac-gustavo": "Claude · Gustavo", "claude-mac-main": "Claude · Main",
  "claude-mac-096": "Claude · 096", "claude-windows": "Claude · Windows", "claude-wsl": "Claude · WSL",
};
/** Date-only expiry has no invented time. Warn from the prior day in the user's time zone. */
export function dateStatus(value: string | null, now = new Date()): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Unknown";
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return "Unknown";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((date.getTime() - today.getTime()) / 86400000);
  return days < 0 ? "Date passed · verify" : days === 0 ? "Due today · verify" : days === 1 ? "Due tomorrow" : days <= 7 ? `Due in ${days} days` : date.toLocaleDateString();
}
export type SignIn = "yes" | "no" | "unknown";
/** Only a positive CLI status reads as signed in; anything the backend could not observe stays unverified. */
export function signInLabel(s: SignIn, checking = false): string {
  return s === "yes" ? "signed in" : s === "no" ? "not signed in" : checking ? "checking sign-in…" : "sign-in unverified";
}
export function dateChanged(value: string | null, saved: string | null): boolean {
  return (value || null) !== (saved || null);
}
/** A date that differs from the saved file shows as unsaved, so a field filled by the OS never looks stored. */
export function pendingDateLabel(value: string | null, saved: string | null, now = new Date()): string {
  const status = dateStatus(value, now);
  return dateChanged(value, saved) ? `Unsaved · ${status}` : status;
}
export function hasUnsavedDates(plans: PlanDates[], saved: PlanDates[]): boolean {
  return plans.some(p => {
    const s = saved.find(x => x.id === p.id);
    return dateChanged(p.billingRenewsOn, s?.billingRenewsOn ?? null)
      || dateChanged(p.creditExpiresOn, s?.creditExpiresOn ?? null)
      || dateChanged(p.credentialExpiresOn, s?.credentialExpiresOn ?? null);
  });
}
export interface PlanView<A extends { plans: PlanDates[] }> {
  data: A | null;
  saved: PlanDates[];
}
/** A refresh replaces the provider status but never discards dates the user typed and has not saved. */
export function mergeRefresh<A extends { plans: PlanDates[] }>(view: PlanView<A>, next: A): PlanView<A> {
  if (view.data && hasUnsavedDates(view.data.plans, view.saved)) return { data: { ...next, plans: view.data.plans }, saved: view.saved };
  return { data: next, saved: next.plans.map(p => ({ ...p })) };
}
