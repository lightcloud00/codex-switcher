import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseBackupFiles,
  exportFullBackupFile,
  importFullBackupFile,
  validateNewBackupPassword,
} from "../src/lib/platform.ts";

function withBrowser(hostname: string, protocol = "http:"): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { protocol, hostname }, btoa: globalThis.btoa, atob: globalThis.atob },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

test("export requires a meaningful password and exact confirmation", () => {
  assert.match(validateNewBackupPassword("too short", "too short") ?? "", /12 characters/);
  assert.match(validateNewBackupPassword(" ".repeat(12), " ".repeat(12)) ?? "", /12 characters/);
  assert.match(validateNewBackupPassword("  long password  ", "long password") ?? "", /match/);
  assert.equal(validateNewBackupPassword("🦊".repeat(12), "🦊".repeat(12)), null);
  assert.match(validateNewBackupPassword("🦊".repeat(257), "🦊".repeat(257)) ?? "", /too long/);
});

test("the browser forwards the exact password or the separate legacy choice", async (t) => {
  t.after(withBrowser("localhost"));
  const requests: { path: string; body: unknown }[] = [];
  const response = { imported_count: 1, skipped_count: 0, total_in_payload: 1 };
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    requests.push({ path, body: JSON.parse(String(init.body)) });
    return Response.json(response);
  });

  const fixture = new File([new Uint8Array([0x43, 0x53, 0x57, 0x46, 2])], "fixture.cswf");
  const password = "  fixture password 🦊  ";
  assert.deepEqual(await importFullBackupFile(fixture, { kind: "password", password }), response);
  assert.deepEqual(await importFullBackupFile(fixture, { kind: "legacy" }), response);
  assert.deepEqual(requests, [
    {
      path: "/api/invoke/import_accounts_full_encrypted_bytes",
      body: { contentsBase64: "Q1NXRgI=", unlock: { kind: "password", password } },
    },
    {
      path: "/api/invoke/import_accounts_full_encrypted_bytes",
      body: { contentsBase64: "Q1NXRgI=", unlock: { kind: "legacy" } },
    },
  ]);
});

test("browser export posts the chosen password and downloads encrypted bytes", async (t) => {
  t.after(withBrowser("127.0.0.1"));
  const password = "  fixture password 🦊  ";
  const fixture = new Uint8Array([0x43, 0x53, 0x57, 0x46, 2]);
  const fetchMock = t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    assert.equal(path, "/api/invoke/export_accounts_full_encrypted_bytes");
    assert.deepEqual(JSON.parse(String(init.body)), { password });
    return Response.json("Q1NXRgI=");
  });
  const click = t.mock.fn();
  const link = { click, style: {}, href: "", download: "" };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => link,
      body: { appendChild() {}, removeChild() {} },
    },
  });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const objectUrl = t.mock.method(URL, "createObjectURL", () => "blob:fixture");

  assert.equal(await exportFullBackupFile(password), true);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(click.mock.callCount(), 1);
  assert.equal(link.download, "codex-switcher-full.cswf");
  const blob = objectUrl.mock.calls[0].arguments[0] as Blob;
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), fixture);
});

test("LAN pages refuse both backup operations before sending a password", async (t) => {
  t.after(withBrowser("192.0.2.1"));
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(null));
  assert.equal(canUseBackupFiles(), false);
  await assert.rejects(exportFullBackupFile("fixture password"), /local browser/);
  await assert.rejects(importFullBackupFile(new File([], "fixture.cswf"), { kind: "legacy" }), /local browser/);
  assert.equal(fetchMock.mock.callCount(), 0);
});
