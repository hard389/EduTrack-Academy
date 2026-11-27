import test from "node:test";
import assert from "node:assert/strict";
import {
  getPakistanDateKey,
  getTeacherAnnouncementDismissalId,
} from "../server/teacherPortalAnnouncementDomain.mjs";

test("teacher notice dismissal uses the Pakistan calendar day, including UTC date rollover", () => {
  // 19:30 UTC on Nov 18 is 00:30 on Nov 19 in Pakistan (UTC+5).
  assert.equal(getPakistanDateKey(new Date("2026-11-18T19:30:00.000Z")), "2026-11-19");
  // 18:30 UTC remains 23:30 on Nov 18 in Pakistan.
  assert.equal(getPakistanDateKey(new Date("2026-11-18T18:30:00.000Z")), "2026-11-18");
});

test("dismissal document IDs are deterministic per teacher and Pakistan day", () => {
  const first = getTeacherAnnouncementDismissalId("teacher-uid-1", "2026-11-18");
  assert.equal(first, getTeacherAnnouncementDismissalId("teacher-uid-1", "2026-11-18"));
  assert.notEqual(first, getTeacherAnnouncementDismissalId("teacher-uid-2", "2026-11-18"));
  assert.notEqual(first, getTeacherAnnouncementDismissalId("teacher-uid-1", "2026-11-19"));
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("invalid teacher dismissal keys are rejected", () => {
  assert.throws(() => getTeacherAnnouncementDismissalId("", "2026-11-18"), TypeError);
  assert.throws(() => getTeacherAnnouncementDismissalId("uid", "18-11-2026"), TypeError);
  assert.throws(() => getPakistanDateKey(new Date("invalid")), TypeError);
});
