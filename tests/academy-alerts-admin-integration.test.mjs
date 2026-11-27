import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Academy Admin keeps its existing single Alerts route', async () => {
  const app = await read('src/App.tsx');
  assert.match(app, /path=["']alerts["'][^>]*element=\{<AcademyAlertsPage\s*\/>\}/);
  assert.match(app, /path=["']alerts["'][^>]*element=\{<AcademyAlertsPage\s*\/>\}/);
  assert.match(app, /path=["']alerts["'][^>]*element=\{<AcademyPermissionRoute[\s\S]*?<Alerts\s*\/>[\s\S]*?\}/);
});

test('Academy Alerts UI uses only the Academy workspace API and never teacher endpoints', async () => {
  const page = await read('src/pages/academy-admin/AcademyAlertsPage.tsx');
  assert.match(page, /academyManagementRequest/);
  assert.match(page, /action: 'academy-teacher-alerts'/);
  assert.match(page, /action: 'academy-whatsapp-dashboard'/);
  assert.match(page, /action: 'academy-whatsapp-reconcile'/);
  assert.doesNotMatch(page, /\/api\/teacher\//);
  assert.doesNotMatch(page, /tenantAlertsPath|isOwnedActiveTeacherProfile|onSnapshot|setDoc\(/);
  assert.match(page, /No message will be sent from this form/);
});

test('Academy API actions are behind the verified Academy Admin actor', async () => {
  const server = await read('server/academyAdminWorkspace.ts');
  assert.match(server, /const actor = await adminActor\(request\);[\s\S]*?case 'academy-teacher-alerts'/);
  assert.match(server, /case 'academy-whatsapp-dashboard'/);
  assert.match(server, /case 'academy-whatsapp-reconcile'/);
  assert.match(server, /allowedCategories = \['Announcements', 'Fees', 'Attendance', 'Exams'\]/);
  assert.match(server, /whatsappStatus: 'not_requested', whatsappSent: false/);
  assert.match(server, /session\.role !== 'academy_admin'/);
  assert.match(server, /member\.data\(\)\?\.active !== true/);
});

test('teacher aggregation re-verifies academy membership, workspace profile and Firebase Auth', async () => {
  const server = await read('server/academyAdminWorkspace.ts');
  assert.match(server, /academyMemberships/);
  assert.match(server, /mapping\.academyId !== actor\.session\.academyId/);
  assert.match(server, /profile\.academyId !== actor\.session\.academyId/);
  assert.match(server, /profile\.role !== 'teacher'/);
  assert.match(server, /profile\.active !== true/);
  assert.match(server, /auth\.getUser\(snapshot\.id\)/);
  assert.match(server, /authUser\.emailVerified !== true/);
});

test('Academy Admin reconciliation records the actual admin as operator and retains audit history', async () => {
  const server = await read('server/academyAdminWorkspace.ts');
  const reconciliation = await read('server/whatsappReconciliation.ts');
  assert.match(server, /reconcileWhatsAppNotificationForActor\([\s\S]*?\{ uid: actor\.session\.uid, email: actor\.session\.email, role: 'academy_admin' \}/);
  assert.match(server, /whatsapp\.teacher_alert\.reconciled/);
  assert.match(reconciliation, /reconciledByRole = operator\?\.role \|\| "teacher"/);
  assert.match(reconciliation, /decision !== "confirmed_sent" && decision !== "confirmed_not_sent"/);
});

test('existing teacher dashboard and reconciliation handlers keep their own teacher authentication', async () => {
  const dashboard = await read('server/teacherWhatsAppAlerts.ts');
  const reconciliation = await read('server/whatsappReconciliation.ts');
  assert.match(dashboard, /export async function getTeacherWhatsAppAlertsDashboard\(request: Request\) \{\s*const actor = await verifyTeacherRequest\(request\);\s*await assertTeacherActorFeatureEntitlement\(actor, "announcements"\);/);
  assert.match(reconciliation, /export async function reconcileWhatsAppNotification\(request: ReconcileRequest\) \{\s*const actor = await verifyTeacherRequest\(request\);/);
});

test('rebasing Alerts preserves the existing Student Extra Charges action', async () => {
  const server = await read('server/academyAdminWorkspace.ts');
  assert.match(server, /import \{ normalizeAcademyStudentExtraCharges \} from '\.\/academyStudentExtraChargesDomain\.mjs';/);
  assert.match(server, /async function updateStudentExtraCharges\(/);
  assert.match(server, /case 'update-student-extra-charges': return updateStudentExtraCharges\(actor, body\);/);
});
