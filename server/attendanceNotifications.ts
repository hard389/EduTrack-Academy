import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import {
  verifyTeacherRequest,
  TeacherApiAuthError,
  type TeacherApiRequest,
} from "./teacherAuth.js";
import { getAttendanceDispatchReadiness } from "./attendanceDispatchReadiness.js";
import { getFailedExpiryMillis, isSafeAttendanceRetryJob } from "./whatsappFailedJobDomain.mjs";

type RecordLike = Record<string, unknown>;

export class AttendanceQueueError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AttendanceQueueError";
  }
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStudentId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value).trim();
  return id && !id.includes("/") ? id : null;
}

function normalizePhone(value: unknown): string | null {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) {
    digits = `92${digits.slice(1)}`;
  } else if (digits.length === 10) {
    digits = `92${digits}`;
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

const RESERVED_CLASS_KEYS = new Set([
  "id", "name", "code", "monthlyFee", "className", "title", "fee",
  "classFee", "createdAt", "createdDate", "date", "updatedAt", "students",
]);

function isStudentRecord(value: unknown): value is RecordLike {
  return isRecord(value) &&
    (typeof value.name === "string" ||
      value.id !== undefined ||
      value.studentId !== undefined);
}

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
    const arrayIndex = /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
    const stableKey = !studentsAreArray && !arrayIndex ? key : undefined;
    const id = normalizeStudentId(value.id ?? value.studentId ?? stableKey);
    if (id && !roster.has(id)) roster.set(id, value);
  }

  return roster;
}

function hasExplicitOptIn(student: RecordLike): boolean {
  if (student.attendanceWhatsAppOptIn !== true) return false;
  if (
    typeof student.attendanceWhatsAppOptInAt !== "string" ||
    !student.attendanceWhatsAppOptInAt.trim()
  ) return false;

  const consentPhone = normalizePhone(student.attendanceWhatsAppOptInPhone);
  if (!consentPhone) return false;

  return ["phone", "fatherPhone", "parentPhone", "guardianPhone"]
    .some((field) => normalizePhone(student[field]) === consentPhone);
}

function hasUsablePhone(student: RecordLike): boolean {
  return ["fatherPhone", "parentPhone", "guardianPhone", "phone"]
    .some((field) => Boolean(normalizePhone(student[field])));
}

function stableJobId(
  tenantId: string,
  attendanceId: string,
  studentId: string,
): string {
  return createHash("sha256")
    .update(`${tenantId}\u0000${attendanceId}\u0000${studentId}\u0000attendance_absent_v1`)
    .digest("hex");
}

function isValidAttendanceDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

export async function createAttendanceNotificationJobs(
  request: TeacherApiRequest & { body?: unknown },
) {
  const actor = await verifyTeacherRequest(request);

  if (!isRecord(request.body)) {
    throw new AttendanceQueueError(400, "A valid JSON request body is required.");
  }

  const classId = clean(request.body.classId);
  const date = request.body.date;

  if (
    !classId ||
    classId.includes("/") ||
    !isValidAttendanceDate(date)
  ) {
    throw new AttendanceQueueError(400, "Class ID or attendance date is invalid.");
  }

  const attendanceId = `${classId}_${date}`;
  const attendanceRef = actor.tenantRef.collection("attendance").doc(attendanceId);
  const classRef = actor.tenantRef.collection("classes").doc(classId);

  const [attendanceSnapshot, classSnapshot] = await Promise.all([
    attendanceRef.get(),
    classRef.get(),
  ]);

  if (!attendanceSnapshot.exists) {
    throw new AttendanceQueueError(404, "Saved attendance record was not found.");
  }

  if (!classSnapshot.exists) {
    throw new AttendanceQueueError(404, "The selected class no longer exists.");
  }

  const attendance = attendanceSnapshot.data();
  const classData = classSnapshot.data();

  if (!attendance || !classData || !isRecord(attendance) || !isRecord(classData)) {
    throw new AttendanceQueueError(409, "Attendance or class data is invalid.");
  }

  if (
    attendance.classId !== classId ||
    attendance.date !== date ||
    attendanceId !== `${clean(attendance.classId)}_${clean(attendance.date)}`
  ) {
    throw new AttendanceQueueError(409, "Attendance record does not match the requested class and date.");
  }

  if (
    attendance.isHoliday === true ||
    clean(attendance.status).toLowerCase() === "holiday"
  ) {
    return {
      success: true,
      preparedCount: 0,
      blockedCount: 0,
      alreadyExistedCount: 0,
      skippedMissingStudentCount: 0,
      message: "Holiday attendance does not create notification jobs.",
      messageSent: false,
    };
  }

  if (!isRecord(attendance.attendanceMap)) {
    throw new AttendanceQueueError(409, "Attendance map is missing or invalid.");
  }

  const entries = Object.entries(attendance.attendanceMap);
  if (entries.some(([, value]) => typeof value !== "boolean")) {
    throw new AttendanceQueueError(409, "Attendance map contains invalid status values.");
  }

  const absentStudentIds = [...new Set(
    entries
      .filter(([, present]) => present === false)
      .map(([id]) => id.trim())
      .filter((id) => id && !id.includes("/")),
  )];

  if (absentStudentIds.length === 0) {
    return {
      success: true,
      preparedCount: 0,
      blockedCount: 0,
      alreadyExistedCount: 0,
      skippedMissingStudentCount: 0,
      message: "No absent students were found. No notification jobs were created.",
      messageSent: false,
    };
  }

  const roster = readClassRoster(classData);
  const className = clean(classData.name) ||
    clean(classData.className) ||
    clean(classData.title) ||
    clean(attendance.className) ||
    "Class";

  let preparedCount = 0;
  let blockedCount = 0;
  let alreadyExistedCount = 0;
  let skippedMissingStudentCount = 0;
  const preparedJobIds: string[] = [];

  for (const studentId of absentStudentIds) {
    const student = roster.get(studentId);

    if (!student) {
      skippedMissingStudentCount++;
      continue;
    }

    const hasPhone = hasUsablePhone(student);
    const optedIn = hasExplicitOptIn(student);

    const status = !hasPhone
      ? "blocked_missing_phone"
      : !optedIn
        ? "blocked_missing_opt_in"
        : "prepared_for_vercel";

    const jobId = stableJobId(actor.email, attendanceId, studentId);
    const jobRef = actor.tenantRef.collection("whatsappNotificationJobs").doc(jobId);

    const created = await actor.db.runTransaction(async (transaction) => {
      const existing = await transaction.get(jobRef);
      if (existing.exists) return false;

      transaction.create(jobRef, {
        schemaVersion: 2,
        kind: "attendance_absent",
        provider: "postabi",
        dispatchEnabled: false,
        tenantId: actor.email,
        sourceAttendanceId: attendanceId,
        classId,
        className,
        attendanceDate: date,
        studentId,
        status,
        blockedReason: status.startsWith("blocked_")
          ? status.slice("blocked_".length)
          : null,
        attemptCount: 0,
        retrySafe: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return true;
    });

    if (!created) {
      alreadyExistedCount++;
    } else if (status === "prepared_for_vercel") {
      preparedCount++;
      preparedJobIds.push(jobId);
    } else {
      blockedCount++;
    }
  }

  const whatsappSettingsSnapshot = await actor.db
    .collection("platformSettings")
    .doc("whatsapp")
    .get();

  const whatsappSettings = whatsappSettingsSnapshot.data() ?? {};
  const dispatchReadiness = await getAttendanceDispatchReadiness(
    actor.db,
    actor.uid,
    whatsappSettings,
  );

  return {
    success: true,
    dispatchAvailable: dispatchReadiness.available,
    dispatchBlockers: dispatchReadiness.blockers,
    preparedCount,
    preparedJobIds,
    blockedCount,
    alreadyExistedCount,
    skippedMissingStudentCount,
    message: "Attendance notification jobs prepared. Newly created eligible job IDs are returned for controlled dispatch.",
    messageSent: false,
  };
}

export function sendAttendanceQueueApiError(
  res: {
    status(code: number): { json(data: unknown): unknown };
  },
  error: unknown,
) {
  if (
    error instanceof TeacherApiAuthError ||
    error instanceof AttendanceQueueError
  ) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
    });
  }

  console.error("[AttendanceQueue] Request failed.", error);
  return res.status(500).json({
    success: false,
    error: "Attendance notification jobs could not be prepared.",
  });
}


function getRetryAttemptCount(job: RecordLike): number {
  const count = job.attemptCount;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

function isSafeRetryJob(job: RecordLike): boolean {
  const attempts = getRetryAttemptCount(job);
  return attempts >= 0 && attempts < 3 && isSafeAttendanceRetryJob(job, Date.now());
}

export async function listRetryableAttendanceJobs(
  request: TeacherApiRequest,
) {
  const actor = await verifyTeacherRequest(request);

  const snapshot = await actor.tenantRef
    .collection("whatsappNotificationJobs")
    .where("status", "==", "failed")
    .limit(100)
    .get();

  const jobs = snapshot.docs
    .filter((doc) => {
      const data = doc.data();
      return isSafeRetryJob(data) &&
        data.tenantId === actor.email;
    })
    .slice(0, 25)
    .map((doc) => {
      const job = doc.data();
      const createdAt =
        job.createdAt && typeof job.createdAt.toMillis === "function"
          ? job.createdAt.toMillis()
          : null;

      return {
        jobId: doc.id,
        status: "failed" as const,
        attemptCount: getRetryAttemptCount(job),
        createdAt,
        lastError: typeof job.lastError === "string"
          ? job.lastError.slice(0, 240)
          : null,
        expiresAt: getFailedExpiryMillis(job),
      };
    });

  return { success: true, jobs };
}

export async function retryAttendanceJob(
  request: TeacherApiRequest & { body?: unknown },
) {
  const actor = await verifyTeacherRequest(request);

  if (!isRecord(request.body)) {
    throw new AttendanceQueueError(400, "A valid JSON request body is required.");
  }

  const jobId = clean(request.body.jobId);

  if (!jobId || jobId.includes("/") || jobId.length > 128) {
    throw new AttendanceQueueError(400, "The notification job ID is invalid.");
  }

  const jobRef = actor.tenantRef
    .collection("whatsappNotificationJobs")
    .doc(jobId);

  const outcome = await actor.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(jobRef);

    if (!snapshot.exists) return "missing" as const;

    const job = snapshot.data();
    if (!job || job.tenantId !== actor.email) return "not_safe" as const;

    const attempts = getRetryAttemptCount(job);

    if (
      job.kind === "attendance_absent" &&
      job.status === "failed" &&
      job.retrySafe === true &&
      attempts >= 3
    ) {
      return "max_attempts" as const;
    }

    if (!isSafeRetryJob(job)) return "not_safe" as const;

    transaction.update(jobRef, {
      status: "prepared_for_vercel",
      provider: "postabi",
      dispatchEnabled: false,
      retrySafe: false,
      lastError: null,
      failedAt: FieldValue.delete(),
      expiresAt: FieldValue.delete(),
      retryQueuedAt: FieldValue.serverTimestamp(),
      retryQueuedBy: actor.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return "prepared" as const;
  });

  if (outcome === "missing") {
    throw new AttendanceQueueError(404, "The attendance notification job was not found.");
  }

  if (outcome === "max_attempts") {
    throw new AttendanceQueueError(429, "This notification has reached its retry limit.");
  }

  if (outcome !== "prepared") {
    throw new AttendanceQueueError(
      409,
      "This job is not verified as safe to retry. Review its status before taking further action.",
    );
  }

  return {
    success: true,
    status: "prepared_for_vercel",
    jobId,
    message: "The notification was prepared for the Vercel dispatch pipeline. No WhatsApp message was sent.",
    messageSent: false,
  };
}
