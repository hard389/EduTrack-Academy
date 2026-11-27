import { createHash } from 'node:crypto';
import { FieldValue, type DocumentData, type DocumentReference, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { getFirebaseAdminAuth, getFirebaseAdminFirestore } from './firebaseAdmin.js';
import { AcademyApiError, resolveAcademySession } from './academyIdentity.js';
import { getWhatsAppAlertsDashboardForWorkspace } from './teacherWhatsAppAlerts.js';
import { reconcileWhatsAppNotificationForActor, WhatsAppReconciliationError } from './whatsappReconciliation.js';
import { verifyAcademyAdminWhatsAppNumbers, WhatsAppNumberVerificationError } from './whatsappNumberVerification.js';
import { normalizeAcademyStudentExtraCharges } from './academyStudentExtraChargesDomain.mjs';
import { advanceClassRollSequence, nextClassRollNumber, normalizeIdList } from './academyManagementDomain.mjs';

type Request = { headers?: Record<string, string | string[] | undefined>; body?: unknown };
type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const id = (value: unknown, label: string) => { const result = text(value); if (!result || result.length > 128 || /[\/\\]/.test(result) || result.includes('..')) throw new AcademyApiError(400, `${label} is invalid.`, 'INVALID_REQUEST'); return result; };
const required = (value: unknown, label: string, max = 160) => { const result = text(value); if (!result || result.length > max) throw new AcademyApiError(400, `${label} is required.`, 'INVALID_REQUEST'); return result; };
const number = (value: unknown, label: string, min = 0, max = 100_000_000) => { const result = Number(value); if (!Number.isFinite(result) || result < min || result > max) throw new AcademyApiError(400, `${label} is invalid.`, 'INVALID_REQUEST'); return Math.round((result + Number.EPSILON) * 100) / 100; };
const isoDate = (value: unknown, label = 'Date') => { const result = text(value); if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00.000Z`))) throw new AcademyApiError(400, `${label} must use YYYY-MM-DD.`, 'INVALID_DATE'); return result; };
const dateValue = (value: unknown): Date | null => { if (value && typeof value === 'object' && 'toDate' in value && typeof (value as { toDate?: unknown }).toDate === 'function') { try { return (value as { toDate: () => Date }).toDate(); } catch { return null; } } if (typeof value === 'string' || typeof value === 'number') { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed; } return null; };
const iso = (value: unknown) => dateValue(value)?.toISOString() ?? null;
const normalizePakMobile = (value: unknown) => { let digits = text(value).replace(/\D/g, ''); if (digits.startsWith('00')) digits = digits.slice(2); if (digits.startsWith('0') && digits.length === 11) digits = `92${digits.slice(1)}`; if (digits.length === 10) digits = `92${digits}`; return /^923\d{9}$/.test(digits) ? `+${digits}` : ''; };
const rootFor = (db: ReturnType<typeof getFirebaseAdminFirestore>, academyId: string) => db.collection('academies').doc(academyId);
const hashId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 48);

async function adminActor(request: Request) {
  const session = await resolveAcademySession(request);
  if (session.role !== 'academy_admin') throw new AcademyApiError(403, 'Academy Admin access is required.', 'ACADEMY_ADMIN_REQUIRED');
  const db = getFirebaseAdminFirestore();
  const root = rootFor(db, session.academyId);
  const memberRef = root.collection('members').doc(session.uid);
  const member = await memberRef.get();
  if (!member.exists || member.data()?.uid !== session.uid || member.data()?.academyId !== session.academyId || member.data()?.role !== 'academy_admin' || member.data()?.active !== true) {
    throw new AcademyApiError(403, 'Your active Academy Admin membership could not be verified.', 'ACADEMY_MEMBERSHIP_INACTIVE');
  }
  return { session, db, root, memberRef };
}

function auditRef(root: ReturnType<typeof rootFor>) { return root.collection('auditLogs').doc(); }
function toRow(doc: QueryDocumentSnapshot<DocumentData>): Row & { id: string; createdAt: string | null; updatedAt: string | null } { const data = doc.data(); return { ...data, id: doc.id, createdAt: iso(data.createdAt), updatedAt: iso(data.updatedAt) }; }

async function getRoster(root: ReturnType<typeof rootFor>, classId: string, subjectId?: string) {
  let query = root.collection('studentSubjectEnrollments').where('classId', '==', classId).where('active', '==', true);
  const snapshot = await query.limit(2000).get();
  const deduped = new Map<string, Row>();
  for (const doc of snapshot.docs) {
    const row = doc.data() as Row;
    if (subjectId && row.subjectId !== subjectId) continue;
    const studentId = text(row.studentId);
    if (!studentId) continue;
    deduped.set(studentId, { studentId, subjectId: text(row.subjectId), subjectName: text(row.subjectName), teacherUid: text(row.teacherUid) });
  }
  const students = await Promise.all([...deduped.keys()].map((studentId) => root.collection('students').doc(studentId).get()));
  return students.filter((doc) => doc.exists && doc.data()?.status !== 'archived').map((doc) => ({ id: doc.id, ...doc.data(), ...(deduped.get(doc.id) ?? {}) } as Row));
}

async function listAttendance(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const recordsSnapshot = await actor.root.collection('studentAttendance').orderBy('date', 'desc').limit(500).get().catch(() => null);
  const classId = text(body.classId);
  const date = text(body.date);
  const records = (recordsSnapshot?.docs ?? []).map(toRow).filter((row) => (!classId || row.classId === classId) && (!date || row.date === date));
  if (!classId) return { success: true, records, students: [], record: records.find((row) => row.date === date) ?? null };
  const classSnap = await actor.root.collection('classes').doc(classId).get();
  if (!classSnap.exists) throw new AcademyApiError(404, 'Class was not found.', 'CLASS_NOT_FOUND');
  const subjectId = text(body.subjectId);
  const students = await getRoster(actor.root, classId, subjectId || undefined);
  const selectedRecord = records.find((row) => row.classId === classId && (!date || row.date === date) && (!subjectId || row.subjectId === subjectId)) ?? null;
  return {
    success: true,
    records,
    class: { id: classSnap.id, name: text(classSnap.data()?.name), classCode: text(classSnap.data()?.classCode) },
    students: students.map((student) => ({ id: student.id, name: text(student.name), rollNo: text(student.rollNo), gender: text(student.gender), status: text(student.status) })),
    record: selectedRecord,
  };
}

async function saveAttendance(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const classId = id(body.classId, 'Class');
  const date = isoDate(body.date);
  const attendanceMap = isRow(body.attendanceMap) ? body.attendanceMap : {};
  const recordRef = actor.root.collection('studentAttendance').doc(`${classId}_${date}`);
  const classRef = actor.root.collection('classes').doc(classId);
  const rosterSnapshot = await actor.root.collection('studentSubjectEnrollments').where('classId', '==', classId).where('active', '==', true).limit(2000).get();
  const enrolledIds = [...new Set(rosterSnapshot.docs.map((doc) => text(doc.data().studentId)).filter(Boolean))];
  if (!enrolledIds.length) throw new AcademyApiError(409, 'No active subject enrolments exist for this class.', 'EMPTY_ROSTER');
  const submittedIds = Object.keys(attendanceMap).sort();
  if (JSON.stringify([...enrolledIds].sort()) !== JSON.stringify(submittedIds)) throw new AcademyApiError(409, 'The class roster changed or the submitted register is incomplete. Refresh and try again.', 'ROSTER_CHANGED');
  const invalid = Object.values(attendanceMap).some((value) => typeof value !== 'boolean');
  if (invalid) throw new AcademyApiError(400, 'Attendance values must be present or absent.', 'INVALID_ATTENDANCE');
  const studentRefs = enrolledIds.map((studentId) => actor.root.collection('students').doc(studentId));
  const audit = auditRef(actor.root);
  await actor.db.runTransaction(async (tx) => {
    const [classSnap, existing, studentSnaps] = await Promise.all([tx.get(classRef), tx.get(recordRef), Promise.all(studentRefs.map((ref) => tx.get(ref)))]);
    if (!classSnap.exists || ['archived', 'inactive'].includes(text(classSnap.data()?.status))) throw new AcademyApiError(409, 'This class is not active.', 'CLASS_NOT_ACTIVE');
    if (existing.exists) throw new AcademyApiError(409, 'Attendance already exists for this class and date. Use correction with a reason.', 'ATTENDANCE_ALREADY_SAVED');
    if (studentSnaps.some((doc) => !doc.exists || doc.data()?.status === 'archived')) throw new AcademyApiError(409, 'A student roster record changed. Refresh and try again.', 'ROSTER_CHANGED');
    const present = Object.values(attendanceMap).filter(Boolean).length;
    const absent = enrolledIds.length - present;
    const now = FieldValue.serverTimestamp();
    tx.create(recordRef, {
      academyId: actor.session.academyId, classId, className: text(classSnap.data()?.name), date,
      attendanceMap, rosterStudentIds: enrolledIds, totalStudents: enrolledIds.length,
      presentCount: present, absentCount: absent, attendancePercentage: Math.round((present / enrolledIds.length) * 10000) / 100,
      status: 'saved', locked: true, source: 'academy_admin', createdByUid: actor.session.uid,
      createdByRole: 'academy_admin', createdAt: now, updatedByUid: actor.session.uid, updatedAt: now, revision: 1,
    });
    tx.create(audit, { event: 'attendance.created', academyId: actor.session.academyId, classId, date, actorUid: actor.session.uid, before: null, after: { presentCount: present, absentCount: absent }, createdAt: now });
  });
  return { success: true, recordId: recordRef.id, presentCount: Object.values(attendanceMap).filter(Boolean).length, absentCount: enrolledIds.length - Object.values(attendanceMap).filter(Boolean).length };
}

async function correctAttendance(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const classId = id(body.classId, 'Class'); const date = isoDate(body.date); const reason = required(body.reason, 'Correction reason', 500);
  const attendanceMap = isRow(body.attendanceMap) ? body.attendanceMap : {};
  if (Object.values(attendanceMap).some((value) => typeof value !== 'boolean')) throw new AcademyApiError(400, 'Attendance values must be present or absent.', 'INVALID_ATTENDANCE');
  const recordId = body.recordId ? id(body.recordId, 'Attendance record') : `${classId}_${date}`;
  const ref = actor.root.collection('studentAttendance').doc(recordId); const audit = auditRef(actor.root);
  await actor.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.status === 'void') throw new AcademyApiError(404, 'A saved attendance record was not found.', 'ATTENDANCE_NOT_FOUND');
    const before = snap.data() ?? {}; const rosterIds = Array.isArray(before.rosterStudentIds) ? [...before.rosterStudentIds].map(String).sort() : Object.keys(isRow(before.attendanceMap) ? before.attendanceMap : {}).sort();
    if (JSON.stringify(rosterIds) !== JSON.stringify(Object.keys(attendanceMap).sort())) throw new AcademyApiError(409, 'The original roster must be preserved when correcting historical attendance.', 'ROSTER_CHANGED');
    const present = Object.values(attendanceMap).filter(Boolean).length; const now = FieldValue.serverTimestamp();
    tx.update(ref, { attendanceMap, presentCount: present, absentCount: rosterIds.length - present, attendancePercentage: rosterIds.length ? Math.round((present / rosterIds.length) * 10000) / 100 : 0, updatedByUid: actor.session.uid, updatedAt: now, revision: Number(before.revision ?? 1) + 1, lastCorrectionReason: reason, correctedAt: now, locked: true });
    tx.create(audit, { event: 'attendance.corrected', academyId: actor.session.academyId, classId, date, actorUid: actor.session.uid, reason, before: { attendanceMap: before.attendanceMap, revision: before.revision ?? 1 }, after: { attendanceMap, revision: Number(before.revision ?? 1) + 1 }, createdAt: now });
  });
  return { success: true, recordId: ref.id };
}

async function voidAttendance(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const classId = id(body.classId, 'Class'); const date = isoDate(body.date); const reason = required(body.reason, 'Void reason', 500);
  const recordId = body.recordId ? id(body.recordId, 'Attendance record') : `${classId}_${date}`;
  const ref = actor.root.collection('studentAttendance').doc(recordId); const audit = auditRef(actor.root);
  await actor.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref); if (!snap.exists || snap.data()?.status === 'void') throw new AcademyApiError(404, 'A saved attendance record was not found.', 'ATTENDANCE_NOT_FOUND');
    const now = FieldValue.serverTimestamp(); tx.update(ref, { status: 'void', voidedByUid: actor.session.uid, voidedAt: now, voidReason: reason, updatedAt: now, updatedByUid: actor.session.uid });
    tx.create(audit, { event: 'attendance.voided', academyId: actor.session.academyId, classId, date, actorUid: actor.session.uid, reason, createdAt: now });
  });
  return { success: true, recordId: ref.id, status: 'void' };
}

async function listQuizzes(actor: Awaited<ReturnType<typeof adminActor>>) {
  const snapshot = await actor.root.collection('quizzes').limit(1000).get();
  return { success: true, quizzes: snapshot.docs.map(toRow).filter((row) => row.status !== 'archived') };
}

function normalizeScores(raw: unknown, totalMarks: number, roster: Row[]) {
  if (!Array.isArray(raw) || raw.length !== roster.length) throw new AcademyApiError(400, 'Provide one result for every active enrolled student.', 'QUIZ_ROSTER_MISMATCH');
  const allowed = new Map(roster.map((student) => [text(student.id), student]));
  const seen = new Set<string>();
  return raw.map((entry) => {
    if (!isRow(entry)) throw new AcademyApiError(400, 'A student result is invalid.', 'INVALID_SCORE');
    const studentId = id(entry.studentId, 'Student'); const student = allowed.get(studentId); const marks = number(entry.marks, 'Marks', 0, totalMarks);
    if (!student || seen.has(studentId)) throw new AcademyApiError(400, 'A result contains a student outside the selected subject roster or a duplicate student.', 'INVALID_SCORE_STUDENT');
    seen.add(studentId); return { studentId, name: text(student.name), rollNo: text(student.rollNo), marks, totalMarks };
  });
}

async function createQuiz(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const classId = id(body.classId, 'Class'); const subjectId = id(body.subjectId, 'Subject'); const title = required(body.title ?? body.topic, 'Quiz title', 140); const totalMarks = number(body.totalMarks, 'Total marks', 0.01, 10000); const date = isoDate(body.date);
  const subjectRef = actor.root.collection('subjects').doc(subjectId); const classRef = actor.root.collection('classes').doc(classId);
  const [subjectSnap, classSnap, roster, assignmentSnapshot] = await Promise.all([
    subjectRef.get(), classRef.get(), getRoster(actor.root, classId, subjectId),
    actor.root.collection('teacherAssignments').where('classId', '==', classId).limit(200).get(),
  ]);
  if (!subjectSnap.exists || subjectSnap.data()?.classId !== classId || subjectSnap.data()?.active !== true) throw new AcademyApiError(404, 'Active subject was not found in the selected class.', 'SUBJECT_NOT_FOUND');
  if (!classSnap.exists || ['archived', 'inactive'].includes(text(classSnap.data()?.status))) throw new AcademyApiError(404, 'Active class was not found.', 'CLASS_NOT_FOUND');
  if (!roster.length) throw new AcademyApiError(409, 'No active students are enrolled in this subject.', 'EMPTY_QUIZ_ROSTER');
  const subjectAssignments = assignmentSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Row))
    .filter((assignment) => assignment.active === true && text(assignment.subjectId) === subjectId && text(assignment.teacherUid));
  const teacherUids = [...new Set(subjectAssignments.map((assignment) => text(assignment.teacherUid)))];
  if (teacherUids.length !== 1) throw new AcademyApiError(409, 'This subject must have exactly one active assigned teacher before a quiz can be distributed to the Teacher Portal.', 'QUIZ_TEACHER_ASSIGNMENT_AMBIGUOUS');
  const assignedTeacherUid = teacherUids[0];
  const assignedTeacherSnap = await actor.root.collection('members').doc(assignedTeacherUid).get();
  if (!assignedTeacherSnap.exists || assignedTeacherSnap.data()?.active !== true || assignedTeacherSnap.data()?.role !== 'teacher') throw new AcademyApiError(409, 'The assigned subject teacher is not active.', 'QUIZ_TEACHER_INACTIVE');
  const assignedTeacherEmail = text(assignedTeacherSnap.data()?.email).toLowerCase();
  const scores = normalizeScores(body.scores, totalMarks, roster);
  const ref = actor.root.collection('quizzes').doc(); const audit = auditRef(actor.root); const now = FieldValue.serverTimestamp();
  await actor.db.runTransaction(async (tx) => {
    tx.create(ref, { academyId: actor.session.academyId, quizId: ref.id, classId, className: text(classSnap.data()?.name), subjectId, subjectName: text(subjectSnap.data()?.name), teacherUid: assignedTeacherUid, teacherEmail: assignedTeacherEmail, title, topic: title, date, monthKey: date.slice(0, 7), totalMarks, studentScores: scores, averageMarks: scores.reduce((sum, row) => sum + row.marks, 0) / scores.length, status: 'active', createdByUid: actor.session.uid, creatorRole: 'academy_admin', createdAt: now, updatedByUid: actor.session.uid, updatedAt: now, revision: 1 });
    tx.create(audit, { event: 'quiz.created', academyId: actor.session.academyId, actorUid: actor.session.uid, quizId: ref.id, classId, subjectId, createdAt: now });
  });
  return { success: true, quizId: ref.id };
}

async function updateQuiz(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const quizId = id(body.quizId, 'Quiz'); const ref = actor.root.collection('quizzes').doc(quizId); const snap = await ref.get();
  if (!snap.exists || snap.data()?.status === 'archived') throw new AcademyApiError(404, 'Quiz was not found.', 'QUIZ_NOT_FOUND');
  const existing = snap.data() ?? {}; const totalMarks = number(body.totalMarks ?? existing.totalMarks, 'Total marks', 0.01, 10000); const title = required(body.title ?? existing.title, 'Quiz title', 140); const date = isoDate(body.date ?? existing.date);
  const roster = await getRoster(actor.root, text(existing.classId), text(existing.subjectId)); const scores = body.scores === undefined ? existing.studentScores : normalizeScores(body.scores, totalMarks, roster);
  if (!Array.isArray(scores)) throw new AcademyApiError(409, 'Quiz scores are malformed; the existing record was not changed.', 'QUIZ_DATA_INVALID');
  const reason = required(body.reason, 'Edit reason', 500); const audit = auditRef(actor.root); const now = FieldValue.serverTimestamp();
  await actor.db.runTransaction(async (tx) => {
    const fresh = await tx.get(ref); if (!fresh.exists || Number(fresh.data()?.revision ?? 1) !== Number(body.expectedRevision ?? existing.revision ?? 1)) throw new AcademyApiError(409, 'This quiz changed in another session. Refresh before editing.', 'QUIZ_CONCURRENT_MODIFICATION');
    tx.update(ref, { title, topic: title, totalMarks, date, monthKey: date.slice(0, 7), studentScores: scores, averageMarks: (scores as Row[]).reduce((sum, row) => sum + Number(row.marks ?? 0), 0) / Math.max(1, (scores as Row[]).length), updatedByUid: actor.session.uid, updatedAt: now, revision: Number(existing.revision ?? 1) + 1, lastEditReason: reason });
    tx.create(audit, { event: 'quiz.updated', academyId: actor.session.academyId, actorUid: actor.session.uid, quizId, reason, beforeRevision: existing.revision ?? 1, createdAt: now });
  });
  return { success: true, quizId };
}

async function archiveQuiz(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const quizId = id(body.quizId, 'Quiz'); const reason = required(body.reason, 'Archive reason', 500); const ref = actor.root.collection('quizzes').doc(quizId); const audit = auditRef(actor.root);
  await actor.db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists || snap.data()?.status === 'archived') throw new AcademyApiError(404, 'Quiz was not found.', 'QUIZ_NOT_FOUND'); const now = FieldValue.serverTimestamp(); tx.update(ref, { status: 'archived', archivedAt: now, archivedByUid: actor.session.uid, archiveReason: reason, updatedAt: now }); tx.create(audit, { event: 'quiz.archived', academyId: actor.session.academyId, actorUid: actor.session.uid, quizId, reason, createdAt: now }); });
  return { success: true, quizId, status: 'archived' };
}

async function listAlerts(actor: Awaited<ReturnType<typeof adminActor>>) {
  const snapshot = await actor.root.collection('notifications').limit(1000).get();
  return { success: true, notifications: snapshot.docs.map(toRow).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))).filter((row) => row.status !== 'archived') };
}

const ALERT_CATEGORIES = ['Announcements', 'Fees', 'Attendance', 'Exams', 'WhatsApp'] as const;
const MAX_ALERT_TEACHERS = 50;
const MAX_ALERTS_PER_TEACHER = 500;

type VerifiedTeacherWorkspace = {
  uid: string;
  email: string;
  name: string;
  tenantRef: DocumentReference<DocumentData>;
  tenantData: Record<string, unknown>;
};

function normalizedTeacherEmail(value: unknown): string {
  const email = text(value).toLowerCase();
  return email && email.includes('@') && !email.includes('/') && !email.includes('\\') && !/\s/.test(email) ? email : '';
}

async function getVerifiedTeacherWorkspaces(actor: Awaited<ReturnType<typeof adminActor>>) {
  const membersSnapshot = await actor.root.collection('members').where('role', '==', 'teacher').limit(501).get();
  const candidates = membersSnapshot.docs.filter((snapshot) => {
    const member = snapshot.data() ?? {};
    return member.uid === snapshot.id && member.academyId === actor.session.academyId && member.role === 'teacher' && member.active === true && member.emailVerified === true;
  });
  const isCandidateListTruncated = membersSnapshot.size >= 501;
  let skipped = 0;
  const verified: VerifiedTeacherWorkspace[] = [];
  const auth = getFirebaseAdminAuth();

  for (let start = 0; start < candidates.length && verified.length < MAX_ALERT_TEACHERS; start += 10) {
    const batch = candidates.slice(start, start + 10);
    const results = await Promise.all(batch.map(async (snapshot) => {
      const member = snapshot.data() ?? {};
      const email = normalizedTeacherEmail(member.email);
      if (!email) return null;
      const [mappingSnapshot, profileSnapshot, authUser] = await Promise.all([
        actor.db.collection('academyMemberships').doc(snapshot.id).get(),
        actor.db.collection('users').doc(email).get(),
        auth.getUser(snapshot.id).catch(() => null),
      ]);
      const mapping = mappingSnapshot.data() ?? {};
      const profile = profileSnapshot.data() ?? {};
      if (
        !mappingSnapshot.exists || (mapping.uid !== undefined && mapping.uid !== snapshot.id) || mapping.role !== 'teacher' || mapping.academyId !== actor.session.academyId || mapping.active !== true ||
        !profileSnapshot.exists || profile.uid !== snapshot.id || normalizedTeacherEmail(profile.email) !== email || profile.academyId !== actor.session.academyId || profile.role !== 'teacher' || profile.active !== true || profile.disabled === true || profile.deleted === true ||
        !authUser || authUser.disabled || authUser.emailVerified !== true || normalizedTeacherEmail(authUser.email) !== email
      ) return null;
      return {
        uid: snapshot.id,
        email,
        name: text(member.displayName) || text(profile.displayName) || text(member.name) || 'Teacher',
        tenantRef: actor.db.collection('users').doc(email),
        tenantData: profile as Record<string, unknown>,
      };
    }));
    for (const result of results) {
      if (!result) skipped += 1;
      else if (verified.length < MAX_ALERT_TEACHERS) verified.push(result);
    }
  }
  const hasMoreCandidates = candidates.length > verified.length + skipped;
  return {
    teachers: verified,
    truncated: isCandidateListTruncated || hasMoreCandidates || candidates.length > MAX_ALERT_TEACHERS,
    skipped,
  };
}

function isTrustedTeacherAlert(data: Row, uid: string, documentId: string): boolean {
  if (!ALERT_CATEGORIES.includes(text(data.category) as (typeof ALERT_CATEGORIES)[number])) return false;
  if (!text(data.title) || !text(data.message)) return false;
  if (data.category === 'WhatsApp') {
    return /^wa_[a-f0-9]{48}$/.test(documentId) && data.sender === 'EduTrack WhatsApp Queue' && data.whatsappReconciliationRequired === true &&
      typeof data.whatsappQueueType === 'string' && typeof data.whatsappSourceCollection === 'string' && typeof data.whatsappJobId === 'string';
  }
  if (data.sourceType === 'teacher_created') return data.createdByUid === uid && data.createdByRole === 'teacher';
  return data.sourceType === undefined && data.type === undefined && data.notificationType === undefined && data.kind === undefined &&
    data.sender === 'Tigerr_Alert System' && typeof data.targetClass === 'string';
}

async function listAcademyTeacherAlerts(actor: Awaited<ReturnType<typeof adminActor>>) {
  const { teachers, truncated: teacherListTruncated, skipped } = await getVerifiedTeacherWorkspaces(actor);
  const rows: Row[] = [];
  let alertsTruncated = false;
  for (let start = 0; start < teachers.length; start += 5) {
    const group = teachers.slice(start, start + 5);
    const snapshots = await Promise.all(group.map(async (teacher) => {
      const snapshot = await teacher.tenantRef.collection('notifications').where('category', 'in', [...ALERT_CATEGORIES]).limit(MAX_ALERTS_PER_TEACHER).get();
      return { teacher, snapshot };
    }));
    for (const { teacher, snapshot } of snapshots) {
      alertsTruncated ||= snapshot.size >= MAX_ALERTS_PER_TEACHER;
      for (const notification of snapshot.docs) {
        const data = notification.data() as Row;
        if (!isTrustedTeacherAlert(data, teacher.uid, notification.id)) continue;
        rows.push({
          id: `teacher:${teacher.uid}:${notification.id}`,
          sourceId: notification.id,
          source: 'teacher',
          teacherUid: teacher.uid,
          teacherName: teacher.name,
          teacherEmail: teacher.email,
          title: text(data.title),
          message: text(data.message),
          category: text(data.category),
          priority: ['high', 'medium', 'normal'].includes(text(data.priority)) ? text(data.priority) : 'normal',
          targetClass: text(data.targetClass) || 'All Classes',
          isRead: data.isRead === true,
          createdAt: iso(data.createdAt),
          sender: text(data.sender) || teacher.name,
          whatsappDispatchStatus: text(data.whatsappDispatchStatus) || text(data.whatsappStatus) || 'not_requested',
          whatsappReconciliationRequired: data.whatsappReconciliationRequired === true,
          whatsappReconciliationStatus: text(data.whatsappReconciliationStatus) || null,
          whatsappSourceStatus: text(data.whatsappSourceStatus) || null,
          whatsappQueueType: text(data.whatsappQueueType) || null,
          whatsappSourceCollection: text(data.whatsappSourceCollection) || null,
          whatsappJobId: text(data.whatsappJobId) || null,
          whatsappDispatchId: text(data.whatsappDispatchId) || null,
          whatsappRecipientId: text(data.whatsappRecipientId) || null,
          whatsappRecipientLast4: text(data.whatsappRecipientLast4) || null,
          whatsappProviderMessageId: text(data.whatsappProviderMessageId) || null,
        });
      }
    }
  }
  rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  return {
    success: true,
    alerts: rows,
    teacherCount: teachers.length,
    partial: teacherListTruncated || alertsTruncated || skipped > 0,
    partialReason: teacherListTruncated || alertsTruncated || skipped > 0
      ? 'Some teacher workspaces or older alert records were omitted by the safe query limits or could not be reverified. Displayed records are limited to active, verified teachers belonging to this Academy.'
      : null,
  };
}

async function getAcademyTeacherWhatsAppDashboard(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const month = text(body.month);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AcademyApiError(400, 'Month must use YYYY-MM.', 'INVALID_MONTH');
  const { teachers, truncated: teacherListTruncated, skipped } = await getVerifiedTeacherWorkspaces(actor);
  const dashboards: Array<{ teacher: (typeof teachers)[number]; dashboard: Awaited<ReturnType<typeof getWhatsAppAlertsDashboardForWorkspace>> }> = [];
  let failedTeachers = 0;
  for (let start = 0; start < teachers.length; start += 3) {
    const group = teachers.slice(start, start + 3);
    const results = await Promise.all(group.map(async (teacher) => {
      try {
        const dashboard = await getWhatsAppAlertsDashboardForWorkspace({ db: actor.db, uid: teacher.uid, email: teacher.email, tenantRef: teacher.tenantRef }, month);
        return { teacher, dashboard };
      } catch (error) {
        console.error('[AcademyAlerts] A verified teacher dashboard could not be read.', error instanceof Error ? error.name : 'UnknownError');
        return null;
      }
    }));
    for (const result of results) {
      if (result) dashboards.push(result);
      else failedTeachers += 1;
    }
  }

  const nowDate = new Date(`${month}-01T00:00:00.000Z`);
  const daysInMonth = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 0)).getUTCDate();
  const categoryMap = new Map<string, Row>([
    ['attendance', { key: 'attendance', label: 'Attendance', dataAvailable: false, deliveryTrackingAvailable: true, sourceDocuments: 0, counts: { total: 0, providerAccepted: 0, deliveryConfirmed: 0, failed: 0, pending: 0, unknown: 0 } }],
    ['fees', { key: 'fees', label: 'Fee Alerts', dataAvailable: false, deliveryTrackingAvailable: false, sourceDocuments: 0, counts: { total: 0, providerAccepted: 0, deliveryConfirmed: null, failed: 0, pending: 0, unknown: 0 } }],
    ['quiz', { key: 'quiz', label: 'Quiz Alerts', dataAvailable: false, deliveryTrackingAvailable: false, sourceDocuments: 0, counts: { total: 0, providerAccepted: 0, deliveryConfirmed: null, failed: 0, pending: 0, unknown: 0 } }],
    ['announcements', { key: 'announcements', label: 'Announcements', dataAvailable: false, deliveryTrackingAvailable: false, sourceDocuments: 0, counts: { total: 0, providerAccepted: 0, deliveryConfirmed: null, failed: 0, pending: 0, unknown: 0 } }],
    ['library', { key: 'library', label: 'Library Links', dataAvailable: false, deliveryTrackingAvailable: false, sourceDocuments: 0, counts: { total: 0, providerAccepted: 0, deliveryConfirmed: null, failed: 0, pending: 0, unknown: 0 } }],
  ]);
  const keys = ['total', 'providerAccepted', 'deliveryConfirmed', 'failed', 'pending', 'unknown'] as const;
  const summary = Object.fromEntries(keys.map((key) => [key, 0])) as Record<(typeof keys)[number], number>;
  const dailyActivity = Array.from({ length: daysInMonth }, (_, index) => ({ day: index + 1, date: `${month}-${String(index + 1).padStart(2, '0')}`, total: 0, providerAccepted: 0, deliveryConfirmed: 0, failed: 0, pending: 0, unknown: 0 }));
  let previousTotal = 0;
  let hasPreviousHistory = false;
  let analyticsIncomplete = false;
  let failuresTruncated = false;
  const failedMessages: Row[] = [];
  for (const { teacher, dashboard } of dashboards) {
    const analytics = isRow(dashboard.analytics) ? dashboard.analytics : {};
    const analyticsSummary = isRow(analytics.summary) ? analytics.summary : {};
    const comparison = isRow(analytics.comparison) ? analytics.comparison : null;
    analyticsIncomplete ||= analytics.complete === false || Boolean(analytics.partialDataNote);
    for (const key of keys) summary[key] += Number(analyticsSummary[key] ?? 0) || 0;
    if (comparison && Number(comparison.previousTotal) > 0) {
      previousTotal += Number(comparison.previousTotal) || 0;
      hasPreviousHistory = true;
    }
    const categories = Array.isArray(analytics.categories) ? analytics.categories.filter(isRow) : [];
    for (const item of categories) {
      const itemKey = String(item.key ?? 'unknown');
      const itemLabel = String(item.label ?? itemKey);
      const itemCounts = isRow(item.counts) ? item.counts : {};
      const deliveryTrackingAvailable = item.deliveryTrackingAvailable === true;
      const existing = categoryMap.get(itemKey) ?? {
        key: itemKey, label: itemLabel, dataAvailable: false,
        deliveryTrackingAvailable,
        sourceDocuments: 0,
        counts: { total: 0, providerAccepted: 0, deliveryConfirmed: deliveryTrackingAvailable ? 0 : null, failed: 0, pending: 0, unknown: 0 },
      };
      existing.dataAvailable = existing.dataAvailable === true || item.dataAvailable === true;
      existing.sourceDocuments = (Number(existing.sourceDocuments) || 0) + (Number(item.sourceDocuments) || 0);
      const existingCounts = isRow(existing.counts) ? existing.counts : {};
      for (const key of keys) {
        if (key === 'deliveryConfirmed' && itemCounts.deliveryConfirmed === null) continue;
        existingCounts[key] = (Number(existingCounts[key] ?? 0) || 0) + (Number(itemCounts[key] ?? 0) || 0);
      }
      existing.counts = existingCounts;
      categoryMap.set(itemKey, existing);
    }
    const dailyRows = Array.isArray(analytics.dailyActivity) ? analytics.dailyActivity.filter(isRow) : [];
    for (const daily of dailyRows) {
      const dayNumber = Number(daily.day);
      const target = Number.isInteger(dayNumber) ? dailyActivity[dayNumber - 1] : undefined;
      if (!target) continue;
      for (const key of keys) target[key] += Number(daily[key] ?? 0) || 0;
    }
    for (const message of dashboard.failedMessages ?? []) {
      failedMessages.push({ ...message, id: `${teacher.uid}:${String(message.id)}`, teacherUid: teacher.uid, teacherName: teacher.name, teacherEmail: teacher.email, alertId: message.alertId || String(message.id).replace(/^[^:]+:/, '') });
    }
    failuresTruncated ||= dashboard.failedMessagesMayBeIncomplete === true;
  }
  const currentTotal = summary.total;
  const analytics = {
    month,
    timezone: 'Asia/Karachi',
    daysInMonth,
    summary: { ...summary, expiredRetryJobs: 0, dataCoverageComplete: !analyticsIncomplete && !teacherListTruncated && failedTeachers === 0 },
    categories: [...categoryMap.values()],
    dailyActivity,
    complete: !analyticsIncomplete && !teacherListTruncated && failedTeachers === 0,
    comparison: hasPreviousHistory ? { previousMonth: (() => { const date = new Date(`${month}-01T00:00:00.000Z`); date.setUTCMonth(date.getUTCMonth() - 1); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`; })(), previousTotal, currentTotal, change: currentTotal - previousTotal, percentChange: previousTotal > 0 ? Math.round(((currentTotal - previousTotal) / previousTotal) * 1000) / 10 : null } : null,
    historicalDataNote: hasPreviousHistory ? null : 'No WhatsApp activity records were available for the previous month.',
    partialDataNote: teacherListTruncated || failedTeachers > 0 || skipped > 0
      ? `Analytics include ${dashboards.length} verified teacher workspace(s). ${failedTeachers} workspace(s) could not be read and ${skipped} membership(s) failed re-verification; some teacher workspaces may be omitted.`
      : analyticsIncomplete || failuresTruncated
        ? 'One or more teacher workspaces returned partial history or reached their safe Firestore read cap. Displayed totals may be partial.'
        : null,
    countingPolicy: 'Academy totals combine persisted records from active, verified teacher workspaces that are currently linked to this Academy. Provider acceptance and confirmed delivery are counted separately. Legacy dispatches without persisted parent counters are not expanded into unbounded reads.',
  };
  failedMessages.sort((a, b) => String(b.failedAt ?? '').localeCompare(String(a.failedAt ?? '')));
  return { success: true, analytics, workspaceCount: teachers.length, analyticsWorkspaceCount: dashboards.length, failedMessages: failedMessages.slice(0, 100), failedMessagesMayBeIncomplete: failuresTruncated || failedMessages.length > 100 || teacherListTruncated || failedTeachers > 0 };
}

async function reconcileAcademyTeacherWhatsAppAlert(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const teacherUid = id(body.teacherUid, 'Teacher');
  const alertId = id(body.alertId, 'WhatsApp alert');
  const teacher = await getVerifiedTeacherWorkspaces(actor);
  const workspace = teacher.teachers.find((item) => item.uid === teacherUid);
  if (!workspace) throw new AcademyApiError(404, 'The active teacher workspace was not found in this Academy.', 'TEACHER_WORKSPACE_NOT_FOUND');
  try {
    const result = await reconcileWhatsAppNotificationForActor(
      { db: actor.db, uid: workspace.uid, email: workspace.email, tenantRef: workspace.tenantRef, tenantData: workspace.tenantData },
      { alertId, decision: body.decision },
      { uid: actor.session.uid, email: actor.session.email, role: 'academy_admin' },
    );
    const audit = auditRef(actor.root);
    await audit.create({ event: 'whatsapp.teacher_alert.reconciled', academyId: actor.session.academyId, actorUid: actor.session.uid, teacherUid, alertId, decision: text(body.decision), status: result.status, createdAt: FieldValue.serverTimestamp() });
    return result;
  } catch (error) {
    if (error instanceof WhatsAppReconciliationError) throw new AcademyApiError(error.status, error.message, 'WHATSAPP_RECONCILIATION_FAILED');
    throw error;
  }
}

async function saveAlert(actor: Awaited<ReturnType<typeof adminActor>>, body: Row, updating = false) {
  const title = required(body.title, 'Notification title', 140); const message = required(body.message, 'Notification message', 4000); const priority = ['low', 'normal', 'high', 'urgent'].includes(text(body.priority)) ? text(body.priority) : 'normal';
  const allowedCategories = ['Announcements', 'Fees', 'Attendance', 'Exams'];
  const category = body.category === undefined || body.category === null || body.category === ''
    ? 'Announcements'
    : allowedCategories.includes(text(body.category)) ? text(body.category) : '';
  if (!category) throw new AcademyApiError(400, 'Choose a supported alert category.', 'INVALID_ALERT_CATEGORY');
  const targetClassId = text(body.targetClassId); const subjectId = text(body.subjectId); const audience = ['academy', 'class', 'subject'].includes(text(body.audience)) ? text(body.audience) : 'academy';
  if (audience !== 'academy' && !targetClassId) throw new AcademyApiError(400, 'Select a class for this notification.', 'CLASS_REQUIRED');
  if (audience === 'subject' && !subjectId) throw new AcademyApiError(400, 'Select a subject for this notification.', 'SUBJECT_REQUIRED');
  if (targetClassId) { const cls = await actor.root.collection('classes').doc(targetClassId).get(); if (!cls.exists || cls.data()?.status === 'archived') throw new AcademyApiError(404, 'Selected class was not found.', 'CLASS_NOT_FOUND'); }
  if (subjectId) { const subject = await actor.root.collection('subjects').doc(subjectId).get(); if (!subject.exists || subject.data()?.classId !== targetClassId || subject.data()?.active !== true) throw new AcademyApiError(404, 'Selected subject was not found in this class.', 'SUBJECT_NOT_FOUND'); }
  const ref = updating ? actor.root.collection('notifications').doc(id(body.notificationId, 'Notification')) : actor.root.collection('notifications').doc();
  const audit = auditRef(actor.root); const now = FieldValue.serverTimestamp();
  await actor.db.runTransaction(async (tx) => {
    if (updating) { const snap = await tx.get(ref); if (!snap.exists || snap.data()?.status !== 'draft') throw new AcademyApiError(409, 'Only draft notifications can be edited.', 'NOTIFICATION_IMMUTABLE'); tx.update(ref, { title, message, category, priority, audience, targetClassId: targetClassId || null, subjectId: subjectId || null, updatedByUid: actor.session.uid, updatedAt: now }); }
    else tx.create(ref, { academyId: actor.session.academyId, notificationId: ref.id, title, message, priority, category, audience, targetClassId: targetClassId || null, subjectId: subjectId || null, status: 'draft', whatsappStatus: 'not_requested', whatsappSent: false, createdByUid: actor.session.uid, createdByRole: 'academy_admin', createdAt: now, updatedByUid: actor.session.uid, updatedAt: now });
    tx.create(audit, { event: updating ? 'notification.updated' : 'notification.created', academyId: actor.session.academyId, actorUid: actor.session.uid, notificationId: ref.id, createdAt: now });
  });
  return { success: true, notificationId: ref.id };
}

async function publishAlert(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const notificationId = id(body.notificationId, 'Notification');
  const notificationRef = actor.root.collection('notifications').doc(notificationId);
  const notificationSnap = await notificationRef.get();
  if (!notificationSnap.exists) throw new AcademyApiError(404, 'Notification was not found.', 'NOTIFICATION_NOT_FOUND');
  const notification = notificationSnap.data() as Row;
  if (notification.status !== 'draft') throw new AcademyApiError(409, 'Only an unpublished draft can be sent to Teacher Portals.', 'NOTIFICATION_NOT_DRAFT');

  const { teachers, truncated } = await getVerifiedTeacherWorkspaces(actor);
  if (truncated) throw new AcademyApiError(409, 'The verified teacher list exceeded the safe broadcast limit. Nothing was sent. Reduce the active teacher list or publish after the list is complete.', 'TEACHER_LIST_TRUNCATED');

  const audience = text(notification.audience) || 'academy';
  const targetClassId = text(notification.targetClassId);
  const subjectId = text(notification.subjectId);
  const targetClassSnapshot = targetClassId ? await actor.root.collection('classes').doc(targetClassId).get() : null;
  const targetClassName = text(targetClassSnapshot?.data()?.name) || targetClassId;
  let intendedUids = new Set<string>();
  if (audience === 'academy') {
    intendedUids = new Set(teachers.map((teacher) => teacher.uid));
  } else {
    if (!targetClassId) throw new AcademyApiError(409, 'The draft target class is missing.', 'ALERT_TARGET_INVALID');
    const assignmentSnapshot = await actor.root.collection('teacherAssignments').where('classId', '==', targetClassId).limit(500).get();
    for (const item of assignmentSnapshot.docs) {
      const assignment = item.data() as Row;
      if (assignment.active !== true) continue;
      if (audience === 'subject' && text(assignment.subjectId) !== subjectId) continue;
      if (text(assignment.teacherUid)) intendedUids.add(text(assignment.teacherUid));
    }
    if (!intendedUids.size) throw new AcademyApiError(409, 'No active teacher is assigned to the selected audience.', 'ALERT_AUDIENCE_EMPTY');
  }

  const verifiedByUid = new Map(teachers.map((teacher) => [teacher.uid, teacher]));
  const recipients = [...intendedUids].map((uid) => verifiedByUid.get(uid)).filter((teacher): teacher is VerifiedTeacherWorkspace => Boolean(teacher));
  const unresolved = [...intendedUids].filter((uid) => !verifiedByUid.has(uid));
  if (unresolved.length) throw new AcademyApiError(409, 'One or more assigned teachers could not be verified. Nothing was sent to avoid a partial broadcast.', 'ALERT_RECIPIENT_UNVERIFIED');
  // Verify the exact Academy permission before delivering to a Teacher Portal workspace.
  const memberSnapshots = await Promise.all(recipients.map((teacher) => actor.root.collection('members').doc(teacher.uid).get()));
  const deliverable = recipients.filter((teacher, index) => {
    const member = memberSnapshots[index].data() as Row | undefined;
    const permissions = member?.permissions as Row | undefined;
    return permissions?.['alerts.view'] === true;
  });
  if (!deliverable.length) throw new AcademyApiError(409, 'No audience teacher has the alerts.view permission. Nothing was sent.', 'ALERT_AUDIENCE_NO_PERMISSION');

  const now = FieldValue.serverTimestamp();
  const batch = actor.db.batch();
  const recipientsForAudit = deliverable.map((teacher) => ({ uid: teacher.uid, email: teacher.email }));
  for (const teacher of deliverable) {
    const targetClass = audience === 'academy' ? 'All Classes' : targetClassName;
    const target = teacher.tenantRef.collection('notifications').doc(`academy_${notificationId}`);
    batch.set(target, {
      academyId: actor.session.academyId,
      academyNotificationId: notificationId,
      title: text(notification.title),
      message: text(notification.message),
      category: text(notification.category) || 'Announcements',
      priority: text(notification.priority) || 'normal',
      targetClass,
      targetClassId: targetClassId || null,
      subjectId: subjectId || null,
      audience,
      sourceType: 'academy_admin',
      createdByUid: actor.session.uid,
      createdByRole: 'academy_admin',
      sender: 'Academy Admin',
      isRead: false,
      status: 'published',
      whatsappSent: false,
      createdAt: now,
      updatedAt: now,
    }, { merge: true });
  }
  batch.update(notificationRef, {
    status: 'published', publishedAt: now, publishedByUid: actor.session.uid,
    publishedRecipients: recipientsForAudit, recipientCount: deliverable.length, updatedAt: now,
  });
  batch.create(auditRef(actor.root), {
    event: 'notification.published', academyId: actor.session.academyId, actorUid: actor.session.uid,
    notificationId, audience, recipientCount: deliverable.length, recipientUids: deliverable.map((teacher) => teacher.uid), createdAt: now,
  });
  await batch.commit();
  return { success: true, notificationId, status: 'published', recipientCount: deliverable.length };
}

async function archiveAlert(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const notificationId = id(body.notificationId, 'Notification'); const reason = required(body.reason, 'Archive reason', 500); const ref = actor.root.collection('notifications').doc(notificationId); const audit = auditRef(actor.root);
  const existing = await ref.get();
  if (!existing.exists || existing.data()?.status === 'archived') throw new AcademyApiError(404, 'Notification was not found.', 'NOTIFICATION_NOT_FOUND');
  const notification = existing.data() as Row;
  const batch = actor.db.batch();
  const now = FieldValue.serverTimestamp();
  batch.update(ref, { status: 'archived', archivedByUid: actor.session.uid, archivedAt: now, archiveReason: reason, updatedAt: now });
  batch.create(audit, { event: 'notification.archived', academyId: actor.session.academyId, actorUid: actor.session.uid, notificationId, reason, createdAt: now });
  const publishedRecipients = Array.isArray(notification.publishedRecipients) ? notification.publishedRecipients as Row[] : [];
  for (const recipient of publishedRecipients) {
    const email = normalizedTeacherEmail(recipient.email);
    if (!email) continue;
    batch.set(actor.db.collection('users').doc(email).collection('notifications').doc(`academy_${notificationId}`), {
      status: 'archived', archivedAt: now, updatedAt: now,
    }, { merge: true });
  }
  await batch.commit();
  return { success: true, notificationId, status: 'archived' };
}

async function getAnalytics(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const [students, classes, enrolments, attendance, invoices, expenses, quizzes, studentReports] = await Promise.all([
    actor.root.collection('students').limit(3000).get(), actor.root.collection('classes').limit(500).get(),
    actor.root.collection('studentSubjectEnrollments').where('active', '==', true).limit(5000).get(),
    actor.root.collection('studentAttendance').limit(3000).get(), actor.root.collection('feeInvoices').limit(3000).get(),
    actor.root.collection('expenses').where('status', '==', 'posted').limit(3000).get(), actor.root.collection('quizzes').limit(2000).get(),
    actor.root.collection('studentReports').limit(3000).get(),
  ]);
  const startMonth = text(body.fromMonth); const endMonth = text(body.toMonth);
  const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
  if ((startMonth && !monthPattern.test(startMonth)) || (endMonth && !monthPattern.test(endMonth))) throw new AcademyApiError(400, 'Analytics date filters must use YYYY-MM.', 'INVALID_MONTH_RANGE');
  if (startMonth && endMonth && startMonth > endMonth) throw new AcademyApiError(400, 'The start month must not be after the end month.', 'INVALID_MONTH_RANGE');
  if (startMonth && endMonth) { const [sy, sm] = startMonth.split('-').map(Number); const [ey, em] = endMonth.split('-').map(Number); if ((ey - sy) * 12 + (em - sm) > 35) throw new AcademyApiError(400, 'Select a maximum date range of 36 months.', 'MONTH_RANGE_TOO_LARGE'); }
  const inRange = (month: string) => (!startMonth || month >= startMonth) && (!endMonth || month <= endMonth);
  const monthMap = new Map<string, { month: string; newStudents: number; present: number; absent: number; collected: number; outstanding: number }>();
  const bucket = (month: string) => { if (!month) return null; if (!monthMap.has(month)) monthMap.set(month, { month, newStudents: 0, present: 0, absent: 0, collected: 0, outstanding: 0 }); return monthMap.get(month)!; };
  for (const doc of students.docs) { const d = dateValue(doc.data().createdAt); const month = d?.toISOString().slice(0, 7) ?? ''; if (inRange(month)) { const b = bucket(month); if (b) b.newStudents += 1; } }
  for (const doc of attendance.docs) { const row = doc.data(); const month = text(row.date).slice(0, 7); if (!inRange(month) || row.status === 'void') continue; const b = bucket(month); if (!b) continue; const map = isRow(row.attendanceMap) ? row.attendanceMap : {}; for (const value of Object.values(map)) { if (value === true) b.present += 1; else if (value === false) b.absent += 1; } }
  for (const doc of invoices.docs) { const row = doc.data(); const month = text(row.billingMonth) || dateValue(row.createdAt)?.toISOString().slice(0, 7) || ''; if (!inRange(month)) continue; const b = bucket(month); if (b) { b.collected += Number(row.paidAmount ?? 0); b.outstanding += Number(row.remainingBalance ?? 0); } }
  const classNames = new Map(classes.docs.map((doc) => [doc.id, text(doc.data().name) || doc.id]));
  const classCounts = new Map<string, number>(); const subjectCounts = new Map<string, number>();
  for (const doc of enrolments.docs) { const row = doc.data(); const classId = text(row.classId); const subjectId = text(row.subjectId); if (classId) classCounts.set(classId, (classCounts.get(classId) ?? 0) + 1); if (subjectId) subjectCounts.set(text(row.subjectName) || subjectId, (subjectCounts.get(text(row.subjectName) || subjectId) ?? 0) + 1); }
  const quizRows = quizzes.docs.filter((doc) => doc.data().status !== 'archived').map((doc) => { const row = doc.data(); const scores = Array.isArray(row.studentScores) ? row.studentScores as Row[] : []; const total = Number(row.totalMarks ?? 0); const graded = scores.filter((score) => typeof score.marks === 'number' && Number.isFinite(score.marks) && Number(score.marks) >= 0 && Number(score.marks) <= total); const average = graded.length && total > 0 ? graded.reduce((sum, score) => sum + (Number(score.marks) / total) * 100, 0) / graded.length : null; return { quizId: doc.id, title: text(row.title), subjectName: text(row.subjectName), className: text(row.className), date: text(row.date), averagePercentage: average, gradedStudents: graded.length, totalStudents: scores.length }; }).filter((row) => inRange(row.date.slice(0, 7)));
  const expenseTotal = expenses.docs.reduce((sum, doc) => { const month = text(doc.data().expenseDate).slice(0, 7); return inRange(month) ? sum + Number(doc.data().amount ?? 0) : sum; }, 0);
  const months = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
  return { success: true, summary: { totalStudents: students.size, activeStudents: students.docs.filter((doc) => doc.data().status === 'active').length, totalClasses: classes.docs.filter((doc) => doc.data().status !== 'archived').length, totalSubjectEnrolments: enrolments.size, attendanceRecords: attendance.docs.filter((doc) => doc.data().status !== 'void').length, quizzes: quizRows.length, studentReports: studentReports.docs.filter((doc) => doc.data().status !== 'archived').length, postedExpenses: expenseTotal }, monthly: months, classDistribution: [...classCounts].map(([classId, count]) => ({ classId, className: classNames.get(classId) ?? classId, students: count })), subjectDistribution: [...subjectCounts].map(([subjectName, students]) => ({ subjectName, students })), quizPerformance: quizRows, meta: { limited: students.size >= 3000 || enrolments.size >= 5000 || attendance.size >= 3000 || invoices.size >= 3000 || expenses.size >= 3000 || quizzes.size >= 2000 || studentReports.size >= 3000 } };
}

async function updateStudentExtraCharges(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const studentId = id(body.studentId, 'Student');
  const reason = required(body.reason, 'Extra-charge change reason', 500);
  const expectedVersion = Number(body.expectedVersion ?? 0);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new AcademyApiError(400, 'The extra-charge revision is invalid. Refresh the student and retry.', 'INVALID_EXTRA_CHARGE_REVISION');
  }
  let extraCharges: ReturnType<typeof normalizeAcademyStudentExtraCharges>;
  try {
    extraCharges = normalizeAcademyStudentExtraCharges(body.extraCharges);
  } catch (error) {
    throw new AcademyApiError(400, error instanceof Error ? error.message : 'Extra charges are invalid.', 'INVALID_EXTRA_CHARGES');
  }
  const studentRef = actor.root.collection('students').doc(studentId);
  const audit = auditRef(actor.root);
  let nextVersion = expectedVersion;
  await actor.db.runTransaction(async (tx) => {
    const studentSnap = await tx.get(studentRef);
    if (!studentSnap.exists || studentSnap.data()?.status === 'archived') {
      throw new AcademyApiError(404, 'Active student was not found.', 'STUDENT_NOT_FOUND');
    }
    const current = studentSnap.data() ?? {};
    const currentVersion = Number.isSafeInteger(Number(current.extraChargesVersion)) && Number(current.extraChargesVersion) >= 0
      ? Number(current.extraChargesVersion)
      : 0;
    if (currentVersion !== expectedVersion) {
      throw new AcademyApiError(409, 'Extra charges changed in another session. Refresh before saving.', 'EXTRA_CHARGES_CHANGED');
    }
    nextVersion = currentVersion + 1;
    tx.update(studentRef, {
      extraCharges,
      extraChargesVersion: nextVersion,
      updatedByUid: actor.session.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(audit, {
      event: 'student.extra_charges_updated',
      academyId: actor.session.academyId,
      actorUid: actor.session.uid,
      studentId,
      reason,
      chargeCount: extraCharges.length,
      revision: nextVersion,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return { success: true, studentId, extraCharges, extraChargesVersion: nextVersion };
}

async function updateStudent(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const studentId = id(body.studentId, 'Student');
  const ref = actor.root.collection('students').doc(studentId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.status === 'archived') throw new AcademyApiError(404, 'Active student was not found.', 'STUDENT_NOT_FOUND');
  const before = snap.data() ?? {};
  const name = required(body.name ?? before.name, 'Student name', 120);
  const fatherName = text(body.fatherName ?? before.fatherName).slice(0, 120);
  const gender = text(body.gender ?? before.gender);
  if (!['Male', 'Female'].includes(gender)) throw new AcademyApiError(400, 'Gender must be Male or Female.', 'INVALID_GENDER');
  const phoneInput = body.phone === undefined ? text(before.phone) : text(body.phone);
  const phone = phoneInput ? normalizePakMobile(phoneInput) : '';
  if (phoneInput && !phone) throw new AcademyApiError(400, 'Guardian phone must be a valid Pakistani +92 mobile number.', 'INVALID_PHONE');
  const changedPhone = phone !== text(before.phone);
  const reason = required(body.reason, 'Edit reason', 500);
  const admissionDate = body.admissionDate === undefined ? text(before.admissionDate) : isoDate(body.admissionDate, 'Admission date');
  const targetClassId = body.classId === undefined ? text(before.primaryClassId) : id(body.classId, 'Class');
  const shouldUpdateEnrollments = body.subjectIds !== undefined || body.classId !== undefined;
  const currentEnrollmentSnap = shouldUpdateEnrollments
    ? await actor.root.collection('studentSubjectEnrollments').where('studentId', '==', studentId).where('active', '==', true).limit(200).get()
    : null;
  const currentEnrollments = currentEnrollmentSnap?.docs ?? [];
  const selectedSubjectIds = shouldUpdateEnrollments
    ? normalizeIdList(body.subjectIds === undefined ? currentEnrollments.filter((doc) => text(doc.data().classId) === targetClassId).map((doc) => text(doc.data().subjectId)) : body.subjectIds, 'Subjects', 30)
    : [];
  if (shouldUpdateEnrollments && !selectedSubjectIds.length) throw new AcademyApiError(400, 'Select at least one subject for the student.', 'SUBJECT_REQUIRED');

  const classRef = shouldUpdateEnrollments ? actor.root.collection('classes').doc(targetClassId) : null;
  const classSnap = classRef ? await classRef.get() : null;
  if (shouldUpdateEnrollments && (!classSnap?.exists || ['archived', 'inactive'].includes(text(classSnap.data()?.status)))) {
    throw new AcademyApiError(409, 'Select an active Academy class.', 'CLASS_NOT_ACTIVE');
  }
  const subjectRefs = shouldUpdateEnrollments ? selectedSubjectIds.map((subjectId) => actor.root.collection('subjects').doc(subjectId)) : [];
  const subjectSnaps = await Promise.all(subjectRefs.map((subjectRef) => subjectRef.get()));
  if (shouldUpdateEnrollments && subjectSnaps.some((subject) => !subject.exists || subject.data()?.active !== true || text(subject.data()?.classId) !== targetClassId)) {
    throw new AcademyApiError(400, 'Every selected subject must belong to the selected active class.', 'SUBJECT_CLASS_MISMATCH');
  }
  const allClassAssignments = shouldUpdateEnrollments
    ? await actor.root.collection('teacherAssignments').where('classId', '==', targetClassId).where('active', '==', true).limit(300).get()
    : null;
  const selectedAssignments = shouldUpdateEnrollments ? selectedSubjectIds.map((subjectId) => {
    const matches = (allClassAssignments?.docs ?? []).filter((doc) => text(doc.data().subjectId) === subjectId);
    if (matches.length !== 1) throw new AcademyApiError(409, `The subject ${subjectId} must have exactly one active assigned teacher.`, 'SUBJECT_ASSIGNMENT_AMBIGUOUS');
    return matches[0];
  }) : [];
  const teacherUids = [...new Set(selectedAssignments.map((doc) => text(doc.data().teacherUid)).filter(Boolean))];
  if (shouldUpdateEnrollments && (selectedAssignments.length !== selectedSubjectIds.length || selectedAssignments.some((doc) => !text(doc.data().teacherUid)))) {
    throw new AcademyApiError(409, 'Every selected subject must have an assigned teacher.', 'TEACHER_ASSIGNMENT_REQUIRED');
  }
  const teacherRefs = teacherUids.map((uid) => actor.root.collection('members').doc(uid));
  const mappingRefs = teacherUids.map((uid) => actor.db.collection('academyMemberships').doc(uid));
  const teacherMemberSnaps = await Promise.all(teacherRefs.map((teacherRef) => teacherRef.get()));
  const teacherEmails = teacherMemberSnaps.map((teacher) => text(teacher.data()?.email).toLowerCase());
  if (teacherEmails.some((email, index) => !email || !teacherMemberSnaps[index].exists || teacherMemberSnaps[index].data()?.role !== 'teacher' || teacherMemberSnaps[index].data()?.active !== true || teacherMemberSnaps[index].data()?.emailVerified !== true)) {
    throw new AcademyApiError(409, 'A selected subject teacher is not an active, verified Academy member.', 'TEACHER_MEMBERSHIP_CHANGED');
  }
  const profileRefs = teacherEmails.map((email) => actor.db.collection('users').doc(email));
  const enrollmentRefs = shouldUpdateEnrollments ? selectedSubjectIds.map((subjectId) => actor.root.collection('studentSubjectEnrollments').doc(hashId(`${studentId}|${targetClassId}|${subjectId}`))) : [];
  const sequenceRef = shouldUpdateEnrollments ? actor.root.collection('rollNumberSequences').doc(targetClassId) : null;
  const studentsForClassQuery = shouldUpdateEnrollments ? actor.root.collection('students').where('primaryClassId', '==', targetClassId).limit(2000) : null;

  const patch: Row = {
    name, fatherName, gender, phone, guardianWhatsapp: phone,
    admissionDate,
    updatedByUid: actor.session.uid, updatedAt: FieldValue.serverTimestamp(),
  };
  if (body.notes !== undefined) patch.notes = text(body.notes).slice(0, 2000);
  if (body.avatarStoragePath !== undefined) {
    const avatarStoragePath = text(body.avatarStoragePath);
    const expectedPath = `academies/${actor.session.academyId}/students/${studentId}/profile/avatar`;
    if (avatarStoragePath && avatarStoragePath !== expectedPath) throw new AcademyApiError(400, 'Student photo must belong to this Academy student profile in Firebase Storage.', 'INVALID_AVATAR_PATH');
    patch.avatarStoragePath = avatarStoragePath || null;
  }
  if (changedPhone) {
    for (const key of ['attendanceWhatsAppOptIn', 'parentWhatsAppOptIn', 'quizResultsWhatsAppOptIn', 'feeAlertsWhatsAppOptIn', 'announcementWhatsAppOptIn', 'libraryLinkWhatsAppOptIn']) patch[key] = false;
    for (const key of ['attendanceWhatsAppOptInAt', 'parentWhatsAppOptInAt', 'quizResultsWhatsAppOptInAt', 'feeAlertsWhatsAppOptInAt', 'announcementWhatsAppOptInAt', 'libraryLinkWhatsAppOptInAt', 'attendanceWhatsAppOptInPhone', 'parentWhatsAppOptInPhone', 'quizResultsWhatsAppOptInPhone', 'feeAlertsWhatsAppOptInPhone', 'announcementWhatsAppOptInPhone', 'libraryLinkWhatsAppOptInPhone']) patch[key] = null;
  }
  const consentKeys = ['attendanceWhatsAppOptIn', 'parentWhatsAppOptIn', 'quizResultsWhatsAppOptIn', 'feeAlertsWhatsAppOptIn', 'announcementWhatsAppOptIn', 'libraryLinkWhatsAppOptIn'];
  consentKeys.forEach((key) => {
    if (body[key] !== undefined) {
      const accepted = body[key] === true;
      patch[key] = accepted;
      patch[`${key}At`] = accepted ? FieldValue.serverTimestamp() : null;
      patch[`${key}Phone`] = accepted ? phone : null;
    }
  });

  const audit = auditRef(actor.root);
  const now = FieldValue.serverTimestamp();
  let phoneConsentReset = changedPhone;
  let allocatedRollNo = text(before.rollNo);
  await actor.db.runTransaction(async (tx) => {
    const reads = await Promise.all([
      tx.get(ref),
      classRef ? tx.get(classRef) : Promise.resolve(null),
      Promise.all(subjectRefs.map((subjectRef) => tx.get(subjectRef))),
      Promise.all(selectedAssignments.map((assignment) => tx.get(assignment.ref))),
      Promise.all(teacherRefs.map((teacherRef) => tx.get(teacherRef))),
      Promise.all(mappingRefs.map((mappingRef) => tx.get(mappingRef))),
      Promise.all(profileRefs.map((profileRef) => tx.get(profileRef))),
      Promise.all(currentEnrollments.map((doc) => tx.get(doc.ref))),
      Promise.all(enrollmentRefs.map((enrollmentRef) => tx.get(enrollmentRef))),
      sequenceRef ? tx.get(sequenceRef) : Promise.resolve(null),
      studentsForClassQuery && targetClassId !== text(before.primaryClassId) ? tx.get(studentsForClassQuery) : Promise.resolve(null),
    ]);
    const [fresh, freshClass, freshSubjects, freshAssignments, freshTeachers, freshMappings, freshProfiles, freshOldEnrollments, freshNewEnrollments, sequenceSnapshot, existingClassStudents] = reads;
    if (!fresh.exists || fresh.data()?.status === 'archived') throw new AcademyApiError(409, 'Student state changed. Refresh and retry.', 'STUDENT_STATE_CHANGED');
    if (text(fresh.data()?.phone) !== text(before.phone)) throw new AcademyApiError(409, 'Guardian phone changed in another session. Refresh before saving.', 'STUDENT_CONCURRENT_MODIFICATION');
    if (shouldUpdateEnrollments) {
      if (!freshClass?.exists || ['archived', 'inactive'].includes(text(freshClass.data()?.status))) throw new AcademyApiError(409, 'The selected class is no longer active.', 'CLASS_NOT_ACTIVE');
      if (freshSubjects.some((subject) => !subject.exists || subject.data()?.active !== true || text(subject.data()?.classId) !== targetClassId)) throw new AcademyApiError(409, 'A subject changed while the student was being edited. Refresh and retry.', 'SUBJECT_STATE_CHANGED');
      if (freshAssignments.some((assignment) => !assignment.exists || assignment.data()?.active !== true || !text(assignment.data()?.teacherUid))) throw new AcademyApiError(409, 'A subject teacher assignment changed. Refresh and retry.', 'ASSIGNMENT_CHANGED');
      for (let index = 0; index < teacherUids.length; index += 1) {
        const mapping = freshMappings[index].data() ?? {};
        const profile = freshProfiles[index].data() ?? {};
        if (!freshTeachers[index].exists || freshTeachers[index].data()?.role !== 'teacher' || freshTeachers[index].data()?.active !== true || freshTeachers[index].data()?.emailVerified !== true ||
          !freshMappings[index].exists || mapping.academyId !== actor.session.academyId || mapping.role !== 'teacher' || mapping.active !== true ||
          !freshProfiles[index].exists || profile.uid !== teacherUids[index] || profile.academyId !== actor.session.academyId || profile.role !== 'teacher') {
          throw new AcademyApiError(409, 'A selected subject teacher membership changed. Refresh and retry.', 'TEACHER_MEMBERSHIP_CHANGED');
        }
      }
      const classChanged = targetClassId !== text(fresh.data()?.primaryClassId);
      if (classChanged) {
        if (!sequenceSnapshot) throw new AcademyApiError(409, 'Class roll-number sequence could not be read.', 'ROLL_SEQUENCE_INVALID');
        let nextRoll = Number(sequenceSnapshot.data()?.nextRollNo);
        if (!sequenceSnapshot.exists) {
          if ((existingClassStudents?.size ?? 0) >= 2000) throw new AcademyApiError(409, 'The selected class has too many students for automatic roll-number initialization. Initialize its sequence first.', 'ROLL_SEQUENCE_INITIALIZATION_REQUIRED');
          nextRoll = nextClassRollNumber((existingClassStudents?.docs ?? []).map((doc) => doc.data().rollNo), 1);
        }
        if (!Number.isSafeInteger(nextRoll) || nextRoll < 1) throw new AcademyApiError(409, 'The selected class roll-number sequence is invalid.', 'ROLL_SEQUENCE_INVALID');
        allocatedRollNo = String(nextRoll);
        let duplicate = true;
        for (let attempt = 0; attempt < 100 && duplicate; attempt += 1) {
          const normalized = allocatedRollNo.toLowerCase().replace(/\s+/g, ' ');
          const duplicateQuery = actor.root.collection('students').where('primaryClassId', '==', targetClassId).where('rollNoNormalized', '==', normalized).limit(2);
          const duplicateSnap = await tx.get(duplicateQuery);
          duplicate = duplicateSnap.docs.some((doc) => doc.id !== studentId);
          if (duplicate) allocatedRollNo = String(Number(allocatedRollNo) + 1);
          if (attempt === 99 && duplicate) throw new AcademyApiError(409, 'Could not allocate a unique roll number in the selected class.', 'ROLL_NUMBER_ALLOCATION_FAILED');
        }
        const normalized = allocatedRollNo.toLowerCase().replace(/\s+/g, ' ');
        tx.set(sequenceRef!, { classId: targetClassId, nextRollNo: advanceClassRollSequence(nextRoll, allocatedRollNo), lastAllocatedRollNo: allocatedRollNo, updatedByUid: actor.session.uid, updatedAt: now }, { merge: true });
        patch.rollNo = allocatedRollNo;
        patch.rollNoNormalized = normalized;
      }
      const keepKeys = new Set([
        ...freshOldEnrollments
          .filter((enrollment) => enrollment.exists && enrollment.data()?.active === true && text(enrollment.data()?.classId) !== targetClassId)
          .map((enrollment) => `${text(enrollment.data()?.classId)}:${text(enrollment.data()?.subjectId)}`),
        ...selectedSubjectIds.map((subjectId) => `${targetClassId}:${subjectId}`),
      ]);
      freshOldEnrollments.forEach((enrollment) => {
        if (!enrollment.exists || enrollment.data()?.active !== true) return;
        const key = `${text(enrollment.data()?.classId)}:${text(enrollment.data()?.subjectId)}`;
        if (!keepKeys.has(key)) tx.update(enrollment.ref, { active: false, endedAt: now, endedByUid: actor.session.uid, endReason: 'student_enrolments_edited', updatedAt: now });
      });
      let totalMonthlyFee = 0;
      selectedSubjectIds.forEach((subjectId, index) => {
        const subject = freshSubjects[index].data() ?? {};
        const assignment = freshAssignments[index].data() ?? {};
        const monthlyFee = Number(subject.monthlyFee ?? 0);
        totalMonthlyFee += monthlyFee;
        tx.set(enrollmentRefs[index], {
          enrollmentId: enrollmentRefs[index].id, academyId: actor.session.academyId, studentId,
          classId: targetClassId, className: text(freshClass.data()?.name), subjectId,
          subjectName: text(subject.name), teacherUid: text(assignment.teacherUid),
          feeAmountMonthly: monthlyFee, billingFrequency: text(subject.billingFrequency) || 'monthly',
          active: true, updatedAt: now, updatedByUid: actor.session.uid,
          ...(freshNewEnrollments[index]?.exists ? {} : { createdAt: now, createdByUid: actor.session.uid }),
        }, { merge: true });
      });
      patch.primaryClassId = targetClassId;
      patch.primaryTeacherUid = teacherUids.length === 1 ? teacherUids[0] : null;
      patch.monthlyFee = Math.round(totalMonthlyFee * 100) / 100;
      patch.studentFee = String(Math.round(totalMonthlyFee * 100) / 100);
    }
    tx.update(ref, { ...patch, updatedAt: now });
    tx.create(audit, {
      event: 'student.updated', academyId: actor.session.academyId, actorUid: actor.session.uid,
      studentId, reason, phoneConsentReset: changedPhone,
      changedFields: Object.keys(patch).filter((field) => !['updatedAt', 'updatedByUid'].includes(field)),
      ...(shouldUpdateEnrollments ? { classId: targetClassId, subjectIds: selectedSubjectIds, rollNo: allocatedRollNo } : {}),
      createdAt: now,
    });
  });
  return { success: true, studentId, phoneConsentReset, rollNo: allocatedRollNo };
}

async function archiveStudent(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const studentId = id(body.studentId, 'Student');
  const reason = required(body.reason, 'Archive reason', 500);
  const ref = actor.root.collection('students').doc(studentId);
  const enrolments = actor.root.collection('studentSubjectEnrollments').where('studentId', '==', studentId).where('active', '==', true).limit(400);
  const audit = auditRef(actor.root);
  await actor.db.runTransaction(async (tx) => {
    const [snap, enrolmentSnap] = await Promise.all([tx.get(ref), tx.get(enrolments)]);
    if (enrolmentSnap.size >= 400) throw new AcademyApiError(409, 'This student has an unusually large number of active enrolments. Review them before archiving.', 'ARCHIVE_LIMIT_REACHED');
    if (!snap.exists || snap.data()?.status === 'archived') throw new AcademyApiError(404, 'Student was not found.', 'STUDENT_NOT_FOUND');
    const now = FieldValue.serverTimestamp();
    tx.update(ref, { status: 'archived', archivedAt: now, archivedByUid: actor.session.uid, archiveReason: reason, updatedAt: now });
    enrolmentSnap.docs.forEach((doc) => tx.update(doc.ref, { active: false, endedAt: now, endedByUid: actor.session.uid, endReason: 'student_archived' }));
    tx.create(audit, { event: 'student.archived', academyId: actor.session.academyId, actorUid: actor.session.uid, studentId, reason, affectedEnrollments: enrolmentSnap.size, createdAt: now });
  });
  return { success: true, studentId, status: 'archived' };
}

async function updateClass(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const classId = id(body.classId, 'Class');
  const ref = actor.root.collection('classes').doc(classId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.status === 'archived') throw new AcademyApiError(404, 'Active class was not found.', 'CLASS_NOT_FOUND');
  const before = snap.data() ?? {};
  const name = required(body.name ?? before.name, 'Class name', 100);
  const grade = text(body.grade ?? before.grade).slice(0, 32);
  const section = text(body.section ?? before.section).slice(0, 32);
  const academicYear = text(body.academicYear ?? before.academicYear).slice(0, 24);
  const reason = required(body.reason, 'Edit reason', 500);
  const normalizedName = `${name} ${section}`.trim().toLowerCase().replace(/\s+/g, ' ');
  const classCode = text(before.classCode);
  const assignments = await actor.root.collection('teacherAssignments').where('classId', '==', classId).where('active', '==', true).limit(100).get();
  if (assignments.size >= 100) throw new AcademyApiError(409, 'This class has too many teacher projections to update safely in one action.', 'CLASS_PROJECTION_LIMIT');
  const teacherUids = [...new Set(assignments.docs.map((doc) => text(doc.data().teacherUid)).filter(Boolean))];
  const memberSnaps = await Promise.all(teacherUids.map((uid) => actor.root.collection('members').doc(uid).get()));
  const legacyRefs = memberSnaps.map((member) => {
    const email = text(member.data()?.email).toLowerCase();
    return email ? actor.db.collection('users').doc(email).collection('classes').doc(classId) : null;
  }).filter((value): value is NonNullable<typeof value> => Boolean(value));
  const audit = auditRef(actor.root);
  await actor.db.runTransaction(async (tx) => {
    const [fresh, projections] = await Promise.all([tx.get(ref), Promise.all(legacyRefs.map((legacyRef) => tx.get(legacyRef)))]);
    if (!fresh.exists || fresh.data()?.status === 'archived') throw new AcademyApiError(409, 'Class state changed. Refresh and retry.', 'CLASS_STATE_CHANGED');
    const now = FieldValue.serverTimestamp();
    tx.update(ref, { name, grade, section, academicYear, normalizedName, updatedAt: now, updatedByUid: actor.session.uid });
    projections.forEach((projection, index) => {
      if (projection.exists) tx.set(legacyRefs[index], { ...projection.data(), id: classId, name, className: name, grade, section, classCode, academyId: actor.session.academyId, academyClassId: classId, updatedAt: new Date().toISOString() }, { merge: true });
    });
    tx.create(audit, { event: 'class.updated', academyId: actor.session.academyId, actorUid: actor.session.uid, classId, reason, before: { name: before.name, grade: before.grade, section: before.section, academicYear: before.academicYear }, after: { name, grade, section, academicYear }, createdAt: now });
  });
  return { success: true, classId, updatedTeacherProjections: legacyRefs.length };
}

async function archiveClass(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const classId = id(body.classId, 'Class');
  const reason = required(body.reason, 'Archive reason', 500);
  const classRef = actor.root.collection('classes').doc(classId);
  const [subjectSnap, assignmentSnap, enrolmentSnap] = await Promise.all([
    actor.root.collection('subjects').where('classId', '==', classId).limit(150).get(),
    actor.root.collection('teacherAssignments').where('classId', '==', classId).where('active', '==', true).limit(150).get(),
    actor.root.collection('studentSubjectEnrollments').where('classId', '==', classId).where('active', '==', true).limit(150).get(),
  ]);
  if (subjectSnap.size >= 150 || assignmentSnap.size >= 150 || enrolmentSnap.size >= 150 || subjectSnap.size + assignmentSnap.size + enrolmentSnap.size > 450) {
    throw new AcademyApiError(409, 'This class has too many related records for a single safe archive. Use the reviewed bulk archival procedure.', 'CLASS_ARCHIVE_LIMIT');
  }
  const audit = auditRef(actor.root);
  await actor.db.runTransaction(async (tx) => {
    const [cls, subjectDocs, assignmentDocs, enrolmentDocs] = await Promise.all([
      tx.get(classRef), Promise.all(subjectSnap.docs.map((doc) => tx.get(doc.ref))),
      Promise.all(assignmentSnap.docs.map((doc) => tx.get(doc.ref))), Promise.all(enrolmentSnap.docs.map((doc) => tx.get(doc.ref))),
    ]);
    if (!cls.exists || cls.data()?.status === 'archived') throw new AcademyApiError(404, 'Class was not found.', 'CLASS_NOT_FOUND');
    const now = FieldValue.serverTimestamp();
    tx.update(classRef, { status: 'archived', archivedAt: now, archivedByUid: actor.session.uid, archiveReason: reason, updatedAt: now });
    subjectDocs.forEach((doc) => { if (doc.exists) tx.update(doc.ref, { active: false, archivedAt: now, updatedAt: now, archiveReason: reason }); });
    assignmentDocs.forEach((doc) => { if (doc.exists) tx.update(doc.ref, { active: false, endedAt: now, endedByUid: actor.session.uid }); });
    enrolmentDocs.forEach((doc) => { if (doc.exists) tx.update(doc.ref, { active: false, endedAt: now, endedByUid: actor.session.uid, endReason: 'class_archived' }); });
    tx.create(audit, { event: 'class.archived', academyId: actor.session.academyId, actorUid: actor.session.uid, classId, reason, affectedSubjects: subjectDocs.length, affectedAssignments: assignmentDocs.length, affectedEnrollments: enrolmentDocs.length, createdAt: now });
  });
  return { success: true, classId, status: 'archived', affectedEnrollments: enrolmentSnap.size };
}

async function updateSubject(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const subjectId = id(body.subjectId, 'Subject');
  const ref = actor.root.collection('subjects').doc(subjectId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.active !== true) throw new AcademyApiError(404, 'Active subject was not found.', 'SUBJECT_NOT_FOUND');
  const before = snap.data() ?? {};
  const classId = id(before.classId, 'Subject class');
  const name = required(body.name ?? before.name, 'Subject name', 100);
  const monthlyFee = number(body.monthlyFee ?? before.monthlyFee, 'Monthly fee');
  const code = text(body.code ?? before.code).slice(0, 32);
  const billingFrequency = text(body.billingFrequency ?? before.billingFrequency ?? 'monthly').toLowerCase();
  if (!['monthly', 'termly', 'yearly'].includes(billingFrequency)) throw new AcademyApiError(400, 'Billing frequency must be monthly, termly or yearly.', 'INVALID_BILLING_FREQUENCY');
  const reason = required(body.reason, 'Edit reason', 500);
  const now = FieldValue.serverTimestamp();
  const audit = auditRef(actor.root);

  const [enrollmentSnap, assignmentSnap] = await Promise.all([
    actor.root.collection('studentSubjectEnrollments').where('subjectId', '==', subjectId).where('active', '==', true).limit(300).get(),
    actor.root.collection('teacherAssignments').where('subjectId', '==', subjectId).where('active', '==', true).limit(10).get(),
  ]);
  if (enrollmentSnap.size >= 300) throw new AcademyApiError(409, 'This subject has too many active enrolments to update in one transaction.', 'SUBJECT_UPDATE_LIMIT');
  if (assignmentSnap.size > 1) throw new AcademyApiError(409, 'Multiple active teachers are assigned to this subject. Resolve the duplicate assignment before editing.', 'DUPLICATE_ACTIVE_ASSIGNMENT');

  const previousAssignment = assignmentSnap.docs[0] ?? null;
  const previousTeacherUid = text(previousAssignment?.data()?.teacherUid);
  const teacherUid = body.teacherUid === undefined ? previousTeacherUid : text(body.teacherUid);
  const teacherMemberRef = teacherUid ? actor.root.collection('members').doc(id(teacherUid, 'Teacher')) : null;
  const teacherMappingRef = teacherUid ? actor.db.collection('academyMemberships').doc(teacherUid) : null;
  const teacherMember = teacherMemberRef ? await teacherMemberRef.get() : null;
  const teacherEmail = text(teacherMember?.data()?.email).toLowerCase();
  if (teacherUid && (!teacherMember?.exists || teacherMember.data()?.role !== 'teacher' || teacherMember.data()?.active !== true || teacherMember.data()?.emailVerified !== true || !teacherEmail)) {
    throw new AcademyApiError(400, 'Assign an active, verified teacher from this Academy.', 'INVALID_TEACHER');
  }
  const teacherProfileRef = teacherUid ? actor.db.collection('users').doc(teacherEmail) : null;
  const nextAssignmentRef = teacherUid
    ? (teacherUid === previousTeacherUid && previousAssignment ? previousAssignment.ref : actor.root.collection('teacherAssignments').doc())
    : null;
  const legacyClassRef = teacherUid ? teacherProfileRef!.collection('classes').doc(classId) : null;
  const classRef = actor.root.collection('classes').doc(classId);
  const classSnapshot = await classRef.get();
  if (!classSnapshot.exists || classSnapshot.data()?.status === 'archived') throw new AcademyApiError(409, 'The subject class is no longer active.', 'CLASS_NOT_ACTIVE');

  await actor.db.runTransaction(async (tx) => {
    const reads = await Promise.all([
      tx.get(ref),
      Promise.all(enrollmentSnap.docs.map((doc) => tx.get(doc.ref))),
      previousAssignment ? tx.get(previousAssignment.ref) : Promise.resolve(null),
      teacherMemberRef ? tx.get(teacherMemberRef) : Promise.resolve(null),
      teacherMappingRef ? tx.get(teacherMappingRef) : Promise.resolve(null),
      teacherProfileRef ? tx.get(teacherProfileRef) : Promise.resolve(null),
      legacyClassRef ? tx.get(legacyClassRef) : Promise.resolve(null),
      tx.get(classRef),
      previousTeacherUid && previousTeacherUid !== teacherUid ? tx.get(actor.root.collection('members').doc(previousTeacherUid)) : Promise.resolve(null),
    ]);
    const [fresh, rows, freshPreviousAssignment, freshTeacherMember, freshTeacherMapping, freshTeacherProfile, legacyClass, freshClass, oldTeacher] = reads;
    if (!fresh.exists || fresh.data()?.active !== true) throw new AcademyApiError(409, 'Subject state changed.', 'SUBJECT_STATE_CHANGED');
    if (!freshClass.exists || freshClass.data()?.status === 'archived') throw new AcademyApiError(409, 'The subject class is no longer active.', 'CLASS_NOT_ACTIVE');
    if (teacherUid && (!freshTeacherMember?.exists || freshTeacherMember.data()?.role !== 'teacher' || freshTeacherMember.data()?.active !== true || freshTeacherMember.data()?.emailVerified !== true ||
      !freshTeacherMapping?.exists || freshTeacherMapping.data()?.academyId !== actor.session.academyId || freshTeacherMapping.data()?.role !== 'teacher' || freshTeacherMapping.data()?.active !== true ||
      !freshTeacherProfile?.exists || freshTeacherProfile.data()?.uid !== teacherUid || freshTeacherProfile.data()?.academyId !== actor.session.academyId || freshTeacherProfile.data()?.role !== 'teacher')) {
      throw new AcademyApiError(409, 'The selected teacher membership changed. Refresh and retry.', 'TEACHER_MEMBERSHIP_CHANGED');
    }
    tx.update(ref, { name, code, monthlyFee, billingFrequency, updatedAt: now, updatedByUid: actor.session.uid });
    rows.forEach((row) => {
      if (row.exists && row.data()?.active === true) tx.update(row.ref, {
        subjectName: name, feeAmountMonthly: monthlyFee, billingFrequency,
        ...(teacherUid ? { teacherUid } : { teacherUid: null }), updatedAt: now, updatedByUid: actor.session.uid,
      });
    });

    if (previousAssignment && previousTeacherUid !== teacherUid && freshPreviousAssignment?.exists) {
      tx.update(previousAssignment.ref, { active: false, endedAt: now, endedByUid: actor.session.uid, endReason: 'subject_teacher_reassigned' });
    }
    if (teacherUid && nextAssignmentRef) {
      tx.set(nextAssignmentRef, {
        assignmentId: nextAssignmentRef.id, academyId: actor.session.academyId, teacherUid, teacherEmail,
        classId, subjectId, subjectName: name, active: true,
        startsOn: new Date().toISOString().slice(0, 10),
        ...(teacherUid === previousTeacherUid && previousAssignment ? {} : { createdAt: now, createdByUid: actor.session.uid }),
        updatedAt: now,
      }, { merge: true });
      if (freshTeacherMember?.exists) {
        const current = freshTeacherMember.data() ?? {};
        const classIds = Array.isArray(current.assignedClassIds) ? current.assignedClassIds.map(String) : [];
        const subjectIds = Array.isArray(current.assignedSubjectIds) ? current.assignedSubjectIds.map(String) : [];
        tx.update(teacherMemberRef!, {
          assignedClassIds: [...new Set([...classIds, classId])],
          assignedSubjectIds: [...new Set([...subjectIds, subjectId])],
          updatedAt: now,
        });
      }
      const legacy = legacyClass?.data() ?? {};
      const academySubjectIds = Array.isArray(legacy.academySubjectIds) ? legacy.academySubjectIds.map(String) : [];
      tx.set(legacyClassRef!, {
        ...legacy, id: classId, name: text(freshClass.data()?.name), className: text(freshClass.data()?.name),
        grade: text(freshClass.data()?.grade), section: text(freshClass.data()?.section),
        classCode: text(freshClass.data()?.classCode), academicYear: text(freshClass.data()?.academicYear),
        academyId: actor.session.academyId, academyClassId: classId,
        academySubjectIds: [...new Set([...academySubjectIds, subjectId])], updatedAt: new Date().toISOString(),
      }, { merge: true });
    }
    if (previousAssignment && previousTeacherUid && previousTeacherUid !== teacherUid && freshPreviousAssignment?.exists) {
      // The previous teacher's assignment remains historical, but it must no longer
      // appear in the active teacher assignment projection after reassignment.
      const oldTeacherRef = actor.root.collection('members').doc(previousTeacherUid);
      if (oldTeacher?.exists) {
        const current = oldTeacher.data() ?? {};
        const remaining = await Promise.resolve(assignmentSnap.docs.filter((doc) => doc.id !== previousAssignment.id && text(doc.data().teacherUid) === previousTeacherUid));
        if (remaining.length === 0) {
          const subjectIds = Array.isArray(current.assignedSubjectIds) ? current.assignedSubjectIds.map(String).filter((value) => value !== subjectId) : [];
          const classIds = Array.isArray(current.assignedClassIds) ? current.assignedClassIds.map(String) : [];
          const stillHasClass = assignmentSnap.docs.some((doc) => doc.id !== previousAssignment.id && text(doc.data().teacherUid) === previousTeacherUid && text(doc.data().classId) === classId);
          tx.update(oldTeacherRef, { assignedSubjectIds: subjectIds, ...(stillHasClass ? {} : { assignedClassIds: classIds.filter((value) => value !== classId) }), updatedAt: now });
        }
      }
    }
    tx.create(audit, {
      event: 'subject.updated', academyId: actor.session.academyId, actorUid: actor.session.uid,
      subjectId, classId, reason,
      before: { name: before.name, monthlyFee: before.monthlyFee, billingFrequency: before.billingFrequency, teacherUid: previousTeacherUid },
      after: { name, monthlyFee, billingFrequency, teacherUid: teacherUid || null }, createdAt: now,
    });
  });
  return { success: true, subjectId, affectedEnrollments: enrollmentSnap.size, teacherUid: teacherUid || null };
}

async function archiveSubject(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const subjectId = id(body.subjectId, 'Subject');
  const reason = required(body.reason, 'Archive reason', 500);
  const ref = actor.root.collection('subjects').doc(subjectId);
  const [assignmentSnap, enrolmentSnap] = await Promise.all([
    actor.root.collection('teacherAssignments').where('subjectId', '==', subjectId).where('active', '==', true).limit(200).get(),
    actor.root.collection('studentSubjectEnrollments').where('subjectId', '==', subjectId).where('active', '==', true).limit(200).get(),
  ]);
  if (assignmentSnap.size >= 200 || enrolmentSnap.size >= 200 || assignmentSnap.size + enrolmentSnap.size > 450) throw new AcademyApiError(409, 'This subject has too many related records for a single safe archive.', 'SUBJECT_ARCHIVE_LIMIT');
  const audit = auditRef(actor.root);
  await actor.db.runTransaction(async (tx) => {
    const [subject, assignmentRows, enrolmentRows] = await Promise.all([tx.get(ref), Promise.all(assignmentSnap.docs.map((doc) => tx.get(doc.ref))), Promise.all(enrolmentSnap.docs.map((doc) => tx.get(doc.ref)))]);
    if (!subject.exists || subject.data()?.active !== true) throw new AcademyApiError(404, 'Subject was not found.', 'SUBJECT_NOT_FOUND');
    const now = FieldValue.serverTimestamp();
    tx.update(ref, { active: false, archivedAt: now, archivedByUid: actor.session.uid, archiveReason: reason, updatedAt: now });
    assignmentRows.forEach((doc) => { if (doc.exists) tx.update(doc.ref, { active: false, endedAt: now, endedByUid: actor.session.uid }); });
    enrolmentRows.forEach((doc) => { if (doc.exists) tx.update(doc.ref, { active: false, endedAt: now, endedByUid: actor.session.uid, endReason: 'subject_archived' }); });
    tx.create(audit, { event: 'subject.archived', academyId: actor.session.academyId, actorUid: actor.session.uid, subjectId, reason, affectedAssignments: assignmentRows.length, affectedEnrollments: enrolmentRows.length, createdAt: now });
  });
  return { success: true, subjectId, status: 'archived' };
}

async function updateTeacher(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const teacherUid = id(body.teacherUid, 'Teacher UID');
  const memberRef = actor.root.collection('members').doc(teacherUid);
  const mappingRef = actor.db.collection('academyMemberships').doc(teacherUid);
  const [member, mapping] = await Promise.all([memberRef.get(), mappingRef.get()]);
  if (!member.exists || member.data()?.role !== 'teacher' || !mapping.exists || mapping.data()?.academyId !== actor.session.academyId) throw new AcademyApiError(404, 'Teacher membership was not found.', 'TEACHER_NOT_FOUND');
  const email = text(member.data()?.email).toLowerCase();
  if (!email) throw new AcademyApiError(409, 'Teacher email is missing.', 'TEACHER_PROFILE_MISSING');
  const displayName = required(body.displayName ?? member.data()?.displayName, 'Teacher name', 120);
  const contactPhone = text(body.contactPhone ?? member.data()?.contactPhone).replace(/[\s().-]/g, '').slice(0, 16);
  if (contactPhone && !/^\+?[0-9]{10,15}$/.test(contactPhone)) throw new AcademyApiError(400, 'The contact number is invalid.', 'INVALID_CONTACT_PHONE');
  const designation = text(body.designation ?? member.data()?.designation).slice(0, 80);
  const contactEmail = text(body.contactEmail ?? member.data()?.contactEmail ?? email).toLowerCase();
  if (contactEmail && !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/i.test(contactEmail)) throw new AcademyApiError(400, 'Contact email must be a valid Gmail address ending in @gmail.com.', 'INVALID_CONTACT_EMAIL');
  const removeProfileImage = body.removeProfileImage === true;
  const profileImageStoragePath = removeProfileImage ? '' : text(body.profileImageStoragePath ?? member.data()?.profileImageStoragePath);
  if (profileImageStoragePath && profileImageStoragePath !== `academies/${actor.session.academyId}/teachers/${teacherUid}/profile/avatar`) {
    throw new AcademyApiError(400, 'Teacher photo path is invalid.', 'INVALID_TEACHER_PHOTO_PATH');
  }
  const profileImage = removeProfileImage ? '' : (body.profileImage === undefined ? undefined : text(body.profileImage).slice(0, 2400));
  if (profileImage && !/^https:\/\//i.test(profileImage)) throw new AcademyApiError(400, 'Teacher profile image must use HTTPS.', 'INVALID_PROFILE_IMAGE_URL');
  const reason = required(body.reason, 'Edit reason', 500);
  const profileRef = actor.db.collection('users').doc(email);
  const settingsRef = profileRef.collection('settings').doc('profile_data');
  const audit = auditRef(actor.root);
  const now = FieldValue.serverTimestamp();
  const auth = getFirebaseAdminAuth();
  try {
    await auth.updateUser(teacherUid, { displayName });
    await actor.db.runTransaction(async (tx) => {
      const [freshMember, freshMapping, profile, settings] = await Promise.all([tx.get(memberRef), tx.get(mappingRef), tx.get(profileRef), tx.get(settingsRef)]);
      if (!freshMember.exists || !freshMapping.exists || freshMapping.data()?.academyId !== actor.session.academyId || !profile.exists) throw new AcademyApiError(409, 'Teacher membership changed. Refresh and retry.', 'TEACHER_MEMBERSHIP_CHANGED');
      const profileData = profile.data() ?? {};
      const settingsData = settings.data() ?? {};
      const savedProfile = settingsData.profile && typeof settingsData.profile === 'object' && !Array.isArray(settingsData.profile) ? settingsData.profile as Row : {};
      const imageUrl = removeProfileImage ? '' : (profileImage === undefined ? text(profileData.profileImage) || text(savedProfile.avatarUrl) : profileImage);
      const imageFields = removeProfileImage
        ? { profileImageStoragePath: '', profileImage: '', avatarUrl: '' }
        : { ...(profileImageStoragePath ? { profileImageStoragePath } : {}), ...(profileImage !== undefined ? { profileImage, avatarUrl: profileImage } : {}) };
      tx.update(memberRef, { displayName, contactPhone, contactEmail, designation, ...imageFields, updatedAt: now, updatedByUid: actor.session.uid });
      tx.set(profileRef, {
        displayName, teacherName: displayName, name: displayName,
        contactPhone, whatsappNumber: contactPhone, phone: contactPhone, contactEmail,
        designation, teacherDesignation: designation,
        ...imageFields, academyName: actor.session.academyName, schoolName: actor.session.academyName,
        updatedAt: now,
      }, { merge: true });
      tx.set(settingsRef, {
        profile: { ...savedProfile, name: displayName, role: designation, schoolName: actor.session.academyName, email: contactEmail || email, contactEmail, phone: contactPhone, avatarUrl: imageUrl },
        updatedAt: now,
      }, { merge: true });
      tx.create(audit, { event: 'teacher.updated', academyId: actor.session.academyId, actorUid: actor.session.uid, teacherUid, reason, createdAt: now });
    });
  } catch (error) {
    try { await auth.updateUser(teacherUid, { displayName: text(member.data()?.displayName) || undefined }); } catch { /* surface original failure; manual reconciliation is safer than hiding it */ }
    throw error;
  }
  return { success: true, teacherUid };
}

async function setTeacherActive(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const teacherUid = id(body.teacherUid, 'Teacher UID');
  const active = body.active === true;
  const reason = required(body.reason, active ? 'Reactivation reason' : 'Deactivation reason', 500);
  const memberRef = actor.root.collection('members').doc(teacherUid);
  const mappingRef = actor.db.collection('academyMemberships').doc(teacherUid);
  const [member, mapping] = await Promise.all([memberRef.get(), mappingRef.get()]);
  if (!member.exists || member.data()?.role !== 'teacher' || !mapping.exists || mapping.data()?.academyId !== actor.session.academyId) throw new AcademyApiError(404, 'Teacher membership was not found.', 'TEACHER_NOT_FOUND');
  if (active && member.data()?.emailVerified !== true) throw new AcademyApiError(409, 'A teacher must verify their email before activation.', 'TEACHER_EMAIL_UNVERIFIED');
  const email = text(member.data()?.email).toLowerCase();
  const profileRef = actor.db.collection('users').doc(email);
  const audit = auditRef(actor.root);
  const now = FieldValue.serverTimestamp();
  const auth = getFirebaseAdminAuth();
  const previousAuth = await auth.getUser(teacherUid);
  try {
    await auth.updateUser(teacherUid, { disabled: !active });
    await actor.db.runTransaction(async (tx) => {
      const [freshMember, freshMapping, profile] = await Promise.all([tx.get(memberRef), tx.get(mappingRef), tx.get(profileRef)]);
      if (!freshMember.exists || !freshMapping.exists || freshMapping.data()?.academyId !== actor.session.academyId || !profile.exists) throw new AcademyApiError(409, 'Teacher membership changed. Refresh and retry.', 'TEACHER_MEMBERSHIP_CHANGED');
      tx.update(memberRef, { active, status: active ? 'active' : 'suspended', updatedAt: now, updatedByUid: actor.session.uid });
      tx.update(mappingRef, { active, status: active ? 'active' : 'suspended', updatedAt: now });
      tx.update(profileRef, { active, updatedAt: now });
      tx.create(audit, { event: active ? 'teacher.reactivated' : 'teacher.deactivated', academyId: actor.session.academyId, actorUid: actor.session.uid, teacherUid, reason, createdAt: now });
    });
  } catch (error) {
    try { await auth.updateUser(teacherUid, { disabled: previousAuth.disabled }); } catch { /* surface original failure; manual reconciliation is safer than hiding it */ }
    throw error;
  }
  return { success: true, teacherUid, active };
}

async function cancelInvoice(actor: Awaited<ReturnType<typeof adminActor>>, body: Row) {
  const invoiceId = id(body.invoiceId, 'Invoice'); const reason = required(body.reason, 'Cancellation reason', 500); const ref = actor.root.collection('feeInvoices').doc(invoiceId); const audit = auditRef(actor.root);
  await actor.db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) throw new AcademyApiError(404, 'Invoice was not found.', 'INVOICE_NOT_FOUND'); const row = snap.data() ?? {}; if (Number(row.paidAmount ?? 0) > 0) throw new AcademyApiError(409, 'An invoice with recorded payments cannot be deleted or cancelled. Use a reviewed refund/credit workflow.', 'INVOICE_HAS_PAYMENTS'); if (row.status === 'void') throw new AcademyApiError(409, 'Invoice is already cancelled.', 'INVOICE_ALREADY_VOID'); const now = FieldValue.serverTimestamp(); tx.update(ref, { status: 'void', cancelledAt: now, cancelledByUid: actor.session.uid, cancellationReason: reason, updatedAt: now }); tx.create(audit, { event: 'invoice.cancelled', academyId: actor.session.academyId, actorUid: actor.session.uid, invoiceId, reason, createdAt: now }); });
  return { success: true, invoiceId, status: 'void' };
}

export async function handleAcademyAdminWorkspaceAction(request: Request, body: Row) {
  const action = text(body.action);
  if (action === 'verify-guardian-whatsapp') {
    try { return await verifyAcademyAdminWhatsAppNumbers({ ...request, body }); }
    catch (error) {
      if (error instanceof WhatsAppNumberVerificationError) throw new AcademyApiError(error.status, error.message, 'WHATSAPP_VERIFICATION_FAILED');
      throw error;
    }
  }
  const actor = await adminActor(request);
  switch (action) {
    case 'attendance': return listAttendance(actor, body);
    case 'save-attendance': return saveAttendance(actor, body);
    case 'correct-attendance': return correctAttendance(actor, body);
    case 'void-attendance': return voidAttendance(actor, body);
    case 'quizzes': return listQuizzes(actor);
    case 'create-quiz': return createQuiz(actor, body);
    case 'update-quiz': return updateQuiz(actor, body);
    case 'archive-quiz': return archiveQuiz(actor, body);
    case 'notifications': return listAlerts(actor);
    case 'academy-teacher-alerts': return listAcademyTeacherAlerts(actor);
    case 'academy-whatsapp-dashboard': return getAcademyTeacherWhatsAppDashboard(actor, body);
    case 'academy-whatsapp-reconcile': return reconcileAcademyTeacherWhatsAppAlert(actor, body);
    case 'create-notification': return saveAlert(actor, body);
    case 'update-notification': return saveAlert(actor, body, true);
    case 'publish-notification': return publishAlert(actor, body);
    case 'archive-notification': return archiveAlert(actor, body);
    case 'analytics': return getAnalytics(actor, body);
    case 'update-student': return updateStudent(actor, body);
    case 'update-student-extra-charges': return updateStudentExtraCharges(actor, body);
    case 'archive-student': return archiveStudent(actor, body);
    case 'update-class': return updateClass(actor, body);
    case 'archive-class': return archiveClass(actor, body);
    case 'update-subject': return updateSubject(actor, body);
    case 'archive-subject': return archiveSubject(actor, body);
    case 'update-teacher': return updateTeacher(actor, body);
    case 'set-teacher-active': return setTeacherActive(actor, body);
    case 'cancel-invoice': return cancelInvoice(actor, body);
    default: throw new AcademyApiError(400, 'Unknown Academy Admin workspace action.', 'UNKNOWN_WORKSPACE_ACTION');
  }
}
