// Show-week cheat sheet: which Codex and Claude account to use at each point of filming
// (2026-11-04 to 11-08). Built from the 2026-11-03 12:08Z capacity_refresh and claude-usage reads.
// shortcut: hand-written reset times, upgrade to live lane data if the guide outlives this show.

export interface ShowStep {
  id: string;
  /** UTC instant this step starts. */
  start: string;
  /** Short plain-words title, in Eastern time. */
  when: string;
  codex: string;
  claude: string;
  note?: string;
}

export const SHOW_STEPS: readonly ShowStep[] = [
  {
    id: "before",
    start: "2026-11-03T00:00:00Z",
    when: "Today (before the show)",
    codex: "lightcloud007",
    claude: "gustavopayano096 (save it, only 31% left)",
    note: "Go easy so day 1 stays full.",
  },
  {
    id: "day1-am",
    start: "2026-11-04T05:00:00Z",
    when: "Wed Nov 4, morning",
    codex: "lightcloud007, backup gustavopayanovasquez25 (fresh from 6 AM)",
    claude: "gustavopayano096",
  },
  {
    id: "day1-pm",
    start: "2026-11-04T20:00:00Z",
    when: "Wed Nov 4, from 3 PM",
    codex: "lightcloud007, backup gustavopayanovasquez25",
    claude: "Switch to gustavopayano00 (fresh week)",
  },
  {
    id: "day2-pm",
    start: "2026-11-05T19:00:00Z",
    when: "Thu Nov 5, from 2 PM",
    codex: "lightcloud007, backup gustavopayanovasquez25",
    claude: "gustavopayano00, extra: Windows WSL is back",
  },
  {
    id: "day2-eve",
    start: "2026-11-06T00:00:00Z",
    when: "Thu Nov 5, from 7 PM",
    codex: "lightcloud007, backup fingerlakesdigital (fresh week)",
    claude: "gustavopayano00",
  },
  {
    id: "day4-pm",
    start: "2026-11-07T22:00:00Z",
    when: "Sat Nov 7, from 5 PM",
    codex: "lightcloud007, backup fingerlakesdigital",
    claude: "lightcloud007 Mac is back (fresh week)",
  },
  {
    id: "day5-pm",
    start: "2026-11-08T18:00:00Z",
    when: "Sun Nov 8, from 1 PM",
    codex: "lightcloud007, backup fingerlakesdigital",
    claude: "lightcloud007 Mac, extra: Windows PC fresh week",
  },
];

export const SHOW_NEVER = "Never use Fable or the free Codex accounts.";

/** The guide disappears once the show is over. */
export const SHOW_GUIDE_ENDS = "2026-11-10T05:00:00Z";

export function showGuideVisible(now: Date): boolean {
  return now.getTime() < Date.parse(SHOW_GUIDE_ENDS);
}

/** Index of the step in effect at `now`, or -1 before the first step. */
export function currentStepIndex(now: Date, steps: readonly ShowStep[] = SHOW_STEPS): number {
  const t = now.getTime();
  let index = -1;
  steps.forEach((step, i) => {
    if (Date.parse(step.start) <= t) index = i;
  });
  return index;
}
