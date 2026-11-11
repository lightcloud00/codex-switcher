export interface BuildInfo {
  version: string;
  commit: string | null;
  tree: string | null;
  dirty: boolean | null;
  target: string | null;
}

function objectId(value: unknown): string | null {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
    ? value.toLowerCase()
    : null;
}

/** Keep diagnostics restricted to build metadata, including when talking to an older server. */
export function parseBuildInfo(value: unknown): BuildInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.version !== "string" ||
    raw.version.length > 80 ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(raw.version)
  ) return null;
  const commit = objectId(raw.commit);
  const tree = objectId(raw.tree);
  return {
    version: raw.version,
    commit,
    tree,
    dirty: commit && tree && typeof raw.dirty === "boolean" ? raw.dirty : null,
    target: typeof raw.target === "string" &&
      raw.target.length <= 100 && /^[A-Za-z0-9_.-]+$/.test(raw.target)
      ? raw.target
      : null,
  };
}

export function buildInfoSummary(info: BuildInfo): string {
  const revision = info.commit ? info.commit.slice(0, 8) : "source unknown";
  const status = info.dirty === true
    ? " · modified sources"
    : info.commit && info.dirty === null ? " · source state unknown" : "";
  return info.version + " · " + revision + status;
}

export function buildInfoCopyText(info: BuildInfo): string {
  return JSON.stringify({
    version: info.version,
    commit: info.commit,
    tree: info.tree,
    dirty: info.dirty,
    target: info.target,
  }, null, 2);
}
