import assert from "node:assert/strict";
import test from "node:test";
import { claudeSubscriptionText, estimatedMonthlyRenewal } from "../src/lib/claudeSubscription.ts";

const now = new Date(2026, 10, 10, 14).getTime();

test("renewal is explicitly an estimate and never inferred for free or unknown billing", () => {
  const subscriptionCreatedAt = new Date(2026, 0, 24, 12).toISOString();
  assert.match(claudeSubscriptionText({ subscriptionCreatedAt, billingType: "apple_subscription" }, now), /^Estimated monthly renewal/);
  assert.equal(claudeSubscriptionText({ subscriptionCreatedAt, billingType: "none" }, now), "Free · no paid expiry");
  assert.equal(claudeSubscriptionText({ subscriptionCreatedAt }, now), "Expiry not recorded");
  assert.equal(estimatedMonthlyRenewal("invalid", now), null);
  assert.equal(estimatedMonthlyRenewal("2030-01-01", now), null);
});

test("monthly anniversary clamps month end, retains today, and crosses December", () => {
  const start = new Date(2026, 6, 31, 12).toISOString();
  const november = estimatedMonthlyRenewal(start, now)!;
  assert.equal(november.getMonth(), 10);
  assert.equal(november.getDate(), 30);
  const today = estimatedMonthlyRenewal(start, new Date(2026, 10, 30, 23).getTime())!;
  assert.equal(today.getDate(), 30);
  const january = estimatedMonthlyRenewal(new Date(2026, 0, 3).toISOString(), new Date(2026, 11, 10).getTime())!;
  assert.equal(january.getFullYear(), 2027);
  assert.equal(january.getMonth(), 0);
  assert.equal(january.getDate(), 3);
});
