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
