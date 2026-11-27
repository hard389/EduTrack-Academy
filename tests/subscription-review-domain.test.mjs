import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSubscriptionPeriodBounds,
  getSubscriptionPeriodStatus,
  isReviewablePayment,
} from '../server/subscriptionReviewDomain.mjs';

test('billing month boundaries follow Pakistan local calendar month', () => {
  const bounds = getSubscriptionPeriodBounds('2026-11');
  assert.equal(bounds.startedAt.toISOString(), '2026-10-31T19:00:00.000Z');
  assert.equal(bounds.expiresAt.toISOString(), '2026-11-30T19:00:00.000Z');
});

test('billing period parser rejects malformed and impossible months', () => {
  for (const period of ['2026-00', '2026-13', '26-11', '2026-2', '2026-11-01', '', null]) {
    assert.throws(() => getSubscriptionPeriodBounds(period), TypeError);
  }
});

test('subscription is scheduled before the month, active within it, and expired at its exclusive end', () => {
  const bounds = getSubscriptionPeriodBounds('2026-11');
  assert.equal(getSubscriptionPeriodStatus(bounds, new Date('2026-10-31T18:59:59.999Z')), 'scheduled');
  assert.equal(getSubscriptionPeriodStatus(bounds, new Date('2026-10-31T19:00:00.000Z')), 'active');
  assert.equal(getSubscriptionPeriodStatus(bounds, new Date('2026-11-30T18:59:59.999Z')), 'active');
  assert.equal(getSubscriptionPeriodStatus(bounds, new Date('2026-11-30T19:00:00.000Z')), 'expired');
});

test('review status is accepted only when invoice and submission are linked and pending', () => {
  const invoice = { id: 'invoice-1', teacherUid: 'teacher-1', status: 'payment_pending', paymentStatus: 'pending_review', receiptId: 'receipt-1' };
  const submission = { id: 'receipt-1', teacherUid: 'teacher-1', invoiceId: 'invoice-1', status: 'pending_review' };
  assert.equal(isReviewablePayment(invoice, submission, 'receipt-1'), true);
  assert.equal(isReviewablePayment(invoice, submission, 'receipt-2'), false);
  assert.equal(isReviewablePayment(invoice, { ...submission, teacherUid: 'other-teacher' }, 'receipt-1'), false);
  assert.equal(isReviewablePayment(invoice, { ...submission, status: 'approved' }, 'receipt-1'), false);
  assert.equal(isReviewablePayment({ ...invoice, paymentStatus: 'paid' }, submission, 'receipt-1'), false);
});
