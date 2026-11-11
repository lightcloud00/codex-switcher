/** Backend commands already have their own deadlines; these are the frontend ceilings that sit just above them. */
export const CHECK_LIMITS_MS = {
  local: 15_000,
  signIn: 25_000,
  clients: 55_000,
  credits: 70_000,
  launch: 15_000,
} as const;

export class CheckTimeoutError extends Error {
  readonly ms: number;
  constructor(ms: number) {
    super(`timed out after ${Math.round(ms / 1000)} s`);
    this.ms = ms;
    this.name = "CheckTimeoutError";
  }
}

/**
 * Rejects with CheckTimeoutError if `work` has not settled within `ms`. The timer is always cleared, and a
 * late result or late rejection of `work` is swallowed so it never becomes an unhandled rejection.
 */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CheckTimeoutError(ms)), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** One short line for a failed check; the detail is the backend's own message or the timeout. */
export function failedCheckText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const detail = raw.replace(/^Error:\s*/, "").trim();
  return detail ? `Couldn't check · ${detail}` : "Couldn't check";
}
