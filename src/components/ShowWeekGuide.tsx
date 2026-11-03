import { useEffect, useState } from "react";
import { BlurredText } from "./AccountCard";
import { currentStepIndex, SHOW_NEVER, SHOW_STEPS, showGuideVisible } from "../lib/showWeek";

const CLOCK_TICK_MS = 60_000;

interface ShowWeekGuideProps {
  masked: boolean;
}

export function ShowWeekGuide({ masked }: ShowWeekGuideProps) {
  const [now, setNow] = useState(() => new Date());
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  if (!showGuideVisible(now)) return null;

  const index = currentStepIndex(now);
  if (index < 0) return null;
  const current = SHOW_STEPS[index];
  const next = SHOW_STEPS[index + 1];

  return (
    <section
      aria-label="Show week guide"
      className="mb-4 rounded-xl border border-violet-300 bg-violet-50 p-4 dark:border-violet-700 dark:bg-violet-950/50"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-violet-800 dark:text-violet-300">
          Show week · {current.when}
        </p>
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs font-medium text-violet-800 underline dark:text-violet-300"
        >
          {showAll ? "Hide schedule" : "Full schedule"}
        </button>
      </div>

      <dl className="mt-2 grid gap-1 text-sm text-gray-900 dark:text-gray-100 sm:grid-cols-[auto_1fr] sm:gap-x-3">
        <dt className="font-semibold">Codex</dt>
        <dd>
          <BlurredText blur={masked}>{current.codex}</BlurredText>
        </dd>
        <dt className="font-semibold">Claude</dt>
        <dd>
          <BlurredText blur={masked}>{current.claude}</BlurredText>
        </dd>
      </dl>

      {current.note && <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">{current.note}</p>}

      {next && (
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
          <span className="font-semibold">Next change:</span> {next.when}
        </p>
      )}

      {showAll && (
        <ol className="mt-3 space-y-2 border-t border-violet-200 pt-3 text-sm dark:border-violet-800">
          {SHOW_STEPS.map((step, i) => (
            <li
              key={step.id}
              className={i === index ? "font-semibold text-gray-900 dark:text-white" : "text-gray-700 dark:text-gray-300"}
            >
              <span>{step.when}</span>
              {i === index && <span className="ml-2 text-violet-700 dark:text-violet-300">← now</span>}
              <div className="font-normal">
                Codex: <BlurredText blur={masked}>{step.codex}</BlurredText>
              </div>
              <div className="font-normal">
                Claude: <BlurredText blur={masked}>{step.claude}</BlurredText>
              </div>
            </li>
          ))}
          <li className="text-red-800 dark:text-red-300">{SHOW_NEVER}</li>
        </ol>
      )}
    </section>
  );
}
