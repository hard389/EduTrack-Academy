import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildAddOnInvoiceSnapshots,
  normalizeOfferMutation,
  parsePakistanEndDate,
  parsePakistanStartDate,
  selectReactivationPeriod,
  validateAdminSubscriptionCommand,
} from '../server/subscriptionAdminDomain.mjs';

const now = new Date('2026-11-15T07:00:00.000Z');

const validAdminCommand = {
  operation: 'assign',
  planId: 'plan_basic_01',
  startsAt: '2026-11-15',
  expiresAt: '2026-12-14',
  reason: 'Approved complimentary onboarding period',
  adminConfirmed: true,
};

test('manual assignment requires explicit admin confirmation and a reason', () => {
  assert.throws(() => validateAdminSubscriptionCommand({ ...validAdminCommand, adminConfirmed: false }, { now }), /Confirm/);
  assert.throws(() => validateAdminSubscriptionCommand({ ...validAdminCommand, reason: 'ok' }, { now }), /reason of 10 to 500/);
  const command = validateAdminSubscriptionCommand(validAdminCommand, { now });
  assert.equal(command.operation, 'assign');
  assert.equal(command.planId, 'plan_basic_01');
  assert.ok(command.startsAt instanceof Date);
  assert.ok(command.expiresAt instanceof Date);
  assert.ok(command.expiresAt > command.startsAt);
});

test('manual change, extension, suspend, reactivate and cancel accept only supported operations', () => {
  for (const operation of ['change', 'extend', 'suspend', 'reactivate', 'cancel']) {
    const input = { ...validAdminCommand, operation };
    if (operation !== 'change') delete input.planId;
    if (operation === 'extend') delete input.startsAt;
    const result = validateAdminSubscriptionCommand(input, { now });
    assert.equal(result.operation, operation);
  }
  assert.throws(() => validateAdminSubscriptionCommand({ ...validAdminCommand, operation: 'delete' }, { now }), /valid customer subscription operation/);
});

test('Pakistan date boundaries use UTC+05 and end dates remain inclusive', () => {
  assert.equal(parsePakistanStartDate('2026-12-01').toISOString(), '2026-11-30T19:00:00.000Z');
  assert.equal(parsePakistanEndDate('2026-12-01').toISOString(), '2026-12-01T18:59:59.999Z');
  assert.throws(() => parsePakistanStartDate('2026-02-30'), /valid calendar date/);
  assert.throws(() => parsePakistanEndDate('2026-13-01'), /valid calendar date/);
});

test('reactivation prefers a current eligible period, otherwise the nearest future period', () => {
  const periods = [
    { id: 'far-future', data: { status: 'scheduled', approved: true }, startsAt: new Date('2027-02-01T00:00:00Z'), expiresAt: new Date('2027-03-01T00:00:00Z') },
    { id: 'current', data: { status: 'active', approved: true }, startsAt: new Date('2026-11-01T00:00:00Z'), expiresAt: new Date('2026-12-01T00:00:00Z') },
    { id: 'near-future', data: { status: 'scheduled', approved: true }, startsAt: new Date('2026-12-01T00:00:00Z'), expiresAt: new Date('2027-01-01T00:00:00Z') },
    { id: 'revoked', data: { status: 'cancelled', approved: true }, startsAt: new Date('2026-11-15T00:00:00Z'), expiresAt: new Date('2026-12-01T00:00:00Z') },
  ];
  assert.equal(selectReactivationPeriod(periods, now).id, 'current');
  assert.equal(selectReactivationPeriod(periods.filter((item) => item.id !== 'current'), now).id, 'near-future');
});

test('offer editing validates discount, dates and selected plan IDs', () => {
  const patch = normalizeOfferMutation({
    name: 'Winter renewal',
    description: 'Discount for selected plans',
    discountType: 'percentage',
    discountValue: 25,
    validFrom: '2026-11-01',
    validUntil: '2026-12-31',
    planIds: ['basic', 'pro', 'basic'],
  });
  assert.equal(patch.name, 'Winter renewal');
  assert.equal(patch.discountValue, 25);
  assert.deepEqual(patch.planIds, ['basic', 'pro']);
  assert.throws(() => normalizeOfferMutation({ discountType: 'percentage', discountValue: 101 }, { discountType: 'percentage', discountValue: 20 }), /discount value is invalid/);
  assert.throws(() => normalizeOfferMutation({ validFrom: '2026-12-31' }, { validFrom: '2026-12-31', validUntil: '2026-11-30' }), /end date cannot precede/);
  assert.throws(() => normalizeOfferMutation({ planIds: ['bad/id'] }), /invalid plan ID/);
});

test('paid add-on invoice snapshots freeze catalog names, features and monthly prices', () => {
  const catalog = [
    { id: 'fee_addon', name: 'Fee Alerts', description: 'Fee reminder alerts', featureKey: 'fee_alerts', monthlyPricePaisa: 50000, active: true },
    { id: 'analytics_addon', name: 'Advanced Analytics', description: 'Advanced reports', featureKey: 'advanced_analytics', monthlyPricePaisa: 80000, active: true },
  ];
  const result = buildAddOnInvoiceSnapshots(['fee_addon', 'analytics_addon', 'fee_addon'], catalog);
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.totalPaisa, 130000);
  assert.equal(result.lineItems.length, 2);
  assert.equal(result.snapshots[0].billingPeriod, 'monthly');
  assert.throws(() => buildAddOnInvoiceSnapshots(['disabled'], catalog), /no longer active/);
  assert.throws(() => buildAddOnInvoiceSnapshots(['bad_feature'], [{ id: 'bad_feature', name: 'Bad', featureKey: 'unknown_feature', monthlyPricePaisa: 100, active: true }]), /unsupported feature key/);
  assert.throws(() => buildAddOnInvoiceSnapshots(['fee_addon', 'fee_addon_2'], [
    { id: 'fee_addon', name: 'Fee Alerts A', featureKey: 'fee_alerts', monthlyPricePaisa: 100, active: true },
    { id: 'fee_addon_2', name: 'Fee Alerts B', featureKey: 'fee_alerts', monthlyPricePaisa: 200, active: true },
  ]), /Only one paid add-on per ERP feature/);
});

test('admin subscription controls are routed and write auditable, server-owned changes', () => {
  const backend = readFileSync(new URL('../server/adminSubscriptions.ts', import.meta.url), 'utf8');
  const reviews = readFileSync(new URL('../server/adminSubscriptionReviews.ts', import.meta.url), 'utf8');
  const scheduler = readFileSync(new URL('../src/functions/src/subscriptionProjectionRefresh.ts', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../src/pages/admin/Subscriptions.tsx', import.meta.url), 'utf8');
  assert.match(backend, /case 'manageCustomerSubscription'/);
  assert.match(backend, /subscriptionAuditLogs/);
  assert.match(backend, /paymentBypassed: true/);
  assert.match(backend, /case 'createAddOnCatalogItem'/);
  assert.match(backend, /addOnSnapshots/);
  assert.match(backend, /already included in the selected plan/);
  assert.match(reviews, /grantSource: 'paid_addon_invoice'/);
  assert.match(reviews, /accountPatch.status = 'scheduled'/);
  assert.match(scheduler, /'cancelled', 'canceled'/);
  assert.match(scheduler, /else if \(selectedPeriod && !accountBlocked/);
  assert.match(ui, /Administrator subscription controls/);
  assert.match(ui, /Applicable plans/);
  assert.match(ui, /Edit promotional offer/);
  assert.match(ui, /Paid monthly add-ons/);
});
