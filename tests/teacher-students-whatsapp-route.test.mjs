import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('student creation endpoint is reachable through the teacher API dispatcher', () => {
  const router = read('server/teacherApiRouter.ts');
  const handler = read('api-handlers/teacher/students-add.ts');
  const service = read('server/teacherStudentRoster.ts');
  const management = read('server/academyManagement.ts');
  assert.match(router, /import teacherStudentAddHandler from ["']\.\.\/api-handlers\/teacher\/students-add\.js["']/);
  assert.match(router, /defineApiRoute\(\["students", "add"\], teacherStudentAddHandler\)/);
  assert.match(handler, /addTeacherStudentToClass\(req\)/);
  assert.match(service, /createTeacherCanonicalStudentFromExistingForm/);
  assert.match(management, /requireTeacherPermission\(actor, 'students.create'\)/);
});

test('WhatsApp reconciliation endpoint is registered and teacher-authenticated', () => {
  const router = read('server/teacherApiRouter.ts');
  const handler = read('api-handlers/teacher/whatsapp/reconcile.ts');
  const service = read('server/whatsappReconciliation.ts');
  assert.match(router, /defineApiRoute\(\["whatsapp", "reconcile"\], teacherWhatsAppReconcileHandler\)/);
  assert.match(handler, /reconcileWhatsAppNotification\(req\)/);
  assert.match(service, /verifyTeacherRequest\(request\)/);
  assert.match(service, /decision !== "confirmed_sent" && decision !== "confirmed_not_sent"/);
  assert.match(service, /operator_confirmed_sent/);
  assert.match(service, /operatorRetryApprovedAt/);
});

test('Alerts UI loads tenant WhatsApp queue alerts and exposes explicit reconciliation choices', () => {
  const alerts = read('src/pages/alerts.tsx');
  assert.match(alerts, /type AlertCategory = [^\n]*'WhatsApp'/);
  assert.match(alerts, /const READABLE_ALERT_CATEGORIES: AlertCategory\[\] = \[\.\.\.ALERT_CATEGORIES, 'WhatsApp'\]/);
  assert.match(alerts, /whatsappReconciliationRequired === true/);
  assert.match(alerts, /\/api\/teacher\/whatsapp\/reconcile/);
  assert.match(alerts, /confirmed_sent/);
  assert.match(alerts, /confirmed_not_sent/);
  assert.match(alerts, /Confirm not sent & requeue/);
  assert.match(alerts, /provider history/);
});
