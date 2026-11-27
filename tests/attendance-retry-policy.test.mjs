import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isOwnedActiveTeacherTenant,
  isSafeAttendanceRetryJob,
  hasReachedAttendanceRetryLimit,
} = require("../src/functions/lib/attendanceRetryPolicy.js");

const validProfile = {
  uid: "teacher-uid-1",
  email: "teacher@example.com",
  role: "teacher",
  active: true,
};

test("accepts a matching active teacher profile", () => {
  assert.equal(
    isOwnedActiveTeacherTenant(validProfile, "teacher-uid-1", "TEACHER@example.com"),
    true,
  );
});

test("rejects a profile belonging to a different UID/tenant", () => {
  assert.equal(
    isOwnedActiveTeacherTenant(validProfile, "different-uid", "teacher@example.com"),
    false,
  );
});

test("rejects an email that does not match the tenant profile", () => {
  assert.equal(
    isOwnedActiveTeacherTenant(validProfile, "teacher-uid-1", "other@example.com"),
    false,
  );
});

test("rejects non-teacher roles", () => {
  assert.equal(
    isOwnedActiveTeacherTenant({ ...validProfile, role: "admin" }, "teacher-uid-1", "teacher@example.com"),
    false,
  );
});

test("rejects role values that do not exactly match the frontend validator", () => {
  for (const role of ["Teacher", "TEACHER", " teacher ", "admin"]) {
    assert.equal(
      isOwnedActiveTeacherTenant(
        { ...validProfile, role },
        "teacher-uid-1",
        "teacher@example.com",
      ),
      false,
      `role ${JSON.stringify(role)} must be rejected`,
    );
  }
});

test("rejects inactive or missing active status", () => {
  assert.equal(
    isOwnedActiveTeacherTenant({ ...validProfile, active: false }, "teacher-uid-1", "teacher@example.com"),
    false,
  );
  const missingActive = { ...validProfile };
  delete missingActive.active;
  assert.equal(
    isOwnedActiveTeacherTenant(missingActive, "teacher-uid-1", "teacher@example.com"),
    false,
  );
});

test("rejects disabled and deleted teacher profiles", () => {
  assert.equal(
    isOwnedActiveTeacherTenant({ ...validProfile, disabled: true }, "teacher-uid-1", "teacher@example.com"),
    false,
  );
  assert.equal(
    isOwnedActiveTeacherTenant({ ...validProfile, deleted: true }, "teacher-uid-1", "teacher@example.com"),
    false,
  );
});

test("rejects invalid authenticated email values", () => {
  assert.equal(isOwnedActiveTeacherTenant(validProfile, "teacher-uid-1", "bad/email"), false);
  assert.equal(isOwnedActiveTeacherTenant(validProfile, "teacher-uid-1", ""), false);
});

test("allows an explicitly safe failed job below the retry limit", () => {
  assert.equal(
    isSafeAttendanceRetryJob({
      status: "failed",
      retrySafe: true,
      attemptCount: 2,
    }),
    true,
  );
});

test("rejects unknown_outcome even when retrySafe is incorrectly true", () => {
  assert.equal(
    isSafeAttendanceRetryJob({
      status: "unknown_outcome",
      retrySafe: true,
      attemptCount: 1,
    }),
    false,
  );
});

test("rejects sending and accepted jobs", () => {
  for (const status of ["sending", "accepted_by_meta", "sent", "delivered", "read"]) {
    assert.equal(
      isSafeAttendanceRetryJob({ status, retrySafe: true, attemptCount: 1 }),
      false,
      `status ${status} must not be eligible`,
    );
  }
});

test("rejects a failed job without explicit retry safety", () => {
  assert.equal(
    isSafeAttendanceRetryJob({
      status: "failed",
      retrySafe: false,
      attemptCount: 1,
    }),
    false,
  );
});

test("enforces the maximum of three attempts", () => {
  assert.equal(
    hasReachedAttendanceRetryLimit({ attemptCount: 3 }),
    true,
  );
  assert.equal(
    isSafeAttendanceRetryJob({ status: "failed", retrySafe: true, attemptCount: 3 }),
    false,
  );
  assert.equal(
    isSafeAttendanceRetryJob({ status: "failed", retrySafe: true, attemptCount: 4 }),
    false,
  );
});

test("rejects negative retry attempt counts", () => {
  assert.equal(
    isSafeAttendanceRetryJob({ status: "failed", retrySafe: true, attemptCount: -1 }),
    false,
  );
});
