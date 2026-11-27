import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBulkInvoiceTargets } from '../server/subscriptionBulkInvoiceDomain.mjs';

const now = Date.parse('2026-11-15T12:00:00.000Z');

test("bulk invoice targets use each customer's saved plan, pricing mode and active add-ons", () => {
  const result = buildBulkInvoiceTargets([
    {
      uid: 'teacher_1', email: 'base@gmail.com', name: 'Base Customer', planId: 'base',
      planName: 'Base Plan', pricingMode: 'per_student', accessMode: 'paid_subscription',
      activeAddOns: [{ catalogId: 'fee_alerts' }, { catalogId: 'quiz_reports' }, { catalogId: 'fee_alerts' }, { id: 'legacy-without-catalog-id' }],
    },
  ], '2026-11', now);

  assert.equal(result.targets.length, 1);
  assert.deepEqual(result.targets[0], {
    teacherUid: 'teacher_1', teacherEmail: 'base@gmail.com', teacherName: 'Base Customer',
    planId: 'base', planName: 'Base Plan', billingPeriod: '2026-11', pricingMode: 'per_student',
    addOnCatalogIds: ['fee_alerts', 'quiz_reports'], isPostpaid: false,
  });
  assert.equal(result.skipped.length, 0);
});

test('bulk invoice target retains each completed postpaid usage month', () => {
  const result = buildBulkInvoiceTargets([
    {
      uid: 'teacher_2', email: 'postpaid@gmail.com', name: 'Postpaid Customer',
      planId: 'postpaid-plan', postpaidPlanId: 'postpaid-plan', postpaidPlanName: 'Advance',
      accessMode: 'postpaid_monthly', postpaidUsageBillingPeriod: '2026-10',
      postpaidUsageExpiresAt: '2026-11-01T00:00:00.000Z', postpaidInvoiceStatus: 'paid',
      pricingMode: 'lump_sum', activeAddOns: [],
    },
  ], '2026-11', now);

  assert.equal(result.targets[0].billingPeriod, '2026-10');
  assert.equal(result.targets[0].pricingMode, 'lump_sum');
  assert.equal(result.targets[0].isPostpaid, true);
});

test('bulk invoice target skips missing plans and postpaid customers whose month is not complete', () => {
  const result = buildBulkInvoiceTargets([
    { uid: 'teacher_3', email: 'no-plan@gmail.com', accessMode: 'paid_subscription' },
    {
      uid: 'teacher_4', email: 'still-active@gmail.com', planId: 'plan-a', postpaidPlanId: 'plan-a',
      accessMode: 'postpaid_monthly', postpaidUsageBillingPeriod: '2026-11',
      postpaidUsageExpiresAt: '2026-12-01T00:00:00.000Z', postpaidInvoiceStatus: 'paid',
    },
    {
      uid: 'teacher_5', email: 'pending@gmail.com', planId: 'plan-a', postpaidPlanId: 'plan-a',
      accessMode: 'postpaid_monthly', postpaidUsageBillingPeriod: '2026-10',
      postpaidUsageExpiresAt: '2026-11-01T00:00:00.000Z', postpaidInvoiceStatus: 'pending_review',
    },
  ], '2026-11', now);

  assert.equal(result.targets.length, 0);
  assert.equal(result.skipped.length, 3);
  assert.match(result.skipped[0].reason, /No saved subscription plan/);
  assert.match(result.skipped[1].reason, /has not ended/);
  assert.match(result.skipped[2].reason, /awaiting payment or review/);
});

test('bulk invoice builder rejects invalid billing months', () => {
  assert.throws(() => buildBulkInvoiceTargets([], '2026-13', now), /valid monthly billing period/);
});

test("bulk invoice excludes add-ons already included in the customer plan and skips disabled accounts", () => {
  const result = buildBulkInvoiceTargets([
    {
      uid: 'teacher_6', email: 'included@gmail.com', planId: 'plan-a', planName: 'Advance',
      pricingMode: 'lump_sum', subscriptionStatus: 'active',
      featurePermissions: { fee_alerts: 'enabled', quiz_result_notifications: 'configurable' },
      activeAddOns: [
        { catalogId: 'fee-alerts', featureKey: 'fee_alerts' },
        { catalogId: 'quiz-results', featureKey: 'quiz_result_notifications' },
      ],
    },
    {
      uid: 'teacher_7', email: 'suspended@gmail.com', planId: 'plan-a',
      subscriptionStatus: 'suspended', accessMode: 'paid_subscription',
    },
  ], '2026-11', now);

  assert.deepEqual(result.targets[0].addOnCatalogIds, ['quiz-results']);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /suspended, cancelled or disabled/);
});
