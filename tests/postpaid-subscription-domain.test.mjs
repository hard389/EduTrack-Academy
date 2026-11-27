import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarMonth, createPostpaidUsageWindow, pakistanBillingMonth, renewPostpaidUsageWindow } from '../server/postpaidSubscriptionDomain.mjs';

test('postpaid usage window runs for one calendar month and retains Pakistan billing month', () => {
  const start = new Date('2026-11-15T08:30:00.000Z');
  const window = createPostpaidUsageWindow(start);
  assert.equal(window.billingPeriod, '2026-11');
  assert.equal(window.startedAt.toISOString(), start.toISOString());
  assert.equal(window.expiresAt.toISOString(), '2026-12-15T08:30:00.000Z');
});

test('calendar-month addition clamps month-end dates, including leap February', () => {
  assert.equal(addCalendarMonth(new Date('2027-01-31T12:00:00Z')).toISOString(), '2027-02-28T12:00:00.000Z');
  assert.equal(addCalendarMonth(new Date('2028-01-31T12:00:00Z')).toISOString(), '2028-02-29T12:00:00.000Z');
});

test('renewal starts at the old expiry when still active and starts now when already expired', () => {
  const stillActive = renewPostpaidUsageWindow({ currentExpiresAt: new Date('2026-12-15T00:00:00Z'), now: new Date('2026-12-10T00:00:00Z') });
  assert.equal(stillActive.startedAt.toISOString(), '2026-12-15T00:00:00.000Z');
  assert.equal(stillActive.expiresAt.toISOString(), '2027-01-15T00:00:00.000Z');
  const expired = renewPostpaidUsageWindow({ currentExpiresAt: new Date('2026-12-15T00:00:00Z'), now: new Date('2027-01-02T00:00:00Z') });
  assert.equal(expired.startedAt.toISOString(), '2027-01-02T00:00:00.000Z');
  assert.equal(expired.billingPeriod, '2027-01');
});

test('Pakistan billing month uses the +05:00 local date boundary', () => {
  assert.equal(pakistanBillingMonth(new Date('2026-11-30T20:00:00.000Z')), '2026-12');
});
