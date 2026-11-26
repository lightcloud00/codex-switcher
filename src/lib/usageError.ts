import { needsRelogin } from "./accountAuth.ts";

export { needsRelogin } from "./accountAuth.ts";

/** Use only messages emitted by the upstream token refresh and usage backends. */
export function formatUsageError(error: string): { title: string; message: string } {
  if (needsRelogin(error)) {
    return {
      title: "Switcher sign-in needs renewal",
      message: "Use Re-login on this account in Switcher to renew the saved sign-in; other apps may still be signed in.",
    };
  }
  if (/\b429\b|too many requests/i.test(error)) {
    return {
      title: "Rate limited, try again later",
      message: "The usage service is limiting requests. Your saved login is not necessarily invalid.",
    };
  }
  if (/failed to parse usage response/i.test(error)) {
    return {
      title: "Usage format changed",
      message: "The account may still be signed in, but Switcher could not read the usage response.",
    };
  }
  if (/error sending request|operation timed out|connection refused|dns error|token refresh returned an invalid or expired id_token|refresh response did not include id_token|failed to parse token refresh response|\b401\b|\bunauthorized\b|\binvalid_token\b|\btoken_(?:expired|revoked|invalidated)\b/i.test(error)) {
    return {
      title: "Usage check unsuccessful",
      message: "This request failed without proving that the saved login is invalid. Retry before re-authenticating.",
    };
  }
  return { title: "Usage unavailable", message: error };
}
