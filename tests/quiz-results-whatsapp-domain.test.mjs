import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateQuizResultsContentHash,
  createQuizResultMessage,
  createQuizResultsDispatchId,
  createQuizResultsRecipientKey,
  getQuizResultsConsentedPhone,
  normalizeQuizWhatsAppPhone,
  parseQuizResultMark,
} from "../server/quizResultsWhatsAppDomain.mjs";

test("Pakistani parent numbers normalize to country-code form", () => {
  assert.equal(normalizeQuizWhatsAppPhone("0300 1234567"), "923001234567");
  assert.equal(normalizeQuizWhatsAppPhone("+92 300 1234567"), "923001234567");
  assert.equal(normalizeQuizWhatsAppPhone("not-a-number"), null);
});

test("Quiz-results consent requires explicit opt-in, timestamp, and the exact current phone", () => {
  const base = {
    phone: "+92 300 1234567",
    quizResultsWhatsAppOptIn: true,
    quizResultsWhatsAppOptInAt: "2026-11-13T09:00:00.000Z",
    quizResultsWhatsAppOptInPhone: "0300 1234567",
  };
  assert.equal(getQuizResultsConsentedPhone(base), "923001234567");
  assert.equal(getQuizResultsConsentedPhone({ ...base, quizResultsWhatsAppOptIn: false }), null);
  assert.equal(getQuizResultsConsentedPhone({ ...base, quizResultsWhatsAppOptInAt: null }), null);
  assert.equal(getQuizResultsConsentedPhone({ ...base, phone: "0311 0000000" }), null);
  assert.equal(getQuizResultsConsentedPhone({ ...base, quizResultsWhatsAppOptInPhone: "0311 0000000" }), null);
});

test("quiz marks accept only finite values between zero and total marks", () => {
  assert.deepEqual(parseQuizResultMark("18", 20), { kind: "valid", value: 18 });
  assert.deepEqual(parseQuizResultMark(0, 20), { kind: "valid", value: 0 });
  assert.deepEqual(parseQuizResultMark("", 20), { kind: "empty" });
  assert.deepEqual(parseQuizResultMark("abc", 20), { kind: "invalid" });
  assert.deepEqual(parseQuizResultMark(21, 20), { kind: "invalid" });
});

test("content hash is order-independent and changes when a saved mark changes", () => {
  const input = {
    classId: "class-1", quizId: "quiz-1", topic: "Math", totalMarks: 20, date: "13 Nov 2026",
    rows: [
      { studentId: "2", studentName: "B", rollNo: "2", marksObtained: 18 },
      { studentId: "1", studentName: "A", rollNo: "1", marksObtained: 16 },
    ],
  };
  const hash = calculateQuizResultsContentHash(input);
  assert.equal(calculateQuizResultsContentHash({ ...input, rows: [...input.rows].reverse() }), hash);
  assert.notEqual(calculateQuizResultsContentHash({ ...input, rows: input.rows.map((row) => row.studentId === "1" ? { ...row, marksObtained: 17 } : row) }), hash);
});

test("dispatch id is permanently stable for one tenant/class/quiz across content revisions", () => {
  const input = { tenantId: "teacher@example.com", classId: "c1", quizId: "q1", contentHash: "a".repeat(64) };
  assert.equal(createQuizResultsDispatchId(input), createQuizResultsDispatchId({ ...input }));
  assert.equal(createQuizResultsDispatchId(input), createQuizResultsDispatchId({ ...input, contentHash: "b".repeat(64) }));
  assert.notEqual(createQuizResultsDispatchId(input), createQuizResultsDispatchId({ ...input, tenantId: "other@example.com" }));
  assert.match(createQuizResultsRecipientKey("student-1"), /^[a-f0-9]{64}$/);
});

test("quiz message contains only the individual student's score and computed percentage", () => {
  const message = createQuizResultMessage({ studentName: "Ayesha", className: "Class 5", topic: "Math", date: "13 Nov 2026", marksObtained: 18, totalMarks: 20, teacherName: "Teacher" });
  assert.match(message, /Ayesha/);
  assert.match(message, /Marks: 18\/20/);
  assert.match(message, /Percentage: 90%/);
  assert.doesNotMatch(message, /923001234567/);
});
