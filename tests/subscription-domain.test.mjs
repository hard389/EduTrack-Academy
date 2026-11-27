import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDiscountPaisa,
  isValidPeriodKey,
  makeSubscriptionInvoiceId,
} from '../server/subscriptionDomain.mjs';

test('billing period accepts real YYYY-MM months only', () => {
  assert.equal(isValidPeriodKey('2026-11'), true);
  assert.equal(isValidPeriodKey('2026-13'), false);
  assert.equal(isValidPeriodKey('2026-2'), false);
  assert.equal(isValidPeriodKey('2026-02-30'), false);
});

test('subscription invoice ID is deterministic for one teacher and month', () => {
  assert.equal(makeSubscriptionInvoiceId('2026-11', 'teacher_123'), '2026-11_teacher_123');
  assert.equal(makeSubscriptionInvoiceId('2026-11', 'teacher_123'), makeSubscriptionInvoiceId('2026-11', 'teacher_123'));
  assert.throws(() => makeSubscriptionInvoiceId('2026-11', '../teacher'), /UID/);
});

test('percentage discounts round to the nearest paisa', () => {
  assert.equal(calculateDiscountPaisa(10_001, { discountType: 'percentage', discountValue: 10 }), 1_000);
});

test('fixed discounts cannot reduce the invoice below zero', () => {
  assert.equal(calculateDiscountPaisa(5_000, { discountType: 'fixed', discountValue: 8_000 }), 5_000);
});

test('100 percent discount is allowed but over 100 percent is rejected', () => {
  assert.equal(calculateDiscountPaisa(9_999, { discountType: 'percentage', discountValue: 100 }), 9_999);
  assert.throws(() => calculateDiscountPaisa(9_999, { discountType: 'percentage', discountValue: 101 }), /cannot exceed/);
});

test('invalid money and discount types are rejected', () => {
  assert.throws(() => calculateDiscountPaisa(-1, { discountType: 'fixed', discountValue: 1 }));
  assert.throws(() => calculateDiscountPaisa(100, { discountType: 'other', discountValue: 1 }));
});
