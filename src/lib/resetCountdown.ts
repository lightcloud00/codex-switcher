// Time left until a usage window resets, e.g. "45s", "12m", "4h 55m", "4d 18h" or "now".
// Null when the reset time is unknown. Same wording as the native menu (src-tauri/src/tray.rs).
export function formatResetCountdown(
  resetAt: number | null | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string | null {
  if (!resetAt) return null;

  const diff = resetAt - nowSeconds;
  if (diff <= 0) return "now";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86_400) {
    return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  }
  return `${Math.floor(diff / 86_400)}d ${Math.floor((diff % 86_400) / 3600)}h`;
}
