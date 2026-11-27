import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/pages/alerts.tsx', 'utf8');
const helper = fs.readFileSync('src/pages/alerts.logic.tsx', 'utf8');

test('retired trigger-alert settings listener and imports are fully removed', () => {
  for (const name of ['TriggerAlertSettings', 'triggerAlertsSettings', 'setTriggerAlertsSettings', 'userSettingsProfilePath']) {
    assert.equal(source.includes(name), false, `${name} should no longer be referenced`);
  }
  assert.match(source, /onAuthStateChanged\(auth/);
  assert.match(source, /isOwnedActiveTeacherProfile\(snapshot\.data\(\), user\.uid, user\.email\)/);
  assert.match(source, /generationRef\.current/);
});

test('teacher-created announcements reserve and commit quota without collecting a raw recipient phone', () => {
  assert.match(source, /const alertId = doc\(collection\(db, path\)\)\.id/);
  assert.match(source, /action: 'reserve', alertId, targetClass: newClass/);
  assert.match(source, /await setDoc\(alertRef, \{/);
  assert.match(source, /announcementQuotaReservationId: alertId/);
  assert.match(source, /action: 'commit', alertId, targetClass: newClass/);
  assert.match(source, /action: 'release', alertId, targetClass: newClass/);
  assert.doesNotMatch(source, /recipientPhone:\s*['"]{2}/);
  assert.match(helper, /tenantAlertsPath/);
});

test('new alerts never claim WhatsApp delivery before a confirmed receipt', () => {
  assert.match(source, /whatsappSent: false,/);
  assert.match(source, /whatsappDispatchStatus: sendAnnouncementWhatsApp \? 'queued' : 'not_requested'/);
  assert.doesNotMatch(source, /whatsappSent:\s*true/);
});

test('consented announcement dispatch uses the authorized API prepare and dispatch actions', () => {
  assert.match(source, /authorizedRequest\('\/api\/whatsapp\/announcement-broadcast', body\)/);
  assert.match(source, /action: 'prepare', alertId/);
  assert.match(source, /action: 'dispatch', alertId, dispatchId/);
  assert.match(source, /sessionIsActive\(context\)/);
});

test('WhatsApp reconciliation is explicit and provider acceptance is not described as delivery confirmation', () => {
  assert.match(source, /whatsappReconciliationRequired/);
  assert.match(source, /confirmed_sent/);
  assert.match(source, /confirmed_not_sent/);
  assert.match(source, /Confirm not sent & requeue/);
  assert.match(source, /Only confirmed delivery receipts count as delivered/);
});
