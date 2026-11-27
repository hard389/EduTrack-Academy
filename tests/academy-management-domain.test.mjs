import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACADEMY_PERMISSION_KEYS,
  normalizePermissionMap,
  normalizeIdList,
  mergeTeacherAssignedIds,
  normalizeBillingMonth,
  buildInvoiceSnapshot,
  applyPaymentToInvoice,
  buildLegacyStudentProjection,
} from '../server/academyManagementDomain.mjs';

test('permission map always enables teacher dashboard and defaults other modules closed', () => {
  const empty = normalizePermissionMap();
  assert.equal(Object.keys(empty).length, ACADEMY_PERMISSION_KEYS.length);
  assert.equal(empty['dashboard.view'], true);
  assert.ok(ACADEMY_PERMISSION_KEYS.filter((key) => key !== 'dashboard.view').every((key) => empty[key] === false));
  assert.equal(normalizePermissionMap({ 'dashboard.view': false })['dashboard.view'], true);
  assert.equal(normalizePermissionMap({ 'fees.collect': true })['fees.collect'], true);
  assert.throws(() => normalizePermissionMap({ 'platform.admin': true }), /Unknown permission/);
  assert.throws(() => normalizePermissionMap({ 'fees.collect': 'true' }), /must be true or false/);
});

test('ID lists are safe, unique and bounded', () => {
  assert.deepEqual(normalizeIdList(['class-a', 'class-a', 'class-b']), ['class-a', 'class-b']);
  assert.throws(() => normalizeIdList(['../other']), /invalid value/);
  assert.throws(() => normalizeIdList('class-a'), /must be an array/);
});

test('teacher assignment aggregation retains every subject assigned in one class', () => {
  const merged = mergeTeacherAssignedIds(
    ['existing-class'],
    ['existing-subject'],
    [
      { classId: 'new-class', subjectId: 'chemistry' },
      { classId: 'new-class', subjectId: 'physics' },
    ],
  );
  assert.deepEqual(merged.assignedClassIds, ['existing-class', 'new-class']);
  assert.deepEqual(merged.assignedSubjectIds, ['existing-subject', 'chemistry', 'physics']);
});

test('teacher assignment aggregation rejects malformed IDs instead of storing partial metadata', () => {
  assert.throws(() => mergeTeacherAssignedIds([], [], [{ classId: 'class-a', subjectId: '' }]), /requires class and subject IDs/);
  assert.throws(() => mergeTeacherAssignedIds([], [], [{ classId: '../other', subjectId: 'subject-a' }]), /invalid value/);
});

test('billing month accepts only YYYY-MM', () => {
  assert.equal(normalizeBillingMonth('2026-11'), '2026-11');
  assert.throws(() => normalizeBillingMonth('2026-13'), /YYYY-MM/);
});

test('invoice snapshots preserve subject fee values and consolidate subjects', () => {
  const invoice = buildInvoiceSnapshot({
    invoiceId: 'student-a_2026-11', academyId: '100',
    student: { studentId: 'student-a', name: 'Ayesha', rollNo: '12' }, month: '2026-11', issuedAt: 'now',
    enrollments: [
      { classId: 'class-a', subjectId: 'math', subjectName: 'Mathematics', feeAmountMonthly: 1200, teacherUid: 't1' },
      { classId: 'class-a', subjectId: 'science', subjectName: 'Science', feeAmountMonthly: 800, teacherUid: 't2' },
    ],
  });
  assert.equal(invoice.totalAmount, 2000);
  assert.equal(invoice.lineItems.length, 2);
  assert.equal(invoice.lineItems[0].amount, 1200);
  assert.equal(invoice.lineItems[1].amount, 800);
  assert.throws(() => buildInvoiceSnapshot({
    invoiceId: 'x', academyId: '100', student: { studentId: 'x' }, month: '2026-11', issuedAt: 'now',
    enrollments: [
      { classId: 'c', subjectId: 'math', feeAmountMonthly: 100 },
      { classId: 'c', subjectId: 'math', feeAmountMonthly: 100 },
    ],
  }), /Duplicate active/);
});

test('payment allocation updates one consolidated invoice and blocks overpayment', () => {
  const invoice = buildInvoiceSnapshot({
    invoiceId: 's_2026-11', academyId: '100', student: { studentId: 's', name: 'Student' },
    month: '2026-11', issuedAt: 'now',
    enrollments: [
      { classId: 'c', subjectId: 'math', subjectName: 'Math', feeAmountMonthly: 1000 },
      { classId: 'c', subjectId: 'science', subjectName: 'Science', feeAmountMonthly: 500 },
    ],
  });
  const first = applyPaymentToInvoice(invoice, { amount: 1200, collectorUid: 'teacher-1', collectorEmail: 't@gmail.com', collectorRole: 'teacher', paymentMethod: 'cash' });
  assert.equal(first.invoice.paidAmount, 1200);
  assert.equal(first.invoice.remainingBalance, 300);
  assert.equal(first.invoice.lineItems[0].remainingBalance, 0);
  assert.equal(first.invoice.lineItems[1].remainingBalance, 300);
  assert.equal(first.payment.allocations.reduce((sum, item) => sum + item.amount, 0), 1200);
  assert.throws(() => applyPaymentToInvoice(first.invoice, { amount: 301 }), /exceeds the outstanding balance/);
});

test('legacy teacher projection keeps a canonical student identity key', () => {
  const projection = buildLegacyStudentProjection({ studentId: 'canonical-1', academyId: '100', name: 'Ali', rollNo: '7' });
  assert.equal(projection.id, 'canonical-1');
  assert.equal(projection.canonicalStudentId, 'canonical-1');
  assert.equal(projection.academyId, '100');
});
