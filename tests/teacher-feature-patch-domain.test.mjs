import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAnnouncementExtraCharge,
  summarizeProviderStatuses,
  summarizeAnnouncementRecipientsByClass,
} from '../server/teacherFeaturePatchDomain.mjs';
import { LEGACY_FEATURE_PERMISSION_MAP } from '../server/academyManagementDomain.mjs';
import { readFile } from 'node:fs/promises';

test('base announcement allowance creates no extra invoice charge', () => {
  assert.deepEqual(calculateAnnouncementExtraCharge({ quotaPerClass: 4, billableClassCount: 12 }), { extraPacks: 0, amountPaisa: 0 });
});

test('extra announcement quota is charged by pack and billable class count', () => {
  assert.deepEqual(calculateAnnouncementExtraCharge({ quotaPerClass: 8, extraPackSize: 4, extraPackPricePaisa: 2500, billableClassCount: 3 }), { extraPacks: 1, amountPaisa: 7500 });
  assert.deepEqual(calculateAnnouncementExtraCharge({ quotaPerClass: 13, extraPackSize: 4, extraPackPricePaisa: 2500, billableClassCount: 2 }), { extraPacks: 3, amountPaisa: 15000 });
});

test('extra allowance without a configured price is rejected', () => {
  assert.throws(() => calculateAnnouncementExtraCharge({ quotaPerClass: 8, extraPackSize: 4, extraPackPricePaisa: 0, billableClassCount: 1 }), /requires a configured pack price/);
});

test('provider acceptance is never counted as delivery confirmation', () => {
  const result = summarizeProviderStatuses([
    { status: 'accepted_by_provider' },
    { status: 'accepted_by_postabi' },
    { status: 'delivered', deliveryConfirmed: true },
    { status: 'delivered', deliveryConfirmed: false },
    { status: 'provider_rejected' },
    { status: 'unknown_outcome' },
    { status: 'pending' },
  ]);
  assert.deepEqual(result, { providerAccepted: 2, deliveryConfirmed: 1, rejected: 1, unknownOutcome: 1, pending: 1, inspected: 7 });
});

test('announcement recipient reports count each class in a school-wide dispatch', () => {
  const summary = summarizeAnnouncementRecipientsByClass([
    { classIds: ['class-a', 'class-b'], status: 'provider_accepted' },
    { classIds: ['class-a'], status: 'provider_rejected' },
    { classIds: ['class-b'], status: 'unknown_outcome' },
  ]);
  assert.deepEqual(summary.get('class-a'), { accepted: 1, rejected: 1, unknown: 0 });
  assert.deepEqual(summary.get('class-b'), { accepted: 1, rejected: 0, unknown: 1 });
});


test('legacy teacher feature keys map to explicit Academy Admin grants', () => {
  assert.equal(LEGACY_FEATURE_PERMISSION_MAP.library_link_whatsapp, 'notes.manage');
  assert.equal(LEGACY_FEATURE_PERMISSION_MAP.announcements, 'alerts.manage');
  assert.equal(LEGACY_FEATURE_PERMISSION_MAP.quiz_management, 'quiz.view_assigned');
});

test('new Firestore announcements require a server-owned monthly quota reservation', async () => {
  const rules = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(rules, /request\.resource\.data\.announcementQuotaReservationId == notificationId/);
  assert.match(rules, /hasAnnouncementQuotaReservation\(tenantId, notificationId\)/);
  assert.match(rules, /request\.resource\.data\.get\('announcementQuotaReservationId',\s*null\)\s*==\s*resource\.data\.get\('announcementQuotaReservationId',\s*null\)/);
  assert.match(rules, /match \/announcementQuotaReservations\//);
});


test('teacher announcement access is an Academy permission and no subscription quota is applied', async () => {
  const source = await readFile(new URL('../server/announcementQuota.ts', import.meta.url), 'utf8');
  assert.match(source, /assertTeacherActorFeatureEntitlement\(actor, 'announcements'\)/);
  assert.match(source, /accessMode: 'academy_permissions'/);
  assert.match(source, /quota: null/);
  assert.match(source, /unrestricted: true/);
  assert.doesNotMatch(source, /monthlyQuota|planQuota|extraPackPrice/);
});

test('announcement dispatch reservation remains idempotent and permission-scoped', async () => {
  const source = await readFile(new URL('../server/announcementQuota.ts', import.meta.url), 'utf8');
  assert.match(source, /announcementQuotaReservations/);
  assert.match(source, /A conflicting announcement reservation exists for this request/);
  assert.match(source, /assertTeacherActorFeatureEntitlement/);
  assert.match(source, /status: 'reserved'/);
  assert.match(source, /status: 'committed'/);
});
