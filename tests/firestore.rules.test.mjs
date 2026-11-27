import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { readFileSync } from 'node:fs';

let testEnv;
const RULES_FILE = 'firestore.rules';
const FIRESTORE_EMULATOR_URL = new URL(`http://${process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'}`);
const TEACHER_UID = 'alice-uid';
const TEACHER_EMAIL = 'alice@example.com';
const ACADEMY_ID = '100';

// These are the current Academy membership permission keys, not the retired
// subscription feature-permission strings used by the original test fixture.
const allPermissions = Object.fromEntries([
  'dashboard.view',
  'classes.view_assigned', 'classes.create_assigned', 'classes.manage_all',
  'subjects.view_assigned', 'subjects.manage_all',
  'students.view_assigned', 'students.create', 'students.edit_assigned', 'students.manage_all',
  'attendance.take_assigned', 'attendance.view_assigned', 'attendance.view_all', 'attendance.correct', 'attendance.substitute_session',
  'fees.view_assigned', 'fees.collect', 'fees.view_all', 'fees.issue_invoice', 'fees.configure', 'fees.adjust', 'fees.refund', 'fees.alerts',
  'reports.view_assigned', 'reports.view_all', 'analytics.view_assigned', 'analytics.view_all',
  'notes.view', 'notes.manage', 'quiz.view_assigned', 'quiz.manage_assigned', 'alerts.view', 'alerts.manage', 'settings.profile',
].map((key) => [key, true]));

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-edutrack',
    firestore: {
      host: FIRESTORE_EMULATOR_URL.hostname,
      port: Number(FIRESTORE_EMULATOR_URL.port || 8080),
      rules: readFileSync(RULES_FILE, 'utf8'),
    },
  });
});
after(async () => { if (testEnv) await testEnv.cleanup(); });
beforeEach(async () => { await testEnv.clearFirestore(); });

async function seedTeacher({
  permissions = allPermissions,
  memberActive = true,
  mappingActive = memberActive,
  profileActive = true,
  emailVerified = true,
  academyStatus = 'active',
} = {}) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, `academies/${ACADEMY_ID}`), {
      academyId: ACADEMY_ID, academyName: 'Test Academy', ownerUid: 'academy-owner', status: academyStatus,
    });
    await setDoc(doc(db, `academies/${ACADEMY_ID}/members/${TEACHER_UID}`), {
      uid: TEACHER_UID, email: TEACHER_EMAIL, academyId: ACADEMY_ID, role: 'teacher',
      active: memberActive, emailVerified, status: memberActive ? 'active' : 'suspended', permissions,
    });
    // Intentionally omit `uid`: this is the real legacy mapping shape. Its
    // document ID is already the Firebase Auth UID.
    await setDoc(doc(db, `academyMemberships/${TEACHER_UID}`), {
      academyId: ACADEMY_ID, email: TEACHER_EMAIL, role: 'teacher',
      active: mappingActive, emailVerified, status: mappingActive ? 'active' : 'suspended',
    });
    await setDoc(doc(db, `users/${TEACHER_EMAIL}`), {
      uid: TEACHER_UID, email: TEACHER_EMAIL, role: 'teacher', active: profileActive, academyId: ACADEMY_ID,
      emailVerified, disabled: false, deleted: false,
    });
  });
}
function teacherDb() {
  return testEnv.authenticatedContext(TEACHER_UID, { email: TEACHER_EMAIL, email_verified: true }).firestore();
}

test('browser cannot self-create a teacher profile or assign its Academy identity', async () => {
  const db = teacherDb();
  await assertFails(setDoc(doc(db, `users/${TEACHER_EMAIL}`), {
    uid: TEACHER_UID, email: TEACHER_EMAIL, teacherName: 'Test Teacher', whatsappNumber: '+923001234567',
    profileImage: 'https://example.com/default-avatar.png', active: true, role: 'teacher', academyId: ACADEMY_ID,
    registrationSource: 'self_registered', approvalStatus: 'approved', createdAt: new Date().toISOString(),
  }));
});

test('verified Academy Admin can read only their Academy identity but cannot mutate it', async () => {
  const ownerUid = 'academy-owner-uid';
  const ownerEmail = 'owner@example.com';
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'academies/100'), { academyId: '100', academyName: 'Owner Academy', ownerUid, status: 'active' });
    await setDoc(doc(db, `academies/100/members/${ownerUid}`), {
      uid: ownerUid, email: ownerEmail, academyId: '100', role: 'academy_admin', active: true, emailVerified: true,
    });
    await setDoc(doc(db, `academyMemberships/${ownerUid}`), {
      academyId: '100', email: ownerEmail, role: 'academy_admin', active: true, emailVerified: true,
    });
  });
  const db = testEnv.authenticatedContext(ownerUid, { email: ownerEmail, email_verified: true }).firestore();
  await assertSucceeds(getDoc(doc(db, 'academies/100')));
  await assertSucceeds(getDoc(doc(db, `academies/100/members/${ownerUid}`)));
  await assertSucceeds(getDoc(doc(db, `academyMemberships/${ownerUid}`)));
  await assertFails(updateDoc(doc(db, 'academies/100'), { academyId: '101' }));
  await assertFails(updateDoc(doc(db, `academyMemberships/${ownerUid}`), { role: 'teacher' }));
});

test('platform super-admin claim does not create an Academy membership', async () => {
  const db = testEnv.authenticatedContext('platform-admin', { email: 'admin@example.com', email_verified: true, admin: true }).firestore();
  await assertFails(getDoc(doc(db, 'academies/100')));
  await assertFails(setDoc(doc(db, 'academyMemberships/platform-admin'), { academyId: '100', role: 'academy_admin' }));
});

test('teacher cannot alter Academy ID or Academy membership role', async () => {
  await seedTeacher();
  const db = teacherDb();
  await assertFails(updateDoc(doc(db, `users/${TEACHER_EMAIL}`), { academyId: '101' }));
  await assertFails(updateDoc(doc(db, `academyMemberships/${TEACHER_UID}`), { role: 'academy_admin' }));
  await assertFails(updateDoc(doc(db, `academies/${ACADEMY_ID}/members/${TEACHER_UID}`), { role: 'academy_admin' }));
});

test('browser cannot write Academy records or system ID counter', async () => {
  await seedTeacher();
  const db = teacherDb();
  await assertFails(setDoc(doc(db, 'academies/101'), { academyId: '101', academyName: 'Injected' }));
  await assertFails(setDoc(doc(db, 'academies/100/members/fake'), { role: 'academy_admin' }));
  await assertFails(setDoc(doc(db, 'academyMemberships/fake'), { academyId: '100', role: 'academy_admin' }));
  await assertFails(setDoc(doc(db, 'systemCounters/academyIds'), { nextId: 900 }));
  await assertFails(setDoc(doc(db, 'academyRateLimits/registration_fake'), { count: 1 }));
});

test('teacher cannot read another Academy member or private membership mapping', async () => {
  await seedTeacher();
  const db = teacherDb();
  await assertFails(getDoc(doc(db, 'academies/101')));
  await assertFails(getDoc(doc(db, 'academies/100/members/another-user')));
  await assertFails(getDoc(doc(db, 'academyMemberships/another-user')));
});

test('legacy UID-keyed membership mapping authorizes only the teacher own class projection', async () => {
  await seedTeacher({ permissions: { ...allPermissions, 'classes.view_assigned': false, 'attendance.view_assigned': true } });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `users/${TEACHER_EMAIL}/classes/class-1`), {
      academyId: ACADEMY_ID, name: 'Class 1', students: [],
    });
  });
  const db = teacherDb();
  await assertSucceeds(getDoc(doc(db, `users/${TEACHER_EMAIL}/classes/class-1`)));
  await assertFails(getDoc(doc(db, 'users/bob@example.com/classes/class-1')));
});

test('active teacher can update only the students array in a server-created class projection', async () => {
  await seedTeacher();
  const classRef = doc(teacherDb(), `users/${TEACHER_EMAIL}/classes/class-1`);
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `users/${TEACHER_EMAIL}/classes/class-1`), {
      academyId: ACADEMY_ID, name: 'Test Class', students: [{ id: 's-1', name: 'Student One' }],
    });
  });
  const db = teacherDb();
  await assertSucceeds(getDoc(classRef));
  await assertSucceeds(updateDoc(classRef, { students: [{ id: 's-1', name: 'Updated Student' }] }));
  await assertFails(updateDoc(classRef, { name: 'Client-created class name' }));
});

test('nested Teacher Portal records are permission-gated', async () => {
  await seedTeacher();
  const db = teacherDb();
  await assertSucceeds(setDoc(doc(db, `users/${TEACHER_EMAIL}/classes/class-1/quizzes/quiz-1`), { title: 'Quiz' }));
  await assertSucceeds(setDoc(doc(db, `users/${TEACHER_EMAIL}/classes/class-1/reports/student-1_2026-11`), { studentId: 'student-1' }));
  await assertSucceeds(setDoc(doc(db, `users/${TEACHER_EMAIL}/classes/class-1/documents/doc-1`), { title: 'Notes' }));
});

test('module-specific permissions can expose class context without exposing unrelated modules', async () => {
  const restricted = Object.fromEntries(Object.keys(allPermissions).map((key) => [key, false]));
  restricted['dashboard.view'] = true;
  restricted['attendance.view_assigned'] = true;
  await seedTeacher({ permissions: restricted });
  const db = teacherDb();
  await assertSucceeds(getDoc(doc(db, `users/${TEACHER_EMAIL}/classes/class-1`)));
  await assertFails(getDoc(doc(db, `users/${TEACHER_EMAIL}/classes/class-1/quizzes/quiz-1`)));
  await assertFails(getDoc(doc(db, `users/${TEACHER_EMAIL}/classes/class-1/reports/report-1`)));
  await assertFails(getDoc(doc(db, `users/${TEACHER_EMAIL}/classes/class-1/documents/document-1`)));
});

test('dashboard-only permission does not grant access to a teacher class projection', async () => {
  await seedTeacher({ permissions: { 'dashboard.view': true } });
  const db = teacherDb();
  await assertFails(getDoc(doc(db, `users/${TEACHER_EMAIL}/classes/class-1`)));
});

test('unauthenticated user cannot access tenant data', async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, `users/${TEACHER_EMAIL}/classes/class-1`)));
  await assertFails(setDoc(doc(db, `users/${TEACHER_EMAIL}/classes/unauthorized`), { name: 'Unauthorized' }));
});

test('browser cannot read or write WhatsApp notification jobs', async () => {
  await seedTeacher();
  const db = teacherDb();
  const jobRef = doc(db, `users/${TEACHER_EMAIL}/whatsappNotificationJobs/job-1`);
  await assertFails(getDoc(jobRef));
  await assertFails(setDoc(jobRef, { status: 'accepted_by_meta' }));
});

test('teacher may update approved profile fields but cannot change identity or server-owned entitlements', async () => {
  await seedTeacher();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `users/${TEACHER_EMAIL}/subscriptionEntitlements/current`), {
      uid: TEACHER_UID, email: TEACHER_EMAIL, active: true, status: 'active', featurePermissions: { fees: 'enabled' },
    });
  });
  const db = teacherDb();
  const profileRef = doc(db, `users/${TEACHER_EMAIL}`);
  const entitlementRef = doc(db, `users/${TEACHER_EMAIL}/subscriptionEntitlements/current`);
  await assertSucceeds(updateDoc(profileRef, { teacherName: 'Updated by owner' }));
  await assertFails(updateDoc(profileRef, { role: 'admin' }));
  await assertFails(updateDoc(profileRef, { uid: 'different-uid' }));
  await assertFails(updateDoc(profileRef, { email: 'other@example.com' }));
  await assertFails(updateDoc(profileRef, { active: false }));
  await assertFails(updateDoc(profileRef, { disabled: true }));
  await assertFails(updateDoc(profileRef, { deleted: true }));
  await assertFails(updateDoc(entitlementRef, { featurePermissions: { fees: 'enabled' } }));
  await assertFails(getDoc(entitlementRef));
});

test('active teacher can access attendance, fees, profile settings, alert settings and monthly reports', async () => {
  await seedTeacher();
  const db = teacherDb();
  await assertSucceeds(setDoc(doc(db, `users/${TEACHER_EMAIL}/attendance/class-1_2026-11-14`), { classId: 'class-1', date: '2026-11-14', attendanceMap: {} }));
  await assertSucceeds(setDoc(doc(db, `users/${TEACHER_EMAIL}/fees/class-1_2026-11`), { classId: 'class-1', month: '2026-11' }));
  await assertSucceeds(setDoc(doc(db, `users/${TEACHER_EMAIL}/settings/profile_data`), { profile: { name: 'Test Teacher' } }));
  await assertSucceeds(setDoc(doc(db, `users/${TEACHER_EMAIL}/feeAlertSettings/general`), { enabled: true, reminderDays: [5, 20] }));
  await assertSucceeds(setDoc(doc(db, `users/${TEACHER_EMAIL}/classes/class-1/reports/student-1_2026-11`), { studentId: 'student-1', month: '2026-11' }));
});

test('trigger alert settings require the Academy alerts.manage permission', async () => {
  await seedTeacher();
  const db = teacherDb();
  await assertSucceeds(setDoc(doc(db, `users/${TEACHER_EMAIL}/settings/trigger_alerts`), { enabled: true }));
});

test('trigger alert settings are denied when Academy alerts.manage is not granted', async () => {
  await seedTeacher({ permissions: { ...allPermissions, 'alerts.manage': false } });
  const db = teacherDb();
  await assertFails(setDoc(doc(db, `users/${TEACHER_EMAIL}/settings/trigger_alerts`), { enabled: true }));
});

test('fee collection and fee alerts are independently permission-gated', async () => {
  await seedTeacher({ permissions: { ...allPermissions, 'fees.view_assigned': false, 'fees.collect': false, 'fees.alerts': false } });
  const db = teacherDb();
  await assertFails(setDoc(doc(db, `users/${TEACHER_EMAIL}/fees/class-1_2026-11`), { amount: 100 }));
  await assertFails(getDoc(doc(db, `users/${TEACHER_EMAIL}/feeAlertSettings/general`)));
});

test('fee alerts can be used independently from fee viewing/collection', async () => {
  await seedTeacher({ permissions: { ...allPermissions, 'fees.view_assigned': false, 'fees.collect': false, 'fees.alerts': true } });
  const db = teacherDb();
  await assertSucceeds(setDoc(doc(db, `users/${TEACHER_EMAIL}/feeAlertSettings/general`), { enabled: false, reminderDays: [5, 20] }));
  await assertFails(setDoc(doc(db, `users/${TEACHER_EMAIL}/fees/class-1_2026-11`), { amount: 100 }));
});

test('fee collection remains available when fee alerts are disabled', async () => {
  await seedTeacher({ permissions: { ...allPermissions, 'fees.alerts': false } });
  const db = teacherDb();
  await assertSucceeds(setDoc(doc(db, `users/${TEACHER_EMAIL}/fees/class-1_2026-11`), { classId: 'class-1', month: '2026-11' }));
  await assertFails(getDoc(doc(db, `users/${TEACHER_EMAIL}/feeAlertSettings/general`)));
});

test('inactive Academy membership blocks protected reads but preserves owner profile settings', async () => {
  await seedTeacher({ memberActive: false, mappingActive: false });
  const db = teacherDb();
  await assertFails(getDoc(doc(db, `users/${TEACHER_EMAIL}/classes/class-1`)));
  await assertFails(setDoc(doc(db, `users/${TEACHER_EMAIL}/attendance/att-1`), { status: 'absent' }));
  await assertSucceeds(setDoc(doc(db, `users/${TEACHER_EMAIL}/settings/profile_data`), { profile: { name: 'Profile remains available' } }));
});

test('inactive Academy blocks teacher workspace even when membership documents remain active', async () => {
  await seedTeacher({ academyStatus: 'suspended' });
  const db = teacherDb();
  await assertFails(getDoc(doc(db, `users/${TEACHER_EMAIL}/classes/class-1`)));
});

test('announcements require an active quota reservation and WhatsApp jobs remain server-only', async () => {
  await seedTeacher();
  const db = teacherDb();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `users/${TEACHER_EMAIL}/announcementQuotaReservations/announcement-1`), {
      teacherUid: TEACHER_UID, tenantEmail: TEACHER_EMAIL, targetClass: 'All Classes', status: 'reserved',
    });
  });
  await assertSucceeds(setDoc(doc(db, `users/${TEACHER_EMAIL}/notifications/announcement-1`), {
    category: 'Announcements', title: 'School closed', message: 'School will remain closed tomorrow.', targetClass: 'All Classes',
    sender: 'EduTrack Alert System', sourceType: 'teacher_created', createdByUid: TEACHER_UID,
    createdByRole: 'teacher', createdAt: new Date(), announcementQuotaReservationId: 'announcement-1',
  }));
  await assertFails(setDoc(doc(db, `users/${TEACHER_EMAIL}/notifications/announcement-without-reservation`), {
    category: 'Announcements', title: 'No reservation', message: 'This must be denied.', targetClass: 'All Classes',
  }));
  await assertFails(setDoc(doc(db, `users/${TEACHER_EMAIL}/notifications/whatsapp-forged`), {
    category: 'WhatsApp', title: 'Forged', message: 'Client cannot enqueue WhatsApp work.',
  }));
});

test('alerts without the explicit manage permission cannot be read or created', async () => {
  await seedTeacher({ permissions: { ...allPermissions, 'alerts.manage': false } });
  const db = teacherDb();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `users/${TEACHER_EMAIL}/notifications/existing`), { category: 'Fees', title: 'Old alert' });
  });
  await assertFails(getDoc(doc(db, `users/${TEACHER_EMAIL}/notifications/existing`)));
  await assertFails(setDoc(doc(db, `users/${TEACHER_EMAIL}/notifications/new-alert`), { category: 'Fees', title: 'New alert', message: 'Denied' }));
});

test('teacher cannot write another tenant attendance or settings', async () => {
  await seedTeacher();
  const db = teacherDb();
  await assertFails(setDoc(doc(db, 'users/bob@example.com/attendance/class-1_2026-11-14'), { attendanceMap: {} }));
  await assertFails(setDoc(doc(db, 'users/bob@example.com/settings/profile_data'), { profile: { name: 'Unauthorized' } }));
});

test('browser cannot access billing documents', async () => {
  await seedTeacher();
  const db = teacherDb();
  const billingRef = doc(db, `users/${TEACHER_EMAIL}/billing/customer-1`);
  await assertFails(getDoc(billingRef));
  await assertFails(setDoc(billingRef, { amount: 100 }));
});

test('browser clients cannot read or mutate platform teacher notices or daily dismissal receipts', async () => {
  await seedTeacher();
  const db = teacherDb();
  const noticeRef = doc(db, 'platformSettings/teacherPortalAnnouncement');
  const dismissalRef = doc(db, 'platformTeacherAnnouncementDismissals/teacher-day-test');
  await assertFails(getDoc(noticeRef));
  await assertFails(setDoc(noticeRef, { status: 'published', title: 'Client-side forged notice' }));
  await assertFails(getDoc(dismissalRef));
  await assertFails(setDoc(dismissalRef, { teacherUid: TEACHER_UID, dateKey: '2026-11-18' }));
});
