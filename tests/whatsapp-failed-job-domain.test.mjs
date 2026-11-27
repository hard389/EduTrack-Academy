import test from "node:test";
import assert from "node:assert/strict";
import {
  getFailedAtMillis,
  getFailedExpiryMillis,
  isExpiredSafeAttendanceRetryJob,
  isSafeAttendanceRetryJob,
} from "../server/whatsappFailedJobDomain.mjs";

const now = Date.UTC(2026, 10, 20, 12, 0, 0);
const baseJob = {
  kind: "attendance_absent",
  status: "failed",
  retrySafe: true,
  attemptCount: 1,
  failedAt: now - 60_000,
};

test("safe attendance failure receives a server timestamp-based 24-hour retry window", () => {
  assert.equal(getFailedAtMillis(baseJob), now - 60_000);
  assert.equal(getFailedExpiryMillis(baseJob), now - 60_000 + 86_400_000);
  assert.equal(isSafeAttendanceRetryJob(baseJob, now), true);
  assert.equal(isExpiredSafeAttendanceRetryJob(baseJob, now), false);
});

test("expired retry job is no longer eligible and can be cleaned", () => {
  const expired = { ...baseJob, failedAt: now - 86_400_001 };
  assert.equal(isSafeAttendanceRetryJob(expired, now), false);
  assert.equal(isExpiredSafeAttendanceRetryJob(expired, now), true);
});

test("explicit server expiry wins over a client-created or old timestamp", () => {
  const job = { ...baseJob, failedAt: now - 86_400_000 * 5, expiresAt: now + 1000 };
  assert.equal(getFailedExpiryMillis(job), now + 1000);
  assert.equal(isSafeAttendanceRetryJob(job, now), true);
});

test("accepted, rejected non-retryable, and unknown outcomes cannot enter the retry queue", () => {
  for (const job of [
    { ...baseJob, status: "accepted_by_postabi" },
    { ...baseJob, status: "unknown_outcome" },
    { ...baseJob, retrySafe: false },
    { ...baseJob, attemptCount: 3 },
  ]) {
    assert.equal(isSafeAttendanceRetryJob(job, now), false);
  }
});
