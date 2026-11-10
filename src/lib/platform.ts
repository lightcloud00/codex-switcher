import type { ImportAccountsSummary } from "../types";

export type FileSource = string | File;

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function invokeBackend<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }

  const response = await fetch(`/api/invoke/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

export async function pickAuthJsonFile(): Promise<FileSource | null> {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
      title: "Select auth.json file",
    });

    if (!selected || Array.isArray(selected)) return null;
    return selected;
  }

  return pickBrowserFile(".json,application/json");
}

export const MIN_BACKUP_PASSWORD_CHARACTERS = 12;
const MAX_BACKUP_PASSWORD_BYTES = 1024;
const MAX_BACKUP_FILE_BYTES = 8 * 1024 * 1024;

export type BackupUnlock = { kind: "password"; password: string } | { kind: "legacy" };

export function canUseBackupFiles(): boolean {
  if (isTauriRuntime()) return true;
  if (typeof window === "undefined") return false;
  const { protocol, hostname } = window.location;
  return (protocol === "http:" || protocol === "https:") &&
    ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

function requireLocalBackup(): void {
  if (!canUseBackupFiles()) {
    throw new Error("Open the desktop app or a local browser to use backups.");
  }
}

export function validateNewBackupPassword(password: string, confirmation: string): string | null {
  if (!password.trim() || Array.from(password).length < MIN_BACKUP_PASSWORD_CHARACTERS) {
    return `Use at least ${MIN_BACKUP_PASSWORD_CHARACTERS} characters for the password.`;
  }
  if (new TextEncoder().encode(password).length > MAX_BACKUP_PASSWORD_BYTES) {
    return "The backup password is too long.";
  }
  if (password !== confirmation) return "The passwords don’t match.";
  return null;
}

export async function exportFullBackupFile(password: string): Promise<boolean> {
  requireLocalBackup();
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const selected = await save({
      title: "Save Password-Protected Backup",
      defaultPath: "codex-switcher-full.cswf",
      filters: [{ name: "Codex Switcher Full Backup", extensions: ["cswf"] }],
    });

    if (!selected) return false;
    await invokeBackend("export_accounts_full_encrypted_file", { path: selected, password });
    return true;
  }

  const contentsBase64 = await invokeBackend<string>("export_accounts_full_encrypted_bytes", {
    password,
  });
  downloadBase64File(
    contentsBase64,
    "codex-switcher-full.cswf",
    "application/octet-stream"
  );
  return true;
}

export async function pickFullBackupFile(): Promise<FileSource | null> {
  requireLocalBackup();
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      title: "Choose Account Backup",
      filters: [{ name: "Codex Switcher Full Backup", extensions: ["cswf"] }],
    });

    return typeof selected === "string" ? selected : null;
  }

  return pickBrowserFile(".cswf,application/octet-stream");
}

export async function importFullBackupFile(
  source: FileSource,
  unlock: BackupUnlock,
): Promise<ImportAccountsSummary> {
  requireLocalBackup();
  if (typeof source === "string") {
    if (!isTauriRuntime()) throw new Error("Choose a backup file to restore.");
    return invokeBackend<ImportAccountsSummary>("import_accounts_full_encrypted_file", {
      path: source,
      unlock,
    });
  }

  if (source.size > MAX_BACKUP_FILE_BYTES) throw new Error("The backup file is too large.");
  const contentsBase64 = await fileToBase64(source);
  return invokeBackend<ImportAccountsSummary>("import_accounts_full_encrypted_bytes", {
    contentsBase64,
    unlock,
  });
}

export function describeFileSource(source: FileSource | null): string {
  if (!source) return "No file selected";
  return typeof source === "string" ? source : source.name;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x8000) {
    const chunk = bytes.subarray(index, index + 0x8000);
    binary += String.fromCharCode(...chunk);
  }

  return window.btoa(binary);
}

function downloadBase64File(
  base64: string,
  fileName: string,
  mimeType: string
): void {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function pickBrowserFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;

    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", handleWindowFocus);
      input.remove();
      resolve(file);
    };

    const handleWindowFocus = () => {
      window.setTimeout(() => {
        finish(input.files?.[0] ?? null);
      }, 0);
    };

    input.addEventListener(
      "change",
      () => {
        finish(input.files?.[0] ?? null);
      },
      { once: true }
    );

    document.body.appendChild(input);
    window.addEventListener("focus", handleWindowFocus, { once: true });
    input.click();
  });
}

async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}
