import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUARDIAN_CONSENT_CAPABILITIES,
  STUDENT_CONSENT_CONFIG,
  buildStudentRecord,
  hasDuplicateRollNumber,
  listStudentRecords,
  normalizePakistaniPhone,
  planStudentRosterAdd,
} from '../server/studentRosterDomain.mjs';

const baseStudent = {
  name: 'Ayesha Khan',
  fatherName: 'Ahmed Khan',
  phone: '0300 1234567',
  rollNo: '001',
  gender: 'Female',
  studentFee: '5000',
  avatar: 'https://example.com/avatar.png',
};
const allAllowed = Object.fromEntries(STUDENT_CONSENT_CONFIG.map((item) => [item.permissionKey, true]));
const allRequested = Object.fromEntries(STUDENT_CONSENT_CONFIG.map((item) => [item.input, true]));

test('guardian consent availability is separate from teacher module permissions', () => {
  const { student } = buildStudentRecord({ ...baseStudent, attendanceWhatsAppOptIn: true }, GUARDIAN_CONSENT_CAPABILITIES, 122);
  assert.equal(student.attendanceWhatsAppOptIn, true);
  assert.equal(student.quizResultsWhatsAppOptIn, false);
  assert.equal(student.feeAlertsWhatsAppOptIn, false);
});

test('server phone normalization validates Pakistani guardian numbers and retains international prefix format', () => {
  assert.equal(normalizePakistaniPhone('0300 1234567'), '+92 300 1234567');
  assert.equal(normalizePakistaniPhone('+92 300 1234567'), '+92 300 1234567');
  assert.equal(normalizePakistaniPhone('123'), '');
});

test('each consent persists independently with its own timestamp and exact guardian phone binding', () => {
  const { student } = buildStudentRecord({ ...baseStudent, ...allRequested }, allAllowed, 123);
  for (const item of STUDENT_CONSENT_CONFIG) {
    assert.equal(student[item.property], true, `${item.permissionKey} should be true`);
    assert.ok(typeof student[item.timestamp] === 'string' && student[item.timestamp].length > 0);
    assert.equal(student[item.phone], '+92 300 1234567');
  }
  const timestamps = new Set(STUDENT_CONSENT_CONFIG.map((item) => student[item.timestamp]));
  assert.equal(timestamps.size, STUDENT_CONSENT_CONFIG.length, 'each purpose gets a distinct timestamp value');
});

test('a Yes for one purpose cannot enable another purpose', () => {
  const { student } = buildStudentRecord({ ...baseStudent, attendanceWhatsAppOptIn: true }, allAllowed, 124);
  assert.equal(student.attendanceWhatsAppOptIn, true);
  assert.equal(student.parentWhatsAppOptIn, false);
  assert.equal(student.quizResultsWhatsAppOptIn, false);
  assert.equal(student.feeAlertsWhatsAppOptIn, false);
  assert.equal(student.announcementWhatsAppOptIn, false);
  assert.equal(student.libraryLinkWhatsAppOptIn, false);
});

test('locked consent fields are forced false without timestamp or phone binding and are reported', () => {
  const permissions = { ...allAllowed, fee_alerts: false, announcements: false, library_link_whatsapp: false };
  const { student, ignoredConsentFeatures } = buildStudentRecord({ ...baseStudent, ...allRequested }, permissions, 125);
  for (const item of STUDENT_CONSENT_CONFIG.filter((field) => permissions[field.permissionKey] === false)) {
    assert.equal(student[item.property], false);
    assert.equal(student[item.timestamp], null);
    assert.equal(student[item.phone], null);
    assert.ok(ignoredConsentFeatures.includes(item.permissionKey));
  }
  assert.equal(student.attendanceWhatsAppOptIn, true);
  assert.equal(student.parentWhatsAppOptIn, true);
});

test('blank, No and invalid consent values never result in a grant at server boundary', () => {
  const values = { ...baseStudent, attendanceWhatsAppOptIn: false, feeAlertsWhatsAppOptIn: 'Yes' };
  const { student } = buildStudentRecord(values, allAllowed, 126);
  assert.equal(student.attendanceWhatsAppOptIn, false);
  assert.equal(student.attendanceWhatsAppOptInAt, null);
  assert.equal(student.attendanceWhatsAppOptInPhone, null);
  assert.equal(student.feeAlertsWhatsAppOptIn, false);
});

test('guardian phone consent binding uses the new guardian number and never carries a previous phone', () => {
  const { student } = buildStudentRecord({ ...baseStudent, phone: '0311 9876543', attendanceWhatsAppOptIn: true }, allAllowed, 127);
  assert.equal(student.attendanceWhatsAppOptInPhone, '+92 311 9876543');
});

test('adding students preserves existing array, nested map and legacy top-level roster layouts', () => {
  const arrayPlan = planStudentRosterAdd({ students: [{ id: 1, rollNo: 'old' }] }, { id: 2, rollNo: 'new' });
  assert.equal(arrayPlan.type, 'array');
  assert.equal(arrayPlan.students[0].id, 2);
  const nestedPlan = planStudentRosterAdd({ students: { 0: { id: 1, name: 'Existing' } } }, { id: 2, name: 'New' });
  assert.deepEqual({ type: nestedPlan.type, key: nestedPlan.key }, { type: 'studentsMap', key: '1' });
  const legacyPlan = planStudentRosterAdd({ name: 'Class', 0: { id: 1, name: 'Existing' } }, { id: 2, name: 'New' });
  assert.deepEqual({ type: legacyPlan.type, key: legacyPlan.key }, { type: 'topLevel', key: '1' });
  const emptyPlan = planStudentRosterAdd({ students: [] }, { id: 3, name: 'A' });
  assert.deepEqual(emptyPlan.students.map((student) => student.id), [3]);
});

test('duplicate roll checks are case-insensitive across supported roster layouts', () => {
  const classData = { students: [{ id: 1, rollNo: 'Ab-01' }] };
  assert.equal(hasDuplicateRollNumber(classData, 'ab-01'), true);
  assert.equal(hasDuplicateRollNumber(classData, 'AB-02'), false);
  assert.equal(listStudentRecords(classData).length, 1);
});
