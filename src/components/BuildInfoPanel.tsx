import { useCallback, useEffect, useRef, useState } from "react";
import { invokeBackend } from "../lib/platform";
import { withTimeout } from "../lib/withTimeout";
import { buildInfoCopyText, buildInfoSummary, parseBuildInfo } from "../lib/buildInfo";
import type { BuildInfo } from "../lib/buildInfo";

export function BuildInfoPanel() {
  const [info, setInfo] = useState<BuildInfo | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(() => {
    const id = ++requestId.current;
    setStatus("loading");
    setInfo(null);
    setCopied(false);
    setCopyFailed(false);
    void withTimeout(invokeBackend<unknown>("get_build_info"), 5_000).then((value) => {
      if (id !== requestId.current) return;
      const parsed = parseBuildInfo(value);
      setInfo(parsed);
      setStatus(parsed ? "ready" : "unavailable");
    }).catch(() => {
      if (id === requestId.current) setStatus("unavailable");
    });
  }, []);

  useEffect(() => {
    load();
    return () => { requestId.current += 1; };
  }, [load]);

  const copy = async () => {
    if (!info) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(buildInfoCopyText(info));
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <section aria-labelledby="build-details-title" className="border-t border-gray-100 dark:border-gray-800 pt-3">
      <div className="flex items-center justify-between gap-3">
        <h3 id="build-details-title" className="text-sm font-medium text-gray-900 dark:text-gray-100">Build details</h3>
        {info && (
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-md px-2 py-1 text-xs font-medium text-orange-700 dark:text-orange-300 hover:bg-orange-50 dark:hover:bg-orange-950"
            aria-label="Copy build details"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {info ? (
        <>
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{buildInfoSummary(info)}</p>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-400 select-text">
            <dt>Commit</dt><dd className="min-w-0 break-all font-mono">{info.commit ?? "Unavailable"}</dd>
            <dt>Source tree</dt><dd className="min-w-0 break-all font-mono">{info.tree ?? "Unavailable"}</dd>
            <dt>Sources</dt><dd>{info.dirty === true ? "Modified when built" : info.dirty === false ? "Clean when built" : "Unknown"}</dd>
            <dt>Platform</dt><dd className="min-w-0 break-all font-mono">{info.target ?? "Unavailable"}</dd>
          </dl>
          {copied && <p role="status" className="mt-2 text-xs text-gray-500 dark:text-gray-400">Build details copied.</p>}
          {copyFailed && <p role="status" className="mt-2 text-xs text-gray-500 dark:text-gray-400">Could not copy. Select the details above to copy them.</p>}
        </>
      ) : status === "loading" ? (
        <p role="status" className="mt-1 text-sm text-gray-500 dark:text-gray-400">Loading build details…</p>
      ) : (
        <div className="mt-1 flex items-center justify-between gap-3 text-sm text-gray-500 dark:text-gray-400">
          <p>Build details unavailable.</p>
          <button type="button" onClick={load} className="text-xs font-medium text-orange-700 dark:text-orange-300">Retry</button>
        </div>
      )}
    </section>
  );
}
