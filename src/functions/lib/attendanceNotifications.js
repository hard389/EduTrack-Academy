"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listRetryableAbsentAttendanceNotifications = exports.retryFailedAbsentAttendanceNotification = exports.sendQueuedAbsentAttendanceNotification = exports.queueAbsentAttendanceNotifications = void 0;
/**
 * Attendance notification pipeline:
 * 1) create idempotent Firestore jobs when attendance is first saved;
 * 2) send only queued jobs whose current guardian record still has explicit opt-in;
 * 3) record Meta API acceptance separately from confirmed delivery.
 */
const node_crypto_1 = require("node:crypto");
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const https_1 = require("firebase-functions/v2/https");
const firestore_2 = require("firebase-functions/v2/firestore");
const whatsappService_1 = require("./whatsappService");
const attendanceRetryPolicy_1 = require("./attendanceRetryPolicy");
const subscriptionEntitlements_1 = require("./subscriptionEntitlements");
if (!(0, app_1.getApps)().length)
    (0, app_1.initializeApp)();
const db = (0, firestore_1.getFirestore)();
const REGION = "us-central1";
const RESERVED_CLASS_KEYS = new Set([
    "id", "name", "code", "monthlyFee", "className", "title", "fee",
    "classFee", "createdAt", "createdDate", "date", "updatedAt", "students",
]);
function isRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function isStudentRecord(value) {
    if (!isRecord(value))
        return false;
    return typeof value.name === "string" || value.id !== undefined || value.studentId !== undefined;
}
function normalizeStudentId(value) {
    if (typeof value !== "string" && typeof value !== "number")
        return null;
    const result = String(value).trim();
    return result ? result : null;
}
function readString(value) {
    return typeof value === "string" ? value.trim() : "";
}
/** Supports the same array, map, and legacy top-level class layouts as the UI. */
function readClassRoster(classData) {
    const rawStudents = classData.students;
    let entries = [];
    let studentsAreArray = false;
    if (Array.isArray(rawStudents)) {
        studentsAreArray = true;
        entries = rawStudents.map((student, index) => [String(index), student]);
    }
    else if (isRecord(rawStudents)) {
        entries = Object.entries(rawStudents);
    }
    else if (rawStudents === undefined || rawStudents === null) {
        entries = Object.entries(classData).filter(([key, value]) => !RESERVED_CLASS_KEYS.has(key) && isStudentRecord(value));
    }
    const roster = new Map();
    for (const [key, value] of entries) {
        if (!isRecord(value))
            continue;
        const keyIsArrayIndex = /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
        const stableMapKey = !studentsAreArray && !keyIsArrayIndex ? key : undefined;
        const id = normalizeStudentId(value.id ?? value.studentId ?? stableMapKey);
        if (!id || roster.has(id))
            continue;
        roster.set(id, value);
    }
    return roster;
}
function hasUsablePhone(student) {
    return ["fatherPhone", "parentPhone", "guardianPhone", "phone"]
        .some((field) => Boolean((0, whatsappService_1.normalizeWhatsAppPhone)(student[field])));
}
function getStudentPhone(student) {
    if (!hasExplicitOptIn(student))
        return null;
    const consentPhone = (0, whatsappService_1.normalizeWhatsAppPhone)(student.attendanceWhatsAppOptInPhone);
    return consentPhone;
}
function hasExplicitOptIn(student) {
    // Attendance consent must be explicit, timestamped and tied to a current saved contact.
    if (student.attendanceWhatsAppOptIn !== true)
        return false;
    if (typeof student.attendanceWhatsAppOptInAt !== "string" ||
        !student.attendanceWhatsAppOptInAt.trim())
        return false;
    const consentPhone = (0, whatsappService_1.normalizeWhatsAppPhone)(student.attendanceWhatsAppOptInPhone);
    if (!consentPhone)
        return false;
    return [student.phone, student.fatherPhone, student.parentPhone, student.guardianPhone]
        .some((value) => (0, whatsappService_1.normalizeWhatsAppPhone)(value) === consentPhone);
}
function profileDisplayValues(tenantData, settingsData) {
    const tenant = tenantData ?? {};
    const settings = settingsData ?? {};
    const nestedTenant = isRecord(tenant.profile) ? tenant.profile : {};
    const nestedSettings = isRecord(settings.profile) ? settings.profile : settings;
    const firstText = (...values) => {
        for (const value of values) {
            if (typeof value !== "string")
                continue;
            const text = value.trim();
            if (text && !/^(undefined|null|\[object Object\])$/i.test(text))
                return text;
        }
        return "";
    };
    return {
        teacherName: firstText(nestedSettings.name, nestedSettings.teacherName, settings.teacherName, tenant.teacherName, tenant.name, nestedTenant.name) || "Teacher",
        academyName: firstText(nestedSettings.schoolName, nestedSettings.academyName, settings.schoolName, settings.academyName, tenant.schoolName, tenant.academyName, nestedTenant.schoolName, nestedTenant.academyName) || "EduTrack",
    };
}
function stableJobId(tenantId, attendanceId, studentId) {
    return (0, node_crypto_1.createHash)("sha256")
        .update(`${tenantId}\u0000${attendanceId}\u0000${studentId}\u0000attendance_absent_v1`)
        .digest("hex");
}
exports.queueAbsentAttendanceNotifications = (0, firestore_2.onDocumentCreated)({
    document: "users/{tenantId}/attendance/{attendanceId}",
    region: REGION,
    retry: true,
}, async (event) => {
    const tenantId = event.params.tenantId;
    const attendanceId = event.params.attendanceId;
    const attendanceData = event.data?.data();
    if (!tenantId || !attendanceData || !isRecord(attendanceData)) {
        firebase_functions_1.logger.warn("Attendance notification job creation skipped: missing tenant or record data.", {
            attendanceId,
        });
        return;
    }
    const tenantProfile = await db.collection("users").doc(tenantId).get();
    const tenantUid = readString(tenantProfile.data()?.uid);
    if (!await (0, subscriptionEntitlements_1.hasActiveTeacherFeatureEntitlement)(tenantId, tenantUid, "attendance_alerts")) {
        firebase_functions_1.logger.info("Attendance notification job creation skipped: Academy permission is not granted.", { tenantId, attendanceId });
        return;
    }
    const classId = typeof attendanceData.classId === "string" ? attendanceData.classId.trim() : "";
    const date = typeof attendanceData.date === "string" ? attendanceData.date.trim() : "";
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
    const validDate = Boolean(parsedDate && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === date);
    if (!classId || !validDate || attendanceId !== `${classId}_${date}`) {
        firebase_functions_1.logger.warn("Attendance notification job creation skipped: invalid class/date/document ID.", {
            tenantId,
            attendanceId,
        });
        return;
    }
    if (attendanceData.isHoliday === true || String(attendanceData.status ?? "").trim().toLowerCase() === "holiday") {
        firebase_functions_1.logger.info("Attendance notification job creation skipped for a holiday.", { tenantId, attendanceId });
        return;
    }
    if (!isRecord(attendanceData.attendanceMap)) {
        firebase_functions_1.logger.warn("Attendance notification job creation skipped: attendanceMap is missing or invalid.", {
            tenantId,
            attendanceId,
        });
        return;
    }
    const attendanceEntries = Object.entries(attendanceData.attendanceMap);
    if (attendanceEntries.some(([, value]) => typeof value !== "boolean")) {
        firebase_functions_1.logger.warn("Attendance notification job creation skipped: attendanceMap contains non-boolean values.", {
            tenantId,
            attendanceId,
        });
        return;
    }
    const absentStudentIds = attendanceEntries
        .filter(([, isPresent]) => isPresent === false)
        .map(([studentId]) => studentId.trim())
        .filter(Boolean);
    if (absentStudentIds.length === 0) {
        firebase_functions_1.logger.info("No absent students found; no notification jobs created.", { tenantId, attendanceId });
        return;
    }
    const classRef = db.collection("users").doc(tenantId).collection("classes").doc(classId);
    const classSnapshot = await classRef.get();
    if (!classSnapshot.exists) {
        // A deleted/missing class is not retryable; do not create jobs for an unknown roster.
        firebase_functions_1.logger.warn("Attendance notification job creation skipped: class document does not exist.", {
            tenantId,
            attendanceId,
            classId,
        });
        return;
    }
    const classData = classSnapshot.data();
    if (!classData || !isRecord(classData)) {
        firebase_functions_1.logger.warn("Attendance notification job creation skipped: class document data is invalid.", {
            tenantId,
            attendanceId,
            classId,
        });
        return;
    }
    const className = String(classData.name ?? classData.className ?? classData.title ?? attendanceData.className ?? "").trim();
    const roster = readClassRoster(classData);
    const tenantRef = db.collection("users").doc(tenantId);
    let createdCount = 0;
    let alreadyExistedCount = 0;
    let skippedMissingStudentCount = 0;
    for (const studentId of absentStudentIds) {
        const student = roster.get(studentId);
        if (!student) {
            skippedMissingStudentCount++;
            firebase_functions_1.logger.warn("Absent student ID was not found in the current class roster; no job created.", {
                tenantId,
                attendanceId,
                classId,
                studentId,
            });
            continue;
        }
        const hasPhone = hasUsablePhone(student);
        const optedIn = hasExplicitOptIn(student);
        const status = !hasPhone
            ? "blocked_missing_phone"
            : !optedIn
                ? "blocked_missing_opt_in"
                : "queued";
        const jobId = stableJobId(tenantId, attendanceId, studentId);
        const jobRef = tenantRef.collection("whatsappNotificationJobs").doc(jobId);
        const job = {
            schemaVersion: 1,
            kind: "attendance_absent",
            tenantId,
            sourceAttendanceId: attendanceId,
            classId,
            className,
            attendanceDate: date,
            studentId,
            templateName: whatsappService_1.WHATSAPP_ATTENDANCE_TEMPLATE_NAME.value(),
            language: whatsappService_1.WHATSAPP_ATTENDANCE_TEMPLATE_LANGUAGE.value(),
            status,
            blockedReason: status.startsWith("blocked_") ? status.slice("blocked_".length) : null,
            attemptCount: 0,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        };
        const wasCreated = await db.runTransaction(async (transaction) => {
            const existing = await transaction.get(jobRef);
            if (existing.exists)
                return false;
            transaction.create(jobRef, job);
            return true;
        });
        if (wasCreated)
            createdCount++;
        else
            alreadyExistedCount++;
    }
    firebase_functions_1.logger.info("Attendance notification job creation completed. No WhatsApp messages were sent.", {
        tenantId,
        attendanceId,
        classId,
        absentCount: absentStudentIds.length,
        createdCount,
        alreadyExistedCount,
        skippedMissingStudentCount,
    });
});
/**
 * Sends a queued absent-attendance template from the trusted Firebase backend.
 * This trigger only handles jobs with status="queued"; all other statuses are ignored.
 * API acceptance is recorded as accepted_by_meta, not as confirmed delivery.
 */
exports.sendQueuedAbsentAttendanceNotification = (0, firestore_2.onDocumentWritten)({
    document: "users/{tenantId}/whatsappNotificationJobs/{jobId}",
    region: REGION,
    retry: false,
    secrets: [whatsappService_1.WHATSAPP_ACCESS_TOKEN],
}, async (event) => {
    const after = event.data?.after;
    if (!after?.exists)
        return;
    const initialJob = after.data();
    if (!isRecord(initialJob) || initialJob.status !== "queued")
        return;
    const tenantId = String(event.params.tenantId ?? "").trim();
    const tenantProfile = await db.collection("users").doc(tenantId).get();
    const tenantUid = readString(tenantProfile.data()?.uid);
    if (!await (0, subscriptionEntitlements_1.hasActiveTeacherFeatureEntitlement)(tenantId, tenantUid, "attendance_alerts")) {
        await after.ref.update({
            status: "blocked_permission",
            retrySafe: false,
            blockedReason: "academy_permission_not_granted_for_attendance_alerts",
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        return;
    }
    // Safety boundary: never call the external WhatsApp API from local emulators.
    const projectId = process.env.GCLOUD_PROJECT ??
        process.env.GOOGLE_CLOUD_PROJECT ??
        "";
    const runningInEmulator = process.env.FUNCTIONS_EMULATOR === "true" ||
        projectId.startsWith("demo-");
    if (runningInEmulator) {
        await after.ref.update({
            status: "blocked_emulator",
            retrySafe: false,
            blockedReason: "whatsapp_sending_disabled_in_emulator",
            lastError: "Local emulator test: external WhatsApp sending is disabled.",
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        firebase_functions_1.logger.info("WhatsApp sending skipped in Firebase Emulator; no external request was made.", {
            tenantId: String(event.params.tenantId ?? ""),
            jobId: String(event.params.jobId ?? ""),
        });
        return;
    }
    const jobRef = after.ref;
    const claimed = await db.runTransaction(async (transaction) => {
        const currentSnapshot = await transaction.get(jobRef);
        if (!currentSnapshot.exists)
            return false;
        const current = currentSnapshot.data();
        if (!current || current.status !== "queued")
            return false;
        transaction.update(jobRef, {
            status: "sending",
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
            attemptCount: firestore_1.FieldValue.increment(1),
        });
        return true;
    });
    if (!claimed)
        return;
    const jobId = String(event.params.jobId ?? "").trim();
    const classId = readString(initialJob.classId);
    const studentId = normalizeStudentId(initialJob.studentId);
    const attendanceDate = readString(initialJob.attendanceDate);
    let metaAcceptedMessageId = "";
    let sendApiInvoked = false;
    try {
        if (!tenantId || !classId || !studentId || !attendanceDate) {
            throw new Error("The queued attendance notification job is missing required identifiers.");
        }
        const classRef = db.collection("users").doc(tenantId).collection("classes").doc(classId);
        const tenantRef = db.collection("users").doc(tenantId);
        const [classSnapshot, tenantSnapshot, settingsSnapshot] = await Promise.all([
            classRef.get(),
            tenantRef.get(),
            tenantRef.collection("settings").doc("profile_data").get(),
        ]);
        if (!classSnapshot.exists)
            throw new Error("Class no longer exists; no WhatsApp message was sent.");
        const classData = classSnapshot.data();
        if (!classData || !isRecord(classData))
            throw new Error("Class roster is unavailable; no WhatsApp message was sent.");
        const student = readClassRoster(classData).get(studentId);
        if (!student)
            throw new Error("Student no longer exists in the class roster; no WhatsApp message was sent.");
        if (!hasExplicitOptIn(student)) {
            await jobRef.update({
                status: "blocked_missing_opt_in",
                blockedReason: "opt_in_revoked_before_send",
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            return;
        }
        const recipientPhone = getStudentPhone(student);
        if (!recipientPhone) {
            await jobRef.update({
                status: "blocked_missing_phone",
                blockedReason: "missing_or_invalid_guardian_whatsapp_number",
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            return;
        }
        const { teacherName, academyName } = profileDisplayValues(tenantSnapshot.data(), settingsSnapshot.data());
        const className = readString(classData.name) || readString(classData.className) || readString(classData.title) || readString(initialJob.className) || "Class";
        sendApiInvoked = true;
        const result = await (0, whatsappService_1.sendApprovedTextTemplate)("attendance", recipientPhone, {
            studentName: readString(student.name) || "Student",
            fatherName: readString(student.fatherName) || "Parent/Guardian",
            rollNo: readString(student.rollNo),
            className,
            date: attendanceDate,
            teacherName,
            academyName,
        });
        metaAcceptedMessageId = result.messageId;
        await jobRef.update({
            status: "accepted_by_meta",
            whatsappMessageId: result.messageId,
            acceptedAt: firestore_1.FieldValue.serverTimestamp(),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
            blockedReason: null,
            lastError: null,
        });
        firebase_functions_1.logger.info("Attendance notification accepted by WhatsApp Cloud API; delivery is not yet confirmed.", {
            tenantId,
            jobId,
            messageId: result.messageId,
        });
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown WhatsApp notification failure.";
        if (metaAcceptedMessageId) {
            firebase_functions_1.logger.error("Meta accepted the attendance message, but status persistence failed; leaving the job locked to reduce duplicate-send risk.", {
                tenantId,
                jobId,
                messageId: metaAcceptedMessageId,
                reason,
            });
            return;
        }
        firebase_functions_1.logger.error("Attendance notification could not be sent through WhatsApp Cloud API.", {
            tenantId,
            jobId,
            reason,
        });
        await jobRef.update({
            status: sendApiInvoked ? "unknown_outcome" : "failed",
            retrySafe: !sendApiInvoked,
            lastError: reason.slice(0, 500),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }).catch((updateError) => {
            firebase_functions_1.logger.error("Could not save the attendance notification failure status.", {
                tenantId,
                jobId,
                error: updateError instanceof Error ? updateError.message : "Unknown Firestore error",
            });
        });
    }
});
/**
 * Manually requeues an attendance job only when the previous failure is
 * explicitly marked safe to retry. Uncertain external-send outcomes are
 * never requeued by this callable.
 */
exports.retryFailedAbsentAttendanceNotification = (0, https_1.onCall)({ region: REGION }, async (request) => {
    const authUid = request.auth?.uid;
    const rawEmail = request.auth?.token.email;
    const authEmail = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
    // Validate the tenant document ID before using it as a Firestore path.
    const validEmail = !!authEmail &&
        !authEmail.includes("/") &&
        !authEmail.includes("\\") &&
        !/\s/.test(authEmail) &&
        authEmail.includes("@") &&
        !authEmail.startsWith("@") &&
        !authEmail.endsWith("@");
    if (!authUid || !validEmail) {
        throw new https_1.HttpsError("unauthenticated", "Sign in with your teacher account before retrying an attendance notification.");
    }
    if (!isRecord(request.data)) {
        throw new https_1.HttpsError("invalid-argument", "A notification job ID is required.");
    }
    const jobId = readString(request.data.jobId);
    if (!jobId || jobId.includes("/")) {
        throw new https_1.HttpsError("invalid-argument", "The notification job ID is invalid.");
    }
    // Tenant scope is derived from the verified sign-in email, never supplied
    // by the browser. Admin SDK access must be protected explicitly.
    const tenantRef = db.collection("users").doc(authEmail);
    const tenantSnapshot = await tenantRef.get();
    if (!tenantSnapshot.exists) {
        throw new https_1.HttpsError("permission-denied", "The teacher workspace could not be verified.");
    }
    const tenantData = tenantSnapshot.data();
    if (!(0, attendanceRetryPolicy_1.isOwnedActiveTeacherTenant)(tenantData, authUid, authEmail)) {
        throw new https_1.HttpsError("permission-denied", "You do not own this teacher workspace.");
    }
    if (!await (0, subscriptionEntitlements_1.hasActiveTeacherFeatureEntitlement)(authEmail, authUid, "attendance_alerts")) {
        throw new https_1.HttpsError("permission-denied", "Your Academy Admin has not granted Attendance Alerts permission.");
    }
    const jobRef = tenantRef
        .collection("whatsappNotificationJobs")
        .doc(jobId);
    // Only one concurrent caller can change a particular failed job to queued.
    const outcome = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(jobRef);
        if (!snapshot.exists)
            return "missing";
        const job = snapshot.data();
        if (!job)
            return "not_safe";
        if (job.status === "failed" &&
            job.retrySafe === true &&
            (0, attendanceRetryPolicy_1.hasReachedAttendanceRetryLimit)(job)) {
            return "max_attempts";
        }
        if (!(0, attendanceRetryPolicy_1.isSafeAttendanceRetryJob)(job)) {
            return "not_safe";
        }
        const attempts = (0, attendanceRetryPolicy_1.getAttendanceRetryAttemptCount)(job);
        transaction.update(jobRef, {
            status: "queued",
            retrySafe: false,
            lastError: null,
            retryQueuedAt: firestore_1.FieldValue.serverTimestamp(),
            retryQueuedBy: authUid,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        return "queued";
    });
    if (outcome === "missing") {
        throw new https_1.HttpsError("not-found", "The attendance notification job was not found.");
    }
    if (outcome === "max_attempts") {
        throw new https_1.HttpsError("resource-exhausted", "This notification has reached its retry limit. Review it before taking further action.");
    }
    if (outcome !== "queued") {
        throw new https_1.HttpsError("failed-precondition", "This job is not marked as safe to retry. Check its status before taking further action.");
    }
    firebase_functions_1.logger.info("A failed attendance notification was safely requeued.", {
        tenantId: authEmail,
        jobId,
        requestedBy: authUid,
    });
    return {
        success: true,
        status: "queued",
        jobId,
        message: "The eligible attendance notification was requeued; delivery is not yet confirmed.",
    };
});
/**
 * Lists only safely retryable attendance jobs for the authenticated,
 * active teacher's own tenant. Guardian contact data is never returned.
 */
exports.listRetryableAbsentAttendanceNotifications = (0, https_1.onCall)({ region: REGION }, async (request) => {
    const authUid = request.auth?.uid;
    const rawEmail = request.auth?.token.email;
    const authEmail = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
    const validEmail = !!authEmail &&
        !authEmail.includes("/") &&
        !authEmail.includes("\\") &&
        !/\s/.test(authEmail) &&
        authEmail.includes("@") &&
        !authEmail.startsWith("@") &&
        !authEmail.endsWith("@");
    if (!authUid || !validEmail) {
        throw new https_1.HttpsError("unauthenticated", "Sign in with your teacher account to view retryable notifications.");
    }
    const tenantRef = db.collection("users").doc(authEmail);
    const tenantSnapshot = await tenantRef.get();
    if (!tenantSnapshot.exists) {
        throw new https_1.HttpsError("permission-denied", "The teacher workspace could not be verified.");
    }
    const tenantData = tenantSnapshot.data();
    if (!(0, attendanceRetryPolicy_1.isOwnedActiveTeacherTenant)(tenantData, authUid, authEmail)) {
        throw new https_1.HttpsError("permission-denied", "You do not own an active teacher workspace.");
    }
    if (!await (0, subscriptionEntitlements_1.hasActiveTeacherFeatureEntitlement)(authEmail, authUid, "attendance_alerts")) {
        throw new https_1.HttpsError("permission-denied", "Your Academy Admin has not granted Attendance Alerts permission.");
    }
    // Query by status only to avoid requiring a composite Firestore index.
    // Filter retry safety and attempt limits on the server before returning.
    const jobsSnapshot = await tenantRef
        .collection("whatsappNotificationJobs")
        .where("status", "==", "failed")
        .limit(100)
        .get();
    const jobs = jobsSnapshot.docs
        .filter((doc) => (0, attendanceRetryPolicy_1.isSafeAttendanceRetryJob)(doc.data()))
        .slice(0, 25)
        .map((doc) => {
        const job = doc.data();
        const attempts = (0, attendanceRetryPolicy_1.getAttendanceRetryAttemptCount)(job);
        const createdAt = job.createdAt && typeof job.createdAt.toMillis === "function"
            ? job.createdAt.toMillis()
            : null;
        return {
            jobId: doc.id,
            status: "failed",
            attemptCount: attempts,
            createdAt,
            lastError: typeof job.lastError === "string"
                ? job.lastError.slice(0, 240)
                : null,
        };
    });
    return { success: true, jobs };
});
//# sourceMappingURL=attendanceNotifications.js.map