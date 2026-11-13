// Outage badges from the providers' public status pages (polled by the backend every few minutes).

export type StatusIndicator =
  | "none"
  | "minor"
  | "major"
  | "critical"
  | "maintenance"
  | "unknown";

export interface ProviderStatus {
  id: string;
  label: string;
  indicator: StatusIndicator;
  description: string;
  pageUrl: string;
}

export interface StatusBadge {
  id: string;
  label: string;
  word: string;
  tone: "warn" | "bad" | "info";
  title: string;
}

const WORDS: Partial<Record<StatusIndicator, { word: string; tone: StatusBadge["tone"] }>> = {
  minor: { word: "degraded", tone: "warn" },
  major: { word: "outage", tone: "bad" },
  critical: { word: "major outage", tone: "bad" },
  maintenance: { word: "maintenance", tone: "info" },
};

/** Only providers in trouble get a badge; healthy, unknown or malformed rows show nothing. */
export function statusBadges(statuses: readonly ProviderStatus[] | null | undefined): StatusBadge[] {
  if (!Array.isArray(statuses)) return [];
  return statuses.flatMap((status: ProviderStatus | null): StatusBadge[] => {
    const entry = status ? WORDS[status.indicator] : undefined;
    if (!status || !entry || typeof status.label !== "string" || !status.label) return [];
    const detail = typeof status.description === "string" ? status.description.trim() : "";
    return [
      {
        id: status.id,
        label: status.label,
        word: entry.word,
        tone: entry.tone,
        title: detail ? `${status.label}: ${detail}` : `${status.label}: ${entry.word}`,
      },
    ];
  });
}
