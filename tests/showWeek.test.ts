import assert from "node:assert/strict";
import test from "node:test";
import { currentStepIndex, SHOW_STEPS, showGuideVisible } from "../src/lib/showWeek.ts";

test("steps are in time order", () => {
  for (let i = 1; i < SHOW_STEPS.length; i++) {
    assert.ok(Date.parse(SHOW_STEPS[i].start) > Date.parse(SHOW_STEPS[i - 1].start), SHOW_STEPS[i].id);
  }
});

test("picks the step in effect", () => {
  assert.equal(currentStepIndex(new Date("2026-11-02T12:00:00Z")), -1);
  assert.equal(SHOW_STEPS[currentStepIndex(new Date("2026-11-03T12:08:00Z"))].id, "before");
  assert.equal(SHOW_STEPS[currentStepIndex(new Date("2026-11-04T14:00:00Z"))].id, "day1-am");
  assert.equal(SHOW_STEPS[currentStepIndex(new Date("2026-11-04T20:00:00Z"))].id, "day1-pm");
  assert.equal(SHOW_STEPS[currentStepIndex(new Date("2026-11-06T03:00:00Z"))].id, "day2-eve");
  assert.equal(SHOW_STEPS[currentStepIndex(new Date("2026-11-09T12:00:00Z"))].id, "day5-pm");
});

test("guide hides after the show", () => {
  assert.equal(showGuideVisible(new Date("2026-11-08T23:00:00Z")), true);
  assert.equal(showGuideVisible(new Date("2026-11-10T05:00:00Z")), false);
});
