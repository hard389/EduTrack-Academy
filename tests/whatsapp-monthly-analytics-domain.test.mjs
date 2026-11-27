import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyWhatsAppOutcome,
  currentPakistanMonthKey,
  pakistanMonthBoundsUtc,
  previousPakistanMonthKey,
  validatePakistanMonthKey,
} from "../server/whatsappMonthlyAnalyticsDomain.mjs";

test("Pakistan month boundaries convert local midnight to UTC+05 boundaries", () => {
  const bounds = pakistanMonthBoundsUtc("2026-11");
  assert.equal(bounds.start.toISOString(), "2026-10-31T19:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-11-30T19:00:00.000Z");
  assert.equal(bounds.days, 30);
});

test("Pakistan month boundaries handle leap February", () => {
  const bounds = pakistanMonthBoundsUtc("2024-02");
  assert.equal(bounds.days, 29);
  assert.equal(bounds.start.toISOString(), "2024-01-31T19:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2024-02-29T19:00:00.000Z");
});

test("previous month rolls back across the year boundary", () => {
  assert.equal(previousPakistanMonthKey("2026-01"), "2025-12");
  assert.equal(previousPakistanMonthKey("2026-12"), "2026-11");
});

test("current Pakistan month uses the Asia/Karachi calendar date", () => {
  const nearUtcMonthBoundary = new Date("2026-10-31T20:00:00.000Z");
  assert.equal(currentPakistanMonthKey(nearUtcMonthBoundary), "2026-11");
});

test("month selector rejects malformed and future months", () => {
  const now = new Date("2026-11-20T06:00:00.000Z");
  assert.equal(validatePakistanMonthKey("", now), "2026-11");
  assert.equal(validatePakistanMonthKey("2026-10", now), "2026-10");
  assert.throws(() => validatePakistanMonthKey("2026-13", now), /valid month/);
  assert.throws(() => validatePakistanMonthKey("2026-12", now), /Future months/);
});

test("provider acceptance and delivery confirmation remain separate outcomes", () => {
  assert.equal(classifyWhatsAppOutcome("accepted_by_provider"), "providerAccepted");
  assert.equal(classifyWhatsAppOutcome("delivered"), "deliveryConfirmed");
  assert.equal(classifyWhatsAppOutcome("provider_rejected"), "failed");
  assert.equal(classifyWhatsAppOutcome("unknown_outcome"), "unknown");
  assert.equal(classifyWhatsAppOutcome("pending"), "pending");
});

test("pre-provider attendance retry jobs are excluded from message totals", () => {
  assert.equal(classifyWhatsAppOutcome("failed", { retrySafe: true }), null);
  assert.equal(classifyWhatsAppOutcome("failed", { retrySafe: false }), "failed");
});
