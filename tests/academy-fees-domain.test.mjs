import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getClassInvoiceTotals, getClassLineItems, getExtraLineItems, getLineItemStatus,
  getPreviousBillingMonth, getStudentClassLineTotals, hasUnsupportedMonthlyBillingCycle,
  sumInvoiceLines, sumMonthlyEnrolmentPreview,
} from '../src/lib/academyFeesDomain.mjs';

const invoice = {
  billingMonth: '2026-11', status: 'PARTIAL', totalAmount: 2200, paidAmount: 700, remainingBalance: 1500,
  lineItems: [
    { lineItemId: 'c1:s1', classId: 'c1', kind: 'tuition', amount: 1000, paidAmount: 500, remainingBalance: 500 },
    { lineItemId: 'c2:s2', classId: 'c2', kind: 'tuition', amount: 800, paidAmount: 200, remainingBalance: 600 },
    { lineItemId: 'extra:1', classId: '', kind: 'extra_charge', amount: 400, paidAmount: 0, remainingBalance: 400 },
  ],
};

test('previous billing month handles year boundaries', () => {
  assert.equal(getPreviousBillingMonth('2026-01'), '2025-12');
  assert.equal(getPreviousBillingMonth('2026-11'), '2026-10');
  assert.throws(() => getPreviousBillingMonth('2026-13'), /YYYY-MM/);
});

test('class line item totals do not include another class or unassigned extra charges', () => {
  assert.deepEqual(getClassLineItems(invoice, 'c1'), [invoice.lineItems[0]]);
  assert.deepEqual(getStudentClassLineTotals(invoice, 'c1'), { billed: 1000, paid: 500, due: 500 });
  assert.deepEqual(getStudentClassLineTotals(invoice, 'c2'), { billed: 800, paid: 200, due: 600 });
  assert.deepEqual(getExtraLineItems(invoice), [invoice.lineItems[2]]);
});

test('class invoice totals aggregate only line items assigned to selected class', () => {
  const totals = getClassInvoiceTotals([invoice], 'c1', '2026-11');
  assert.deepEqual(totals, { billed: 1000, paid: 500, due: 500 });
  assert.equal(getClassInvoiceTotals([invoice], 'c9', '2026-11'), null);
});

test('line item payment status derives from actual billed, paid and due values', () => {
  assert.equal(getLineItemStatus({ billed: 100, paid: 100, due: 0 }), 'PAID');
  assert.equal(getLineItemStatus({ billed: 100, paid: 25, due: 75 }), 'PARTIAL');
  assert.equal(getLineItemStatus({ billed: 100, paid: 0, due: 100 }), 'UNPAID');
  assert.equal(getLineItemStatus(null), 'NOT_INVOICED');
  assert.equal(sumInvoiceLines([]), null);
});

test('monthly tuition preview excludes termly and yearly enrolments', () => {
  const enrolments = [
    { classId: 'c1', billingFrequency: 'monthly', feeAmountMonthly: 1200 },
    { classId: 'c1', billingFrequency: 'termly', feeAmountMonthly: 600 },
    { classId: 'c2', billingFrequency: 'monthly', feeAmountMonthly: 400 },
  ];
  assert.equal(sumMonthlyEnrolmentPreview(enrolments, 'c1'), 1200);
  assert.equal(hasUnsupportedMonthlyBillingCycle(enrolments.filter((row) => row.classId === 'c1')), true);
  assert.equal(hasUnsupportedMonthlyBillingCycle([enrolments[0]]), false);
});

test('invalid historical line-item amounts make class totals unavailable instead of displaying a partial total', () => {
  const invalidInvoice = {
    billingMonth: '2026-11',
    status: 'UNPAID',
    lineItems: [
      { lineItemId: 'c1:s1', classId: 'c1', amount: 1000, paidAmount: 0, remainingBalance: 1000 },
      { lineItemId: 'c1:s2', classId: 'c1', amount: 'not-a-number', paidAmount: 0, remainingBalance: 100 },
    ],
  };
  assert.equal(getStudentClassLineTotals(invalidInvoice, 'c1'), null);
  assert.equal(getClassInvoiceTotals([invalidInvoice], 'c1', '2026-11'), null);
});

test('monthly tuition preview is unavailable when a saved monthly amount is malformed', () => {
  assert.equal(sumMonthlyEnrolmentPreview([
    { classId: 'c1', billingFrequency: 'monthly', feeAmountMonthly: 1000 },
    { classId: 'c1', billingFrequency: 'monthly', feeAmountMonthly: 'bad' },
  ], 'c1'), null);
});
