import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type {
  AccountInfo,
  UsageInfo,
  AccountWithUsage,
  WarmupSummary,
} from "../types";
import { invokeBackend, isTauriRuntime, type FileSource } from "../lib/platform";
import { createUsageRefresher } from "../lib/usageRefresh";

export function useAccounts() {
  const [accounts, setAccounts] = useState<AccountWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accountsRef = useRef<AccountWithUsage[]>([]);
  const metadataRefreshInFlightRef = useRef(new Set<string>());
  const accountLoadGenerationRef = useRef(0);
  const maxConcurrentUsageRequests = 10;

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  const buildUsageError = useCallback(
    (accountId: string, message: string, planType: string | null): UsageInfo => ({
      account_id: accountId,
      plan_type: planType,
      primary_used_percent: null,
      primary_window_minutes: null,
      primary_resets_at: null,
      secondary_used_percent: null,
      secondary_window_minutes: null,
      secondary_resets_at: null,
      has_credits: null,
      unlimited_credits: null,
      credits_balance: null,
      error: message,
    }),
    []
  );

  // Native get_usage ingests successful reads; report failures synthesized here.
  const reportUsageToTray = useCallback((usages: UsageInfo[]) => {
    if (!isTauriRuntime() || usages.length === 0) return;
    void invokeBackend("report_usage", { usages }).catch(() => {});
  }, []);

  const usageRefresher = useMemo(
    () => createUsageRefresher<UsageInfo>(
      (accountId) => invokeBackend<UsageInfo>("get_usage", { accountId }),
      {
        onStart: (accountId) => {
          setAccounts((prev) => prev.map((account) =>
            account.id === accountId ? { ...account, usageLoading: true } : account
          ));
        },
        onResult: (result) => {
          const account = accountsRef.current.find((item) => item.id === result.accountId);
          const usage = result.ok
            ? result.value
            : buildUsageError(
                result.accountId,
                result.error instanceof Error ? result.error.message : String(result.error),
                account?.plan_type ?? null,
              );
          if (!result.ok) console.error("Failed to refresh usage:", result.error);
          setAccounts((prev) => prev.map((item) =>
            item.id === result.accountId
              ? { ...item, usage, usageLoading: false, usageCheckedAt: result.checkedAt }
              : item
          ));
          if (!result.ok) reportUsageToTray([usage]);
        },
      },
    ),
    [buildUsageError, reportUsageToTray],
  );

  const runWithConcurrency = useCallback(
    async <T,>(
      items: T[],
      worker: (item: T) => Promise<void>,
      concurrency: number
    ) => {
      if (items.length === 0) return;
      const limit = Math.min(Math.max(concurrency, 1), items.length);
      let index = 0;
      const runners = Array.from({ length: limit }, async () => {
        while (true) {
          const current = index++;
          if (current >= items.length) return;
          await worker(items[current]);
        }
      });
      await Promise.allSettled(runners);
    },
    []
  );

  const loadAccounts = useCallback(async (preserveUsage = false) => {
    const run = ++accountLoadGenerationRef.current;
    if (!preserveUsage) {
      usageRefresher.setAccountIds([]);
      setAccounts((prev) => prev.map((account) => ({ ...account, usageLoading: false })));
    }
    try {
      setLoading(true);
      setError(null);
      const accountList = await invokeBackend<AccountInfo[]>("list_accounts");
      if (run !== accountLoadGenerationRef.current) return accountList;
      usageRefresher.setAccountIds(accountList.map((account) => account.id));
      
      if (preserveUsage) {
        // Preserve existing usage data when just updating account info
        setAccounts((prev) => {
          const usageMap = new Map(
            prev.map((a) => [
              a.id,
              { usage: a.usage, usageLoading: a.usageLoading, usageCheckedAt: a.usageCheckedAt },
            ])
          );
          return accountList.map((a) => ({
            ...a,
            usage: usageMap.get(a.id)?.usage,
            usageLoading: usageMap.get(a.id)?.usageLoading,
            usageCheckedAt: usageMap.get(a.id)?.usageCheckedAt,
          }));
        });
      } else {
        setAccounts(accountList.map((a) => ({ ...a, usageLoading: false })));
      }
      return accountList;
    } catch (err) {
      if (run === accountLoadGenerationRef.current) {
        usageRefresher.setAccountIds(accountsRef.current.map((account) => account.id));
        setError(err instanceof Error ? err.message : String(err));
      }
      return [];
    } finally {
      if (run === accountLoadGenerationRef.current) setLoading(false);
    }
  }, [usageRefresher]);

  const refreshMetadata = useCallback(
    async (
      accountList?: AccountInfo[] | AccountWithUsage[]
    ) => {
      const list = accountList ?? accountsRef.current;
      const dueAccounts = list.filter(
        (account) => !metadataRefreshInFlightRef.current.has(account.id)
      );

      // Mark attempts before starting requests so overlapping refresh cycles
      // cannot issue duplicate metadata calls for the same account.
      dueAccounts.forEach((account) => {
        metadataRefreshInFlightRef.current.add(account.id);
      });

      await runWithConcurrency(
        dueAccounts,
        async (account) => {
          try {
            const metadata = await invokeBackend<AccountInfo>("refresh_account_metadata", {
              accountId: account.id,
            });
            setAccounts((prev) =>
              prev.map((item) =>
                item.id === account.id
                  ? {
                      ...item,
                      plan_type: metadata.plan_type,
                      subscription_expires_at: metadata.subscription_expires_at,
                    }
                  : item
              )
            );
          } catch (err) {
            console.warn("Failed to refresh account metadata:", err);
          } finally {
            metadataRefreshInFlightRef.current.delete(account.id);
          }
        },
        maxConcurrentUsageRequests
      );
    },
    [maxConcurrentUsageRequests, runWithConcurrency]
  );

  const refreshUsage = useCallback(
    async (
      accountList?: AccountInfo[] | AccountWithUsage[],
      options?: { refreshMetadata?: boolean }
    ) => {
      const list = accountList ?? accountsRef.current;
      if (list.length === 0) return;

      // Metadata is independent of usage; each account's usage is published as
      // soon as it settles, even when another account or metadata is slow.
      const metadataPromise = options?.refreshMetadata
        ? refreshMetadata(list)
        : Promise.resolve();
      const accountIds = Array.from(new Set(list.map((account) => account.id)));

      await runWithConcurrency(
        accountIds,
        async (accountId) => {
          try {
            await usageRefresher.refresh(accountId);
          } catch {
            // The shared reader publishes errors once. A removed account or
            // superseded login intentionally publishes nothing.
          }
        },
        maxConcurrentUsageRequests,
      );
      await metadataPromise;
    },
    [maxConcurrentUsageRequests, refreshMetadata, runWithConcurrency, usageRefresher],
  );

  const refreshSingleUsage = useCallback(async (
    accountId: string,
    options?: { refreshMetadata?: boolean }
  ) => {
    const account = accountsRef.current.find((item) => item.id === accountId);
    const metadataPromise = options?.refreshMetadata && account
      ? refreshMetadata([account])
      : Promise.resolve();

    const usage = await usageRefresher.refresh(accountId);
    await metadataPromise;
    return usage;
  }, [refreshMetadata, usageRefresher]);

  const warmupAccount = useCallback(async (accountId: string) => {
    try {
      await invokeBackend("warmup_account", { accountId });
    } catch (err) {
      console.error("Failed to warm up account:", err);
      throw err;
    }
  }, []);

  const warmupAllAccounts = useCallback(async () => {
    try {
      return await invokeBackend<WarmupSummary>("warmup_all_accounts");
    } catch (err) {
      console.error("Failed to warm up all accounts:", err);
      throw err;
    }
  }, []);

  const switchAccount = useCallback(
    async (accountId: string) => {
      try {
        await invokeBackend("switch_account", { accountId });
        await loadAccounts(true); // Preserve usage data
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const deleteAccount = useCallback(
    async (accountId: string) => {
      try {
        await invokeBackend("delete_account", { accountId });
        // Account activation can change while deletion is in flight. Re-read
        // backend metadata without discarding the latest cached usage.
        await loadAccounts(true);
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const renameAccount = useCallback(
    async (accountId: string, newName: string) => {
      try {
        await invokeBackend("rename_account", { accountId, newName });
        await loadAccounts(true); // Preserve usage data
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const importFromFile = useCallback(
    async (source: FileSource, name: string) => {
      try {
        if (typeof source === "string") {
          await invokeBackend<AccountInfo>("add_account_from_file", { path: source, name });
        } else {
          const contents = await source.text();
          await invokeBackend<AccountInfo>("add_account_from_auth_json_text", {
            name,
            contents,
          });
        }
        const accountList = await loadAccounts();
        await refreshUsage(accountList);
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage]
  );

  const startOAuthLogin = useCallback(async (accountName: string, reauthAccountId?: string) => {
    try {
      const info = await invokeBackend<{ auth_url: string; callback_port: number }>(
        "start_login",
        { accountName, reauthAccountId }
      );
      return info;
    } catch (err) {
      throw err;
    }
  }, []);

  const completeOAuthLogin = useCallback(async () => {
    try {
      const account = await invokeBackend<AccountInfo>("complete_login");
      const accountList = await loadAccounts();
      // Do not hold the dialog on usage calls: refresh in the background,
      // the new account first.
      const ordered = [
        ...accountList.filter((item) => item.id === account.id),
        ...accountList.filter((item) => item.id !== account.id),
      ];
      void refreshUsage(ordered).catch(() => {});
      return account;
    } catch (err) {
      throw err;
    }
  }, [loadAccounts, refreshUsage]);

  const cancelOAuthLogin = useCallback(async () => {
    try {
      await invokeBackend("cancel_login");
    } catch (err) {
      console.error("Failed to cancel login:", err);
      throw err;
    }
  }, []);

  const loadMaskedAccountIds = useCallback(async () => {
    try {
      return await invokeBackend<string[]>("get_masked_account_ids");
    } catch (err) {
      console.error("Failed to load masked account IDs:", err);
      return [];
    }
  }, []);

  const saveMaskedAccountIds = useCallback(async (ids: string[]) => {
    try {
      await invokeBackend("set_masked_account_ids", { ids });
    } catch (err) {
      console.error("Failed to save masked account IDs:", err);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    loadAccounts().then((accountList) => {
      if (disposed) return;
      void refreshUsage(accountList);
      // Populate live expiry immediately. The native background process keeps
      // its cache current while a desktop webview is hidden or suspended.
      void refreshMetadata(accountList);
    });
    
    // Auto-refresh usage every 60 seconds (same as official Codex CLI)
    const usageInterval = setInterval(() => {
      refreshUsage().catch(() => {});
    }, 60000);

    const metadataInterval = !isTauriRuntime()
      ? setInterval(() => {
          refreshMetadata().catch(() => {});
        }, 6 * 60 * 60 * 1000)
      : undefined;
    
    return () => {
      disposed = true;
      ++accountLoadGenerationRef.current;
      usageRefresher.setAccountIds([]);
      clearInterval(usageInterval);
      if (metadataInterval !== undefined) clearInterval(metadataInterval);
    };
  }, [loadAccounts, refreshMetadata, refreshUsage, usageRefresher]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      if (!("__TAURI_INTERNALS__" in window)) return;
      const { listen } = await import("@tauri-apps/api/event");
      if (disposed) return;
      const stop = await listen("accounts-changed", () => {
        if (!disposed) void loadAccounts(true);
      });
      if (disposed) stop();
      else unlisten = stop;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadAccounts]);

  return {
    accounts,
    loading,
    error,
    loadAccounts,
    refreshUsage,
    refreshSingleUsage,
    warmupAccount,
    warmupAllAccounts,
    switchAccount,
    deleteAccount,
    renameAccount,
    importFromFile,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
  };
}
