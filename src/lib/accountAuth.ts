export type AuthFailureKind = "ended" | "expired" | "reused" | "unauthorized";

export interface AuthFailure {
  kind: AuthFailureKind;
  message: string;
}

const AUTH_FAILURE_PATTERN = /\b401\b|\bunauthorized\b|invalid_grant|invalid_token|token_(?:expired|invalidated|revoked)|refresh_token_(?:reused|expired|invalidated)|(?:refresh|authentication) token[^\n]*(?:expired|invalid|revoked|reused)|missing refresh token/i;

// Order matters: "ended" is checked before the others and before the bare 401 match.
const AUTH_FAILURES: { kind: AuthFailureKind; pattern: RegExp; message: string }[] = [
  {
    kind: "ended",
    pattern: /refresh_token_invalidated|token_revoked|token_invalidated|session has ended/i,
    message: "Session ended — you were signed out in Codex or elsewhere. Re-login to renew.",
  },
  {
    kind: "expired",
    pattern: /refresh_token_expired|token_expired/i,
    message: "Session expired. Re-login to renew.",
  },
  {
    kind: "reused",
    pattern: /refresh_token_reused/i,
    message: "This login was renewed by another app. Re-login to renew.",
  },
  {
    kind: "unauthorized",
    pattern: AUTH_FAILURE_PATTERN,
    message: "Your login needs renewing.",
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
