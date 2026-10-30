/** DeepSeek reports amounts as strings; the other providers as numbers. */
export interface ApiCreditBalance {
  currency: string;
  total: string | number;
  granted?: string | number | null;
  topped_up?: string | number | null;
}
/** One provider row of `api-credit-probe`. A failed row carries `error` instead of the balance fields. */
export interface ApiCreditRow {
  id: string;
  label: string;
  /** CredVault logical name; null for treg, whose own CLI holds its sign-in. */
  credential: string | null;
  dashboard: string;
  observed_at: string;
  available?: boolean;
  billing?: string;
  error?: string;
  account_name?: string | null;
  email?: string | null;
  created_at?: string | null;
  rate_limit_tier?: number | null;
  balance?: ApiCreditBalance | null;
  balance_note?: string;
  reset?: string | null;
  reset_note?: string;
  price_windows?: string;
  models?: string[];
  model_count?: number;
  quotas_in_use?: unknown[];
  used_this_month?: number | null;
  in_flight?: number;
}
export interface ApiCreditsSnapshot {
  schema: string;
  observed_at: string;
  providers: ApiCreditRow[];
}
/** Numbers get two decimals and a leading minus ("-$0.20"); provider strings are shown as sent. */
function money(currency: string, amount: string | number): string {
  const negative = typeof amount === "number" && amount < 0;
  const text = typeof amount === "number" ? Math.abs(amount).toFixed(2) : amount;
  return `${negative ? "-" : ""}${currency === "USD" ? `$${text}` : `${currency} ${text}`}`;
}
/** Shows the balance the provider reported, its own note when it has no balance API, and nothing for a failed row. */
export function balanceLine(row: ApiCreditRow): string {
  if (row.error) return "";
  const b = row.balance;
  if (!b) return row.balance_note ?? "";
  const parts = [
    b.granted != null && `granted ${money(b.currency, b.granted)}`,
    b.topped_up != null && `topped up ${money(b.currency, b.topped_up)}`,
  ].filter(Boolean);
  return `${money(b.currency, b.total)} left${parts.length ? ` (${parts.join(" + ")})` : ""}`;
}
/** A row only reads "ready" when the probe saw the account available and no error. */
export function statusLabel(row: ApiCreditRow): string {
  if (row.error) {
    if (row.error === "credential_broker_unavailable") return "CredVault busy, retry";
    if (row.error === "credential_missing") return "key not in CredVault";
    if (row.error === "timeout") return "timed out";
    if (row.error === "http_401" || row.error === "http_403") return "key rejected";
    const http = /^http_(\d+)$/.exec(row.error);
    if (http && http[1].startsWith("5")) return `provider down (${http[1]})`;
    return http ? `provider error ${http[1]}` : "check failed";
  }
  return row.available ? "ready" : "unavailable";
}
export function asOfLabel(observedAt: string, now = new Date()): string {
  const at = new Date(observedAt);
  if (Number.isNaN(at.getTime())) return "time unknown";
  const seconds = (now.getTime() - at.getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return at.toLocaleString();
}
