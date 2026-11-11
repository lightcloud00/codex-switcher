/**
 * One pending usage read per account. Callers share the read, but each physical
 * read publishes its result once, as soon as it finishes.
 *
 * Replacing the account list invalidates removed accounts. Clearing it before
 * a reload or unmount also prevents late results from reaching a new login.
 */
export type UsageRefreshResult<T> =
  | { accountId: string; checkedAt: number; ok: true; value: T }
  | { accountId: string; checkedAt: number; ok: false; error: unknown };

export class UsageRefreshSupersededError extends Error {
  constructor() {
    super("Usage refresh was superseded by an account reload");
    this.name = "UsageRefreshSupersededError";
  }
}

export interface UsageRefreshOptions<T> {
  onStart?: (accountId: string) => void;
  onResult: (result: UsageRefreshResult<T>) => void;
  now?: () => number;
}

export function createUsageRefresher<T>(
  read: (accountId: string) => Promise<T>,
  { onStart, onResult, now = Date.now }: UsageRefreshOptions<T>,
) {
  let accountIds = new Set<string>();
  const pending = new Map<string, { token: object; promise: Promise<T> }>();

  function setAccountIds(ids: Iterable<string>) {
    accountIds = new Set(ids);
    for (const id of pending.keys()) {
      if (!accountIds.has(id)) pending.delete(id);
    }
  }

  function refresh(accountId: string): Promise<T> {
    if (!accountIds.has(accountId)) {
      return Promise.reject(new UsageRefreshSupersededError());
    }
    const existing = pending.get(accountId);
    if (existing) return existing.promise;

    const token = {};
    const current = () =>
      accountIds.has(accountId) && pending.get(accountId)?.token === token;
    const promise = Promise.resolve()
      .then(() => {
        if (!current()) throw new UsageRefreshSupersededError();
        return read(accountId);
      })
      .then(
        (value) => {
          if (!current()) throw new UsageRefreshSupersededError();
          onResult({ accountId, checkedAt: now(), ok: true, value });
          return value;
        },
        (error: unknown) => {
          if (!current()) throw new UsageRefreshSupersededError();
          onResult({ accountId, checkedAt: now(), ok: false, error });
          throw error;
        },
      )
      .finally(() => {
        // An invalidated request must not remove its replacement.
        if (current()) pending.delete(accountId);
      });

    pending.set(accountId, { token, promise });
    onStart?.(accountId);
    return promise;
  }

  return { refresh, setAccountIds };
}
