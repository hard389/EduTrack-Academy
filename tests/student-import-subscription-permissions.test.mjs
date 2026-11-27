import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoDetectStudentColumnMap,
  getStudentTemplateColumns,
  getIgnoredStudentConsentColumnLabels,
  getStudentConsentFormValues,
  parseStudentConsent,
  STUDENT_CONSENT_COLUMNS,
} from '../src/lib/studentImportSchema.mjs';
import { createDefaultFeaturePermissions } from '../server/subscriptionFeaturePermissions.mjs';

const readable = (permissions) => (key) => permissions[key] === 'enabled' || permissions[key] === 'configurable';
const consentLabels = (permissions) => getStudentTemplateColumns(readable(permissions)).map((column) => column.label);

test('Basic permission matrix includes Attendance and Monthly Report but excludes locked consent options', () => {
  const labels = consentLabels(createDefaultFeaturePermissions('basic'));
  assert.deepEqual(labels, [
    'Student Name', "Father's Name", 'Parent/Guardian WhatsApp', 'Roll Number', 'Gender', 'Monthly Fee (PKR)',
    'Attendance Alert WhatsApp Consent', 'Monthly Report WhatsApp Consent', 'Photo URL',
  ]);
});

test('Advance permission matrix includes configurable features exactly as canAccessFeature does', () => {
  const labels = consentLabels(createDefaultFeaturePermissions('advance'));
  for (const label of [
    'Attendance Alert WhatsApp Consent', 'Monthly Report WhatsApp Consent', 'Quiz Results WhatsApp Consent',
    'Fee Alerts WhatsApp Consent', 'Announcement WhatsApp Consent', 'Library Links WhatsApp Consent',
  ]) assert.ok(labels.includes(label), label);
});

test('Pro permission matrix includes permitted options but excludes disabled Quiz Results', () => {
  const labels = consentLabels(createDefaultFeaturePermissions('pro'));
  assert.ok(!labels.includes('Quiz Results WhatsApp Consent'));
  assert.ok(labels.includes('Fee Alerts WhatsApp Consent'));
  assert.ok(labels.includes('Announcement WhatsApp Consent'));
  assert.ok(labels.includes('Library Links WhatsApp Consent'));
});

test('custom permissions and enabled/configurable add-on overrides are honored without plan-name assumptions', () => {
  const permissions = {
    ...createDefaultFeaturePermissions('basic'),
    announcements: 'enabled',
    library_link_whatsapp: 'configurable',
    fee_alerts: 'disabled',
  };
  const labels = consentLabels(permissions);
  assert.ok(labels.includes('Announcement WhatsApp Consent'));
  assert.ok(labels.includes('Library Links WhatsApp Consent'));
  assert.ok(!labels.includes('Fee Alerts WhatsApp Consent'));
  assert.deepEqual(getStudentTemplateColumns(() => false).map((column) => column.label), [
    'Student Name', "Father's Name", 'Parent/Guardian WhatsApp', 'Roll Number', 'Gender', 'Monthly Fee (PKR)', 'Photo URL',
  ]);
});

test('legacy attendance heading maps to attendance only; generic consent headings map to no purpose', () => {
  const attendanceOnly = autoDetectStudentColumnMap([
    'Student Name', "Father's Name", 'Parent/Guardian WhatsApp', 'Roll Number', 'Gender', 'Monthly Fee (PKR)',
    'Attendance Alert WhatsApp Consent',
  ]);
  assert.equal(attendanceOnly.attendanceConsent, 'Attendance Alert WhatsApp Consent');
  assert.equal(attendanceOnly.feeAlertsConsent, '');
  const generic = autoDetectStudentColumnMap(['Consent']);
  for (const key of ['attendanceConsent', 'monthlyReportConsent', 'feeAlertsConsent']) assert.equal(generic[key], '');
});

test('all purpose-specific consent aliases map independently', () => {
  const map = autoDetectStudentColumnMap(STUDENT_CONSENT_COLUMNS.map((column) => column.label));
  for (const column of STUDENT_CONSENT_COLUMNS) assert.equal(map[column.key], column.label);
});

test('only explicit Yes grants consent; No, blank and invalid values remain false', () => {
  assert.equal(parseStudentConsent('Yes'), true);
  assert.equal(parseStudentConsent(' yes '), true);
  for (const value of ['No', '', undefined, 'TRUE', '1', 'unknown']) assert.equal(parseStudentConsent(value), false);
});

test('import revalidation ignores old consent columns after downgrade and grants only still-accessible purposes', () => {
  const uploadedMap = autoDetectStudentColumnMap(STUDENT_CONSENT_COLUMNS.map((column) => column.label));
  const downgraded = {
    attendance_alerts: 'enabled', monthly_reports: 'configurable', quiz_result_notifications: 'disabled',
    fee_alerts: 'disabled', announcements: 'disabled', library_link_whatsapp: 'disabled',
  };
  assert.deepEqual(getIgnoredStudentConsentColumnLabels(uploadedMap, downgraded), [
    'Quiz Results WhatsApp Consent', 'Fee Alerts WhatsApp Consent', 'Announcement WhatsApp Consent', 'Library Links WhatsApp Consent',
  ]);
  assert.deepEqual(getStudentConsentFormValues({
    attendanceConsent: true, monthlyReportConsent: true, quizResultsConsent: true,
    feeAlertsConsent: true, announcementConsent: true, libraryLinkConsent: true,
  }, downgraded), {
    attendanceWhatsAppOptIn: true, monthlyReportWhatsAppOptIn: true, quizResultsWhatsAppOptIn: false,
    feeAlertsWhatsAppOptIn: false, announcementWhatsAppOptIn: false, libraryLinkWhatsAppOptIn: false,
  });
});

test('missing permission keys fail closed for import consent mapping', () => {
  const values = getStudentConsentFormValues({ attendanceConsent: true }, {});
  assert.equal(values.attendanceWhatsAppOptIn, false);
  assert.deepEqual(getIgnoredStudentConsentColumnLabels({ attendanceConsent: 'Attendance Alert WhatsApp Consent' }, {}), [
    'Attendance Alert WhatsApp Consent',
  ]);
});
