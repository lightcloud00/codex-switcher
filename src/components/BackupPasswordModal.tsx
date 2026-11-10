import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  describeFileSource,
  exportFullBackupFile,
  importFullBackupFile,
  MIN_BACKUP_PASSWORD_CHARACTERS,
  pickFullBackupFile,
  validateNewBackupPassword,
  type BackupUnlock,
  type FileSource,
} from "../lib/platform";
import type { ImportAccountsSummary } from "../types";

interface BackupPasswordModalProps {
  mode: "export" | "import";
  onClose: () => void;
  onExported: () => void;
  onRestored: (summary: ImportAccountsSummary) => void;
}

const inputClass = "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100";
const secondaryClass = "rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700";

export function BackupPasswordModal({ mode, onClose, onExported, onRestored }: BackupPasswordModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [source, setSource] = useState<FileSource | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creating = mode === "export";
  const disabled = busy || picking;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const chooseFile = async () => {
    setPicking(true);
    setError(null);
    try {
      const selected = await pickFullBackupFile();
      if (selected) setSource(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    const validationError = creating
      ? validateNewBackupPassword(password, confirmation)
      : !source
        ? "Choose a backup file."
        : !legacy && !password.trim() ? "Enter the backup password." : null;
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    setError(null);
    setPassword("");
    setConfirmation("");
    try {
      if (creating) {
        if (await exportFullBackupFile(password)) onExported();
      } else if (source) {
        const unlock: BackupUnlock = legacy ? { kind: "legacy" } : { kind: "password", password };
        onRestored(await importFullBackupFile(source, unlock));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="backup-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!disabled) onClose();
      }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-auto rounded-2xl border border-gray-200 bg-white text-gray-900 shadow-xl backdrop:bg-black/40 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
    >
      <form autoComplete="off" onSubmit={(event) => void submit(event)}>
        <div className="border-b border-gray-100 p-5 dark:border-gray-800">
          <h2 id="backup-dialog-title" className="text-lg font-semibold">
            {creating ? "Export Password-Protected Backup" : "Restore Backup"}
          </h2>
        </div>
        <div className="space-y-4 p-5 text-sm">
          {creating ? (
            <p className="text-gray-600 dark:text-gray-300">
              Use at least {MIN_BACKUP_PASSWORD_CHARACTERS} characters. You’ll need this password to restore the backup.
            </p>
          ) : (
            <>
              <p className="text-gray-600 dark:text-gray-300">
                Only missing accounts will be imported. Existing accounts are kept.
              </p>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => void chooseFile()} disabled={disabled} className={`${secondaryClass} shrink-0`}>
                  Choose File
                </button>
                <span className="min-w-0 break-all" aria-live="polite">{describeFileSource(source)}</span>
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={legacy}
                  disabled={disabled}
                  onChange={(event) => {
                    setLegacy(event.currentTarget.checked);
                    setPassword("");
                    setError(null);
                  }}
                />
                Legacy backup (created without a password)
              </label>
              {legacy && (
                <p className="text-amber-700 dark:text-amber-200">
                  Older backups used a built-in password. After restoring, create a new backup with your own password.
                </p>
              )}
            </>
          )}
          {(creating || !legacy) && (
            <label className="block font-medium">
              Backup password
              <input
                type="password"
                autoComplete="off"
                value={password}
                disabled={disabled}
                onChange={(event) => { setPassword(event.currentTarget.value); setError(null); }}
                className={inputClass}
              />
            </label>
          )}
          {creating && (
            <label className="block font-medium">
              Confirm password
              <input
                type="password"
                autoComplete="off"
                value={confirmation}
                disabled={disabled}
                onChange={(event) => { setConfirmation(event.currentTarget.value); setError(null); }}
                className={inputClass}
              />
            </label>
          )}
          {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
        </div>
        <div className="flex justify-end gap-3 border-t border-gray-100 p-5 dark:border-gray-800">
          <button type="button" disabled={disabled} onClick={onClose} className={secondaryClass}>Cancel</button>
          <button
            type="submit"
            disabled={disabled || (!creating && !source)}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {creating ? (busy ? "Saving…" : "Save Backup") : (busy ? "Restoring…" : "Restore Backup")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
