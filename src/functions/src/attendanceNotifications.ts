/**
 * Attendance notification pipeline:
 * 1) create idempotent Firestore jobs when attendance is first saved;
 * 2) send only queued jobs whose current guardian record still has explicit opt-in;
 * 3) record Meta API acceptance separately from confirmed delivery.
 */
import { createHash } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import {
  sendApprovedTextTemplate,
  normalizeWhatsAppPhone,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_ATTENDANCE_TEMPLATE_LANGUAGE,
  WHATSAPP_ATTENDANCE_TEMPLATE_NAME,
} from "./whatsappService";
import {
  getAttendanceRetryAttemptCount,
  hasReachedAttendanceRetryLimit,
  isOwnedActiveTeacherTenant,
  isSafeAttendanceRetryJob,
} from "./attendanceRetryPolicy";
import { hasActiveTeacherFeatureEntitlement } from "./subscriptionEntitlements";

if (!getApps().length) initializeApp();

const db = getFirestore();
const REGION = "us-central1";
const RESERVED_CLASS_KEYS = new Set([
  "id", "name", "code", "monthlyFee", "className", "title", "fee",
  "classFee", "createdAt", "createdDate", "date", "updatedAt", "students",
]);

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStudentRecord(value: unknown): value is RecordLike {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" || value.id !== undefined || value.studentId !== undefined;
}

function normalizeStudentId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).trim();
  return result ? result : null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Supports the same array, map, and legacy top-level class layouts as the UI. */
function readClassRoster(classData: RecordLike): Map<string, RecordLike> {
  const rawStudents = classData.students;
  let entries: Array<[string, unknown]> = [];
  let studentsAreArray = false;

  if (Array.isArray(rawStudents)) {
    studentsAreArray = true;
    entries = rawStudents.map((student, index) => [String(index), student]);
  } else if (isRecord(rawStudents)) {
    entries = Object.entries(rawStudents);
  } else if (rawStudents === undefined || rawStudents === null) {
    entries = Object.entries(classData).filter(([key, value]) =>
      !RESERVED_CLASS_KEYS.has(key) && isStudentRecord(value),
    );
  }

  const roster = new Map<string, RecordLike>();
  for (const [key, value] of entries) {
    if (!isRecord(value)) continue;
    const keyIsArrayIndex = /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
    const stableMapKey = !studentsAreArray && !keyIsArrayIndex ? key : undefined;
    const id = normalizeStudentId(value.id ?? value.studentId ?? stableMapKey);
    if (!id || roster.has(id)) continue;
    roster.set(id, value);
  }
  return roster;
}

function hasUsablePhone(student: RecordLike): boolean {
  return ["fatherPhone", "parentPhone", "guardianPhone", "phone"]
    .some((field) => Boolean(normalizeWhatsAppPhone(student[field])));
}

function getStudentPhone(student: RecordLike): string | null {
  if (!hasExplicitOptIn(student)) return null;

  const consentPhone = normalizeWhatsAppPhone(
    student.attendanceWhatsAppOptInPhone,
  );
  return consentPhone;
}

function hasExplicitOptIn(student: RecordLike): boolean {
  // Attendance consent must be explicit, timestamped and tied to a current saved contact.
  if (student.attendanceWhatsAppOptIn !== true) return false;
  if (
    typeof student.attendanceWhatsAppOptInAt !== "string" ||
    !student.attendanceWhatsAppOptInAt.trim()
  ) return false;

  const consentPhone = normalizeWhatsAppPhone(
    student.attendanceWhatsAppOptInPhone,
  );
  if (!consentPhone) return false;

  return [student.phone, student.fatherPhone, student.parentPhone, student.guardianPhone]
    .some((value) => normalizeWhatsAppPhone(value) === consentPhone);
}

function profileDisplayValues(tenantData: RecordLike | undefined, settingsData: RecordLike | undefined): {
  teacherName: string;
  academyName: string;
} {
  const tenant = tenantData ?? {};
  const settings = settingsData ?? {};
  const nestedTenant = isRecord(tenant.profile) ? tenant.profile : {};
  const nestedSettings = isRecord(settings.profile) ? settings.profile : settings;
  const firstText = (...values: unknown[]): string => {
    for (const value of values) {
      if (typeof value !== "string") continue;
      const text = value.trim();
      if (text && !/^(undefined|null|\[object Object\])$/i.test(text)) return text;
    }
    return "";
  };
  return {
    teacherName: firstText(nestedSettings.name, nestedSettings.teacherName, settings.teacherName, tenant.teacherName, tenant.name, nestedTenant.name) || "Teacher",
    academyName: firstText(nestedSettings.schoolName, nestedSettings.academyName, settings.schoolName, settings.academyName, tenant.schoolName, tenant.academyName, nestedTenant.schoolName, nestedTenant.academyName) || "EduTrack",
  };
}

function stableJobId(tenantId: string, attendanceId: string, studentId: string): string {
  return createHash("sha256")
    .update(`${tenantId}\u0000${attendanceId}\u0000${studentId}\u0000attendance_absent_v1`)
    .digest("hex");
}

export const queueAbsentAttendanceNotifications = onDocumentCreated(
  {
    document: "users/{tenantId}/attendance/{attendanceId}",
    region: REGION,
    retry: true,
  },
  async (event) => {
    const tenantId = event.params.tenantId;
    const attendanceId = event.params.attendanceId;
    const attendanceData = event.data?.data();

    if (!tenantId || !attendanceData || !isRecord(attendanceData)) {
      logger.warn("Attendance notification job creation skipped: missing tenant or record data.", {
        attendanceId,
      });
      return;
    }

    const tenantProfile = await db.collection("users").doc(tenantId).get();
    const tenantUid = readString(tenantProfile.data()?.uid);
    if (!await hasActiveTeacherFeatureEntitlement(tenantId, tenantUid, "attendance_alerts")) {
      logger.info("Attendance notification job creation skipped: Academy permission is not granted.", { tenantId, attendanceId });
      return;
    }

    const classId = typeof attendanceData.classId === "string" ? attendanceData.classId.trim() : "";
    const date = typeof attendanceData.date === "string" ? attendanceData.date.trim() : "";
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
    const validDate = Boolean(parsedDate && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === date);

    if (!classId || !validDate || attendanceId !== `${classId}_${date}`) {
      logger.warn("Attendance notification job creation skipped: invalid class/date/document ID.", {
        tenantId,
        attendanceId,
      });
      return;
    }

    if (attendanceData.isHoliday === true || String(attendanceData.status ?? "").trim().toLowerCase() === "holiday") {
      logger.info("Attendance notification job creation skipped for a holiday.", { tenantId, attendanceId });
      return;
    }

    if (!isRecord(attendanceData.attendanceMap)) {
      logger.warn("Attendance notification job creation skipped: attendanceMap is missing or invalid.", {
        tenantId,
        attendanceId,
      });
      return;
    }

    const attendanceEntries = Object.entries(attendanceData.attendanceMap);
    if (attendanceEntries.some(([, value]) => typeof value !== "boolean")) {
      logger.warn("Attendance notification job creation skipped: attendanceMap contains non-boolean values.", {
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
      logger.info("No absent students found; no notification jobs created.", { tenantId, attendanceId });
      return;
    }

    const classRef = db.collection("users").doc(tenantId).collection("classes").doc(classId);
    const classSnapshot = await classRef.get();
    if (!classSnapshot.exists) {
      // A deleted/missing class is not retryable; do not create jobs for an unknown roster.
      logger.warn("Attendance notification job creation skipped: class document does not exist.", {
        tenantId,
        attendanceId,
        classId,
      });
      return;
    }

    const classData = classSnapshot.data();
    if (!classData || !isRecord(classData)) {
      logger.warn("Attendance notification job creation skipped: class document data is invalid.", {
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
        logger.warn("Absent student ID was not found in the current class roster; no job created.", {
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
        templateName: WHATSAPP_ATTENDANCE_TEMPLATE_NAME.value(),
        language: WHATSAPP_ATTENDANCE_TEMPLATE_LANGUAGE.value(),
        status,
        blockedReason: status.startsWith("blocked_") ? status.slice("blocked_".length) : null,
        attemptCount: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      const wasCreated = await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(jobRef);
        if (existing.exists) return false;
        transaction.create(jobRef, job);
        return true;
      });

      if (wasCreated) createdCount++;
      else alreadyExistedCount++;
    }

    logger.info("Attendance notification job creation completed. No WhatsApp messages were sent.", {
      tenantId,
      attendanceId,
      classId,
      absentCount: absentStudentIds.length,
      createdCount,
      alreadyExistedCount,
      skippedMissingStudentCount,
    });
  },
);


/**
 * Sends a queued absent-attendance template from the trusted Firebase backend.
 * This trigger only handles jobs with status="queued"; all other statuses are ignored.
 * API acceptance is recorded as accepted_by_meta, not as confirmed delivery.
 */
export const sendQueuedAbsentAttendanceNotification = onDocumentWritten(
  {
    document: "users/{tenantId}/whatsappNotificationJobs/{jobId}",
    region: REGION,
    retry: false,
    secrets: [WHATSAPP_ACCESS_TOKEN],
  },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return;
    const initialJob = after.data();
    if (!isRecord(initialJob) || initialJob.status !== "queued") return;
    const tenantId = String(event.params.tenantId ?? "").trim();
    const tenantProfile = await db.collection("users").doc(tenantId).get();
    const tenantUid = readString(tenantProfile.data()?.uid);
    if (!await hasActiveTeacherFeatureEntitlement(tenantId, tenantUid, "attendance_alerts")) {
      await after.ref.update({
        status: "blocked_permission",
        retrySafe: false,
        blockedReason: "academy_permission_not_granted_for_attendance_alerts",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    // Safety boundary: never call the external WhatsApp API from local emulators.
    const projectId =
      process.env.GCLOUD_PROJECT ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      "";
    const runningInEmulator =
      process.env.FUNCTIONS_EMULATOR === "true" ||
      projectId.startsWith("demo-");

    if (runningInEmulator) {
      await after.ref.update({
        status: "blocked_emulator",
        retrySafe: false,
        blockedReason: "whatsapp_sending_disabled_in_emulator",
        lastError: "Local emulator test: external WhatsApp sending is disabled.",
        updatedAt: FieldValue.serverTimestamp(),
      });

      logger.info(
        "WhatsApp sending skipped in Firebase Emulator; no external request was made.",
        {
          tenantId: String(event.params.tenantId ?? ""),
          jobId: String(event.params.jobId ?? ""),
        },
      );
      return;
    }

    const jobRef = after.ref;
    const claimed = await db.runTransaction(async (transaction) => {
      const currentSnapshot = await transaction.get(jobRef);
      if (!currentSnapshot.exists) return false;
      const current = currentSnapshot.data();
      if (!current || current.status !== "queued") return false;
      transaction.update(jobRef, {
        status: "sending",
        updatedAt: FieldValue.serverTimestamp(),
        attemptCount: FieldValue.increment(1),
      });
      return true;
    });
    if (!claimed) return;

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
      if (!classSnapshot.exists) throw new Error("Class no longer exists; no WhatsApp message was sent.");
      const classData = classSnapshot.data();
      if (!classData || !isRecord(classData)) throw new Error("Class roster is unavailable; no WhatsApp message was sent.");
      const student = readClassRoster(classData).get(studentId);
      if (!student) throw new Error("Student no longer exists in the class roster; no WhatsApp message was sent.");
      if (!hasExplicitOptIn(student)) {
        await jobRef.update({
          status: "blocked_missing_opt_in",
          blockedReason: "opt_in_revoked_before_send",
          updatedAt: FieldValue.serverTimestamp(),
        });
        return;
      }

      const recipientPhone = getStudentPhone(student);
      if (!recipientPhone) {
        await jobRef.update({
          status: "blocked_missing_phone",
          blockedReason: "missing_or_invalid_guardian_whatsapp_number",
          updatedAt: FieldValue.serverTimestamp(),
        });
        return;
      }

      const { teacherName, academyName } = profileDisplayValues(
        tenantSnapshot.data() as RecordLike | undefined,
        settingsSnapshot.data() as RecordLike | undefined,
      );
      const className = readString(classData.name) || readString(classData.className) || readString(classData.title) || readString(initialJob.className) || "Class";
      sendApiInvoked = true;
      const result = await sendApprovedTextTemplate("attendance", recipientPhone, {
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
        acceptedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        blockedReason: null,
        lastError: null,
      });
      logger.info("Attendance notification accepted by WhatsApp Cloud API; delivery is not yet confirmed.", {
        tenantId,
        jobId,
        messageId: result.messageId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown WhatsApp notification failure.";
      if (metaAcceptedMessageId) {
        logger.error("Meta accepted the attendance message, but status persistence failed; leaving the job locked to reduce duplicate-send risk.", {
          tenantId,
          jobId,
          messageId: metaAcceptedMessageId,
          reason,
        });
        return;
      }
      logger.error("Attendance notification could not be sent through WhatsApp Cloud API.", {
        tenantId,
        jobId,
        reason,
      });
      await jobRef.update({
        status: sendApiInvoked ? "unknown_outcome" : "failed",
        retrySafe: !sendApiInvoked,
        lastError: reason.slice(0, 500),
        updatedAt: FieldValue.serverTimestamp(),
      }).catch((updateError) => {
        logger.error("Could not save the attendance notification failure status.", {
          tenantId,
          jobId,
          error: updateError instanceof Error ? updateError.message : "Unknown Firestore error",
        });
      });
    }
  },
);


/**
 * Manually requeues an attendance job only when the previous failure is
 * explicitly marked safe to retry. Uncertain external-send outcomes are
 * never requeued by this callable.
 */
export const retryFailedAbsentAttendanceNotification = onCall(
  { region: REGION },
  async (request) => {
    const authUid = request.auth?.uid;
    const rawEmail = request.auth?.token.email;
    const authEmail =
      typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";

    // Validate the tenant document ID before using it as a Firestore path.
    const validEmail =
      !!authEmail &&
      !authEmail.includes("/") &&
      !authEmail.includes("\\") &&
      !/\s/.test(authEmail) &&
      authEmail.includes("@") &&
      !authEmail.startsWith("@") &&
      !authEmail.endsWith("@");

    if (!authUid || !validEmail) {
      throw new HttpsError(
        "unauthenticated",
        "Sign in with your teacher account before retrying an attendance notification.",
      );
    }

    if (!isRecord(request.data)) {
      throw new HttpsError("invalid-argument", "A notification job ID is required.");
    }

    const jobId = readString(request.data.jobId);
    if (!jobId || jobId.includes("/")) {
      throw new HttpsError("invalid-argument", "The notification job ID is invalid.");
    }

    // Tenant scope is derived from the verified sign-in email, never supplied
    // by the browser. Admin SDK access must be protected explicitly.
    const tenantRef = db.collection("users").doc(authEmail);
    const tenantSnapshot = await tenantRef.get();

    if (!tenantSnapshot.exists) {
      throw new HttpsError("permission-denied", "The teacher workspace could not be verified.");
    }

    const tenantData = tenantSnapshot.data();
    if (
      !isOwnedActiveTeacherTenant(tenantData, authUid, authEmail)
    ) {
      throw new HttpsError("permission-denied", "You do not own this teacher workspace.");
    }
    if (!await hasActiveTeacherFeatureEntitlement(authEmail, authUid, "attendance_alerts")) {
      throw new HttpsError("permission-denied", "Your Academy Admin has not granted Attendance Alerts permission.");
    }

    const jobRef = tenantRef
      .collection("whatsappNotificationJobs")
      .doc(jobId);

    // Only one concurrent caller can change a particular failed job to queued.
    const outcome = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(jobRef);

      if (!snapshot.exists) return "missing" as const;

      const job = snapshot.data();
      if (!job) return "not_safe" as const;

      if (
        job.status === "failed" &&
        job.retrySafe === true &&
        hasReachedAttendanceRetryLimit(job)
      ) {
        return "max_attempts" as const;
      }

      if (!isSafeAttendanceRetryJob(job)) {
        return "not_safe" as const;
      }

      const attempts = getAttendanceRetryAttemptCount(job);

      transaction.update(jobRef, {
        status: "queued",
        retrySafe: false,
        lastError: null,
        retryQueuedAt: FieldValue.serverTimestamp(),
        retryQueuedBy: authUid,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return "queued" as const;
    });

    if (outcome === "missing") {
      throw new HttpsError("not-found", "The attendance notification job was not found.");
    }

    if (outcome === "max_attempts") {
      throw new HttpsError(
        "resource-exhausted",
        "This notification has reached its retry limit. Review it before taking further action.",
      );
    }

    if (outcome !== "queued") {
      throw new HttpsError(
        "failed-precondition",
        "This job is not marked as safe to retry. Check its status before taking further action.",
      );
    }

    logger.info("A failed attendance notification was safely requeued.", {
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
  },
);


/**
 * Lists only safely retryable attendance jobs for the authenticated,
 * active teacher's own tenant. Guardian contact data is never returned.
 */
export const listRetryableAbsentAttendanceNotifications = onCall(
  { region: REGION },
  async (request) => {
    const authUid = request.auth?.uid;
    const rawEmail = request.auth?.token.email;
    const authEmail =
      typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";

    const validEmail =
      !!authEmail &&
      !authEmail.includes("/") &&
      !authEmail.includes("\\") &&
      !/\s/.test(authEmail) &&
      authEmail.includes("@") &&
      !authEmail.startsWith("@") &&
      !authEmail.endsWith("@");

    if (!authUid || !validEmail) {
      throw new HttpsError(
        "unauthenticated",
        "Sign in with your teacher account to view retryable notifications.",
      );
    }

    const tenantRef = db.collection("users").doc(authEmail);
    const tenantSnapshot = await tenantRef.get();

    if (!tenantSnapshot.exists) {
      throw new HttpsError(
        "permission-denied",
        "The teacher workspace could not be verified.",
      );
    }

    const tenantData = tenantSnapshot.data();
    if (
      !isOwnedActiveTeacherTenant(tenantData, authUid, authEmail)
    ) {
      throw new HttpsError(
        "permission-denied",
        "You do not own an active teacher workspace.",
      );
    }
    if (!await hasActiveTeacherFeatureEntitlement(authEmail, authUid, "attendance_alerts")) {
      throw new HttpsError("permission-denied", "Your Academy Admin has not granted Attendance Alerts permission.");
    }

    // Query by status only to avoid requiring a composite Firestore index.
    // Filter retry safety and attempt limits on the server before returning.
    const jobsSnapshot = await tenantRef
      .collection("whatsappNotificationJobs")
      .where("status", "==", "failed")
      .limit(100)
      .get();

    const jobs = jobsSnapshot.docs
      .filter((doc) => isSafeAttendanceRetryJob(doc.data()))
      .slice(0, 25)
      .map((doc) => {
        const job = doc.data();
        const attempts = getAttendanceRetryAttemptCount(job);

        const createdAt =
          job.createdAt && typeof job.createdAt.toMillis === "function"
            ? job.createdAt.toMillis()
            : null;

        return {
          jobId: doc.id,
          status: "failed",
          attemptCount: attempts,
          createdAt,
          lastError:
            typeof job.lastError === "string"
              ? job.lastError.slice(0, 240)
              : null,
        };
      });

    return { success: true, jobs };
  },
);
