import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

 test('teacher entitlement resolver reads only relevant plan documents and only current periods when possible', () => {
  const source = read('server/subscriptionEntitlements.ts');
  assert.doesNotMatch(source, /collection\('subscriptionPlans'\)\.get\(\)/);
  assert.match(source, /collection\('subscriptionPlans'\)\.doc\(planId\)\.get\(\)/);
  assert.match(source, /where\('status', 'in', \['active', 'scheduled', 'ACTIVE', 'SCHEDULED'\]\)/);
  assert.match(source, /if \(eligiblePeriods\.length === 0 && !legacyAllowed && !hasFutureApprovedPeriod\)/);
  assert.match(source, /where\('status', 'in', \['active', 'scheduled', 'ACTIVE', 'SCHEDULED'\]\)/);
});

test('read-only entitlement checks skip unchanged projection writes without an extra projection read', () => {
  const source = read('server/subscriptionEntitlements.ts');
  assert.match(source, /serverProjectionFingerprint/);
  assert.match(source, /const projectionChanged = writeGuard\?\.markerData\.serverProjectionFingerprint !== fingerprint/);
  assert.match(source, /const projectionReady = writeGuard\?\.markerData\.serverProjectionReady === true/);
  assert.match(source, /const shouldWriteProjection = projectionChanged \|\| !projectionReady/);
  assert.match(source, /if \(writeGuard && !shouldWriteProjection && !scheduleChanged\) return/);
  assert.match(source, /serverProjectionReady: true/);
  assert.match(source, /if \(shouldWriteProjection\) \{\s*batch\.set\(projectionRef/);
  assert.match(source, /batch\.set\(writeGuard\.markerRef/);
  const syncStart = source.indexOf('export async function syncTeacherEntitlementProjection(');
  const syncEnd = source.indexOf('type AcademyPermissionActor', syncStart);
  assert.ok(syncStart >= 0 && syncEnd > syncStart);
  assert.doesNotMatch(source.slice(syncStart, syncEnd), /\.get\(\)/);
});

test('subscription scheduler avoids repeated projection and account writes while preserving minute cadence', () => {
  const source = read('src/functions/src/subscriptionProjectionRefresh.ts');
  const scheduler = read('src/functions/src/subscriptionProjectionScheduler.ts');
  assert.match(scheduler, /schedule: 'every 1 minutes'/);
  assert.match(source, /schedulerProjectionFingerprint/);
  assert.match(source, /const projectionChanged = registry\.schedulerProjectionFingerprint !== fingerprint/);
  assert.doesNotMatch(source, /serverProjectionFingerprint:\s*null/);
  assert.match(source, /const accountNeedsUpdate =/);
  assert.match(source, /collectionGroup\('customers'\)/);
  assert.match(source, /projectionNextRefreshAt/);
  assert.match(source, /backfillOneCustomerPage/);
  assert.match(source, /!selectedPeriod && hasLegacyAccountWindow/);
});


test('subscription fallback history reads are bounded to the latest period', () => {
  const resolver = read('server/subscriptionEntitlements.ts');
  assert.match(resolver, /collection\('periods'\)\.orderBy\('startedAt', 'desc'\)\.limit\(1\)\.get\(\)/);
  assert.doesNotMatch(resolver, /collection\('periods'\)\.get\(\)/);
  const adminSubscriptions = read('server/adminSubscriptions.ts');
  assert.match(adminSubscriptions, /collection\('periods'\)\.where\('status', 'in', \['active', 'scheduled'\]\)\.get\(\)/);
  assert.match(adminSubscriptions, /await refreshTeacherEntitlementProjection\(context\.db, teacher\.uid, teacher\.email\)/);
});

test('due projection scheduler backfills once and does not scan all customers on every minute run', () => {
  const source = read('src/functions/src/subscriptionProjectionRefresh.ts');
  assert.match(source, /BACKFILL_PAGE_SIZE = 100/);
  assert.match(source, /subscriptionProjectionBackfillComplete/);
  assert.match(source, /backfillBudget = BACKFILL_PAGE_SIZE/);
  assert.match(source, /rootData\.subscriptionProjectionBackfillComplete/);
  assert.match(source, /collectionGroup\('customers'\)[\s\S]*?where\('projectionNextRefreshAt', '<='/);
  assert.match(source, /DUE_PAGE_SIZE = 100/);
});

test('subscription policy changes queue only existing full-access registries for one refresh', () => {
  const source = read('server/adminSubscriptionSettings.ts');
  assert.match(source, /body\.allowUnassignedFullAccess !== previousAllowFullAccess/);
  assert.match(source, /where\('accessMode', '==', 'unassigned_full_access'\)/);
  assert.match(source, /projectionNextRefreshAt: Timestamp\.now\(\)/);
});

test('expired WhatsApp failure cleanup queries collection groups rather than enumerating all teacher profiles', () => {
  const source = read('src/functions/src/whatsappFailedJobCleanup.ts');
  assert.match(source, /collectionGroup\("whatsappNotificationJobs"\)/);
  assert.match(source, /collectionGroup\("feeAlertNotificationJobs"\)/);
  assert.match(source, /const isTeacherTenant =/);
  assert.match(source, /if \(!\(await isTeacherTenant\(tenantRef\)\)\) return/);
  assert.doesNotMatch(source, /db\.collection\("users"\)\.where\("role", "==", "teacher"\)\.get\(\)/);
  const indexes = JSON.parse(read('firestore.indexes.json'));
  for (const group of ['whatsappNotificationJobs', 'feeAlertNotificationJobs']) {
    assert.ok(indexes.indexes.some((entry) => entry.collectionGroup === group && entry.queryScope === 'COLLECTION_GROUP'));
  }
});

test('WhatsApp settings GET does not rewrite unchanged admin metadata and teacher list is server-filtered', () => {
  const source = read('server/adminWhatsApp.ts');
  assert.match(source, /if \(rootReadSucceeded && adminMetadataChanged\)/);
  assert.match(source, /collection\("users"\)\.where\("role", "==", "teacher"\)\.get\(\)/);
  assert.match(source, /legacyTeacherMigration/);
  assert.match(source, /migrationState\.data\(\)\?\.complete === true/);
});

test('worker failure alert avoids writing an unchanged materialized alert', () => {
  const source = read('server/whatsappQueueWorker.ts');
  assert.match(source, /const payloadUnchanged = Object\.entries\(payload\)/);
  assert.match(source, /if \(payloadUnchanged && !sourceChanged\) return/);
});

test('dashboard metrics polling pauses while hidden and prevents overlapping requests', () => {
  const source = read('src/pages/Dashboard.tsx');
  assert.match(source, /document\.visibilityState !== 'visible' \|\| inFlight/);
  assert.match(source, /document\.addEventListener\('visibilitychange', handleVisibilityChange\)/);
});

test('admin dashboard and analytics keep five-minute visible polling and pause in hidden tabs', () => {
  const dashboard = read('src/pages/admin/AdminDashboard.tsx');
  const analytics = read('src/pages/admin/Analytics.tsx');
  assert.match(dashboard, /const POLL_INTERVAL_MS = 5 \* 60_000/);
  assert.match(analytics, /const REFRESH_INTERVAL_MS = 5 \* 60_000/);
  assert.match(dashboard, /Refresh interval: 5 minutes/);
  assert.match(dashboard, /document\.visibilityState === 'visible'/);
  assert.match(analytics, /document\.visibilityState === 'visible'/);
});

test('started scheduled periods remain due until the scheduler normalizes their status', () => {
  const resolver = read('server/subscriptionEntitlements.ts');
  const scheduler = read('src/functions/src/subscriptionProjectionRefresh.ts');
  assert.match(resolver, /status === 'scheduled' && periodStart && periodEnd && periodStart\.getTime\(\) <= nowMs && periodEnd\.getTime\(\) > nowMs/);
  assert.match(resolver, /futureBoundaries\.push\(periodStart\.getTime\(\)\)/);
  assert.match(scheduler, /serverProjectionFingerprint: FieldValue\.delete\(\)/);
});
