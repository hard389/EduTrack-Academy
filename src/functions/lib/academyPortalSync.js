"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncTeacherNotificationsToAcademy = exports.syncTeacherReportsToAcademy = exports.syncAcademyQuizToAssignedTeacher = exports.syncTeacherQuizToAcademy = exports.syncTeacherAttendanceToAcademy = exports.syncTeacherRosterEditsToAcademy = exports.syncAcademySubjectToTeacherPortals = exports.syncAcademyClassToTeacherPortals = exports.syncAcademyTeacherAssignmentToTeacherPortal = exports.syncAcademyEnrollmentToTeacherPortals = exports.syncAcademyStudentToTeacherPortals = exports.syncAcademyTeacherMembershipToTeacherPortal = void 0;
const app_1 = require("firebase-admin/app");
const auth_1 = require("firebase-admin/auth");
const firestore_1 = require("firebase-admin/firestore");
const firestore_2 = require("firebase-functions/v2/firestore");
const node_crypto_1 = require("node:crypto");
if (!(0, app_1.getApps)().length)
    (0, app_1.initializeApp)();
const db = (0, firestore_1.getFirestore)();
const auth = (0, auth_1.getAuth)();
const clean = (value) => typeof value === "string" ? value.trim() : "";
const row = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const arr = (value) => Array.isArray(value) ? value : [];
const hash = (value) => (0, node_crypto_1.createHash)("sha256").update(value).digest("hex").slice(0, 48);
const permission = (member, key) => row(member.permissions)[key] === true;
const active = (value) => value === true;
function dateKey(value) {
    const candidate = clean(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(candidate))
        return candidate;
    // The existing Teacher Quiz page stores dates as DD/MM/YYYY.
    const dayFirst = candidate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dayFirst) {
        const day = Number(dayFirst[1]);
        const month = Number(dayFirst[2]);
        const year = Number(dayFirst[3]);
        const parsed = new Date(Date.UTC(year, month - 1, day));
        if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day) {
            return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        }
        return "";
    }
    const parsed = candidate ? new Date(candidate) : new Date(Number.NaN);
    if (Number.isNaN(parsed.getTime()))
        return "";
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(parsed);
}
function projectionStudent(studentId, student, subjectIds, subjectNames, academyId) {
    const monthlyFee = Number(student.monthlyFee ?? student.studentFee ?? 0);
    return {
        id: studentId,
        studentId,
        canonicalStudentId: studentId,
        name: clean(student.name),
        rollNo: clean(student.rollNo),
        fatherName: clean(student.fatherName),
        phone: clean(student.phone),
        gender: clean(student.gender),
        admissionDate: clean(student.admissionDate),
        monthlyFee: Number.isFinite(monthlyFee) ? monthlyFee : 0,
        studentFee: String(student.studentFee ?? student.monthlyFee ?? 0),
        feeStatus: clean(student.feeStatus) || "Unpaid",
        avatar: clean(student.avatar),
        attendanceWhatsAppOptIn: student.attendanceWhatsAppOptIn === true,
        attendanceWhatsAppOptInAt: student.attendanceWhatsAppOptInAt ?? null,
        attendanceWhatsAppOptInPhone: student.attendanceWhatsAppOptInPhone ?? null,
        parentWhatsAppOptIn: student.parentWhatsAppOptIn === true,
        parentWhatsAppOptInAt: student.parentWhatsAppOptInAt ?? null,
        parentWhatsAppOptInPhone: student.parentWhatsAppOptInPhone ?? null,
        quizResultsWhatsAppOptIn: student.quizResultsWhatsAppOptIn === true,
        quizResultsWhatsAppOptInAt: student.quizResultsWhatsAppOptInAt ?? null,
        quizResultsWhatsAppOptInPhone: student.quizResultsWhatsAppOptInPhone ?? null,
        feeAlertsWhatsAppOptIn: student.feeAlertsWhatsAppOptIn === true,
        feeAlertsWhatsAppOptInAt: student.feeAlertsWhatsAppOptInAt ?? null,
        feeAlertsWhatsAppOptInPhone: student.feeAlertsWhatsAppOptInPhone ?? null,
        announcementWhatsAppOptIn: student.announcementWhatsAppOptIn === true,
        announcementWhatsAppOptInAt: student.announcementWhatsAppOptInAt ?? null,
        announcementWhatsAppOptInPhone: student.announcementWhatsAppOptInPhone ?? null,
        libraryLinkWhatsAppOptIn: student.libraryLinkWhatsAppOptIn === true,
        libraryLinkWhatsAppOptInAt: student.libraryLinkWhatsAppOptInAt ?? null,
        libraryLinkWhatsAppOptInPhone: student.libraryLinkWhatsAppOptInPhone ?? null,
        academyId,
        academySubjectIds: subjectIds,
        academySubjectNames: subjectNames,
    };
}
async function teacherContext(academyId, uid) {
    const academyRef = db.collection("academies").doc(academyId);
    const memberRef = academyRef.collection("members").doc(uid);
    const [academySnap, memberSnap, mappingSnap] = await Promise.all([
        academyRef.get(), memberRef.get(), db.collection("academyMemberships").doc(uid).get(),
    ]);
    if (!academySnap.exists || academySnap.data()?.status !== "active" || !memberSnap.exists || !mappingSnap.exists)
        return null;
    const member = row(memberSnap.data());
    const mapping = row(mappingSnap.data());
    const email = clean(member.email).toLowerCase();
    if (!email || member.uid !== uid || member.role !== "teacher" || member.academyId !== academyId || member.active !== true || member.emailVerified !== true)
        return null;
    if ((mapping.uid !== undefined && mapping.uid !== uid) || mapping.role !== "teacher" || mapping.academyId !== academyId || clean(mapping.email).toLowerCase() !== email || mapping.active !== true || mapping.emailVerified !== true)
        return null;
    const tenantRef = db.collection("users").doc(email);
    const profileSnap = await tenantRef.get();
    if (!profileSnap.exists)
        return null;
    const profile = row(profileSnap.data());
    if (profile.uid !== uid || clean(profile.email).toLowerCase() !== email || profile.role !== "teacher" || profile.academyId !== academyId || profile.active !== true || profile.disabled === true || profile.deleted === true)
        return null;
    const authUser = await auth.getUser(uid).catch(() => null);
    if (!authUser || authUser.disabled || authUser.emailVerified !== true || clean(authUser.email).toLowerCase() !== email)
        return null;
    return { uid, email, academyId, member, profile, tenantRef, academyRef };
}
async function recordIntegrationIssue(academyId, issueKey, payload) {
    const ref = db.collection("academies").doc(academyId).collection("integrationIssues").doc(hash(issueKey));
    await ref.set({ ...payload, issueKey, academyId, status: "open", updatedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
}
async function rebuildTeacherClassProjection(academyId, teacherUid, classId) {
    if (!academyId || !teacherUid || !classId)
        return;
    const context = await teacherContext(academyId, teacherUid);
    if (!context)
        return;
    const assignmentsSnap = await context.academyRef.collection("teacherAssignments").where("classId", "==", classId).limit(500).get();
    const assignments = assignmentsSnap.docs
        .map((doc) => ({ id: doc.id, ...row(doc.data()) }))
        .filter((item) => item.teacherUid === teacherUid && item.active === true && clean(item.subjectId));
    const classRef = context.academyRef.collection("classes").doc(classId);
    const [classSnap, enrollmentsSnap] = await Promise.all([
        classRef.get(), context.academyRef.collection("studentSubjectEnrollments").where("classId", "==", classId).limit(2000).get(),
    ]);
    const teacherClassRef = context.tenantRef.collection("classes").doc(classId);
    if (!classSnap.exists || ["archived", "inactive"].includes(clean(classSnap.data()?.status)) || assignments.length === 0) {
        const existing = await teacherClassRef.get();
        if (existing.exists && existing.data()?.academyId === academyId)
            await teacherClassRef.delete();
        return;
    }
    if (assignmentsSnap.size >= 500 || enrollmentsSnap.size >= 2000) {
        await recordIntegrationIssue(academyId, `roster-limit:${teacherUid}:${classId}`, {
            type: "teacher_roster_projection_limit", teacherUid, classId,
            message: "Roster projection reached a safe query limit. No partial student list was published.",
        });
        return;
    }
    const assignmentBySubject = new Map(assignments.map((item) => [clean(item.subjectId), item]));
    const subjectIds = [...assignmentBySubject.keys()];
    const relevantEnrollments = enrollmentsSnap.docs
        .map((doc) => ({ id: doc.id, ...row(doc.data()) }))
        .filter((item) => item.active === true && item.teacherUid === teacherUid && subjectIds.includes(clean(item.subjectId)) && clean(item.studentId));
    const subjectSnaps = await Promise.all(subjectIds.map((subjectId) => context.academyRef.collection("subjects").doc(subjectId).get()));
    const subjectNameById = new Map(subjectSnaps.map((snap, index) => [subjectIds[index], clean(snap.data()?.name) || subjectIds[index]]));
    const enrolmentsByStudent = new Map();
    for (const enrollment of relevantEnrollments) {
        const studentId = clean(enrollment.studentId);
        const set = enrolmentsByStudent.get(studentId) ?? new Set();
        set.add(clean(enrollment.subjectId));
        enrolmentsByStudent.set(studentId, set);
    }
    const studentIds = [...enrolmentsByStudent.keys()];
    if (studentIds.length > 350) {
        await recordIntegrationIssue(academyId, `roster-size:${teacherUid}:${classId}`, {
            type: "teacher_roster_projection_size", teacherUid, classId,
            message: "A class has more than 350 subject-enrolled students. The projection was not overwritten.",
            studentCount: studentIds.length,
        });
        return;
    }
    const students = await Promise.all(studentIds.map(async (studentId) => {
        const snap = await context.academyRef.collection("students").doc(studentId).get();
        if (!snap.exists)
            return null;
        const data = row(snap.data());
        if (data.status === "archived" || data.status === "inactive")
            return null;
        const ids = [...(enrolmentsByStudent.get(studentId) ?? new Set())];
        const names = ids.map((id) => subjectNameById.get(id) ?? id);
        return projectionStudent(studentId, data, ids, names, academyId);
    }));
    const roster = students.filter((value) => value !== null);
    const payload = {
        id: classId,
        classId,
        academyId,
        academyClassId: classId,
        academyTeacherUid: teacherUid,
        academySubjectIds: subjectIds,
        academySubjectNames: subjectIds.map((id) => subjectNameById.get(id) ?? id),
        academyAccessActive: true,
        academyProjectionVersion: 2,
        academyProjectionWriteAt: firestore_1.FieldValue.serverTimestamp(),
        name: clean(classSnap.data()?.name) || classId,
        className: clean(classSnap.data()?.name) || classId,
        classCode: clean(classSnap.data()?.classCode) || clean(classSnap.data()?.code) || "",
        code: clean(classSnap.data()?.classCode) || clean(classSnap.data()?.code) || "",
        section: clean(classSnap.data()?.section),
        grade: clean(classSnap.data()?.grade),
        students: roster,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    };
    if (JSON.stringify(payload).length > 850_000) {
        await recordIntegrationIssue(academyId, `roster-document-size:${teacherUid}:${classId}`, {
            type: "teacher_roster_projection_size", teacherUid, classId,
            message: "The projected roster is too large for one Firestore document. The previous projection was retained.",
        });
        return;
    }
    await teacherClassRef.set(payload, { merge: true });
}
async function rebuildProjectionForStudent(academyId, studentId) {
    const root = db.collection("academies").doc(academyId);
    const enrollments = await root.collection("studentSubjectEnrollments").where("studentId", "==", studentId).limit(500).get();
    if (enrollments.size >= 500) {
        await recordIntegrationIssue(academyId, `student-enrollment-limit:${studentId}`, {
            type: "student_enrollment_projection_limit", studentId,
            message: "Student has more than 500 enrollment records. Projection was not updated.",
        });
        return;
    }
    const pairs = new Map();
    for (const doc of enrollments.docs) {
        const item = row(doc.data());
        if (item.active !== true)
            continue;
        const teacherUid = clean(item.teacherUid);
        const classId = clean(item.classId);
        if (teacherUid && classId)
            pairs.set(`${teacherUid}:${classId}`, { teacherUid, classId });
    }
    for (const item of pairs.values())
        await rebuildTeacherClassProjection(academyId, item.teacherUid, item.classId);
}
async function rebuildForAssignmentDocument(academyId, data) {
    if (!data)
        return;
    const teacherUid = clean(data.teacherUid);
    const classId = clean(data.classId);
    if (teacherUid && classId)
        await rebuildTeacherClassProjection(academyId, teacherUid, classId);
}
// A teacher's canonical class/student records may have been created while the
// membership was pending, so no usable teacher projection existed at that time.
// Rebuild all active assigned class projections when the membership becomes
// active/verified or permissions are edited. The Admin SDK writes projections;
// browser clients still have no authority to create them.
exports.syncAcademyTeacherMembershipToTeacherPortal = (0, firestore_2.onDocumentWritten)("academies/{academyId}/members/{memberUid}", async (event) => {
    const academyId = clean(event.params.academyId);
    const teacherUid = clean(event.params.memberUid);
    const afterExists = event.data?.after.exists === true;
    const after = afterExists ? row(event.data?.after.data()) : {};
    if (!academyId || !teacherUid || !afterExists || after.role !== "teacher" || after.active !== true || after.emailVerified !== true)
        return;
    // The trigger is also emitted for display-name/permission updates. A bounded
    // assignment query makes the repair idempotent and avoids partial projection writes.
    const context = await teacherContext(academyId, teacherUid);
    if (!context)
        return;
    const assignmentSnap = await context.academyRef.collection("teacherAssignments")
        .where("teacherUid", "==", teacherUid).limit(501).get();
    if (assignmentSnap.size >= 501) {
        await recordIntegrationIssue(academyId, `membership-rebuild-limit:${teacherUid}`, {
            type: "teacher_membership_projection_limit", teacherUid,
            message: "The teacher has more than 500 assignment records. Automatic projection rebuild was paused; review the membership integration issue before retrying.",
        });
        return;
    }
    const classIds = [...new Set(assignmentSnap.docs.map((doc) => row(doc.data()))
            .filter((item) => item.active === true)
            .map((item) => clean(item.classId)).filter(Boolean))];
    for (const classId of classIds) {
        await rebuildTeacherClassProjection(academyId, teacherUid, classId);
    }
});
exports.syncAcademyStudentToTeacherPortals = (0, firestore_2.onDocumentWritten)("academies/{academyId}/students/{studentId}", async (event) => {
    await rebuildProjectionForStudent(event.params.academyId, event.params.studentId);
});
exports.syncAcademyEnrollmentToTeacherPortals = (0, firestore_2.onDocumentWritten)("academies/{academyId}/studentSubjectEnrollments/{enrollmentId}", async (event) => {
    await Promise.all([
        rebuildForAssignmentDocument(event.params.academyId, event.data?.before.exists ? row(event.data.before.data()) : undefined),
        rebuildForAssignmentDocument(event.params.academyId, event.data?.after.exists ? row(event.data.after.data()) : undefined),
    ]);
    const beforeStudent = clean(event.data?.before.data()?.studentId);
    const afterStudent = clean(event.data?.after.data()?.studentId);
    for (const studentId of new Set([beforeStudent, afterStudent].filter(Boolean))) {
        await rebuildProjectionForStudent(event.params.academyId, studentId);
    }
});
exports.syncAcademyTeacherAssignmentToTeacherPortal = (0, firestore_2.onDocumentWritten)("academies/{academyId}/teacherAssignments/{assignmentId}", async (event) => {
    await Promise.all([
        rebuildForAssignmentDocument(event.params.academyId, event.data?.before.exists ? row(event.data.before.data()) : undefined),
        rebuildForAssignmentDocument(event.params.academyId, event.data?.after.exists ? row(event.data.after.data()) : undefined),
    ]);
});
exports.syncAcademyClassToTeacherPortals = (0, firestore_2.onDocumentWritten)("academies/{academyId}/classes/{classId}", async (event) => {
    const root = db.collection("academies").doc(event.params.academyId);
    const assignments = await root.collection("teacherAssignments").where("classId", "==", event.params.classId).limit(500).get();
    const teacherUids = new Set(assignments.docs.map((doc) => clean(doc.data().teacherUid)).filter(Boolean));
    for (const uid of teacherUids)
        await rebuildTeacherClassProjection(event.params.academyId, uid, event.params.classId);
});
exports.syncAcademySubjectToTeacherPortals = (0, firestore_2.onDocumentWritten)("academies/{academyId}/subjects/{subjectId}", async (event) => {
    const subject = row(event.data?.after.data());
    const classId = clean(subject.classId) || clean(event.data?.before.data()?.classId);
    if (!classId)
        return;
    const assignments = await db.collection("academies").doc(event.params.academyId).collection("teacherAssignments").where("classId", "==", classId).limit(500).get();
    const teacherUids = new Set(assignments.docs.map((doc) => clean(doc.data().teacherUid)).filter(Boolean));
    for (const uid of teacherUids)
        await rebuildTeacherClassProjection(event.params.academyId, uid, classId);
});
function timestampMillis(value) {
    if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") {
        try {
            return value.toMillis();
        }
        catch {
            return null;
        }
    }
    return null;
}
function studentKey(value) {
    return clean(value.canonicalStudentId) || clean(value.studentId) || clean(value.id);
}
function studentRows(value) {
    if (Array.isArray(value))
        return value.map((item) => row(item));
    if (value && typeof value === "object")
        return Object.values(value).map((item) => row(item));
    return [];
}
const EDITABLE_STUDENT_FIELDS = [
    "name", "fatherName", "phone", "gender", "admissionDate", "rollNo", "studentFee", "monthlyFee", "avatar",
    "attendanceWhatsAppOptIn", "attendanceWhatsAppOptInAt", "attendanceWhatsAppOptInPhone",
    "parentWhatsAppOptIn", "parentWhatsAppOptInAt", "parentWhatsAppOptInPhone",
    "quizResultsWhatsAppOptIn", "quizResultsWhatsAppOptInAt", "quizResultsWhatsAppOptInPhone",
    "feeAlertsWhatsAppOptIn", "feeAlertsWhatsAppOptInAt", "feeAlertsWhatsAppOptInPhone",
    "announcementWhatsAppOptIn", "announcementWhatsAppOptInAt", "announcementWhatsAppOptInPhone",
    "libraryLinkWhatsAppOptIn", "libraryLinkWhatsAppOptInAt", "libraryLinkWhatsAppOptInPhone",
];
exports.syncTeacherRosterEditsToAcademy = (0, firestore_2.onDocumentWritten)("users/{teacherEmail}/classes/{classId}", async (event) => {
    const beforeSnap = event.data?.before;
    const afterSnap = event.data?.after;
    if (!beforeSnap?.exists || !afterSnap?.exists)
        return;
    const before = row(beforeSnap.data());
    const after = row(afterSnap.data());
    // Server projections update this marker. Browser-side student edits do not.
    if (timestampMillis(before.academyProjectionWriteAt) !== timestampMillis(after.academyProjectionWriteAt))
        return;
    const teacherEmail = clean(event.params.teacherEmail).toLowerCase();
    const profileSnap = await db.collection("users").doc(teacherEmail).get();
    if (!profileSnap.exists)
        return;
    const profile = row(profileSnap.data());
    const uid = clean(profile.uid);
    const academyId = clean(profile.academyId);
    const classId = event.params.classId;
    if (!uid || !academyId || profile.role !== "teacher")
        return;
    const context = await teacherContext(academyId, uid);
    if (!context || context.email !== teacherEmail || (!permission(context.member, "students.edit_assigned") && !permission(context.member, "students.manage_all")))
        return;
    const assignmentSnap = await context.academyRef.collection("teacherAssignments").where("classId", "==", classId).limit(200).get();
    const subjectIds = new Set(assignmentSnap.docs.map((doc) => row(doc.data()))
        .filter((item) => item.active === true && item.teacherUid === uid).map((item) => clean(item.subjectId)).filter(Boolean));
    if (!subjectIds.size)
        return;
    const enrollmentSnap = await context.academyRef.collection("studentSubjectEnrollments").where("classId", "==", classId).limit(2000).get();
    const owned = new Map();
    for (const enrollment of enrollmentSnap.docs) {
        const item = row(enrollment.data());
        if (item.active === true && item.teacherUid === uid && subjectIds.has(clean(item.subjectId))) {
            const studentId = clean(item.studentId);
            if (studentId)
                owned.set(studentId, [...(owned.get(studentId) ?? []), enrollment.ref]);
        }
    }
    const beforeRows = new Map(studentRows(before.students).map((item) => [studentKey(item), item]).filter(([key]) => Boolean(key)));
    const afterRows = new Map(studentRows(after.students).map((item) => [studentKey(item), item]).filter(([key]) => Boolean(key)));
    const removed = [...beforeRows.keys()].filter((id) => !afterRows.has(id) && owned.has(id));
    for (const studentId of removed) {
        for (const ref of owned.get(studentId) ?? [])
            await ref.update({ active: false, inactiveAt: firestore_1.FieldValue.serverTimestamp(), inactiveByUid: uid, inactiveReason: "teacher_removed_from_assigned_class" });
        const remaining = await context.academyRef.collection("studentSubjectEnrollments").where("studentId", "==", studentId).limit(500).get();
        if (!remaining.docs.some((doc) => doc.data().active === true)) {
            await context.academyRef.collection("students").doc(studentId).set({ status: "archived", archivedAt: firestore_1.FieldValue.serverTimestamp(), archivedByUid: uid }, { merge: true });
        }
    }
    for (const [studentId, next] of afterRows) {
        if (!owned.has(studentId))
            continue; // New/unassigned rows are never accepted from a client array.
        const previous = beforeRows.get(studentId) ?? {};
        const changes = {};
        for (const field of EDITABLE_STUDENT_FIELDS) {
            if (next[field] !== undefined && JSON.stringify(next[field]) !== JSON.stringify(previous[field]))
                changes[field] = next[field];
        }
        if (Object.keys(changes).length) {
            if (typeof changes.name === "string")
                changes.name = clean(changes.name).slice(0, 120);
            if (typeof changes.rollNo === "string") {
                changes.rollNo = clean(changes.rollNo).slice(0, 64);
                const normalizedRollNo = String(changes.rollNo).toLocaleLowerCase().replace(/\s+/g, " ");
                const conflicts = await context.academyRef.collection("students")
                    .where("primaryClassId", "==", classId)
                    .where("rollNoNormalized", "==", normalizedRollNo)
                    .limit(2).get();
                if (conflicts.docs.some((doc) => doc.id !== studentId)) {
                    await recordIntegrationIssue(academyId, `student-roll-conflict:${uid}:${classId}:${studentId}`, {
                        type: "teacher_student_roll_number_conflict", teacherUid: uid, classId, studentId,
                        message: "The teacher's student edit was not synchronized because the requested roll number is already used in this class.",
                    });
                    continue;
                }
                changes.rollNoNormalized = normalizedRollNo;
            }
            if (typeof changes.phone === "string")
                changes.phone = clean(changes.phone).slice(0, 30);
            if (!changes.name && Object.prototype.hasOwnProperty.call(changes, "name"))
                continue;
            await context.academyRef.collection("students").doc(studentId).set({ ...changes, updatedAt: firestore_1.FieldValue.serverTimestamp(), updatedByUid: uid, updatedByRole: "teacher" }, { merge: true });
        }
    }
    // Rebuild from canonical records after applying valid edits. This also removes
    // client-added/unassigned rows that are not part of the Academy enrolment set.
    await rebuildTeacherClassProjection(academyId, uid, classId);
});
async function assignedSubject(context, classId) {
    const assignments = await context.academyRef.collection("teacherAssignments").where("classId", "==", classId).limit(200).get();
    const activeAssignments = assignments.docs.map((doc) => row(doc.data())).filter((item) => item.active === true && item.teacherUid === context.uid && clean(item.subjectId));
    const distinct = [...new Set(activeAssignments.map((item) => clean(item.subjectId)))];
    if (distinct.length !== 1) {
        await recordIntegrationIssue(context.academyId, `subject-ambiguous:${context.uid}:${classId}`, {
            type: "teacher_subject_selection_required", teacherUid: context.uid, classId, subjectIds: distinct,
            message: "The existing Teacher Portal screen selects a class but not a subject. Attendance and quiz synchronization is paused until exactly one active subject is assigned to this teacher in this class.",
        });
        return null;
    }
    const subjectId = distinct[0];
    const subjectSnap = await context.academyRef.collection("subjects").doc(subjectId).get();
    if (!subjectSnap.exists || subjectSnap.data()?.active !== true)
        return null;
    return { subjectId, subjectName: clean(subjectSnap.data()?.name) || subjectId };
}
async function activeRoster(context, classId, subjectId) {
    const enrollmentSnap = await context.academyRef.collection("studentSubjectEnrollments").where("classId", "==", classId).limit(2000).get();
    if (enrollmentSnap.size >= 2000) {
        await recordIntegrationIssue(context.academyId, `active-roster-limit:${context.uid}:${classId}:${subjectId}`, {
            type: "teacher_subject_roster_limit", teacherUid: context.uid, classId, subjectId,
            message: "The assigned subject roster reached its safe query limit. Attendance/quiz synchronization was paused.",
        });
        return new Map();
    }
    const rows = enrollmentSnap.docs.map((doc) => row(doc.data())).filter((item) => item.active === true && item.teacherUid === context.uid && item.subjectId === subjectId && clean(item.studentId));
    const uniqueStudentIds = [...new Set(rows.map((item) => clean(item.studentId)))];
    if (uniqueStudentIds.length > 350) {
        await recordIntegrationIssue(context.academyId, `active-roster-size:${context.uid}:${classId}:${subjectId}`, {
            type: "teacher_subject_roster_size", teacherUid: context.uid, classId, subjectId, studentCount: uniqueStudentIds.length,
            message: "The assigned subject roster exceeds 350 students. Attendance/quiz synchronization was paused instead of guessing a truncated roster.",
        });
        return new Map();
    }
    const studentSnaps = await Promise.all(uniqueStudentIds.map((studentId) => context.academyRef.collection("students").doc(studentId).get()));
    const result = new Map();
    studentSnaps.forEach((studentSnap, index) => {
        if (studentSnap.exists && !["archived", "inactive"].includes(clean(studentSnap.data()?.status))) {
            result.set(uniqueStudentIds[index], row(studentSnap.data()));
        }
    });
    return result;
}
exports.syncTeacherAttendanceToAcademy = (0, firestore_2.onDocumentWritten)("users/{teacherEmail}/attendance/{attendanceId}", async (event) => {
    const source = row(event.data?.after.exists ? event.data.after.data() : event.data?.before.data());
    // Holiday markers are calendar metadata, not student attendance registers.
    if (source.isHoliday === true || source.status === "Holiday")
        return;
    const teacherEmail = clean(event.params.teacherEmail).toLowerCase();
    const profileSnap = await db.collection("users").doc(teacherEmail).get();
    if (!profileSnap.exists)
        return;
    const profile = row(profileSnap.data());
    const context = await teacherContext(clean(profile.academyId), clean(profile.uid));
    if (!context || context.email !== teacherEmail)
        return;
    if (!permission(context.member, "attendance.take_assigned"))
        return;
    const classId = clean(source.classId);
    const date = dateKey(source.date);
    if (!classId || !date) {
        await recordIntegrationIssue(context.academyId, `attendance-invalid:${teacherEmail}:${event.params.attendanceId}`, {
            type: "teacher_attendance_invalid", teacherUid: context.uid, sourceId: event.params.attendanceId,
            message: "Attendance cannot be synchronized because classId or date is missing/invalid.",
        });
        return;
    }
    const assignment = await assignedSubject(context, classId);
    if (!assignment)
        return;
    const canonicalId = `tp_${hash(`${context.uid}|${classId}|${assignment.subjectId}|${date}`)}`;
    const canonicalRef = context.academyRef.collection("studentAttendance").doc(canonicalId);
    const canonicalExisting = await canonicalRef.get();
    if (!event.data?.after.exists) {
        if (canonicalExisting.exists) {
            await canonicalRef.set({ status: "void", voidedAt: firestore_1.FieldValue.serverTimestamp(), voidReason: "Teacher source attendance was deleted", updatedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
        }
        return;
    }
    const roster = await activeRoster(context, classId, assignment.subjectId);
    const attendanceMap = row(source.attendanceMap);
    const keys = Object.keys(attendanceMap);
    const unknown = keys.filter((key) => !roster.has(key));
    const missing = [...roster.keys()].filter((key) => !(key in attendanceMap));
    const invalidValues = keys.filter((key) => attendanceMap[key] !== true && attendanceMap[key] !== false);
    if (unknown.length || missing.length || invalidValues.length) {
        await recordIntegrationIssue(context.academyId, `attendance-roster:${context.uid}:${classId}:${date}`, {
            type: "teacher_attendance_roster_mismatch", teacherUid: context.uid, classId, subjectId: assignment.subjectId,
            date, unknownStudentIds: unknown.slice(0, 20), missingStudentIds: missing.slice(0, 20), invalidValues: invalidValues.slice(0, 20),
            message: "Attendance was not copied because its student list does not exactly match the current assigned subject roster.",
        });
        return;
    }
    const presentCount = Object.values(attendanceMap).filter((value) => value === true).length;
    const absentCount = Object.values(attendanceMap).filter((value) => value === false).length;
    const totalStudents = roster.size;
    await canonicalRef.set({
        academyId: context.academyId,
        recordId: canonicalId,
        classId,
        className: clean(source.className) || clean(source.class) || classId,
        subjectId: assignment.subjectId,
        subjectName: assignment.subjectName,
        teacherUid: context.uid,
        teacherEmail,
        date,
        attendanceMap,
        studentIds: [...roster.keys()],
        rosterStudentIds: [...roster.keys()],
        totalStudents,
        presentCount,
        absentCount,
        attendancePercentage: totalStudents ? Math.round((presentCount / totalStudents) * 10000) / 100 : 0,
        status: "saved",
        locked: true,
        source: "teacher_portal",
        sourceType: "teacher_portal",
        sourcePath: `users/${teacherEmail}/attendance/${event.params.attendanceId}`,
        createdByUid: context.uid,
        createdByRole: "teacher",
        createdAt: canonicalExisting.data()?.createdAt ?? firestore_1.FieldValue.serverTimestamp(),
        updatedByUid: context.uid,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
        revision: Number(canonicalExisting.data()?.revision ?? 1),
    }, { merge: true });
});
function scoreRows(raw, roster, totalMarks) {
    if (!Array.isArray(raw) || raw.length !== roster.size)
        return null;
    const seen = new Set();
    const result = [];
    for (const entry of raw) {
        const item = row(entry);
        const studentId = clean(item.studentId) || clean(item.id);
        if (!studentId || seen.has(studentId) || !roster.has(studentId))
            return null;
        const rawMark = item.marksObtained !== undefined ? item.marksObtained : item.marks;
        const isBlank = rawMark === "" || rawMark === null || rawMark === undefined;
        const parsed = isBlank ? null : Number(rawMark);
        if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > totalMarks))
            return null;
        seen.add(studentId);
        const student = roster.get(studentId) ?? {};
        result.push({
            studentId, id: studentId, name: clean(student.name), rollNo: clean(student.rollNo),
            marks: parsed, marksObtained: parsed === null ? "" : parsed, totalMarks,
        });
    }
    return seen.size === roster.size ? result : null;
}
exports.syncTeacherQuizToAcademy = (0, firestore_2.onDocumentWritten)("users/{teacherEmail}/classes/{classId}/quizzes/{quizId}", async (event) => {
    const source = row(event.data?.after.exists ? event.data.after.data() : event.data?.before.data());
    if (source.sourceType === "academy_admin")
        return;
    const teacherEmail = clean(event.params.teacherEmail).toLowerCase();
    const profileSnap = await db.collection("users").doc(teacherEmail).get();
    if (!profileSnap.exists)
        return;
    const profile = row(profileSnap.data());
    const context = await teacherContext(clean(profile.academyId), clean(profile.uid));
    if (!context || context.email !== teacherEmail || !permission(context.member, "quiz.manage_assigned"))
        return;
    const classId = event.params.classId;
    const assignment = await assignedSubject(context, classId);
    if (!assignment)
        return;
    const canonicalId = `tp_${hash(`${context.uid}|${classId}|${event.params.quizId}`)}`;
    const canonicalRef = context.academyRef.collection("quizzes").doc(canonicalId);
    if (!event.data?.after.exists || source.status === "archived") {
        await canonicalRef.set({ status: "archived", archivedAt: firestore_1.FieldValue.serverTimestamp(), updatedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
        return;
    }
    const totalMarks = Number(source.totalMarks);
    const date = dateKey(source.date);
    const roster = await activeRoster(context, classId, assignment.subjectId);
    const scores = Number.isFinite(totalMarks) && totalMarks > 0 ? scoreRows(source.studentScores, roster, totalMarks) : null;
    if (!date || !Number.isFinite(totalMarks) || totalMarks <= 0 || !scores) {
        await recordIntegrationIssue(context.academyId, `quiz-invalid:${context.uid}:${event.params.quizId}`, {
            type: "teacher_quiz_invalid", teacherUid: context.uid, classId, subjectId: assignment.subjectId, quizId: event.params.quizId,
            message: "Quiz was not synchronized because its date, total marks, or student score roster is invalid.",
        });
        return;
    }
    const classSnap = await context.academyRef.collection("classes").doc(classId).get();
    await canonicalRef.set({
        academyId: context.academyId, quizId: canonicalId, sourceQuizId: event.params.quizId,
        classId, className: clean(classSnap.data()?.name) || classId,
        subjectId: assignment.subjectId, subjectName: assignment.subjectName,
        teacherUid: context.uid, teacherEmail,
        title: clean(source.topic) || clean(source.title) || "Quiz", topic: clean(source.topic) || clean(source.title) || "Quiz",
        date, monthKey: date.slice(0, 7), totalMarks, studentScores: scores,
        averageMarks: scores.some((item) => typeof item.marks === "number")
            ? scores.reduce((sum, item) => sum + (typeof item.marks === "number" ? item.marks : 0), 0)
                / scores.filter((item) => typeof item.marks === "number").length
            : null,
        status: "active", sourceType: "teacher_portal", createdByUid: context.uid, creatorRole: "teacher",
        sourcePath: `users/${teacherEmail}/classes/${classId}/quizzes/${event.params.quizId}`,
        updatedAt: firestore_1.FieldValue.serverTimestamp(), updatedByUid: context.uid,
    }, { merge: true });
});
exports.syncAcademyQuizToAssignedTeacher = (0, firestore_2.onDocumentWritten)("academies/{academyId}/quizzes/{quizId}", async (event) => {
    const quiz = row(event.data?.after.exists ? event.data.after.data() : event.data?.before.data());
    const teacherUid = clean(quiz.teacherUid);
    if (!teacherUid || quiz.sourceType === "teacher_portal")
        return;
    const context = await teacherContext(event.params.academyId, teacherUid);
    if (!context || !permission(context.member, "quiz.view_assigned"))
        return;
    const classId = clean(quiz.classId);
    const subjectId = clean(quiz.subjectId);
    if (!classId || !subjectId)
        return;
    const assignments = await context.academyRef.collection("teacherAssignments").where("classId", "==", classId).limit(200).get();
    if (!assignments.docs.some((doc) => doc.data().active === true && doc.data().teacherUid === teacherUid && doc.data().subjectId === subjectId))
        return;
    const target = context.tenantRef.collection("classes").doc(classId).collection("quizzes").doc(event.params.quizId);
    if (!event.data?.after.exists || quiz.status === "archived") {
        await target.set({ status: "archived", sourceType: "academy_admin", academyId: event.params.academyId, updatedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
        return;
    }
    const scores = arr(quiz.studentScores).map((item) => {
        const score = row(item);
        const rawMark = score.marksObtained !== undefined ? score.marksObtained : score.marks;
        const marksObtained = rawMark === "" || rawMark === null || rawMark === undefined ? "" : Number(rawMark);
        return { id: clean(score.studentId), studentId: clean(score.studentId), name: clean(score.name), rollNo: clean(score.rollNo), marksObtained, totalMarks: Number(quiz.totalMarks ?? 0) };
    });
    await target.set({
        id: event.params.quizId,
        topic: clean(quiz.topic) || clean(quiz.title) || "Quiz",
        title: clean(quiz.title) || clean(quiz.topic) || "Quiz",
        totalMarks: Number(quiz.totalMarks ?? 0), date: clean(quiz.date), monthKey: clean(quiz.monthKey),
        studentScores: scores, averageScore: Number(quiz.averageMarks ?? 0),
        createdAt: quiz.createdAt ?? firestore_1.FieldValue.serverTimestamp(), updatedAt: firestore_1.FieldValue.serverTimestamp(),
        updatedByUid: clean(quiz.updatedByUid) || teacherUid,
        academyId: event.params.academyId, subjectId, teacherUid, sourceType: "academy_admin", status: "active",
    }, { merge: true });
});
exports.syncTeacherReportsToAcademy = (0, firestore_2.onDocumentWritten)("users/{teacherEmail}/classes/{classId}/reports/{reportId}", async (event) => {
    const source = row(event.data?.after.exists ? event.data.after.data() : event.data?.before.data());
    const teacherEmail = clean(event.params.teacherEmail).toLowerCase();
    const profileSnap = await db.collection("users").doc(teacherEmail).get();
    if (!profileSnap.exists)
        return;
    const profile = row(profileSnap.data());
    const context = await teacherContext(clean(profile.academyId), clean(profile.uid));
    if (!context || context.email !== teacherEmail || !permission(context.member, "reports.view_assigned"))
        return;
    const studentId = clean(source.studentId);
    const classId = event.params.classId;
    if (!studentId)
        return;
    const enrollmentSnap = await context.academyRef.collection("studentSubjectEnrollments").where("studentId", "==", studentId).limit(200).get();
    const assigned = enrollmentSnap.docs.some((doc) => {
        const enrollment = row(doc.data());
        return enrollment.active === true && enrollment.teacherUid === context.uid && enrollment.classId === classId;
    });
    if (!assigned)
        return;
    const canonicalId = hash(`${context.uid}|${classId}|${studentId}|${clean(source.monthKey)}|${event.params.reportId}`);
    const target = context.academyRef.collection("studentReports").doc(canonicalId);
    if (!event.data?.after.exists) {
        await target.set({ status: "archived", archivedAt: firestore_1.FieldValue.serverTimestamp(), updatedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
        return;
    }
    await target.set({
        academyId: context.academyId, reportId: canonicalId, sourceReportId: event.params.reportId,
        teacherUid: context.uid, teacherEmail, classId, studentId,
        studentName: clean(source.studentName), rollNo: clean(source.rollNo), monthKey: clean(source.monthKey),
        category: clean(source.category), remarks: clean(source.remarks), remarkItems: arr(source.remarkItems),
        mode: clean(source.mode) || "teacher_portal", status: "active", sourceType: "teacher_portal",
        sourcePath: `users/${teacherEmail}/classes/${classId}/reports/${event.params.reportId}`,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
});
exports.syncTeacherNotificationsToAcademy = (0, firestore_2.onDocumentWritten)("users/{teacherEmail}/notifications/{notificationId}", async (event) => {
    const source = row(event.data?.after.exists ? event.data.after.data() : event.data?.before.data());
    if (source.sourceType === "academy_admin" || source.category === "WhatsApp")
        return;
    const teacherEmail = clean(event.params.teacherEmail).toLowerCase();
    const profileSnap = await db.collection("users").doc(teacherEmail).get();
    if (!profileSnap.exists)
        return;
    const profile = row(profileSnap.data());
    const context = await teacherContext(clean(profile.academyId), clean(profile.uid));
    if (!context || context.email !== teacherEmail || !permission(context.member, "alerts.manage"))
        return;
    const canonicalId = hash(`${context.uid}|${event.params.notificationId}`);
    const target = context.academyRef.collection("teacherNotifications").doc(canonicalId);
    if (!event.data?.after.exists) {
        await target.set({ status: "archived", archivedAt: firestore_1.FieldValue.serverTimestamp(), updatedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
        return;
    }
    if (!clean(source.title) || !clean(source.message))
        return;
    await target.set({
        academyId: context.academyId, notificationId: canonicalId, sourceNotificationId: event.params.notificationId,
        teacherUid: context.uid, teacherEmail, title: clean(source.title), message: clean(source.message),
        category: clean(source.category), priority: clean(source.priority) || "normal", targetClass: clean(source.targetClass) || "All Classes",
        isRead: source.isRead === true, sourceType: "teacher_portal", status: "active",
        sourcePath: `users/${teacherEmail}/notifications/${event.params.notificationId}`,
        createdAt: source.createdAt ?? firestore_1.FieldValue.serverTimestamp(), updatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
});
//# sourceMappingURL=academyPortalSync.js.map