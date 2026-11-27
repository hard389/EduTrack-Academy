import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNotificationSvg,
  validateNotificationImagePayload,
} from "../server/whatsappNotificationImageDomain.mjs";

const identity = {
  academyName: "EduTrack Academy",
  studentName: "Student One",
  className: "Class 5",
  classCode: "C5-A",
};

const logo = "data:image/png;base64,bG9nbw==";

test("generic fee reminder is valid without inventing a saved due date", () => {
  const payload = {
    kind: "fee_reminder",
    ...identity,
    feeMonth: "November 2026",
    amountDue: 2500,
    currencyAmount: "PKR 2,500",
    paymentStatus: "PARTIAL",
    dueDate: "",
  };
  assert.deepEqual(validateNotificationImagePayload(payload), { valid: true, kind: "fee_reminder" });
  const svg = buildNotificationSvg(payload, logo);
  assert.match(svg, /FEE REMINDER/);
  assert.match(svg, /OUTSTANDING BALANCE/);
  assert.match(svg, /Not recorded/);
  assert.doesNotMatch(svg, /PAYMENT OVERDUE|DUE SOON|DAYS OVERDUE/);
});

test("upcoming and overdue fee images still require a saved due date", () => {
  const base = {
    ...identity,
    feeMonth: "November 2026",
    amountDue: 2500,
  };
  assert.equal(validateNotificationImagePayload({ ...base, kind: "fee_upcoming" }).valid, false);
  assert.equal(validateNotificationImagePayload({ ...base, kind: "fee_overdue", daysOverdue: 3 }).valid, false);
  assert.equal(validateNotificationImagePayload({ ...base, kind: "fee_upcoming", dueDate: "20 Nov 2026" }).valid, true);
  assert.equal(validateNotificationImagePayload({ ...base, kind: "fee_overdue", dueDate: "05 Nov 2026", daysOverdue: 14 }).valid, true);
});

test("generic fee reminders still require identity and a positive outstanding amount", () => {
  assert.equal(validateNotificationImagePayload({ kind: "fee_reminder", ...identity, feeMonth: "Nov 2026", amountDue: 0 }).valid, false);
  assert.equal(validateNotificationImagePayload({ kind: "fee_reminder", studentName: "Student", className: "Class", classCode: "C1", feeMonth: "Nov 2026", amountDue: 500 }).valid, false);
});
