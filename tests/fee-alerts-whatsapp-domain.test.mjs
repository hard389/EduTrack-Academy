import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFeeReminderMessage,
  computeFeeOutstanding,
  createFeeAlertJobId,
  createFeeAlertRecipientHash,
  getPakistanCalendarParts,
  hasCurrentFeeAlertsConsent,
  isStudentEligibleForFeeMonth,
  normalizeFeeAlertPhone,
  normalizeFeeReminderDays,
} from "../server/feeAlertsWhatsAppDomain.mjs";

test("Pakistani guardian numbers normalize to country-code digits", () => {
  assert.equal(normalizeFeeAlertPhone("0300 1234567"), "923001234567");
  assert.equal(normalizeFeeAlertPhone("+92 300 1234567"), "923001234567");
  assert.equal(normalizeFeeAlertPhone("0092-300-1234567"), "923001234567");
  assert.equal(normalizeFeeAlertPhone("123"), null);
});

test("fee-alert consent needs explicit opt-in, timestamp and same current phone", () => {
  const base = {
    phone: "03001234567",
    feeAlertsWhatsAppOptIn: true,
    feeAlertsWhatsAppOptInAt: "2026-11-13T10:00:00.000Z",
    feeAlertsWhatsAppOptInPhone: "+923001234567",
  };
  assert.equal(hasCurrentFeeAlertsConsent(base), true);
  assert.equal(hasCurrentFeeAlertsConsent({ ...base, feeAlertsWhatsAppOptIn: false }), false);
  assert.equal(hasCurrentFeeAlertsConsent({ ...base, feeAlertsWhatsAppOptInAt: null }), false);
  assert.equal(hasCurrentFeeAlertsConsent({ ...base, feeAlertsWhatsAppOptInPhone: "+923111111111" }), false);
  assert.equal(hasCurrentFeeAlertsConsent({ ...base, phone: "03111234567" }), false);
});

test("students are excluded from fee months before their admission month", () => {
  assert.equal(isStudentEligibleForFeeMonth({ name: "Ahmed", joiningDate: "2026-12-02" }, "2026-11"), false);
  assert.equal(isStudentEligibleForFeeMonth({ name: "Ahmed", joiningDate: "2026-11-02" }, "2026-11"), true);
  assert.equal(isStudentEligibleForFeeMonth({ name: "Ahmed" }, "2026-11"), true);
  assert.equal(isStudentEligibleForFeeMonth({ name: "Ahmed" }, "bad-month"), false);
});

test("exactly two distinct reminder days from 1 through 28 are accepted", () => {
  assert.deepEqual(normalizeFeeReminderDays([20, 5]), [5, 20]);
  assert.equal(normalizeFeeReminderDays([5]), null);
  assert.equal(normalizeFeeReminderDays([5, 5]), null);
  assert.equal(normalizeFeeReminderDays([0, 20]), null);
  assert.equal(normalizeFeeReminderDays([5, 29]), null);
  assert.equal(normalizeFeeReminderDays([5, 20, 25]), null);
});

test("fee ledger calculates the full outstanding monthly amount", () => {
  const result = computeFeeOutstanding({
    student: { id: "student-1", studentFee: "5000" },
    classData: { monthlyFee: "4500" },
    currentRecord: null,
    previousRecord: null,
    monthKey: "2026-11",
  });
  assert.equal(result.valid, true);
  assert.equal(result.monthlyFeeDue, 5000);
  assert.equal(result.previousMonthDues, 0);
  assert.equal(result.remainingDues, 5000);
  assert.equal(result.status, "UNPAID");
});

test("part payments and previous-month arrears produce only the remaining balance", () => {
  const result = computeFeeOutstanding({
    student: { id: "student-2", studentFee: "5000", joiningDate: "2026-01-15" },
    classData: { monthlyFee: "5000" },
    currentRecord: {
      monthlyFeeDue: 5000,
      previousMonthDues: 1000,
      paidAmount: 1000,
      paidTowardsCurrentMonth: 1000,
      remainingDues: 5000,
    },
    previousRecord: { remainingDues: 1000 },
    monthKey: "2026-11",
  });
  assert.equal(result.valid, true);
  assert.equal(result.previousMonthDues, 1000);
  assert.equal(result.paidTowardsCurrentMonth, 1000);
  assert.equal(result.remainingDues, 5000);
  assert.equal(result.status, "PARTIAL");
});

test("fully paid ledger has no outstanding balance and is skipped", () => {
  const result = computeFeeOutstanding({
    student: { id: "student-3", studentFee: "5000" },
    classData: { monthlyFee: "5000" },
    currentRecord: {
      monthlyFeeDue: 5000,
      paidAmount: 5000,
      paidTowardsCurrentMonth: 5000,
      remainingDues: 0,
    },
    previousRecord: null,
    monthKey: "2026-11",
  });
  assert.equal(result.valid, true);
  assert.equal(result.remainingDues, 0);
  assert.equal(result.status, "PAID");
});

test("previous arrears are not carried before the student's admission month", () => {
  const result = computeFeeOutstanding({
    student: { id: "student-4", studentFee: "3000", joiningDate: "2026-11-07" },
    classData: { monthlyFee: "3000" },
    currentRecord: { monthlyFeeDue: 3000, paidTowardsCurrentMonth: 0 },
    previousRecord: { remainingDues: 2500 },
    monthKey: "2026-11",
  });
  assert.equal(result.valid, true);
  assert.equal(result.previousMonthDues, 0);
  assert.equal(result.remainingDues, 3000);
});

test("malformed monetary ledger values are blocked instead of guessed", () => {
  const result = computeFeeOutstanding({
    student: { id: "student-5", studentFee: "5000" },
    classData: { monthlyFee: "5000" },
    currentRecord: { remainingDues: "not-a-number" },
    previousRecord: null,
    monthKey: "2026-11",
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /invalid remainingDues/i);
});

test("admission date calendar parsing follows Pakistan month boundaries", () => {
  const result = computeFeeOutstanding({
    student: { id: "student-6", studentFee: "4000", joiningDate: "11/05/2026" },
    classData: { monthlyFee: "4000" },
    currentRecord: { monthlyFeeDue: 4000 },
    previousRecord: { remainingDues: 1500 },
    monthKey: "2026-11",
  });
  assert.equal(result.valid, true);
  assert.equal(result.previousMonthDues, 0);
});

test("daily Cron resolves the calendar date in Asia/Karachi", () => {
  const parts = getPakistanCalendarParts(new Date("2026-11-13T20:00:00.000Z"));
  assert.deepEqual(parts, { year: 2026, month: 11, day: 14, monthKey: "2026-11" });
});

test("job ID is deterministic per tenant, student, month and reminder date", () => {
  const base = {
    tenantId: "school@example.com",
    classId: "class-a",
    monthKey: "2026-11",
    studentId: "student-1",
    reminderDay: 5,
  };
  assert.equal(createFeeAlertJobId(base), createFeeAlertJobId(base));
  assert.notEqual(createFeeAlertJobId(base), createFeeAlertJobId({ ...base, studentId: "student-2" }));
  assert.notEqual(createFeeAlertJobId(base), createFeeAlertJobId({ ...base, reminderDay: 20 }));
  assert.notEqual(createFeeAlertJobId(base), createFeeAlertJobId({ ...base, tenantId: "other@example.com" }));
});

test("message includes only the individual student's outstanding amount", () => {
  const message = buildFeeReminderMessage({
    studentName: "Ahmed Ali",
    className: "Class 5",
    monthKey: "2026-11",
    amountDue: 2500,
  });
  assert.match(message, /Ahmed Ali/);
  assert.match(message, /Class 5/);
  assert.match(message, /PKR 2,500/);
  assert.doesNotMatch(message, /other student|student-2/i);
  assert.throws(() => buildFeeReminderMessage({ studentName: "Ahmed", className: "Class 5", monthKey: "2026-11", amountDue: 0 }), /positive/i);
});

test("recipient fingerprint is stable but does not store the plain phone number", () => {
  const a = createFeeAlertRecipientHash("03001234567");
  const b = createFeeAlertRecipientHash("+923001234567");
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(a, /923001234567/);
});
