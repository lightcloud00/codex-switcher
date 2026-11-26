export type AuthFailureKind = "ended" | "expired" | "reused" | "unauthorized";

export interface AuthFailure {
  kind: AuthFailureKind;
  message: string;
}

// A failed usage request, expired access token or malformed ID token does not
// establish that the saved refresh grant is unusable. Only terminal renewal
// evidence should send the user through sign-in again.
const AUTH_FAILURES: { kind: AuthFailureKind; pattern: RegExp; message: string }[] = [
  {
    kind: "ended",
    pattern: /\brefresh_token_(?:invalidated|revoked)\b|\bsession has ended\b|Token refresh failed:[\s\S]*\btoken_(?:revoked|invalidated)\b/i,
    message: "This saved sign-in can no longer be renewed. Re-login in Switcher.",
  },
  {
    kind: "expired",
    pattern: /\brefresh_token_expired\b/i,
    message: "This saved sign-in expired. Re-login in Switcher.",
  },
  {
    kind: "reused",
    pattern: /\brefresh_token_reused\b/i,
    message: "This saved sign-in was already renewed. Re-login in Switcher.",
  },
  {
    kind: "unauthorized",
    pattern: /\binvalid_grant\b|\bmissing refresh token\b/i,
    message: "This saved sign-in needs renewal. Re-login in Switcher.",
  },
];

/** Classify a usage/refresh error that only a fresh sign-in can fix, or null for any other error. */
export function describeAuthFailure(error: string | null | undefined): AuthFailure | null {
  if (!error) return null;
  const failure = AUTH_FAILURES.find(({ pattern }) => pattern.test(error));
  return failure ? { kind: failure.kind, message: failure.message } : null;
}

export function needsRelogin(error: string | null | undefined): boolean {
  return describeAuthFailure(error) !== null;
}
