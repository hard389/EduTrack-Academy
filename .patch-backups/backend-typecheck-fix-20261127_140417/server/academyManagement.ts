import { createHash } from 'node:crypto';
import { FieldValue, type DocumentData, type DocumentReference, type DocumentSnapshot, type QueryDocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import type { ApiDispatchRequest, ApiDispatchResponse } from './apiRouteDispatcher.js';
import { getFirebaseAdminAuth, getFirebaseAdminFirestore } from './firebaseAdmin.js';
import { AcademyApiError, resolveAcademySession } from './academyIdentity.js';
import { handleAcademyAdminWorkspaceAction } from './academyAdminWorkspace.js';
import {
  ACADEMY_PERMISSION_DEFINITIONS,
  normalizePermissionMap,
  normalizeIdList,
  mergeTeacherAssignedIds,
  normalizeBillingMonth,
  buildInvoiceSnapshot,
  applyPaymentToInvoice,
  buildLegacyStudentProjection,
  makeClassCode,
  buildExpenseSnapshot,
  nextClassRollNumber,
  advanceClassRollSequence,
} from './academyManagementDomain.mjs';
import { calculateTeacherFeeSummary, isTeacherInvoiceLine, sumTeacherPaymentAllocations } from './academyTeacherFinanceDomain.mjs';
import { buildExpenseAllocationPlan, summarizeAcademyExpenses } from './academyExpensesDomain.mjs';

type Request = ApiDispatchRequest & { headers?: Record<string, string | string[] | undefined>; body?: unknown };
type RecordLike = Record<string, unknown>;
type Actor = { session: Awaited<ReturnType<typeof resolveAcademySession>>; db: ReturnType<typeof getFirebaseAdminFirestore>; member: RecordLike; memberRef: DocumentReference<DocumentData> };

const isRecord = (value: unknown): value is RecordLike => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const safeId = (value: unknown, field: string): string => {
  const result = clean(value);
  if (!result || result.length > 128 || result.includes('/') || result.includes('\\') || result.includes('..')) {
    throw new AcademyApiError(400, `${field} is invalid.`, 'INVALID_REQUEST');
  }
  return result;
};
const requiredText = (value: unknown, field: string, max = 120): string => {
  const result = clean(value);
  if (!result || result.length > max) throw new AcademyApiError(400, `${field} is required.`, 'INVALID_REQUEST');
  return result;
};
const safeNumber = (value: unknown, field: string, minimum = 0): number => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > 100_000_000) throw new AcademyApiError(400, `${field} is invalid.`, 'INVALID_REQUEST');
  return Math.round((number + Number.EPSILON) * 100) / 100;
};
const normalizePakMobile = (value: unknown): string => {
  let digits = clean(value).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = `92${digits.slice(1)}`;
  if (digits.length === 10) digits = `92${digits}`;
  return /^923\d{9}$/.test(digits) ? `+${digits}` : '';
};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const serializeDate = (value: unknown): string | null => {
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    try { const date = (value as { toDate: () => Date }).toDate(); return Number.isNaN(date.getTime()) ? null : date.toISOString(); } catch { return null; }
  }
  return typeof value === 'string' ? value : null;
};
const hashId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 48);
const academyRef = (db: ReturnType<typeof getFirebaseAdminFirestore>, academyId: string) => db.collection('academies').doc(academyId);
const memberRefFor = (db: ReturnType<typeof getFirebaseAdminFirestore>, academyId: string, uid: string) => academyRef(db, academyId).collection('members').doc(uid);

async function getActor(request: Request): Promise<Actor> {
  const session = await resolveAcademySession(request);
  const db = getFirebaseAdminFirestore();
  const memberRef = memberRefFor(db, session.academyId, session.uid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) throw new AcademyApiError(403, 'Academy membership was not found.', 'ACADEMY_MEMBERSHIP_NOT_FOUND');
  const member = memberSnap.data() ?? {};
  if (member.uid !== session.uid || member.academyId !== session.academyId || member.role !== session.role || member.active !== true) {
    throw new AcademyApiError(403, 'Academy membership is not active.', 'ACADEMY_MEMBERSHIP_INACTIVE');
  }
  return { session, db, member, memberRef };
}

async function requireAdmin(request: Request): Promise<Actor> {
  const actor = await getActor(request);
  if (actor.session.role !== 'academy_admin') throw new AcademyApiError(403, 'Academy Admin access is required.', 'ACADEMY_ADMIN_REQUIRED');
  return actor;
}

const permissionEnabled = (member: RecordLike, key: string) => key === 'dashboard.view' || (isRecord(member.permissions) && member.permissions[key] === true);
const requireTeacherPermission = (actor: Actor, key: string) => {
  if (actor.session.role !== 'teacher' || !permissionEnabled(actor.member, key)) {
    throw new AcademyApiError(403, 'Your Academy Admin has not granted this permission.', 'ACADEMY_PERMISSION_DENIED');
  }
};

function serializeDocument(doc: QueryDocumentSnapshot<DocumentData>) {
  const data = doc.data();
  return { id: doc.id, ...data, createdAt: serializeDate(data.createdAt), updatedAt: serializeDate(data.updatedAt) };
}

export async function getAcademyAccess(request: Request) {
  const actor = await getActor(request);
  return {
    success: true,
    uid: actor.session.uid,
    email: actor.session.email,
    academyId: actor.session.academyId,
    academyName: actor.session.academyName,
    role: actor.session.role,
    permissions: actor.session.role === 'academy_admin' ? {} : normalizePermissionMap(actor.member.permissions),
    assignedClassIds: normalizeIdList(asArray(actor.member.assignedClassIds), 'Assigned classes'),
    assignedSubjectIds: normalizeIdList(asArray(actor.member.assignedSubjectIds), 'Assigned subjects'),
  };
}

export async function updateOwnAcademyTeacherProfile(request: Request, body: RecordLike) {
  const actor = await getActor(request);
  if (actor.session.role !== 'teacher') throw new AcademyApiError(403, 'Only an Academy teacher can update their own teacher profile.', 'TEACHER_PROFILE_REQUIRED');

  const displayName = requiredText(body.displayName, 'Teacher name', 120);
  const designation = clean(body.designation).slice(0, 80);
  const contactEmail = clean(body.contactEmail ?? actor.member.contactEmail ?? actor.session.email).toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/i.test(contactEmail)) throw new AcademyApiError(400, 'Contact email must be a valid Gmail address ending in @gmail.com.', 'INVALID_CONTACT_EMAIL');
  const contactPhone = clean(body.contactPhone).replace(/[\s().-]/g, '').slice(0, 16);
  if (contactPhone && !/^\+?[0-9]{10,15}$/.test(contactPhone)) {
    throw new AcademyApiError(400, 'The contact number is invalid.', 'INVALID_CONTACT_PHONE');
  }

  const expectedPath = `academies/${actor.session.academyId}/teachers/${actor.session.uid}/profile/avatar`;
  const submittedPath = body.profileImageStoragePath === undefined ? '' : clean(body.profileImageStoragePath);
  if (submittedPath && submittedPath !== expectedPath) {
    throw new AcademyApiError(400, 'Teacher photo path must point to your own Academy profile image.', 'INVALID_TEACHER_PHOTO_PATH');
  }
  const profileImage = body.profileImage === undefined ? undefined : clean(body.profileImage).slice(0, 2400);
  if (profileImage && !/^https:\/\//i.test(profileImage)) {
    throw new AcademyApiError(400, 'Profile image must be a secure HTTPS URL.', 'INVALID_PROFILE_IMAGE_URL');
  }

  const email = actor.session.email.toLowerCase();
  const profileRef = actor.db.collection('users').doc(email);
  const settingsRef = profileRef.collection('settings').doc('profile_data');
  const mappingRef = actor.db.collection('academyMemberships').doc(actor.session.uid);
  const auditRef = academyRef(actor.db, actor.session.academyId).collection('auditLogs').doc();
  const now = FieldValue.serverTimestamp();
  const adminAuth = getFirebaseAdminAuth();
  let previousDisplayName = '';
  try {
    const authUser = await adminAuth.getUser(actor.session.uid);
    previousDisplayName = authUser.displayName || '';
    await adminAuth.updateUser(actor.session.uid, { displayName });
    await actor.db.runTransaction(async (tx) => {
      const [freshMember, freshMapping, profileSnap, settingsSnap] = await Promise.all([
        tx.get(actor.memberRef), tx.get(mappingRef), tx.get(profileRef), tx.get(settingsRef),
      ]);
      if (!freshMember.exists || freshMember.data()?.role !== 'teacher' || freshMember.data()?.active !== true ||
          !freshMapping.exists || freshMapping.data()?.role !== 'teacher' || freshMapping.data()?.active !== true ||
          freshMapping.data()?.academyId !== actor.session.academyId) {
        throw new AcademyApiError(409, 'Your Academy teacher membership changed. Refresh and retry.', 'TEACHER_MEMBERSHIP_CHANGED');
      }
      const member = freshMember.data() ?? {};
      const profile = profileSnap.data() ?? {};
      const existingSettings = settingsSnap.data() ?? {};
      const oldProfile = isRecord(existingSettings.profile) ? existingSettings.profile : {};
      const storagePath = submittedPath || clean(member.profileImageStoragePath) || clean(profile.profileImageStoragePath);
      const imageUrl = profileImage === undefined ? clean(profile.profileImage) || clean(oldProfile.avatarUrl) : profileImage;
      tx.update(actor.memberRef, {
        displayName, designation, contactEmail, contactPhone,
        ...(storagePath ? { profileImageStoragePath: storagePath } : {}),
        updatedAt: now, updatedByUid: actor.session.uid,
      });
      tx.set(profileRef, {
        displayName, teacherName: displayName, name: displayName,
        designation, teacherDesignation: designation,
        contactEmail, contactPhone, whatsappNumber: contactPhone, phone: contactPhone,
        academyName: actor.session.academyName, schoolName: actor.session.academyName,
        profileImage: imageUrl, avatarUrl: imageUrl,
        ...(storagePath ? { profileImageStoragePath: storagePath } : {}),
        updatedAt: now,
      }, { merge: true });
      tx.set(settingsRef, {
        profile: {
          ...oldProfile,
          name: displayName, role: designation, schoolName: actor.session.academyName,
          email: contactEmail, contactEmail, phone: contactPhone, avatarUrl: imageUrl,
        },
        updatedAt: now,
      }, { merge: true });
      tx.create(auditRef, {
        event: 'teacher.self_profile_updated', academyId: actor.session.academyId,
        actorUid: actor.session.uid, teacherUid: actor.session.uid,
        changedFields: ['displayName', 'designation', 'contactEmail', 'contactPhone', ...(submittedPath ? ['profileImageStoragePath'] : []), ...(profileImage !== undefined ? ['profileImage'] : [])],
        createdAt: now,
      });
    });
  } catch (error) {
    try { await adminAuth.updateUser(actor.session.uid, { displayName: previousDisplayName || undefined }); } catch { /* retain the primary failure */ }
    throw error;
  }
  return { success: true, teacherUid: actor.session.uid, displayName };
}

export async function getAcademyDashboard(request: Request) {
  const actor = await requireAdmin(request);
  const root = academyRef(actor.db, actor.session.academyId);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [teacherCount, members, studentCount, activeStudentCount, classCount, classes, enrolments, invoices, paymentCount, expenses, todayAttendance] = await Promise.all([
    root.collection('members').where('role', '==', 'teacher').count().get(),
    root.collection('members').where('role', '==', 'teacher').limit(500).get(),
    root.collection('students').count().get(),
    root.collection('students').where('status', '==', 'active').count().get(),
    root.collection('classes').count().get(),
    root.collection('classes').limit(1000).get(),
    root.collection('studentSubjectEnrollments').where('active', '==', true).limit(5000).get(),
    root.collection('feeInvoices').limit(3000).get(),
    root.collection('payments').count().get(),
    root.collection('expenses').where('status', '==', 'posted').limit(3000).get(),
    root.collection('studentAttendance').where('date', '==', today).limit(500).get(),
  ]);
  let billed = 0; let paid = 0; let outstanding = 0; let activeInvoices = 0;
  for (const item of invoices.docs) {
    const row = item.data();
    billed += Number(row.totalAmount ?? 0);
    paid += Number(row.paidAmount ?? 0);
    outstanding += Number(row.remainingBalance ?? 0);
    if (!['PAID', 'paid', 'void', 'cancelled', 'archived'].includes(String(row.status ?? ''))) activeInvoices += 1;
  }
  const expenseTotal = expenses.docs.reduce((sum, item) => sum + Number(item.data().amount ?? 0), 0);
  let todayPresent = 0; let todayAbsent = 0;
  for (const item of todayAttendance.docs) {
    const row = item.data();
    if (row.status === 'void') continue;
    const map = isRecord(row.attendanceMap) ? row.attendanceMap as Record<string, unknown> : {};
    todayPresent += Object.values(map).filter((value) => value === true).length;
    todayAbsent += Object.values(map).filter((value) => value === false).length;
  }
  const attendanceMarked = todayPresent + todayAbsent;
  const classCountVisible = classes.docs.filter((item) => item.data().status !== 'archived').length;
  const result = {
    success: true,
    // AcademyAdminOverview renders the academy identity from this response.
    // Keep it in sync with the DashboardData client contract.
    academy: {
      academyId: actor.session.academyId,
      academyName: actor.session.academyName,
    },
    summary: {
      teachers: teacherCount.data().count,
      activeTeachers: members.docs.filter((item) => item.data().active === true).length,
      students: studentCount.data().count,
      activeStudents: activeStudentCount.data().count,
      classes: classCount.data().count,
      activeClasses: classCountVisible,
      totalSubjectEnrolments: enrolments.size,
      todayPresent,
      todayAbsent,
      attendancePercentage: attendanceMarked ? Math.round((todayPresent / attendanceMarked) * 10000) / 100 : 0,
      invoices: invoices.size,
      activeInvoices,
      payments: paymentCount.data().count,
      billedAmount: Math.round(billed * 100) / 100,
      paidAmount: Math.round(paid * 100) / 100,
      outstandingAmount: Math.round(outstanding * 100) / 100,
      totalFeesGenerated: Math.round(billed * 100) / 100,
      totalFeesCollected: Math.round(paid * 100) / 100,
      outstandingFees: Math.round(outstanding * 100) / 100,
      postedExpenses: Math.round(expenseTotal * 100) / 100,
      netCashMovement: Math.round((paid - expenseTotal) * 100) / 100,
      attendanceDate: today,
    },
    meta: { limited: members.size >= 500 || classes.size >= 1000 || enrolments.size >= 5000 || invoices.size >= 3000 || expenses.size >= 3000 || todayAttendance.size >= 500 },
  };
  return result;
}

export async function listAcademyManagementTeachers(request: Request) {
  const actor = await requireAdmin(request);
  const root = academyRef(actor.db, actor.session.academyId);
  const [snapshot, assignmentSnapshot, enrollmentSnapshot] = await Promise.all([
    root.collection('members').where('role', '==', 'teacher').limit(250).get(),
    root.collection('teacherAssignments').where('active', '==', true).limit(1500).get(),
    root.collection('studentSubjectEnrollments').where('active', '==', true).limit(5000).get(),
  ]);
  const teacherUids = new Set(snapshot.docs.map((doc) => doc.id));
  const assignmentsByTeacher = new Map<string, RecordLike[]>();
  for (const doc of assignmentSnapshot.docs) {
    const row = doc.data(); const uid = clean(row.teacherUid);
    if (!uid || !teacherUids.has(uid)) continue;
    assignmentsByTeacher.set(uid, [...(assignmentsByTeacher.get(uid) ?? []), row]);
  }
  const studentsByTeacher = new Map<string, Set<string>>();
  for (const doc of enrollmentSnapshot.docs) {
    const row = doc.data(); const uid = clean(row.teacherUid); const studentId = clean(row.studentId);
    if (!uid || !studentId || !teacherUids.has(uid)) continue;
    const set = studentsByTeacher.get(uid) ?? new Set<string>(); set.add(studentId); studentsByTeacher.set(uid, set);
  }
  const profileSnapshots = await Promise.all(snapshot.docs.map((doc) => {
    const email = clean(doc.data().email).toLowerCase();
    return email ? actor.db.collection('users').doc(email).get() : Promise.resolve(null);
  }));
  return {
    success: true,
    teachers: snapshot.docs.map((doc, index) => {
      const data = doc.data(); const profile = profileSnapshots[index]?.data() ?? {};
      const assignments = assignmentsByTeacher.get(doc.id) ?? [];
      return {
        uid: doc.id,
        name: clean(data.displayName) || 'Teacher',
        email: clean(data.email).toLowerCase(),
        contactEmail: clean(data.contactEmail) || clean(profile.contactEmail),
        active: data.active === true,
        emailVerified: data.emailVerified === true,
        status: clean(data.status) || 'pending',
        designation: clean(data.designation) || clean(profile.designation),
        profileImageStoragePath: clean(data.profileImageStoragePath) || clean(profile.profileImageStoragePath),
        profileImage: clean(profile.profileImage),
        permissions: normalizePermissionMap(data.permissions),
        assignedClassIds: [...new Set(assignments.map((item) => clean(item.classId)).filter(Boolean))],
        assignedSubjectIds: [...new Set(assignments.map((item) => clean(item.subjectId)).filter(Boolean))],
        assignedClassCount: new Set(assignments.map((item) => clean(item.classId)).filter(Boolean)).size,
        assignedSubjectCount: new Set(assignments.map((item) => clean(item.subjectId)).filter(Boolean)).size,
        assignedStudentCount: studentsByTeacher.get(doc.id)?.size ?? 0,
        whatsappNumber: clean(data.contactPhone) || clean(profile.whatsappNumber),
        createdAt: serializeDate(data.createdAt),
      };
    }),
    permissionDefinitions: ACADEMY_PERMISSION_DEFINITIONS,
    meta: { limited: snapshot.size >= 250 || assignmentSnapshot.size >= 1500 || enrollmentSnapshot.size >= 5000 },
  };
}

async function getAcademyTeacherProfile(request: Request, body: RecordLike) {
  const actor = await requireAdmin(request);
  const teacherUid = safeId(body.teacherUid, 'Teacher UID');
  const root = academyRef(actor.db, actor.session.academyId);
  const memberRef = root.collection('members').doc(teacherUid);
  const [memberSnap, mappingSnap] = await Promise.all([
    memberRef.get(), actor.db.collection('academyMemberships').doc(teacherUid).get(),
  ]);
  if (!memberSnap.exists || !mappingSnap.exists || memberSnap.data()?.role !== 'teacher' ||
      mappingSnap.data()?.role !== 'teacher' || mappingSnap.data()?.academyId !== actor.session.academyId) {
    throw new AcademyApiError(404, 'Teacher membership was not found in this Academy.', 'TEACHER_NOT_FOUND');
  }
  const member = memberSnap.data() ?? {};
  const email = clean(member.email).toLowerCase();
  const [profileSnap, assignmentSnap, enrollmentSnap, invoiceSnap] = await Promise.all([
    email ? actor.db.collection('users').doc(email).get() : Promise.resolve(null),
    root.collection('teacherAssignments').where('teacherUid', '==', teacherUid).limit(1000).get(),
    root.collection('studentSubjectEnrollments').where('teacherUid', '==', teacherUid).where('active', '==', true).limit(3000).get(),
    root.collection('feeInvoices').limit(3000).get(),
  ]);
  const profileData = profileSnap?.data() ?? {};
  const assignments = assignmentSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() } as RecordLike)).filter((row) => row.active === true);
  const assignmentKeys = new Set(assignments.map((row) => `${clean(row.classId)}:${clean(row.subjectId)}`));
  const classIds = [...new Set(assignments.map((row) => clean(row.classId)).filter(Boolean))];
  const subjectIds = [...new Set(assignments.map((row) => clean(row.subjectId)).filter(Boolean))];
  const enrollmentRows = enrollmentSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() } as RecordLike));
  const studentIds = [...new Set(enrollmentRows.map((row) => clean(row.studentId)).filter(Boolean))];
  const [classDocs, subjectDocs, studentDocs] = await Promise.all([
    Promise.all(classIds.map((id) => root.collection('classes').doc(id).get())),
    Promise.all(subjectIds.map((id) => root.collection('subjects').doc(id).get())),
    Promise.all(studentIds.slice(0, 500).map((id) => root.collection('students').doc(id).get())),
  ]);
  const classes = new Map(classDocs.filter((doc) => doc.exists).map((doc) => [doc.id, { id: doc.id, ...doc.data() } as RecordLike]));
  const subjects = new Map(subjectDocs.filter((doc) => doc.exists).map((doc) => [doc.id, { id: doc.id, ...doc.data() } as RecordLike]));
  const studentMap = new Map(studentDocs.filter((doc) => doc.exists).map((doc) => [doc.id, { id: doc.id, ...doc.data() } as RecordLike]));
  const studentClassIds = new Map<string, Set<string>>();
  for (const row of enrollmentRows) {
    const studentId = clean(row.studentId); const classId = clean(row.classId);
    if (!studentId || !classId) continue;
    const set = studentClassIds.get(studentId) ?? new Set<string>(); set.add(classId); studentClassIds.set(studentId, set);
  }
  const classRows = classIds.map((classId) => {
    const row = classes.get(classId) ?? {};
    const classAssignments = assignments.filter((item) => clean(item.classId) === classId);
    const classStudents = new Set(enrollmentRows.filter((item) => clean(item.classId) === classId).map((item) => clean(item.studentId)).filter(Boolean));
    return {
      id: classId, name: clean(row.name) || classId, classCode: clean(row.classCode), section: clean(row.section),
      academicYear: clean(row.academicYear), status: clean(row.status) || 'unknown', studentCount: classStudents.size,
      subjects: classAssignments.map((item) => {
        const subject = subjects.get(clean(item.subjectId)) ?? {};
        return { id: clean(item.subjectId), name: clean(subject.name) || clean(item.subjectName) || 'Subject', code: clean(subject.code), monthlyFee: Number(subject.monthlyFee ?? item.feeAmountMonthly ?? 0), status: item.active === true ? 'active' : 'inactive' };
      }),
    };
  });
  const studentRows = studentIds.slice(0, 500).map((studentId) => {
    const row = studentMap.get(studentId) ?? {};
    const studentEnrollments = enrollmentRows.filter((item) => clean(item.studentId) === studentId);
    const studentClassIdSet = studentClassIds.get(studentId) ?? new Set<string>();
    return {
      id: studentId, name: clean(row.name) || clean(row.studentName) || 'Student', rollNo: clean(row.rollNo),
      fatherName: clean(row.fatherName), phone: clean(row.phone), status: clean(row.status) || 'unknown',
      classes: [...studentClassIdSet].map((classId) => ({ id: classId, name: clean(classes.get(classId)?.name) || classId })),
      subjects: [...new Set(studentEnrollments.map((item) => clean(item.subjectName) || clean(subjects.get(clean(item.subjectId))?.name)).filter(Boolean))],
    };
  });

  const teacherInvoiceRows: Array<{ invoice: RecordLike; line: RecordLike; className: string }> = [];
  const invoiceIds: string[] = [];
  for (const doc of invoiceSnap.docs) {
    const invoice = { id: doc.id, ...doc.data() } as RecordLike;
    const lineItems = asArray(invoice.lineItems).filter(isRecord);
    const ownedLines = lineItems.filter((line) => isTeacherInvoiceLine(line, teacherUid, assignmentKeys));
    if (!ownedLines.length) continue;
    invoiceIds.push(doc.id);
    for (const line of ownedLines) {
      teacherInvoiceRows.push({ invoice, line, className: clean(classes.get(clean(line.classId))?.name) || clean(line.classId) || '—' });
    }
  }
  const invoiceIdsForPayments = [...new Set(invoiceIds)].slice(0, 300);
  const paymentSnaps = await Promise.all(Array.from({ length: Math.ceil(invoiceIdsForPayments.length / 30) }, (_, index) =>
    root.collection('payments').where('invoiceId', 'in', invoiceIdsForPayments.slice(index * 30, index * 30 + 30)).limit(1000).get()));
  const lineIdsByInvoice = new Map<string, Set<string>>();
  for (const item of teacherInvoiceRows) {
    const invoiceId = clean(item.invoice.id); const lineId = clean(item.line.lineItemId);
    if (invoiceId && lineId) { const set = lineIdsByInvoice.get(invoiceId) ?? new Set<string>(); set.add(lineId); lineIdsByInvoice.set(invoiceId, set); }
  }
  const paymentRows = new Map<string, RecordLike>();
  for (const snap of paymentSnaps) for (const doc of snap.docs) {
    const row = { id: doc.id, ...doc.data() } as RecordLike; const invoiceId = clean(row.invoiceId);
    const matchingLineIds = lineIdsByInvoice.get(invoiceId) ?? new Set<string>();
    const allocations = asArray(row.allocations).filter(isRecord);
    const teacherAmount = sumTeacherPaymentAllocations(allocations, matchingLineIds);
    if (teacherAmount <= 0) continue;
    const createdAt = serializeDate(row.createdAt);
    paymentRows.set(doc.id, { id: doc.id, invoiceId, studentId: clean(row.studentId), amount: Math.round(teacherAmount * 100) / 100, paymentMethod: clean(row.paymentMethod), paymentReference: clean(row.paymentReference), createdAt, studentName: clean(teacherInvoiceRows.find((item) => clean(item.invoice.id) === invoiceId)?.invoice.studentName) || 'Student' });
  }
  const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  const feeSummary = calculateTeacherFeeSummary(teacherInvoiceRows.map((item) => item.line));
  const billed = feeSummary.billed;
  const collected = feeSummary.collected;
  const outstanding = feeSummary.outstanding;
  const nowPakistan = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).format(new Date());
  const payments = [...paymentRows.values()].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const collectedThisMonth = payments.filter((item) => item.createdAt && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).format(new Date(String(item.createdAt))) === nowPakistan).reduce((sum, item) => sum + Number(item.amount), 0);
  const feeRecords = teacherInvoiceRows.map(({ invoice, line, className }) => {
    const amount = Number(line.amount ?? 0); const paidAmount = Number(line.paidAmount ?? 0);
    const remainingBalance = Math.max(0, Number(line.remainingBalance ?? (amount - paidAmount)));
    return {
      id: `${clean(invoice.id)}:${clean(line.lineItemId)}`, invoiceId: clean(invoice.id), invoiceNumber: clean(invoice.invoiceNumber) || clean(invoice.invoiceNo) || clean(invoice.id),
      studentId: clean(invoice.studentId), studentName: clean(invoice.studentName) || 'Student', className,
      subjectName: clean(line.subjectName) || 'Subject', invoiceDate: serializeDate(invoice.issuedAt) || serializeDate(invoice.createdAt),
      dueDate: serializeDate(invoice.dueDate), billingMonth: clean(invoice.billingMonth), totalAmount: money(amount), paidAmount: money(paidAmount),
      remainingBalance: money(remainingBalance), status: remainingBalance <= 0.004 ? 'PAID' : paidAmount > 0 ? 'PARTIAL' : 'UNPAID', currency: 'PKR',
    };
  }).sort((a, b) => String(b.invoiceDate ?? '').localeCompare(String(a.invoiceDate ?? '')));
  const monthlyCollections = new Map<string, number>();
  for (const payment of payments) {
    if (!payment.createdAt) continue;
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).format(new Date(String(payment.createdAt)));
    monthlyCollections.set(month, (monthlyCollections.get(month) ?? 0) + Number(payment.amount));
  }
  return {
    success: true,
    academy: { academyId: actor.session.academyId, academyName: actor.session.academyName },
    teacher: {
      uid: teacherUid, name: clean(member.displayName) || 'Teacher', email, contactEmail: clean(member.contactEmail) || clean(profileData.contactEmail),
      active: member.active === true, emailVerified: member.emailVerified === true, status: clean(member.status) || 'pending',
      designation: clean(member.designation) || clean(profileData.designation), whatsappNumber: clean(member.contactPhone) || clean(profileData.whatsappNumber),
      profileImageStoragePath: clean(member.profileImageStoragePath) || clean(profileData.profileImageStoragePath), profileImage: clean(profileData.profileImage),
      createdAt: serializeDate(member.createdAt), permissions: normalizePermissionMap(member.permissions),
      assignedClassIds: classIds, assignedSubjectIds: subjectIds,
      assignedClassCount: classIds.length, assignedSubjectCount: subjectIds.length, assignedStudentCount: studentIds.length,
    },
    summary: {
      assignedClasses: classRows.length, assignedStudents: studentIds.length, assignedSubjects: subjectIds.length,
      totalFeesGenerated: money(billed), totalFeesCollected: money(collected), outstandingFees: money(outstanding),
      collectedThisMonth: money(collectedThisMonth),
    },
    classes: classRows, students: studentRows, feeRecords, payments,
    monthlyCollections: [...monthlyCollections.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, amount]) => ({ month, amount: money(amount) })),
    permissionDefinitions: ACADEMY_PERMISSION_DEFINITIONS,
    meta: { limited: assignmentSnap.size >= 1000 || enrollmentSnap.size >= 3000 || invoiceSnap.size >= 3000 || studentIds.length > 500 || invoiceIds.length > 300 || paymentSnaps.some((snapshot) => snapshot.size >= 1000) },
  };
}

export async function updateAcademyTeacherPermissions(request: Request, body: RecordLike) {
  const actor = await requireAdmin(request);
  const teacherUid = safeId(body.teacherUid, 'Teacher UID');
  const permissions = normalizePermissionMap(body.permissions);
  const root = academyRef(actor.db, actor.session.academyId);
  const memberRef = root.collection('members').doc(teacherUid);
  const mappingRef = actor.db.collection('academyMemberships').doc(teacherUid);
  const [memberSnap, mappingSnap] = await Promise.all([memberRef.get(), mappingRef.get()]);
  if (!memberSnap.exists || !mappingSnap.exists || memberSnap.data()?.role !== 'teacher' || mappingSnap.data()?.role !== 'teacher' || mappingSnap.data()?.academyId !== actor.session.academyId) {
    throw new AcademyApiError(404, 'Teacher membership was not found in this Academy.', 'TEACHER_NOT_FOUND');
  }
  await memberRef.update({ permissions, permissionsUpdatedAt: FieldValue.serverTimestamp(), permissionsUpdatedByUid: actor.session.uid, updatedAt: FieldValue.serverTimestamp() });
  return { success: true, teacherUid, permissions };
}

export async function listAcademyClasses(request: Request) {
  const actor = await requireAdmin(request);
  const root = academyRef(actor.db, actor.session.academyId);
  const [classesSnapshot, subjectsSnapshot, assignmentsSnapshot, teachersSnapshot] = await Promise.all([
    root.collection('classes').orderBy('createdAt', 'desc').limit(300).get(),
    root.collection('subjects').where('active', '==', true).limit(1000).get(),
    root.collection('teacherAssignments').where('active', '==', true).limit(1500).get(),
    root.collection('members').where('role', '==', 'teacher').limit(300).get(),
  ]);
  const subjectsByClass = new Map<string, RecordLike[]>();
  for (const doc of subjectsSnapshot.docs) {
    const row = { id: doc.id, ...doc.data() } as RecordLike;
    const classId = clean(row.classId);
    if (!classId) continue;
    subjectsByClass.set(classId, [...(subjectsByClass.get(classId) ?? []), row]);
  }
  const assignmentsBySubject = new Map<string, RecordLike>();
  for (const doc of assignmentsSnapshot.docs) {
    const row = { id: doc.id, ...doc.data() } as RecordLike;
    assignmentsBySubject.set(`${clean(row.classId)}:${clean(row.subjectId)}`, row);
  }
  const teachers = new Map(teachersSnapshot.docs.map((doc) => [doc.id, { uid: doc.id, name: clean(doc.data().displayName) || 'Teacher', email: clean(doc.data().email), active: doc.data().active === true, emailVerified: doc.data().emailVerified === true }]));
  return {
    success: true,
    classes: classesSnapshot.docs.map((doc) => {
      const data = doc.data();
      const subjects = (subjectsByClass.get(doc.id) ?? []).map((subject) => {
        const assignment = assignmentsBySubject.get(`${doc.id}:${clean(subject.id)}`);
        const teacher = assignment ? teachers.get(clean(assignment.teacherUid)) : undefined;
        return { ...subject, teacherUid: clean(assignment?.teacherUid) || null, teacherName: teacher?.name ?? null, teacherEmail: teacher?.email ?? null, assignmentId: assignment?.id ?? null, assigned: Boolean(assignment) };
      });
      return { ...serializeDocument(doc), subjects, subjectCount: subjects.length, activeStudentCount: null };
    }),
    subjects: subjectsSnapshot.docs.map(serializeDocument),
    teachers: [...teachers.values()],
  };
}

export async function createAcademySubject(request: Request, body: RecordLike) {
  const actor = await requireAdmin(request);
  const name = requiredText(body.name, 'Subject name', 100);
  const code = clean(body.code).slice(0, 32);
  const monthlyFee = safeNumber(body.monthlyFee ?? 0, 'Monthly fee');
  const ref = academyRef(actor.db, actor.session.academyId).collection('subjects').doc();
  await ref.create({ subjectId: ref.id, name, code, monthlyFee, active: true, createdAt: FieldValue.serverTimestamp(), createdByUid: actor.session.uid, updatedAt: FieldValue.serverTimestamp() });
  return { success: true, subject: { id: ref.id, name, code, monthlyFee, active: true } };
}

async function appendLegacyClassProjection(
  transaction: Transaction,
  legacyClassRef: DocumentReference<DocumentData>,
  legacyClassSnapshot: DocumentSnapshot<DocumentData>,
  classInfo: RecordLike,
  projection?: RecordLike,
) {
  const current = legacyClassSnapshot.data() ?? {};
  const existing = Array.isArray(current.students) ? current.students : isRecord(current.students) ? Object.values(current.students) : [];
  const students = [...existing.filter((item) => !isRecord(item) || item.canonicalStudentId !== projection?.canonicalStudentId)];
  if (projection) students.push(projection);
  const write = {
    ...current,
    id: legacyClassRef.id,
    name: clean(current.name) || clean(classInfo.name),
    className: clean(current.className) || clean(classInfo.name),
    grade: current.grade ?? classInfo.grade ?? '',
    section: current.section ?? classInfo.section ?? '',
    monthlyFee: current.monthlyFee ?? classInfo.monthlyFee ?? 0,
    academyId: classInfo.academyId,
    academyClassId: classInfo.classId,
    students,
    updatedAt: new Date().toISOString(),
  };
  transaction.set(legacyClassRef, write, { merge: true });
}

export async function createAcademyClass(request: Request, body: RecordLike) {
  const actor = await requireAdmin(request);
  const name = requiredText(body.name, 'Class name', 100);
  const grade = clean(body.grade).slice(0, 32);
  const section = clean(body.section).slice(0, 32);
  const academicYear = clean(body.academicYear).slice(0, 24);
  const subjectInput = asArray(body.subjects);
  if (subjectInput.length < 1 || subjectInput.length > 30) {
    throw new AcademyApiError(400, 'Add between 1 and 30 subject offerings.', 'SUBJECT_REQUIRED');
  }
  const normalizedSubjects = subjectInput.map((raw) => {
    if (!isRecord(raw)) throw new AcademyApiError(400, 'A subject offering is invalid.', 'INVALID_SUBJECT');
    const subjectName = requiredText(raw.name, 'Subject name', 100);
    const normalizedName = subjectName.toLocaleLowerCase().replace(/\s+/g, ' ');
    const monthlyFee = safeNumber(raw.monthlyFee ?? 0, 'Monthly subject fee');
    const teacherUid = clean(raw.teacherUid) ? safeId(raw.teacherUid, 'Teacher') : '';
    const billingFrequency = clean(raw.billingFrequency || 'monthly').toLowerCase();
    if (!['monthly', 'termly', 'yearly'].includes(billingFrequency)) throw new AcademyApiError(400, 'Billing frequency is invalid.', 'INVALID_BILLING_FREQUENCY');
    return { name: subjectName, normalizedName, monthlyFee, teacherUid, billingFrequency };
  });
  if (new Set(normalizedSubjects.map((item) => item.normalizedName)).size !== normalizedSubjects.length) {
    throw new AcademyApiError(409, 'A subject cannot be added twice to the same class.', 'DUPLICATE_SUBJECT');
  }

  const root = academyRef(actor.db, actor.session.academyId);
  const classRef = root.collection('classes').doc();
  const classCode = makeClassCode({ name, section, classId: classRef.id });
  const normalizedName = `${name} ${section}`.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  const subjectRows = normalizedSubjects.map((item) => {
    const subjectId = hashId(`${classRef.id}|${item.normalizedName}`).slice(0, 28);
    const code = `SUB-${hashId(`${classRef.id}|${item.normalizedName}`).slice(0, 8).toUpperCase()}`;
    return { ...item, subjectId, code, ref: root.collection('subjects').doc(subjectId) };
  });
  const assignedTeacherUids = [...new Set(subjectRows.map((item) => item.teacherUid).filter(Boolean))];
  const teacherDetails = new Map<string, { email: string; memberRef: DocumentReference<DocumentData>; mappingRef: DocumentReference<DocumentData>; profileRef: DocumentReference<DocumentData> }>();
  for (const uid of assignedTeacherUids) {
    const memberRef = root.collection('members').doc(uid);
    const member = await memberRef.get();
    const email = clean(member.data()?.email).toLowerCase();
    if (!member.exists || member.data()?.role !== 'teacher' || member.data()?.active !== true || member.data()?.emailVerified !== true || !email) {
      throw new AcademyApiError(400, 'Every assigned subject must use an active, verified teacher from this Academy.', 'INVALID_TEACHER');
    }
    teacherDetails.set(uid, {
      email,
      memberRef,
      mappingRef: actor.db.collection('academyMemberships').doc(uid),
      profileRef: actor.db.collection('users').doc(email),
    });
  }
  const assignmentRows = subjectRows.filter((item) => item.teacherUid).map((item) => ({
    ...item,
    teacher: teacherDetails.get(item.teacherUid)!,
    ref: root.collection('teacherAssignments').doc(hashId(`${item.teacherUid}|${classRef.id}|${item.subjectId}`)),
  }));
  const legacyRows = [...new Map(assignmentRows.map((row) => [row.teacherUid, row.teacher])).entries()].map(([uid, info]) => ({
    uid, ...info, ref: info.profileRef.collection('classes').doc(classRef.id),
  }));
  const duplicateQuery = root.collection('classes').where('normalizedName', '==', normalizedName).limit(25);

  await actor.db.runTransaction(async (transaction) => {
    const [duplicates, teacherSnapshots, mappingSnapshots, profileSnapshots, subjectSnapshots, assignmentSnapshots, legacySnapshots] = await Promise.all([
      transaction.get(duplicateQuery),
      Promise.all(assignedTeacherUids.map((uid) => transaction.get(teacherDetails.get(uid)!.memberRef))),
      Promise.all(assignedTeacherUids.map((uid) => transaction.get(teacherDetails.get(uid)!.mappingRef))),
      Promise.all(assignedTeacherUids.map((uid) => transaction.get(teacherDetails.get(uid)!.profileRef))),
      Promise.all(subjectRows.map((row) => transaction.get(row.ref))),
      Promise.all(assignmentRows.map((row) => transaction.get(row.ref))),
      Promise.all(legacyRows.map((row) => transaction.get(row.ref))),
    ]);
    if (duplicates.docs.some((doc) => clean(doc.data().academicYear) === academicYear)) {
      throw new AcademyApiError(409, 'A class with this name and academic year already exists.', 'DUPLICATE_CLASS');
    }
    if (subjectSnapshots.some((doc) => doc.exists)) throw new AcademyApiError(409, 'A generated subject identifier already exists. Please retry.', 'SUBJECT_ID_COLLISION');
    for (let index = 0; index < assignedTeacherUids.length; index += 1) {
      const member = teacherSnapshots[index].data() ?? {};
      const mapping = mappingSnapshots[index].data() ?? {};
      const profile = profileSnapshots[index].data() ?? {};
      if (!teacherSnapshots[index].exists || member.role !== 'teacher' || member.active !== true || member.emailVerified !== true ||
          !mappingSnapshots[index].exists || mapping.role !== 'teacher' || mapping.academyId !== actor.session.academyId || mapping.active !== true ||
          !profileSnapshots[index].exists || profile.uid !== assignedTeacherUids[index] || profile.academyId !== actor.session.academyId || profile.role !== 'teacher') {
        throw new AcademyApiError(409, 'A teacher membership changed during class creation. Refresh and retry.', 'TEACHER_MEMBERSHIP_CHANGED');
      }
    }
    if (assignmentSnapshots.some((doc) => doc.exists)) throw new AcademyApiError(409, 'A teacher assignment already exists for this subject.', 'DUPLICATE_ASSIGNMENT');

    const now = FieldValue.serverTimestamp();
    const hasUnassigned = subjectRows.some((item) => !item.teacherUid);
    transaction.create(classRef, {
      classId: classRef.id, classCode, academyId: actor.session.academyId, name, normalizedName,
      grade, section, academicYear, subjectIds: subjectRows.map((item) => item.subjectId),
      status: hasUnassigned ? 'draft' : 'active', createdAt: now, updatedAt: now,
      createdByUid: actor.session.uid, createdByRole: 'academy_admin', schemaVersion: 2,
    });
    subjectRows.forEach((item) => transaction.create(item.ref, {
      subjectId: item.subjectId, academyId: actor.session.academyId, classId: classRef.id,
      name: item.name, normalizedName: item.normalizedName, code: item.code,
      monthlyFee: item.monthlyFee, currency: 'PKR', billingFrequency: item.billingFrequency,
      active: true, createdAt: now, updatedAt: now, createdByUid: actor.session.uid,
      feeEffectiveFrom: clean(body.effectiveFrom) || new Date().toISOString().slice(0, 10),
    }));
    assignmentRows.forEach((item) => transaction.create(item.ref, {
      assignmentId: item.ref.id, academyId: actor.session.academyId, teacherUid: item.teacherUid,
      teacherEmail: item.teacher.email, classId: classRef.id, subjectId: item.subjectId,
      subjectName: item.name, active: true, startsOn: clean(body.effectiveFrom) || new Date().toISOString().slice(0, 10),
      createdAt: now, createdByUid: actor.session.uid,
    }));
    // A teacher may receive multiple subject assignments in the same class.
    // Aggregate them before writing the membership document: updating the same
    // document once per subject from the original transaction snapshot causes
    // the final write to overwrite subject IDs from earlier writes.
    assignedTeacherUids.forEach((teacherUid, memberIndex) => {
      const original = teacherSnapshots[memberIndex].data() ?? {};
      const assignmentsForTeacher = assignmentRows
        .filter((item) => item.teacherUid === teacherUid)
        .map((item) => ({ classId: classRef.id, subjectId: item.subjectId }));
      const assignedIds = mergeTeacherAssignedIds(
        asArray(original.assignedClassIds),
        asArray(original.assignedSubjectIds),
        assignmentsForTeacher,
      );
      transaction.update(teacherDetails.get(teacherUid)!.memberRef, {
        ...assignedIds,
        updatedAt: now,
      });
    });
    legacyRows.forEach((legacy, index) => {
      const assignedForTeacher = assignmentRows.filter((item) => item.teacherUid === legacy.uid);
      const data = legacySnapshots[index].data() ?? {};
      transaction.set(legacy.ref, {
        ...data, id: classRef.id, className: name, name, grade, section, classCode,
        academicYear, academyId: actor.session.academyId, academyClassId: classRef.id,
        academySubjectIds: assignedForTeacher.map((item) => item.subjectId),
        monthlyFee: assignedForTeacher.reduce((sum, item) => sum + item.monthlyFee, 0),
        students: Array.isArray(data.students) ? data.students : [], updatedAt: now,
      }, { merge: true });
    });
    transaction.create(root.collection('auditLogs').doc(), {
      event: 'class.created', academyId: actor.session.academyId, actorUid: actor.session.uid,
      classId: classRef.id, classCode, subjectIds: subjectRows.map((item) => item.subjectId),
      createdAt: now,
    });
  });

  return {
    success: true,
    class: { id: classRef.id, classCode, name, grade, section, academicYear, status: subjectRows.some((item) => !item.teacherUid) ? 'draft' : 'active' },
    subjects: subjectRows.map((item) => ({ id: item.subjectId, name: item.name, code: item.code, monthlyFee: item.monthlyFee, teacherUid: item.teacherUid || null })),
  };
}

export async function listAcademyStudents(request: Request) {
  const actor = await requireAdmin(request);
  const root = academyRef(actor.db, actor.session.academyId);
  const [studentsSnapshot, enrolmentsSnapshot, invoicesSnapshot] = await Promise.all([
    root.collection('students').orderBy('createdAt', 'desc').limit(500).get(),
    root.collection('studentSubjectEnrollments').where('active', '==', true).limit(1500).get(),
    root.collection('feeInvoices').limit(3000).get(),
  ]);
  const byStudent = new Map<string, RecordLike[]>();
  const invoicesByStudent = new Map<string, RecordLike[]>();
  for (const doc of enrolmentsSnapshot.docs) {
    const data = doc.data(); const studentId = clean(data.studentId);
    if (!studentId) continue;
    const entries = byStudent.get(studentId) ?? [];
    entries.push({ id: doc.id, ...data }); byStudent.set(studentId, entries);
  }
  for (const doc of invoicesSnapshot.docs) {
    const data = doc.data(); const studentId = clean(data.studentId);
    if (!studentId) continue;
    const entries = invoicesByStudent.get(studentId) ?? [];
    entries.push({
      id: doc.id, status: clean(data.status).toUpperCase(),
      totalAmount: Number(data.totalAmount ?? 0), paidAmount: Number(data.paidAmount ?? 0),
      remainingBalance: Number(data.remainingBalance ?? Math.max(0, Number(data.totalAmount ?? 0) - Number(data.paidAmount ?? 0))),
      billingMonth: clean(data.billingMonth), lineItems: Array.isArray(data.lineItems) ? data.lineItems : [],
      classId: clean(data.classId),
    });
    invoicesByStudent.set(studentId, entries);
  }
  return {
    success: true,
    students: studentsSnapshot.docs.map((doc) => {
      const invoices = invoicesByStudent.get(doc.id) ?? [];
      const hasInvoice = invoices.length > 0;
      const totalOutstanding = invoices.reduce((sum, invoice) => sum + Math.max(0, Number(invoice.remainingBalance ?? 0)), 0);
      const classBalances = new Map<string, { billed: number; paid: number; outstanding: number; invoiceCount: number }>();
      for (const invoice of invoices) {
        const lines = Array.isArray(invoice.lineItems) ? invoice.lineItems : [];
        for (const line of lines) {
          const classId = clean(line?.classId) || invoice.classId;
          if (!classId) continue;
          const current = classBalances.get(classId) ?? { billed: 0, paid: 0, outstanding: 0, invoiceCount: 0 };
          const amount = Number(line?.amount ?? 0);
          const paid = Number(line?.paidAmount ?? 0);
          const outstanding = Number(line?.remainingBalance ?? Math.max(0, amount - paid));
          current.billed += Number.isFinite(amount) ? amount : 0;
          current.paid += Number.isFinite(paid) ? paid : 0;
          current.outstanding += Number.isFinite(outstanding) ? Math.max(0, outstanding) : 0;
          current.invoiceCount += 1;
          classBalances.set(classId, current);
        }
      }
      const paymentStatusByClass = Object.fromEntries([...classBalances.entries()].map(([classId, balance]) => [
        classId,
        { status: balance.invoiceCount > 0 && balance.outstanding <= 0.004 ? 'Paid' : 'Unpaid', outstandingBalance: Math.round(balance.outstanding * 100) / 100, billedAmount: Math.round(balance.billed * 100) / 100, paidAmount: Math.round(balance.paid * 100) / 100 },
      ]));
      const limited = invoicesSnapshot.size >= 3000;
      return {
        id: doc.id, ...doc.data(), createdAt: serializeDate(doc.data().createdAt),
        enrollments: byStudent.get(doc.id) ?? [],
        paymentStatus: hasInvoice && totalOutstanding <= 0.004 ? 'Paid' : 'Unpaid',
        paymentStatusByClass,
        outstandingBalance: Math.round(totalOutstanding * 100) / 100,
        invoiceCount: invoices.length, paymentStatusMayBeIncomplete: limited,
      };
    }),
  };
}

export async function getAcademyStudentLedger(request: Request, body: RecordLike) {
  const actor = await requireAdmin(request);
  const studentId = safeId(body.studentId, 'Student');
  const root = academyRef(actor.db, actor.session.academyId);
  const [studentSnap, invoiceSnap, paymentSnap] = await Promise.all([
    root.collection('students').doc(studentId).get(),
    root.collection('feeInvoices').where('studentId', '==', studentId).limit(1000).get(),
    root.collection('payments').where('studentId', '==', studentId).limit(2000).get(),
  ]);
  if (!studentSnap.exists) throw new AcademyApiError(404, 'Student was not found in this Academy.', 'STUDENT_NOT_FOUND');
  const invoices = invoiceSnap.docs.map((doc) => {
    const row = serializeDocument(doc);
    return { ...row, issuedAt: serializeDate(row.issuedAt), dueDate: serializeDate(row.dueDate) };
  }).sort((a, b) => String(b.billingMonth ?? '').localeCompare(String(a.billingMonth ?? '')));
  const payments = paymentSnap.docs.map((doc) => serializeDocument(doc)).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const totalBilled = invoices.reduce((sum, invoice) => sum + Number(invoice.totalAmount ?? 0), 0);
  const totalPaid = payments.reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);
  const totalOutstanding = invoices.reduce((sum, invoice) => sum + Number(invoice.remainingBalance ?? Math.max(0, Number(invoice.totalAmount ?? 0) - Number(invoice.paidAmount ?? 0))), 0);
  return {
    success: true,
    academyName: actor.session.academyName,
    student: { id: studentSnap.id, ...studentSnap.data(), createdAt: serializeDate(studentSnap.data()?.createdAt) },
    invoices, payments,
    totals: { billed: Math.round(totalBilled * 100) / 100, paid: Math.round(totalPaid * 100) / 100, outstanding: Math.round(totalOutstanding * 100) / 100 },
    limited: invoiceSnap.size >= 1000 || paymentSnap.size >= 2000,
  };
}

export async function createAcademyStudent(request: Request, body: RecordLike, options: { teacherRequest?: boolean } = {}) {
  const actor = await getActor(request);
  if (options.teacherRequest) requireTeacherPermission(actor, 'students.create');
  else if (actor.session.role !== 'academy_admin') throw new AcademyApiError(403, 'Academy Admin access is required to add students.', 'ACADEMY_ADMIN_REQUIRED');

  const values = isRecord(body.values) ? body.values : body;
  const name = requiredText(values.name ?? values.studentName, 'Student name', 120);
  // Teacher admissions retain their existing roll-number input. Academy Admin
  // admissions allocate a number in the transaction below so concurrent requests
  // cannot reserve the same class roll number.
  const requestedRollNo = options.teacherRequest
    ? requiredText(values.rollNo ?? values.rollNumber, 'Roll number', 64)
    : '';
  const requestedRollNoNormalized = requestedRollNo.toLocaleLowerCase().replace(/\s+/g, ' ');
  const classId = safeId(body.classId ?? values.classId, 'Class');
  const root = academyRef(actor.db, actor.session.academyId);
  const classRef = root.collection('classes').doc(classId);
  const classSnap = await classRef.get();
  if (!classSnap.exists || !['active', 'draft'].includes(clean(classSnap.data()?.status))) throw new AcademyApiError(404, 'The selected class is not available.', 'CLASS_NOT_FOUND');

  const assignmentQuery = root.collection('teacherAssignments').where('classId', '==', classId).where('active', '==', true);
  const assignmentSnap = await assignmentQuery.get();
  const activeAssignments = assignmentSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() } as RecordLike));
  const permittedAssignments = options.teacherRequest
    ? activeAssignments.filter((item) => clean(item.teacherUid) === actor.session.uid)
    : activeAssignments;
  const allowedSubjectIds = new Set(permittedAssignments.map((item) => clean(item.subjectId)).filter(Boolean));
  const requestedSubjectIds = options.teacherRequest
    ? (Array.isArray(body.subjectIds) && body.subjectIds.length ? normalizeIdList(body.subjectIds, 'Subjects', 30) : [...allowedSubjectIds])
    : normalizeIdList(body.subjectIds, 'Subjects', 30);
  if (!requestedSubjectIds.length) throw new AcademyApiError(400, 'Select at least one subject with an assigned teacher.', 'SUBJECT_REQUIRED');
  if (requestedSubjectIds.some((id) => !allowedSubjectIds.has(id))) throw new AcademyApiError(403, 'One or more subjects are not assigned to your account.', 'SUBJECT_NOT_ASSIGNED');
  const selectedAssignments = requestedSubjectIds.map((subjectId) => {
    const matches = permittedAssignments.filter((item) => clean(item.subjectId) === subjectId);
    if (matches.length !== 1) throw new AcademyApiError(409, 'Each selected subject must have exactly one active assigned teacher.', 'SUBJECT_ASSIGNMENT_AMBIGUOUS');
    return matches[0];
  });
  if (options.teacherRequest && selectedAssignments.some((item) => clean(item.teacherUid) !== actor.session.uid)) {
    throw new AcademyApiError(403, 'You can only add students to your own assigned subjects.', 'SUBJECT_NOT_ASSIGNED');
  }

  const suppliedIdempotencyKey = clean(body.idempotencyKey).slice(0, 160);
  const idempotencyKey = suppliedIdempotencyKey || (options.teacherRequest ? `teacher-add:${classId}:${requestedRollNoNormalized}` : '');
  const studentId = idempotencyKey ? hashId(`${actor.session.academyId}|${actor.session.uid}|student|${idempotencyKey}`) : root.collection('students').doc().id;
  const studentRef = root.collection('students').doc(studentId);
  const rollNumberSequenceRef = root.collection('rollNumberSequences').doc(classId);
  const studentsForClassQuery = root.collection('students').where('primaryClassId', '==', classId).limit(2000);
  const subjectRefs = requestedSubjectIds.map((id) => root.collection('subjects').doc(id));
  const assignmentRefs = selectedAssignments.map((item) => root.collection('teacherAssignments').doc(clean(item.id)));
  const teacherUids = [...new Set(selectedAssignments.map((item) => clean(item.teacherUid)).filter(Boolean))];
  const teacherRefs = teacherUids.map((uid) => root.collection('members').doc(uid));
  const mappingRefs = teacherUids.map((uid) => actor.db.collection('academyMemberships').doc(uid));
  const teacherProfiles: Array<{ uid: string; email: string; ref: DocumentReference<DocumentData>; legacyRef: DocumentReference<DocumentData> }> = [];
  const teacherSnapshotsOutside = await Promise.all(teacherRefs.map((ref) => ref.get()));
  teacherUids.forEach((uid, index) => {
    const email = clean(teacherSnapshotsOutside[index].data()?.email).toLowerCase();
    if (!email) throw new AcademyApiError(409, 'The assigned teacher profile is incomplete.', 'TEACHER_PROFILE_MISSING');
    const profileRef = actor.db.collection('users').doc(email);
    teacherProfiles.push({ uid, email, ref: profileRef, legacyRef: profileRef.collection('classes').doc(classId) });
  });
  const enrollmentRows = selectedAssignments.map((assignment, index) => ({
    assignment, subjectRef: subjectRefs[index], assignmentRef: assignmentRefs[index],
    enrollmentRef: root.collection('studentSubjectEnrollments').doc(hashId(`${studentId}|${classId}|${clean(assignment.subjectId)}`)),
  }));
  const legacyRows = teacherProfiles.map((teacher) => ({
    ...teacher, subjectRows: enrollmentRows.filter((row) => clean(row.assignment.teacherUid) === teacher.uid),
  }));
  const guardianPhone = normalizePakMobile(values.phone ?? values.contactNumber);
  if (clean(values.phone ?? values.contactNumber) && !guardianPhone) throw new AcademyApiError(400, 'Guardian WhatsApp must be a valid Pakistani mobile number (+92 3XX XXXXXXX).', 'INVALID_GUARDIAN_PHONE');
  const consentKeys = ['attendanceWhatsAppOptIn', 'parentWhatsAppOptIn', 'quizResultsWhatsAppOptIn', 'feeAlertsWhatsAppOptIn', 'announcementWhatsAppOptIn', 'libraryLinkWhatsAppOptIn'] as const;
  const timestamp = FieldValue.serverTimestamp();

  const result = await actor.db.runTransaction(async (transaction) => {
    const [existingStudent, currentClass, subjectDocs, assignmentDocs, memberDocs, mappingDocs, profileDocs, legacyDocs, enrollmentDocs, sequenceSnapshot] = await Promise.all([
      transaction.get(studentRef), transaction.get(classRef),
      Promise.all(subjectRefs.map((ref) => transaction.get(ref))),
      Promise.all(assignmentRefs.map((ref) => transaction.get(ref))),
      Promise.all(teacherRefs.map((ref) => transaction.get(ref))),
      Promise.all(mappingRefs.map((ref) => transaction.get(ref))),
      Promise.all(teacherProfiles.map((item) => transaction.get(item.ref))),
      Promise.all(legacyRows.map((item) => transaction.get(item.legacyRef))),
      Promise.all(enrollmentRows.map((item) => transaction.get(item.enrollmentRef))),
      transaction.get(rollNumberSequenceRef),
    ]);
    if (existingStudent.exists) {
      const existing = existingStudent.data() ?? {};
      if (existing.createdByUid === actor.session.uid && existing.idempotencyKeyHash === hashId(idempotencyKey || studentId)) {
        return { alreadyCreated: true, studentId, rollNo: clean(existing.rollNo) };
      }
      throw new AcademyApiError(409, 'Student ID already exists. No data was changed.', 'STUDENT_ID_COLLISION');
    }
    if (!currentClass.exists || currentClass.data()?.status === 'archived' || currentClass.data()?.status === 'inactive') throw new AcademyApiError(409, 'The class is not open for student enrolment.', 'CLASS_NOT_ACTIVE');
    if (subjectDocs.some((doc) => !doc.exists || doc.data()?.active === false || doc.data()?.classId !== classId)) throw new AcademyApiError(400, 'A selected subject does not belong to this active class.', 'SUBJECT_CLASS_MISMATCH');
    if (assignmentDocs.some((doc) => !doc.exists || doc.data()?.active !== true)) throw new AcademyApiError(409, 'A subject teacher assignment changed. Refresh and retry.', 'ASSIGNMENT_CHANGED');
    if (enrollmentDocs.some((doc) => doc.exists)) throw new AcademyApiError(409, 'This subject enrolment already exists.', 'DUPLICATE_ENROLMENT');

    // The sequence document serializes allocations per class. When introducing a
    // sequence for an existing class, seed it from a bounded in-transaction read
    // of the canonical student profiles. If the bounded read is saturated, fail
    // closed and require a controlled sequence initialization rather than risk a
    // duplicate number.
    let nextRoll = Number(sequenceSnapshot.data()?.nextRollNo);
    if (!sequenceSnapshot.exists) {
      const existingClassStudents = await transaction.get(studentsForClassQuery);
      if (existingClassStudents.size >= 2000) {
        throw new AcademyApiError(409, 'This class has too many existing students for automatic roll-number initialization. Initialize its sequence using a reviewed migration.', 'ROLL_SEQUENCE_INITIALIZATION_REQUIRED');
      }
      nextRoll = nextClassRollNumber(existingClassStudents.docs.map((doc) => doc.data().rollNo), 1);
    } else if (!Number.isSafeInteger(nextRoll) || nextRoll < 1) {
      throw new AcademyApiError(409, 'The class roll-number sequence is invalid and needs administrator review.', 'ROLL_SEQUENCE_INVALID');
    }

    let allocatedRollNo = requestedRollNo || String(nextRoll);
    let allocatedRollNoNormalized = allocatedRollNo.toLocaleLowerCase().replace(/\s+/g, ' ');
    let hasDuplicateRoll = false;
    for (let attempt = 0; attempt < (requestedRollNo ? 1 : 100); attempt += 1) {
      const duplicateQuery = root.collection('students')
        .where('primaryClassId', '==', classId)
        .where('rollNoNormalized', '==', allocatedRollNoNormalized)
        .limit(2);
      const duplicateRoll = await transaction.get(duplicateQuery);
      hasDuplicateRoll = duplicateRoll.docs.some((doc) => doc.id !== studentId);
      if (!hasDuplicateRoll) break;
      if (requestedRollNo) throw new AcademyApiError(409, `Roll number ${allocatedRollNo} is already used in this class.`, 'DUPLICATE_ROLL_NUMBER');
      allocatedRollNo = String(Number(allocatedRollNo) + 1);
      allocatedRollNoNormalized = allocatedRollNo;
      if (attempt === 99) throw new AcademyApiError(409, 'A free roll number could not be allocated. Refresh and retry.', 'ROLL_NUMBER_ALLOCATION_FAILED');
    }
    if (hasDuplicateRoll) throw new AcademyApiError(409, 'A free roll number could not be allocated. Refresh and retry.', 'ROLL_NUMBER_ALLOCATION_FAILED');

    for (let index = 0; index < teacherUids.length; index += 1) {
      const member = memberDocs[index].data() ?? {};
      const mapping = mappingDocs[index].data() ?? {};
      const profile = profileDocs[index].data() ?? {};
      if (!memberDocs[index].exists || member.role !== 'teacher' || member.active !== true || member.emailVerified !== true ||
          !mappingDocs[index].exists || mapping.academyId !== actor.session.academyId || mapping.role !== 'teacher' || mapping.active !== true ||
          !profileDocs[index].exists || profile.uid !== teacherUids[index] || profile.role !== 'teacher' || profile.academyId !== actor.session.academyId) {
        throw new AcademyApiError(409, 'A subject teacher is no longer an active member of this Academy.', 'TEACHER_MEMBERSHIP_CHANGED');
      }
    }

    const classData = currentClass.data() ?? {};
    const totalMonthlyFee = enrollmentRows.reduce((sum, row, index) => sum + safeNumber(subjectDocs[index].data()?.monthlyFee ?? 0, 'Monthly subject fee'), 0);
    if (options.teacherRequest && asArray(values.extraCharges).length && !permissionEnabled(actor.member, 'fees.adjust')) {
      throw new AcademyApiError(403, 'Your Academy Admin has not granted permission to add extra student charges.', 'FEE_ADJUSTMENT_PERMISSION_REQUIRED');
    }
    const extraCharges = asArray(values.extraCharges).slice(0, 20).map((raw) => {
      if (!isRecord(raw)) throw new AcademyApiError(400, 'An extra charge is invalid.', 'INVALID_EXTRA_CHARGE');
      return { label: requiredText(raw.label, 'Extra charge title', 120), amount: safeNumber(raw.amount, 'Extra charge amount', 0.01), appliesToMonth: clean(raw.appliesToMonth), billingFrequency: clean(raw.billingFrequency || 'one_time') };
    });
      const studentData: RecordLike = {
      studentId, academyId: actor.session.academyId, name, rollNo: allocatedRollNo, rollNoNormalized: allocatedRollNoNormalized,
      fatherName: clean(values.fatherName ?? values.parentName).slice(0, 120),
      phone: guardianPhone,
      gender: clean(values.gender).slice(0, 24), admissionDate: clean(values.admissionDate).slice(0, 32),
      monthlyFee: totalMonthlyFee, studentFee: String(totalMonthlyFee), feeStatus: 'Unpaid',
      avatar: clean(values.avatar ?? values.profileImage).slice(0, 2048),
      ...Object.fromEntries(consentKeys.flatMap((key) => {
        const accepted = values[key] === true;
        return [[key, accepted], [`${key}At`, accepted ? timestamp : null], [`${key}Phone`, accepted ? guardianPhone : null]];
      })),
      extraCharges, status: 'active', createdByUid: actor.session.uid, createdByRole: actor.session.role,
      primaryClassId: classId, primaryTeacherUid: teacherUids.length === 1 ? teacherUids[0] : null,
      createdAt: timestamp, updatedAt: timestamp, source: options.teacherRequest ? 'teacher_portal' : 'academy_admin_portal',
      idempotencyKeyHash: hashId(idempotencyKey || studentId),
    };
    transaction.set(rollNumberSequenceRef, {
      classId,
      nextRollNo: advanceClassRollSequence(nextRoll, allocatedRollNo),
      lastAllocatedRollNo: allocatedRollNo,
      updatedByUid: actor.session.uid,
      updatedAt: timestamp,
    }, { merge: true });
    transaction.create(studentRef, studentData);
    enrollmentRows.forEach((row, index) => {
      const assignment = assignmentDocs[index].data() ?? {};
      const subject = subjectDocs[index].data() ?? {};
      const memberIndex = teacherUids.indexOf(clean(assignment.teacherUid));
      transaction.create(row.enrollmentRef, {
        enrollmentId: row.enrollmentRef.id, academyId: actor.session.academyId,
        studentId, classId, className: clean(classData.name), classCode: clean(classData.classCode),
        subjectId: clean(assignment.subjectId), subjectName: clean(subject.name),
        teacherUid: clean(assignment.teacherUid), teacherEmail: teacherProfiles[memberIndex]?.email ?? '',
        feeAmountMonthly: safeNumber(subject.monthlyFee ?? 0, 'Monthly subject fee'),
        currency: clean(subject.currency) || 'PKR', billingFrequency: clean(subject.billingFrequency) || 'monthly',
        active: true, createdAt: timestamp, createdByUid: actor.session.uid,
      });
    });
    legacyRows.forEach((legacy, index) => {
      const legacyClass = legacyDocs[index];
      const current = legacyClass.data() ?? {};
      const rowsForTeacher = legacy.subjectRows;
      const monthlyFee = rowsForTeacher.reduce((sum, row) => sum + Number(row.subjectRef.id ? subjectDocs[subjectRefs.findIndex((ref) => ref.id === row.subjectRef.id)].data()?.monthlyFee ?? 0 : 0), 0);
      const projection = buildLegacyStudentProjection(studentData, {
        classId, className: clean(classData.name), monthlyFee,
        subjectIds: rowsForTeacher.map((row) => clean(row.assignment.subjectId)),
      });
      const existingStudents = Array.isArray(current.students) ? current.students : isRecord(current.students) ? Object.values(current.students) : [];
      const students = [...existingStudents.filter((item) => !isRecord(item) || item.canonicalStudentId !== studentId), projection];
      transaction.set(legacy.legacyRef, {
        ...current, id: classId, name: clean(current.name) || clean(classData.name),
        className: clean(current.className) || clean(classData.name), grade: current.grade ?? classData.grade ?? '',
        section: current.section ?? classData.section ?? '', classCode: clean(classData.classCode),
        academyId: actor.session.academyId, academyClassId: classId,
        academySubjectIds: rowsForTeacher.map((row) => clean(row.assignment.subjectId)),
        monthlyFee, students, updatedAt: timestamp,
      }, { merge: true });
    });
    transaction.create(root.collection('auditLogs').doc(), {
      event: 'student.created', academyId: actor.session.academyId, studentId,
      createdByUid: actor.session.uid, createdByRole: actor.session.role,
      classId, subjectIds: requestedSubjectIds, teacherUids, createdAt: timestamp,
    });
    return { alreadyCreated: false, studentId, rollNo: allocatedRollNo };
  });
  return { success: true, studentId: result.studentId, canonicalStudentId: result.studentId, rollNo: result.rollNo, alreadyCreated: result.alreadyCreated, message: result.alreadyCreated ? 'This student submission was already processed.' : 'Student saved once in the Academy roster and projected to each assigned teacher.' };
}

async function loadInvoiceEnrolments(db: ReturnType<typeof getFirebaseAdminFirestore>, academyId: string, studentId: string) {
  const snapshot = await academyRef(db, academyId).collection('studentSubjectEnrollments')
    .where('studentId', '==', studentId).where('active', '==', true).limit(100).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function ensureAcademyInvoice(actor: Actor, studentId: string, month: string) {
  const root = academyRef(actor.db, actor.session.academyId);
  const studentRef = root.collection('students').doc(studentId);
  const studentSnap = await studentRef.get();
  if (!studentSnap.exists || studentSnap.data()?.status !== 'active') {
    throw new AcademyApiError(404, 'Active student was not found.', 'STUDENT_NOT_FOUND');
  }
  const invoiceId = `${studentId}_${month}`;
  const invoiceRef = root.collection('feeInvoices').doc(invoiceId);
  // Existing invoices are immutable financial snapshots. Return them before validating current
  // enrolment billing cycles so an older Termly/Yearly invoice remains readable and payable.
  const existingInvoice = await invoiceRef.get();
  if (existingInvoice.exists) {
    return { invoiceId, alreadyExists: true, invoice: existingInvoice.data() };
  }

  const enrollments = await loadInvoiceEnrolments(actor.db, actor.session.academyId, studentId);
  const unsupportedCycles = enrollments.filter((item) => {
    const frequency = clean(item.billingFrequency || 'monthly').toLowerCase();
    return frequency !== 'monthly';
  });
  if (unsupportedCycles.length) {
    const labels = [...new Set(unsupportedCycles.map((item) => clean(item.subjectName) || clean(item.subjectId)).filter(Boolean))].slice(0, 5).join(', ');
    throw new AcademyApiError(409, `A monthly invoice was not created because these subjects use a non-monthly billing cycle (${labels || 'subject'}). The current Academy invoice model does not define term due dates for termly/yearly billing. Configure a due-month schedule before issuing these charges.`, 'BILLING_CYCLE_NOT_CONFIGURED');
  }
  if (actor.session.role === 'teacher' && !enrollments.some((item) => item.teacherUid === actor.session.uid)) {
    throw new AcademyApiError(403, 'This student is not assigned to you.', 'STUDENT_NOT_ASSIGNED');
  }
  const invoiceCandidate = buildInvoiceSnapshot({
    invoiceId, academyId: actor.session.academyId,
    student: { ...studentSnap.data(), studentId }, month,
    enrollments, issuedAt: new Date().toISOString(),
  });
  const teacherEmails = new Map<string, string>();
  for (const enrolment of enrollments) {
    const teacherUid = clean(enrolment.teacherUid);
    if (!teacherUid || teacherEmails.has(teacherUid)) continue;
    const member = await root.collection('members').doc(teacherUid).get();
    const email = clean(member.data()?.email).toLowerCase();
    if (email) teacherEmails.set(teacherUid, email);
  }
  const legacyRefs = [...new Set(enrollments.map((item) => `${clean(item.teacherUid)}|${clean(item.classId)}`))]
    .map((key) => {
      const [teacherUid, classId] = key.split('|');
      const email = teacherEmails.get(teacherUid);
      return email ? { teacherUid, classId, ref: actor.db.collection('users').doc(email).collection('fees').doc(`${classId}_${month}`) } : null;
    })
    .filter((item): item is { teacherUid: string; classId: string; ref: DocumentReference<DocumentData> } => Boolean(item));

  const result = await actor.db.runTransaction(async (transaction) => {
    const [existingInvoice, legacySnapshots] = await Promise.all([
      transaction.get(invoiceRef),
      Promise.all(legacyRefs.map((item) => transaction.get(item.ref))),
    ]);
    if (existingInvoice.exists) return { alreadyExists: true, invoice: existingInvoice.data() };
    const timestamp = FieldValue.serverTimestamp();
    transaction.create(invoiceRef, {
      ...invoiceCandidate,
      issuedAt: timestamp,
      createdByUid: actor.session.uid,
      createdAt: timestamp,
    });
    legacyRefs.forEach((item, index) => {
      const current = legacySnapshots[index].data() ?? {};
      const records = isRecord(current.feeRecords) ? { ...current.feeRecords } : {};
      records[studentId] = {
        ...(isRecord(records[studentId]) ? records[studentId] as RecordLike : {}),
        status: 'UNPAID',
        monthlyFeeDue: invoiceCandidate.totalAmount,
        paidAmount: 0,
        remainingDues: invoiceCandidate.totalAmount,
        paidTowardsCurrentMonth: 0,
        previousMonthDues: 0,
        centralInvoiceId: invoiceId,
        canonicalStudentId: studentId,
      };
      transaction.set(item.ref, { classId: item.classId, month, feeRecords: records, updatedAt: new Date().toISOString() }, { merge: true });
    });
    return { alreadyExists: false, invoice: invoiceCandidate };
  });
  return { invoiceId, ...result };
}

export async function generateAcademyInvoice(request: Request, body: RecordLike) {
  const actor = await requireAdmin(request);
  const studentId = safeId(body.studentId, 'Student');
  const month = normalizeBillingMonth(body.month);
  const result = await ensureAcademyInvoice(actor, studentId, month);
  return { success: true, alreadyExists: result.alreadyExists, invoice: result.invoice };
}

export async function listAcademyInvoices(request: Request) {
  const actor = await getActor(request);
  const root = academyRef(actor.db, actor.session.academyId);
  if (actor.session.role === 'academy_admin' || permissionEnabled(actor.member, 'fees.view_all')) {
    const snapshot = await root.collection('feeInvoices').orderBy('billingMonth', 'desc').limit(500).get();
    return { success: true, invoices: snapshot.docs.map(serializeDocument) };
  }
  requireTeacherPermission(actor, 'fees.view_assigned');
  const enrolments = await root.collection('studentSubjectEnrollments').where('teacherUid', '==', actor.session.uid).where('active', '==', true).limit(1500).get();
  const studentIds = [...new Set(enrolments.docs.map((doc) => clean(doc.data().studentId)).filter(Boolean))];
  const results = await Promise.all(Array.from({ length: Math.ceil(studentIds.length / 30) }, (_, index) =>
    root.collection('feeInvoices').where('studentId', 'in', studentIds.slice(index * 30, index * 30 + 30)).limit(300).get(),
  ));
  const combined = new Map<string, QueryDocumentSnapshot<DocumentData>>();
  for (const result of results) for (const doc of result.docs) combined.set(doc.id, doc);
  const invoices = [...combined.values()].map(serializeDocument).filter((invoice) => {
    const lineItems = Array.isArray(invoice.lineItems) ? invoice.lineItems as RecordLike[] : [];
    return lineItems.some((line) => line.teacherUid === actor.session.uid) || (Array.isArray(invoice.teacherUids) && invoice.teacherUids.includes(actor.session.uid));
  }).sort((a, b) => String(b.billingMonth).localeCompare(String(a.billingMonth)));
  return { success: true, invoices };
}

export async function collectAcademyInvoicePayment(request: Request, body: RecordLike) {
  const actor = await getActor(request);
  if (actor.session.role === 'teacher') { requireTeacherPermission(actor, 'fees.view_assigned'); requireTeacherPermission(actor, 'fees.collect'); }
  const invoiceId = safeId(body.invoiceId, 'Invoice ID');
  const amount = safeNumber(body.amount, 'Payment amount', 0.01);
  const method = clean(body.paymentMethod || 'cash').toLowerCase();
  if (!['cash', 'bank_transfer', 'card', 'online', 'cheque', 'other'].includes(method)) throw new AcademyApiError(400, 'Payment method is invalid.', 'INVALID_PAYMENT_METHOD');
  const idempotencyKey = requiredText(body.idempotencyKey, 'Payment idempotency key', 180);
  const paymentId = hashId(`${actor.session.uid}|${idempotencyKey}`);
  const root = academyRef(actor.db, actor.session.academyId);
  const invoiceRef = root.collection('feeInvoices').doc(invoiceId);
  const paymentRef = root.collection('payments').doc(paymentId);
  const invoiceSnapshot = await invoiceRef.get();
  if (!invoiceSnapshot.exists) throw new AcademyApiError(404, 'Invoice was not found.', 'INVOICE_NOT_FOUND');
  const invoiceBefore = invoiceSnapshot.data() ?? {};
  const studentId = safeId(invoiceBefore.studentId, 'Invoice student');
  const enrolments = await loadInvoiceEnrolments(actor.db, actor.session.academyId, studentId);
  if (actor.session.role === 'teacher' && !enrolments.some((item) => item.teacherUid === actor.session.uid && item.active === true)) {
    throw new AcademyApiError(403, 'This invoice does not belong to a student assigned to you.', 'STUDENT_NOT_ASSIGNED');
  }
  const teacherEmails = new Map<string, string>();
  for (const enrolment of enrolments) {
    const teacherUid = clean(enrolment.teacherUid);
    if (!teacherUid || teacherEmails.has(teacherUid)) continue;
    const member = await root.collection('members').doc(teacherUid).get();
    const email = clean(member.data()?.email).toLowerCase();
    if (email) teacherEmails.set(teacherUid, email);
  }
  const legacyRefs = [...new Set(enrolments.map((item) => `${clean(item.teacherUid)}|${clean(item.classId)}`))]
    .map((key) => {
      const [teacherUid, classId] = key.split('|'); const email = teacherEmails.get(teacherUid);
      return email ? { teacherUid, classId, ref: actor.db.collection('users').doc(email).collection('fees').doc(`${classId}_${clean(invoiceBefore.billingMonth)}`) } : null;
    }).filter((item): item is { teacherUid: string; classId: string; ref: DocumentReference<DocumentData> } => Boolean(item));

  const result = await actor.db.runTransaction(async (transaction) => {
    const [paymentSnap, invoiceSnap, legacySnaps] = await Promise.all([
      transaction.get(paymentRef), transaction.get(invoiceRef), Promise.all(legacyRefs.map((item) => transaction.get(item.ref))),
    ]);
    if (paymentSnap.exists) return { duplicate: true, invoice: invoiceSnap.data() };
    if (!invoiceSnap.exists) throw new AcademyApiError(404, 'Invoice was not found.', 'INVOICE_NOT_FOUND');
    const currentInvoice = invoiceSnap.data() ?? {};
    const applied = applyPaymentToInvoice(currentInvoice, {
      amount, collectorUid: actor.session.uid, collectorEmail: actor.session.email,
      collectorRole: actor.session.role, paymentMethod: method,
      paymentReference: clean(body.paymentReference),
    });
    const timestamp = FieldValue.serverTimestamp();
    transaction.update(invoiceRef, { lineItems: applied.invoice.lineItems, paidAmount: applied.invoice.paidAmount, remainingBalance: applied.invoice.remainingBalance, status: applied.invoice.status, updatedAt: timestamp });
    transaction.create(paymentRef, {
      paymentId, ...applied.payment,
      paymentMethod: method,
      paymentReference: clean(body.paymentReference).slice(0, 100),
      idempotencyHash: paymentId,
      createdAt: timestamp,
    });
    legacyRefs.forEach((item, index) => {
      const current = legacySnaps[index].data() ?? {};
      const feeRecords = isRecord(current.feeRecords) ? { ...current.feeRecords } : {};
      const previous = isRecord(feeRecords[studentId]) ? feeRecords[studentId] as RecordLike : {};
      feeRecords[studentId] = {
        ...previous,
        status: applied.invoice.status,
        monthlyFeeDue: Number(applied.invoice.totalAmount),
        paidAmount: Number(applied.invoice.paidAmount),
        remainingDues: Number(applied.invoice.remainingBalance),
        paidTowardsCurrentMonth: Number(applied.invoice.paidAmount),
        previousMonthDues: 0,
        centralInvoiceId: invoiceId,
        canonicalStudentId: studentId,
      };
      transaction.set(item.ref, { classId: item.classId, month: clean(applied.invoice.billingMonth), feeRecords, updatedAt: new Date().toISOString() }, { merge: true });
    });
    return { duplicate: false, invoice: applied.invoice };
  });
  return { success: true, duplicate: result.duplicate, invoice: result.invoice, paymentId: result.duplicate ? null : paymentId };
}

export async function listAcademyPayments(request: Request) {
  const actor = await getActor(request);
  const root = academyRef(actor.db, actor.session.academyId);
  const snapshot = await root.collection('payments').orderBy('createdAt', 'desc').limit(1000).get();
  const payments = snapshot.docs.map(serializeDocument);
  if (actor.session.role === 'academy_admin' || permissionEnabled(actor.member, 'fees.view_all')) return { success: true, payments };
  requireTeacherPermission(actor, 'fees.view_assigned');
  const enrolments = await root.collection('studentSubjectEnrollments').where('teacherUid', '==', actor.session.uid).where('active', '==', true).limit(1500).get();
  const allowedStudents = new Set(enrolments.docs.map((doc) => clean(doc.data().studentId)).filter(Boolean));
  const visibleInvoices = payments.filter((payment) => allowedStudents.has(clean(payment.studentId)) &&
    Array.isArray(payment.allocations) && (payment.allocations as RecordLike[]).some((item) => clean(item.teacherUid) === actor.session.uid || allowedStudents.has(clean(payment.studentId))));
  return { success: true, payments: visibleInvoices };
}

function expenseMonthKey(value: unknown): string {
  const month = clean(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AcademyApiError(400, 'Select a valid expense month.', 'INVALID_MONTH');
  return month;
}

function monthStart(month: string, offset = 0): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function pakistanCurrentMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`;
}

function expenseTeacherRow(uid: string, data: RecordLike, academyId: string) {
  return {
    uid,
    role: clean(data.role),
    academyId: clean(data.academyId),
    active: data.active === true,
    emailVerified: data.emailVerified === true,
    name: clean(data.displayName) || clean(data.name) || 'Teacher',
    designation: clean(data.designation) || clean(data.jobTitle) || clean(data.position) || clean(data.title),
    email: clean(data.email).toLowerCase(),
    photoUrl: clean(data.photoUrl) || clean(data.avatarUrl) || clean(data.profileImage) || clean(data.photoURL),
  };
}

async function readExpenseTeachersInTransaction(
  transaction: Transaction,
  root: ReturnType<typeof academyRef>,
  academyId: string,
  allocationMethod: string,
  requestedUids: string[],
) {
  if (allocationMethod === 'none') return [];
  let rows: Array<{ uid: string; data: RecordLike }> = [];
  if (allocationMethod === 'all_active') {
    const snapshot = await transaction.get(root.collection('members').where('role', '==', 'teacher').limit(251));
    if (snapshot.size >= 251) throw new AcademyApiError(409, 'The Academy has more teachers than the safe all-teacher allocation limit. Select teachers individually.', 'TEACHER_ALLOCATION_LIMIT');
    rows = snapshot.docs.map((doc) => ({ uid: doc.id, data: doc.data() as RecordLike }));
  } else {
    const unique = [...new Set(requestedUids.map((uid) => safeId(uid, 'Teacher')))];
    if (!unique.length) throw new AcademyApiError(400, 'Select at least one active teacher.', 'TEACHER_SELECTION_REQUIRED');
    const docs = await Promise.all(unique.map((uid) => transaction.get(root.collection('members').doc(uid))));
    rows = docs.map((doc, index) => ({ uid: unique[index], data: doc.exists ? doc.data() as RecordLike : {} }));
  }
  return rows
    .map(({ uid, data }) => expenseTeacherRow(uid, data, academyId))
    .filter((teacher) => teacher.role === 'teacher' && teacher.academyId === academyId && teacher.active && teacher.emailVerified);
}

function getExpenseAllocationRequest(body: RecordLike, existing?: RecordLike) {
  const source = existing ?? {};
  const method = clean(body.allocationMethod ?? source.allocationMethod) || 'none';
  const previousRows = Array.isArray(source.teacherAllocations) ? source.teacherAllocations as RecordLike[] : [];
  const selectedTeacherUids = Array.isArray(body.selectedTeacherUids)
    ? body.selectedTeacherUids.map((value) => clean(value)).filter(Boolean)
    : previousRows.map((item) => clean(item.teacherUid)).filter(Boolean);
  const customAllocations = Array.isArray(body.customAllocations)
    ? body.customAllocations
    : method === 'custom'
      ? previousRows.map((item) => ({ teacherUid: clean(item.teacherUid), allocatedAmount: item.allocatedAmount }))
      : [];
  return { method, selectedTeacherUids, customAllocations };
}

export async function listAcademyExpenseTeachers(request: Request) {
  const actor = await requireAdmin(request);
  const root = academyRef(actor.db, actor.session.academyId);
  const snapshot = await root.collection('members').where('role', '==', 'teacher').limit(251).get();
  const limited = snapshot.size >= 251;
  const teachers = snapshot.docs.slice(0, 250)
    .map((doc) => expenseTeacherRow(doc.id, doc.data() as RecordLike, actor.session.academyId))
    .filter((teacher) => teacher.role === 'teacher' && teacher.academyId === actor.session.academyId && teacher.active && teacher.emailVerified)
    .map(({ role: _role, academyId: _academyId, ...teacher }) => teacher)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { success: true, teachers, limited };
}

export async function listAcademyExpenses(request: Request, body: RecordLike = {}) {
  const actor = await requireAdmin(request);
  const root = academyRef(actor.db, actor.session.academyId);
  const month = expenseMonthKey(body.month || pakistanCurrentMonth());
  const start = monthStart(month);
  const end = monthStart(month, 1);
  const trendStart = monthStart(month, -5);
  const [snapshot, trendSnapshot, teacherSnapshot] = await Promise.all([
    root.collection('expenses').where('expenseDate', '>=', start).where('expenseDate', '<', end).orderBy('expenseDate', 'desc').limit(1001).get(),
    root.collection('expenses').where('expenseDate', '>=', trendStart).where('expenseDate', '<', end).orderBy('expenseDate', 'asc').limit(3001).get(),
    root.collection('members').where('role', '==', 'teacher').limit(251).get(),
  ]);
  const expenses = snapshot.docs.slice(0, 1000).map((doc) => {
    const row = serializeDocument(doc);
    const raw = doc.data();
    return { ...row, postedAt: serializeDate(raw.postedAt), voidedAt: serializeDate(raw.voidedAt) };
  });
  const summary = summarizeAcademyExpenses(expenses);
  if (snapshot.size >= 1001 || trendSnapshot.size >= 3001) summary.complete = false;
  const monthlyMap = new Map<string, { month: string; posted: number; draft: number; voided: number; postedCount: number }>();
  let trendMalformedCount = 0;
  for (const item of trendSnapshot.docs.slice(0, 3000)) {
    const row = item.data();
    const key = clean(row.expenseDate).slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) { trendMalformedCount += 1; continue; }
    const point = monthlyMap.get(key) ?? { month: key, posted: 0, draft: 0, voided: 0, postedCount: 0 };
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount < 0) { trendMalformedCount += 1; continue; }
    if (row.status === 'posted') { point.posted += amount; point.postedCount += 1; }
    else if (row.status === 'draft') point.draft += amount;
    else if (row.status === 'void') point.voided += amount;
    monthlyMap.set(key, point);
  }
  const monthlyTrend = [...monthlyMap.values()].sort((a, b) => a.month.localeCompare(b.month)).map((point) => ({
    ...point,
    posted: Math.round(point.posted * 100) / 100,
    draft: Math.round(point.draft * 100) / 100,
    voided: Math.round(point.voided * 100) / 100,
  }));
  const teacherListLimited = teacherSnapshot.size >= 251;
  const activeTeacherCount = teacherListLimited ? null : teacherSnapshot.docs.filter((doc) => {
    const row = doc.data();
    return row.role === 'teacher' && row.academyId === actor.session.academyId && row.active === true && row.emailVerified === true;
  }).length;
  return {
    success: true,
    academy: { academyId: actor.session.academyId, academyName: actor.session.academyName },
    month,
    expenses,
    summary,
    monthlyTrend,
    activeTeacherCount,
    meta: { expensesLimited: snapshot.size >= 1001, trendLimited: trendSnapshot.size >= 3001, teacherListLimited, trendMalformedCount },
  };
}

export async function getAcademyExpenseDetails(request: Request, body: RecordLike) {
  const actor = await requireAdmin(request);
  const expenseId = safeId(body.expenseId, 'Expense');
  const root = academyRef(actor.db, actor.session.academyId);
  const [expenseSnapshot, auditSnapshot] = await Promise.all([
    root.collection('expenses').doc(expenseId).get(),
    root.collection('auditLogs').where('expenseId', '==', expenseId).limit(50).get(),
  ]);
  if (!expenseSnapshot.exists) throw new AcademyApiError(404, 'Expense was not found.', 'EXPENSE_NOT_FOUND');
  const raw = expenseSnapshot.data() ?? {};
  const expense = {
    id: expenseSnapshot.id,
    ...raw,
    createdAt: serializeDate(raw.createdAt),
    updatedAt: serializeDate(raw.updatedAt),
    postedAt: serializeDate(raw.postedAt),
    voidedAt: serializeDate(raw.voidedAt),
  };
  const auditHistory = auditSnapshot.docs.map((doc) => {
    const row = doc.data();
    return { id: doc.id, ...row, createdAt: serializeDate(row.createdAt) };
  }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return { success: true, expense, auditHistory, auditHistoryLimited: auditSnapshot.size >= 50 };
}

export async function createAcademyExpense(request: Request, body: RecordLike) {
  const actor = await requireAdmin(request);
  const expense = buildExpenseSnapshot(body);
  const root = academyRef(actor.db, actor.session.academyId);
  const expenseRef = root.collection('expenses').doc();
  const auditRef = root.collection('auditLogs').doc();
  const idempotencyKey = clean(body.idempotencyKey);
  if (idempotencyKey.length > 160) throw new AcademyApiError(400, 'The expense request identifier is invalid.', 'INVALID_IDEMPOTENCY_KEY');
  const idempotencyRef = idempotencyKey ? root.collection('expenseIdempotency').doc(hashId(`${actor.session.uid}|${idempotencyKey}`)) : null;
  const allocationRequest = getExpenseAllocationRequest(body);
  const requestFingerprint = hashId(JSON.stringify({
    actorUid: actor.session.uid,
    expense,
    allocationMethod: allocationRequest.method,
    selectedTeacherUids: [...allocationRequest.selectedTeacherUids].sort(),
    customAllocations: [...allocationRequest.customAllocations].map((item) => ({ teacherUid: clean(item?.teacherUid), allocatedAmount: String(item?.allocatedAmount ?? '') })).sort((a, b) => a.teacherUid.localeCompare(b.teacherUid)),
  }));
  const result = await actor.db.runTransaction(async (transaction) => {
    if (idempotencyRef) {
      const previous = await transaction.get(idempotencyRef);
      if (previous.exists) {
        const previousData = previous.data() ?? {};
        const previousFingerprint = clean(previousData.requestFingerprint);
        if (previousFingerprint && previousFingerprint !== requestFingerprint) {
          throw new AcademyApiError(409, 'This retry identifier was already used for different expense details. Start a new submission.', 'IDEMPOTENCY_KEY_REUSED');
        }
        return { duplicate: true, expenseId: clean(previousData.expenseId) };
      }
    }
    const teachers = await readExpenseTeachersInTransaction(transaction, root, actor.session.academyId, allocationRequest.method, allocationRequest.selectedTeacherUids);
    let allocation;
    try {
      allocation = buildExpenseAllocationPlan({
        amount: expense.amount,
        allocationMethod: allocationRequest.method,
        selectedTeacherUids: allocationRequest.method === 'all_active' ? teachers.map((teacher) => teacher.uid) : allocationRequest.selectedTeacherUids,
        customAllocations: allocationRequest.customAllocations,
        teachers,
      });
    } catch (error) {
      throw new AcademyApiError(400, error instanceof Error ? error.message : 'Teacher allocation is invalid.', 'INVALID_EXPENSE_ALLOCATION');
    }
    const timestamp = FieldValue.serverTimestamp();
    transaction.create(expenseRef, {
      ...expense, ...allocation,
      expenseId: expenseRef.id, academyId: actor.session.academyId,
      createdByUid: actor.session.uid, createdByNameSnapshot: clean(actor.member.displayName) || clean(actor.member.name) || 'Academy Admin', createdAt: timestamp,
      updatedByUid: actor.session.uid, updatedAt: timestamp,
      ...(expense.status === 'posted' ? { postedByUid: actor.session.uid, postedByNameSnapshot: clean(actor.member.displayName) || clean(actor.member.name) || 'Academy Admin', postedAt: timestamp } : {}),
    });
    transaction.create(auditRef, {
      event: expense.status === 'posted' ? 'expense.posted' : 'expense.created',
      academyId: actor.session.academyId, expenseId: expenseRef.id, actorUid: actor.session.uid,
      actorNameSnapshot: clean(actor.member.displayName) || clean(actor.member.name) || 'Academy Admin',
      amount: expense.amount, category: expense.category, allocationMethod: allocation.allocationMethod,
      allocationTotal: allocation.allocationTotal, allocationCount: allocation.teacherAllocations.length,
      createdAt: timestamp,
    });
    if (idempotencyRef) transaction.create(idempotencyRef, { expenseId: expenseRef.id, actorUid: actor.session.uid, requestFingerprint, createdAt: timestamp });
    return { duplicate: false, expenseId: expenseRef.id, expense: { id: expenseRef.id, ...expense, ...allocation } };
  });
  return { success: true, ...result };
}

export async function updateAcademyExpense(request: Request, body: RecordLike) {
  const actor = await requireAdmin(request);
  const expenseId = safeId(body.expenseId, 'Expense');
  const reason = requiredText(body.reason, 'Edit reason', 500);
  const root = academyRef(actor.db, actor.session.academyId);
  const ref = root.collection('expenses').doc(expenseId);
  const auditRef = root.collection('auditLogs').doc();
  const expense = buildExpenseSnapshot({ ...body, status: 'draft' });
  const allocationRequest = getExpenseAllocationRequest(body);
  await actor.db.runTransaction(async (transaction) => {
    const fresh = await transaction.get(ref);
    if (!fresh.exists) throw new AcademyApiError(404, 'Expense was not found.', 'EXPENSE_NOT_FOUND');
    const before = fresh.data() as RecordLike;
    if (before.status !== 'draft') throw new AcademyApiError(409, 'Only draft expenses can be edited. Posted expenses must be voided with a reason.', 'EXPENSE_IMMUTABLE');
    const teachers = await readExpenseTeachersInTransaction(transaction, root, actor.session.academyId, allocationRequest.method, allocationRequest.selectedTeacherUids);
    let allocation;
    try {
      allocation = buildExpenseAllocationPlan({
        amount: expense.amount,
        allocationMethod: allocationRequest.method,
        selectedTeacherUids: allocationRequest.method === 'all_active' ? teachers.map((teacher) => teacher.uid) : allocationRequest.selectedTeacherUids,
        customAllocations: allocationRequest.customAllocations,
        teachers,
      });
    } catch (error) {
      throw new AcademyApiError(400, error instanceof Error ? error.message : 'Teacher allocation is invalid.', 'INVALID_EXPENSE_ALLOCATION');
    }
    const timestamp = FieldValue.serverTimestamp();
    transaction.update(ref, { ...expense, ...allocation, updatedByUid: actor.session.uid, updatedAt: timestamp });
    transaction.create(auditRef, {
      event: 'expense.updated', academyId: actor.session.academyId, expenseId, actorUid: actor.session.uid,
      actorNameSnapshot: clean(actor.member.displayName) || clean(actor.member.name) || 'Academy Admin',
      reason, before: { title: before.title, category: before.category, amount: before.amount, expenseDate: before.expenseDate, status: before.status, teacherAllocations: before.teacherAllocations ?? [] },
      after: { title: expense.title, category: expense.category, amount: expense.amount, expenseDate: expense.expenseDate, status: 'draft', teacherAllocations: allocation.teacherAllocations },
      createdAt: timestamp,
    });
  });
  return { success: true, expenseId };
}

export async function deleteAcademyDraftExpense(request: Request, body: RecordLike) {
  const actor = await requireAdmin(request);
  const expenseId = safeId(body.expenseId, 'Expense');
  const reason = requiredText(body.reason, 'Deletion reason', 500);
  const root = academyRef(actor.db, actor.session.academyId);
  const ref = root.collection('expenses').doc(expenseId);
  const auditRef = root.collection('auditLogs').doc();
  await actor.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new AcademyApiError(404, 'Expense was not found.', 'EXPENSE_NOT_FOUND');
    const before = snapshot.data() as RecordLike;
    if (before.status !== 'draft') throw new AcademyApiError(409, 'Only draft expenses can be deleted. Posted expenses must be voided.', 'EXPENSE_NOT_DRAFT');
    const timestamp = FieldValue.serverTimestamp();
    transaction.delete(ref);
    transaction.create(auditRef, {
      event: 'expense.draft_deleted', academyId: actor.session.academyId, expenseId, actorUid: actor.session.uid,
      actorNameSnapshot: clean(actor.member.displayName) || clean(actor.member.name) || 'Academy Admin',
      reason, originalSnapshot: { title: before.title, category: before.category, amount: before.amount, currency: before.currency, expenseDate: before.expenseDate, vendor: before.vendor, paymentMethod: before.paymentMethod, reference: before.reference, description: before.description, teacherAllocations: before.teacherAllocations ?? [] },
      createdAt: timestamp,
    });
  });
  return { success: true, expenseId, deleted: true };
}

export async function postAcademyDraftExpense(request: Request, body: RecordLike) {
  const actor = await requireAdmin(request);
  const expenseId = safeId(body.expenseId, 'Expense');
  const reason = requiredText(body.reason, 'Posting confirmation', 500);
  const root = academyRef(actor.db, actor.session.academyId);
  const ref = root.collection('expenses').doc(expenseId);
  const auditRef = root.collection('auditLogs').doc();
  await actor.db.runTransaction(async (transaction) => {
    const fresh = await transaction.get(ref);
    if (!fresh.exists) throw new AcademyApiError(404, 'Expense was not found.', 'EXPENSE_NOT_FOUND');
    const before = fresh.data() as RecordLike;
    if (before.status !== 'draft') throw new AcademyApiError(409, 'Only a draft expense can be posted.', 'EXPENSE_NOT_DRAFT');
    const allocationRequest = getExpenseAllocationRequest({}, before);
    const teachers = await readExpenseTeachersInTransaction(transaction, root, actor.session.academyId, allocationRequest.method, allocationRequest.selectedTeacherUids);
    let allocation;
    try {
      allocation = buildExpenseAllocationPlan({
        amount: before.amount,
        allocationMethod: allocationRequest.method,
        selectedTeacherUids: allocationRequest.method === 'all_active' ? teachers.map((teacher) => teacher.uid) : allocationRequest.selectedTeacherUids,
        customAllocations: allocationRequest.customAllocations,
        teachers,
      });
    } catch (error) {
      throw new AcademyApiError(400, error instanceof Error ? error.message : 'Teacher allocation is invalid.', 'INVALID_EXPENSE_ALLOCATION');
    }
    const timestamp = FieldValue.serverTimestamp();
    transaction.update(ref, { ...allocation, status: 'posted', postedByUid: actor.session.uid, postedByNameSnapshot: clean(actor.member.displayName) || clean(actor.member.name) || 'Academy Admin', postedAt: timestamp, updatedByUid: actor.session.uid, updatedAt: timestamp });
    transaction.create(auditRef, { event: 'expense.posted', academyId: actor.session.academyId, expenseId, actorUid: actor.session.uid, actorNameSnapshot: clean(actor.member.displayName) || clean(actor.member.name) || 'Academy Admin', amount: before.amount, category: before.category, allocationMethod: allocation.allocationMethod, allocationTotal: allocation.allocationTotal, allocationCount: allocation.teacherAllocations.length, reason, createdAt: timestamp });
  });
  return { success: true, expenseId, status: 'posted' };
}

export async function voidAcademyExpense(request: Request, body: RecordLike) {
  const actor = await requireAdmin(request);
  const expenseId = safeId(body.expenseId, 'Expense');
  const reason = requiredText(body.reason, 'Void reason', 500);
  const root = academyRef(actor.db, actor.session.academyId);
  const ref = root.collection('expenses').doc(expenseId);
  await actor.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new AcademyApiError(404, 'Expense was not found.', 'EXPENSE_NOT_FOUND');
    const before = snapshot.data() as RecordLike;
    if (before.status !== 'posted') throw new AcademyApiError(409, 'Only a posted expense can be voided.', 'EXPENSE_NOT_POSTED');
    const timestamp = FieldValue.serverTimestamp();
    transaction.update(ref, { status: 'void', voidedByUid: actor.session.uid, voidedByNameSnapshot: clean(actor.member.displayName) || clean(actor.member.name) || 'Academy Admin', voidedAt: timestamp, voidReason: reason, updatedByUid: actor.session.uid, updatedAt: timestamp });
    transaction.create(root.collection('auditLogs').doc(), {
      event: 'expense.voided', academyId: actor.session.academyId, expenseId, actorUid: actor.session.uid,
      actorNameSnapshot: clean(actor.member.displayName) || clean(actor.member.name) || 'Academy Admin',
      reason, originalAmount: before.amount, allocationSnapshot: before.teacherAllocations ?? [],
      createdAt: timestamp,
    });
  });
  return { success: true, expenseId, status: 'void' };
}

export async function getAcademyReadOnlyReports(request: Request) {
  const actor = await requireAdmin(request);
  const root = academyRef(actor.db, actor.session.academyId);
  const [attendance, staffAttendance, invoices, expenses, students, enrolments, studentReports, quizzes] = await Promise.all([
    root.collection('studentAttendance').orderBy('createdAt', 'desc').limit(2000).get().catch(() => null),
    root.collection('staffAttendance').orderBy('createdAt', 'desc').limit(1000).get().catch(() => null),
    root.collection('feeInvoices').limit(1000).get(),
    root.collection('expenses').where('status', '==', 'posted').limit(1000).get(),
    root.collection('students').where('status', '==', 'active').count().get(),
    root.collection('studentSubjectEnrollments').where('active', '==', true).count().get(),
    root.collection('studentReports').where('status', '==', 'active').limit(2000).get().catch(() => null),
    root.collection('quizzes').where('status', '==', 'active').limit(2000).get().catch(() => null),
  ]);
  const attendanceRows = attendance?.docs.map((doc) => doc.data()) ?? [];
  const staffRows = staffAttendance?.docs.map((doc) => doc.data()) ?? [];
  const counts = attendanceRows.reduce<Record<string, number>>((acc, row) => {
    const status = clean(row.status).toLowerCase() || 'unknown';
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
  const billed = invoices.docs.reduce((sum, doc) => sum + Number(doc.data().totalAmount ?? 0), 0);
  const collected = invoices.docs.reduce((sum, doc) => sum + Number(doc.data().paidAmount ?? 0), 0);
  const expensesTotal = expenses.docs.reduce((sum, doc) => sum + Number(doc.data().amount ?? 0), 0);
  return {
    success: true,
    studentAttendance: { records: attendanceRows.length, statusCounts: counts, mode: 'read_only' },
    studentReports: { records: studentReports?.size ?? 0, mode: 'read_only', source: 'teacher_portal_sync' },
    quizzes: { records: quizzes?.size ?? 0, mode: 'read_only', source: 'academy_and_teacher_portal' },
    staffAttendance: { records: staffRows.length, configured: staffRows.length > 0, statusCounts: staffRows.reduce<Record<string, number>>((acc, row) => { const status = clean(row.status).toLowerCase() || 'unknown'; acc[status] = (acc[status] ?? 0) + 1; return acc; }, {}) },
    finance: { billed, collected, outstanding: Math.max(0, billed - collected), postedExpenses: expensesTotal, netCashMovement: collected - expensesTotal },
    counts: { activeStudents: students.data().count, activeSubjectEnrollments: enrolments.data().count },
  };
}

export async function handleAcademyManagement(request: Request, response: ApiDispatchResponse) {
  response.setHeader('Cache-Control', 'no-store');
  try {
    if (request.method === 'GET') return response.status(200).json(await getAcademyAccess(request));
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'GET, POST');
      return response.status(405).json({ success: false, error: 'Method not allowed.' });
    }
    if (!isRecord(request.body)) throw new AcademyApiError(400, 'A valid request body is required.', 'INVALID_REQUEST');
    const body = request.body;
    const action = clean(body.action);
    let result: unknown;
    switch (action) {
      case 'dashboard': result = await getAcademyDashboard(request); break;
      case 'teachers': result = await listAcademyManagementTeachers(request); break;
      case 'teacher-profile': result = await getAcademyTeacherProfile(request, body); break;
      case 'update-own-teacher-profile': result = await updateOwnAcademyTeacherProfile(request, body); break;
      case 'update-teacher-permissions': result = await updateAcademyTeacherPermissions(request, body); break;
      case 'classes': result = await listAcademyClasses(request); break;
      case 'create-class': result = await createAcademyClass(request, body); break;
      case 'create-subject': result = await createAcademySubject(request, body); break;
      case 'students': result = await listAcademyStudents(request); break;
      case 'student-ledger': result = await getAcademyStudentLedger(request, body); break;
      case 'create-student': result = await createAcademyStudent(request, body); break;
      case 'generate-invoice': result = await generateAcademyInvoice(request, body); break;
      case 'invoices': result = await listAcademyInvoices(request); break;
      case 'collect-payment': result = await collectAcademyInvoicePayment(request, body); break;
      case 'payments': result = await listAcademyPayments(request); break;
      case 'expenses': result = await listAcademyExpenses(request, body); break;
      case 'expense-teachers': result = await listAcademyExpenseTeachers(request); break;
      case 'expense-details': result = await getAcademyExpenseDetails(request, body); break;
      case 'create-expense': result = await createAcademyExpense(request, body); break;
      case 'update-expense': result = await updateAcademyExpense(request, body); break;
      case 'delete-draft-expense': result = await deleteAcademyDraftExpense(request, body); break;
      case 'post-draft-expense': result = await postAcademyDraftExpense(request, body); break;
      case 'void-expense': result = await voidAcademyExpense(request, body); break;
      case 'reports': result = await getAcademyReadOnlyReports(request); break;
      default: result = await handleAcademyAdminWorkspaceAction(request, body); break;
    }
    return response.status(200).json(result);
  } catch (error) {
    if (error instanceof AcademyApiError) return response.status(error.status).json({ success: false, code: error.code, error: error.message });
    if (error instanceof Error && /invalid|must be|duplicate|exceeds|YYYY-MM/i.test(error.message)) return response.status(400).json({ success: false, code: 'INVALID_REQUEST', error: error.message });
    console.error('[academy-management] request failed:', error);
    return response.status(500).json({ success: false, code: 'INTERNAL_ERROR', error: 'The Academy management request could not be completed.' });
  }
}

export async function createTeacherCanonicalStudentFromExistingForm(
  request: Request,
  input: { classId: string; values: RecordLike; classMonthlyFee?: string; }
) {
  const body: RecordLike = { classId: input.classId, values: input.values, classMonthlyFee: input.classMonthlyFee };
  return createAcademyStudent(request, body, { teacherRequest: true });
}
