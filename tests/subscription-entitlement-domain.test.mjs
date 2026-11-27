import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEntitlementFromRecords, featureStateAllowsAccess, isEntitlementProjectionCurrent } from '../server/subscriptionEntitlementDomain.mjs';
import { createDefaultFeaturePermissions } from '../server/subscriptionFeaturePermissions.mjs';

const now = new Date('2026-11-14T06:00:00.000Z');
const activePeriod = (overrides = {}) => ({
  id: '2026-11',
  data: {
    status: 'active',
    approved: true,
    planId: 'basic-id',
    planName: 'Basic',
    startedAt: new Date('2026-11-01T00:00:00.000Z'),
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    featurePermissions: createDefaultFeaturePermissions('basic'),
    ...overrides,
  },
});

 test('only an approved, active, date-valid period grants access', () => {
  const result = resolveEntitlementFromRecords({ account: { status: 'active' }, periods: [activePeriod()], now });
  assert.equal(result.active, true);
  assert.equal(result.status, 'active');
  assert.equal(result.featurePermissions.student_management, 'enabled');
  assert.equal(result.featurePermissions.weekly_reports, 'disabled');
});

test('pending, scheduled, expired, suspended and malformed periods fail closed', () => {
  for (const override of [
    { status: 'pending' },
    { status: 'suspended' },
    { status: 'expired' },
    { expiresAt: new Date('2026-11-13T00:00:00.000Z') },
    { startedAt: new Date('2026-11-15T00:00:00.000Z') },
    { expiresAt: new Date('2026-10-01T00:00:00.000Z') },
  ]) {
    const result = resolveEntitlementFromRecords({ account: { status: 'active' }, periods: [activePeriod(override)], now });
    assert.equal(result.active, false, `period override should not grant: ${JSON.stringify(override)}`);
  }
});

test('approved scheduled subscription activates only after its start boundary', () => {
  const future = resolveEntitlementFromRecords({ account: { status: 'scheduled' }, periods: [activePeriod({ status: 'scheduled', startedAt: new Date('2026-11-15T00:00:00.000Z') })], now });
  assert.equal(future.active, false);
  const due = resolveEntitlementFromRecords({ account: { status: 'pending_payment', active: false }, periods: [activePeriod({ status: 'scheduled' })], now });
  assert.equal(due.active, true);
  assert.equal(due.status, 'active');
});

test('suspended account blocks otherwise valid approved periods', () => {
  const result = resolveEntitlementFromRecords({ account: { status: 'suspended' }, periods: [activePeriod()], now });
  assert.equal(result.active, false);
  assert.equal(result.status, 'suspended');
});

test('an explicitly inactive subscription account blocks otherwise valid periods', () => {
  const result = resolveEntitlementFromRecords({ account: { active: false, status: 'active' }, periods: [activePeriod()], now });
  assert.equal(result.active, false);
});

test('approved period permission snapshot is not silently expanded by current plan catalog', () => {
  const result = resolveEntitlementFromRecords({
    account: { status: 'active' },
    periods: [activePeriod({ featurePermissions: { student_management: true, class_management: true } })],
    plans: [{ id: 'basic-id', data: { name: 'Pro', featurePermissions: createDefaultFeaturePermissions('pro') } }],
    now,
  });
  assert.equal(result.active, true);
  assert.equal(result.featurePermissions.student_management, 'enabled');
  assert.equal(result.featurePermissions.weekly_reports, 'disabled');
  assert.equal(result.featurePermissions.custom_alerts, 'disabled');
});

test('legacy account path requires explicit start and expiry within current window', () => {
  const valid = resolveEntitlementFromRecords({
    account: { active: true, status: 'active', startedAt: new Date('2026-11-01T00:00:00Z'), expiresAt: new Date('2026-12-01T00:00:00Z'), featurePermissions: createDefaultFeaturePermissions('basic') },
    now,
  });
  assert.equal(valid.active, true);
  const noExpiry = resolveEntitlementFromRecords({ account: { active: true, status: 'active', startedAt: new Date('2026-11-01T00:00:00Z') }, now });
  assert.equal(noExpiry.active, false);
});

test('unknown and disabled permission keys never grant access; configurable remains explicit', () => {
  const permissions = createDefaultFeaturePermissions('basic');
  assert.equal(featureStateAllowsAccess(permissions, 'fee_tracking'), true);
  assert.equal(featureStateAllowsAccess(permissions, 'custom_alerts'), false);
  assert.equal(featureStateAllowsAccess(permissions, 'made_up_feature'), false);
});

test('projection validation checks status and date bounds', () => {
  assert.equal(isEntitlementProjectionCurrent({ active: true, status: 'active', startedAt: new Date('2026-11-01'), expiresAt: new Date('2026-12-01') }, now), true);
  assert.equal(isEntitlementProjectionCurrent({ active: true, status: 'suspended', startedAt: new Date('2026-11-01'), expiresAt: new Date('2026-12-01') }, now), false);
  assert.equal(isEntitlementProjectionCurrent({ active: true, status: 'active', startedAt: new Date('2026-11-01'), expiresAt: new Date('2026-11-13') }, now), false);
});


test('explicit unassigned full access is separate from paid subscription and can be disabled by policy', () => {
  const account = { active: true, status: 'active', accessMode: 'unassigned_full_access', fullAccessGranted: true };
  const allowed = resolveEntitlementFromRecords({ account, registrationPolicy: { allowUnassignedFullAccess: true }, now });
  assert.equal(allowed.active, true);
  assert.equal(allowed.accessMode, 'unassigned_full_access');
  assert.equal(allowed.planId, null);
  assert.equal(allowed.featurePermissions.fee_alerts, 'enabled');
  const disabled = resolveEntitlementFromRecords({ account, registrationPolicy: { allowUnassignedFullAccess: false }, now });
  assert.equal(disabled.active, false);
  assert.ok(Object.values(disabled.featurePermissions).every((state) => state === 'disabled'));
});

test('approved, date-valid tenant add-ons grant only their feature keys and pending/revoked/expired add-ons grant nothing', () => {
  const addons = [
    { id: 'approved', data: { status: 'active', approved: true, featureKeys: ['fee_alerts'], startsAt: new Date('2026-11-01'), expiresAt: new Date('2026-12-01') } },
    { id: 'pending', data: { status: 'pending', approved: false, featureKeys: ['announcements'], startsAt: new Date('2026-11-01'), expiresAt: new Date('2026-12-01') } },
    { id: 'expired', data: { status: 'active', approved: true, featureKeys: ['custom_alerts'], startsAt: new Date('2026-10-01'), expiresAt: new Date('2026-11-13') } },
    { id: 'revoked', data: { status: 'revoked', approved: true, featureKeys: ['weekly_reports'], startsAt: new Date('2026-11-01'), expiresAt: new Date('2026-12-01') } },
  ];
  const result = resolveEntitlementFromRecords({ account: { status: 'active' }, periods: [activePeriod()], addOns: addons, now });
  assert.equal(result.featurePermissions.fee_alerts, 'enabled');
  assert.equal(result.featurePermissions.announcements, 'disabled');
  assert.equal(result.featurePermissions.custom_alerts, 'disabled');
  assert.equal(result.featurePermissions.weekly_reports, 'disabled');
  assert.deepEqual(result.addOns.map((item) => item.id), ['approved']);
  assert.equal(result.featureSources.fee_alerts, 'add_on:approved');
});


test('postpaid registration snapshot grants selected plan features without creating an invoice', () => {
  const account = {
    active: true, status: 'active', accessMode: 'postpaid_monthly',
    postpaidPlanId: 'basic-id', postpaidPlanName: 'Basic',
    postpaidPlanSnapshot: { id: 'basic-id', name: 'Basic', featurePermissions: createDefaultFeaturePermissions('basic'), featureVisibilityMode: 'locked' },
    postpaidUsageBillingPeriod: '2026-11',
    postpaidUsageStartedAt: new Date('2026-11-01T00:00:00.000Z'),
    postpaidUsageExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
    postpaidInvoiceStatus: 'not_generated',
  };
  const result = resolveEntitlementFromRecords({ account, now });
  assert.equal(result.active, true);
  assert.equal(result.accessMode, 'postpaid_monthly');
  assert.equal(result.source, 'postpaid_monthly_usage');
  assert.equal(result.planId, 'basic-id');
  assert.equal(result.invoiceId, null);
  assert.equal(result.featurePermissions.student_management, 'enabled');
  assert.equal(result.featurePermissions.quiz_result_notifications, 'disabled');
  assert.equal(result.featureVisibilityMode, 'locked');
});

test('postpaid usage period expires at its exclusive end and cannot be revived by a missing invoice', () => {
  const account = {
    active: true, status: 'active', accessMode: 'postpaid_monthly', postpaidPlanId: 'basic-id',
    postpaidPlanSnapshot: { id: 'basic-id', name: 'Basic', featurePermissions: createDefaultFeaturePermissions('basic') },
    postpaidUsageStartedAt: new Date('2026-11-01T00:00:00.000Z'),
    postpaidUsageExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
  };
  const result = resolveEntitlementFromRecords({ account, now: new Date('2026-12-01T00:00:00.000Z') });
  assert.equal(result.active, false);
  assert.ok(Object.values(result.featurePermissions).every((state) => state === 'disabled'));
});

test('suspension and malformed postpaid snapshots always fail closed', () => {
  const base = {
    active: true, status: 'active', accessMode: 'postpaid_monthly', postpaidPlanId: 'basic-id',
    postpaidPlanSnapshot: { id: 'basic-id', name: 'Basic', featurePermissions: createDefaultFeaturePermissions('basic') },
    postpaidUsageStartedAt: new Date('2026-11-01T00:00:00.000Z'),
    postpaidUsageExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
  };
  assert.equal(resolveEntitlementFromRecords({ account: { ...base, status: 'suspended' }, now }).active, false);
  assert.equal(resolveEntitlementFromRecords({ account: { ...base, postpaidPlanSnapshot: null }, now }).active, false);
  assert.equal(resolveEntitlementFromRecords({ account: { ...base, postpaidPlanId: 'different' }, now }).active, false);
});


test('expired postpaid account does not fall through to an old overlapping paid period', () => {
  const result = resolveEntitlementFromRecords({
    account: {
      active: true, status: 'active', accessMode: 'postpaid_monthly', postpaidPlanId: 'basic-id',
      postpaidPlanSnapshot: { id: 'basic-id', name: 'Basic', featurePermissions: createDefaultFeaturePermissions('basic') },
      postpaidUsageStartedAt: new Date('2026-10-01T00:00:00.000Z'),
      postpaidUsageExpiresAt: new Date('2026-11-01T00:00:00.000Z'),
    },
    periods: [activePeriod()],
    now: new Date('2026-11-14T06:00:00.000Z'),
  });
  assert.equal(result.active, false);
  assert.equal(result.accessMode, 'postpaid_monthly');
  assert.equal(result.status, 'expired');
});
