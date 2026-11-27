import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTeacherFeeSummary, isTeacherInvoiceLine, sumTeacherPaymentAllocations } from '../server/academyTeacherFinanceDomain.mjs';

test('explicit teacher UID takes precedence over a matching class/subject fallback', () => {
  const assignments = new Set(['class-10:math']);
  assert.equal(isTeacherInvoiceLine({ teacherUid: 'teacher-A', classId: 'class-10', subjectId: 'math' }, 'teacher-A', assignments), true);
  assert.equal(isTeacherInvoiceLine({ teacherUid: 'teacher-B', classId: 'class-10', subjectId: 'math' }, 'teacher-A', assignments), false);
});

test('legacy invoice line uses only a currently assigned class/subject pair', () => {
  const assignments = new Set(['class-10:math']);
  assert.equal(isTeacherInvoiceLine({ classId: 'class-10', subjectId: 'math' }, 'teacher-A', assignments), true);
  assert.equal(isTeacherInvoiceLine({ classId: 'class-10', subjectId: 'physics' }, 'teacher-A', assignments), false);
});

test('payment total includes only allocations for this teacher invoice line IDs', () => {
  const teacherLines = new Set(['class-10:math']);
  const allocations = [
    { lineItemId: 'class-10:math', amount: 600 },
    { lineItemId: 'class-10:physics', amount: 400 },
  ];
  assert.equal(sumTeacherPaymentAllocations(allocations, teacherLines), 600);
  assert.equal(sumTeacherPaymentAllocations(null, teacherLines), 0);
});

test('financial summary sums owned lines instead of shared invoice totals', () => {
  const summary = calculateTeacherFeeSummary([
    { amount: 600, paidAmount: 200, remainingBalance: 400 },
    { amount: 300, paidAmount: 300, remainingBalance: 0 },
  ]);
  assert.deepEqual(summary, { billed: 900, collected: 500, outstanding: 400 });
});
