import {
  isMonthlyReportWhatsAppEnabled,
  MONTHLY_REPORT_WHATSAPP_DISABLED_MESSAGE,
} from "./monthlyReportFeature.js";
import { calculateMonthlyReportContentHash } from "./monthlyReportHash.js";
import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import {
  verifyTeacherRequest,
  TeacherApiAuthError,
  type TeacherApiRequest,
} from "./teacherAuth.js";

type RecordLike = Record<string, unknown>;

export class MonthlyReportPreparationError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MonthlyReportPreparationError";
  }
}

function isRecord(value: unknown): value is RecordLike {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStudentId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).trim();
  return result && !result.includes("/") ? result : null;
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

function validMonthKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    return false;
  }
  const [year, month] = value.split("-").map(Number);
  return year >= 2000 && year <= 2200 && month >= 1 && month <= 12;
}

const RESERVED_CLASS_KEYS = new Set([
  "id", "name", "code", "monthlyFee", "className", "title", "fee",
  "classFee", "createdAt", "createdDate", "date", "updatedAt", "students",
]);

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
      !RESERVED_CLASS_KEYS.has(key) &&
      isRecord(value) &&
      (typeof value.name === "string" ||
        value.id !== undefined ||
        value.studentId !== undefined),
    );
  }

  const roster = new Map<string, RecordLike>();

  for (const [key, value] of entries) {
    if (!isRecord(value)) continue;

    const arrayIndex = /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
    const stableKey = !studentsAreArray && !arrayIndex ? key : undefined;
    const studentId = normalizeStudentId(value.id ?? value.studentId ?? stableKey);

    if (studentId && !roster.has(studentId)) roster.set(studentId, value);
  }

  return roster;
}

function chooseGuardianPhone(student: RecordLike): string | null {
  const consentPhone = normalizePhone(student.parentWhatsAppOptInPhone);
  if (!consentPhone) return null;

  const currentPhones = [
    student.phone,
    student.fatherPhone,
    student.parentPhone,
    student.guardianPhone,
  ].map(normalizePhone).filter((phone): phone is string => Boolean(phone));

  return currentPhones.includes(consentPhone) ? consentPhone : null;
}

function reportContentHash(
  report: RecordLike,
  className: string,
  student: RecordLike,
): string {
  return calculateMonthlyReportContentHash(report, className, student);
}

function stableMonthlyJobId(
  tenantId: string,
  classId: string,
  studentId: string,
  monthKey: string,
): string {
  return createHash("sha256")
    .update(`${tenantId}\u0000monthly_report_pdf_v1\u0000${classId}\u0000${studentId}\u0000${monthKey}`)
    .digest("hex");
}

function isSendingLocked(report: RecordLike): boolean {
  return report.whatsAppStatus === "sending" ||
    report.whatsAppStatus === "unknown_outcome" ||
    report.whatsAppStatus === "operator_confirmed_sent";
}

export async function prepareMonthlyReportNotification(
  request: TeacherApiRequest & { body?: unknown },
) {
  const actor = await verifyTeacherRequest(request);

  if (!isMonthlyReportWhatsAppEnabled()) {
    throw new MonthlyReportPreparationError(
      503,
      MONTHLY_REPORT_WHATSAPP_DISABLED_MESSAGE,
    );
  }

  if (!isRecord(request.body)) {
    throw new MonthlyReportPreparationError(400, "A valid JSON request body is required.");
  }

  const classId = clean(request.body.classId);
  const studentId = normalizeStudentId(request.body.studentId);
  const monthKey = request.body.monthKey;
  const source = request.body.source === "automatic" ? "automatic" : "manual";

  if (
    !classId ||
    classId.includes("/") ||
    !studentId ||
    !validMonthKey(monthKey)
  ) {
    throw new MonthlyReportPreparationError(400, "Class, student, or report month is invalid.");
  }

  const classRef = actor.tenantRef.collection("classes").doc(classId);
  const reportRef = classRef.collection("reports").doc(`${studentId}_${monthKey}`);

  const [classSnapshot, reportSnapshot] = await Promise.all([
    classRef.get(),
    reportRef.get(),
  ]);

  if (!classSnapshot.exists) {
    throw new MonthlyReportPreparationError(404, "The selected class no longer exists.");
  }

  if (!reportSnapshot.exists) {
    throw new MonthlyReportPreparationError(404, "Save the student's monthly report before preparing WhatsApp delivery.");
  }

  const classData = classSnapshot.data();
  const report = reportSnapshot.data();

  if (!classData || !report || !isRecord(classData) || !isRecord(report)) {
    throw new MonthlyReportPreparationError(409, "The class roster or monthly report is invalid.");
  }

  if (
    clean(report.studentId) !== studentId ||
    clean(report.monthKey) !== monthKey ||
    (clean(report.classId) && clean(report.classId) !== classId)
  ) {
    throw new MonthlyReportPreparationError(409, "The saved report does not match the selected student, class, and month.");
  }

  if (!clean(report.category)) {
    throw new MonthlyReportPreparationError(409, "Save the student's monthly rating before preparing the report.");
  }

  if (source === "automatic" && clean(report.mode) !== "automatic") {
    throw new MonthlyReportPreparationError(409, "This report is not marked for automatic preparation.");
  }

  const student = readClassRoster(classData).get(studentId);

  if (!student) {
    throw new MonthlyReportPreparationError(404, "The student was not found in the current class roster.");
  }

  if (student.parentWhatsAppOptIn !== true || !clean(student.parentWhatsAppOptInAt) || !chooseGuardianPhone(student)) {
    throw new MonthlyReportPreparationError(409, "Current guardian WhatsApp consent for the saved contact number is required. No message was sent.");
  }

  if (clean(report.lastWhatsAppAcceptedMonth) === monthKey) {
    throw new MonthlyReportPreparationError(409, "This student's report has already been accepted for this month.");
  }

  if (isSendingLocked(report)) {
    throw new MonthlyReportPreparationError(409, "A previous WhatsApp request is still in progress or has an unknown outcome.");
  }

  if (report.whatsAppStatus === "failed" && report.whatsAppRetrySafe !== true) {
    throw new MonthlyReportPreparationError(409, "The previous failure is not marked safe to retry.");
  }

  const className = clean(classData.name) ||
    clean(classData.className) ||
    clean(classData.title) ||
    "Class";
  const contentHash = reportContentHash(report, className, student);
  const jobId = stableMonthlyJobId(actor.email, classId, studentId, monthKey);
  const lockId = createHash("sha256")
    .update(`${actor.email}\u0000monthly_report_whatsapp_v1\u0000${classId}\u0000${studentId}\u0000${monthKey}`)
    .digest("hex");
  const oneTimeLockRef = actor.tenantRef.collection("whatsappOneTimeLocks").doc(`monthly_${lockId}`);
  const jobRef = actor.tenantRef.collection("whatsappNotificationJobs").doc(jobId);

  const outcome = await actor.db.runTransaction(async (transaction) => {
    const [latestReportSnapshot, jobSnapshot, oneTimeLockSnapshot] = await Promise.all([
      transaction.get(reportRef),
      transaction.get(jobRef),
      transaction.get(oneTimeLockRef),
    ]);

    if (!latestReportSnapshot.exists) return "missing_report" as const;

    const latestReport = latestReportSnapshot.data() ?? {};
    const existingJob = jobSnapshot.data() ?? {};
    const permanentLock = oneTimeLockSnapshot.data() ?? {};

    // A report/month can have only one permanently locked WhatsApp payload.
    if (oneTimeLockSnapshot.exists &&
        (permanentLock.jobId !== jobId || permanentLock.contentHash !== contentHash)) {
      return "one_time_locked" as const;
    }
    // A content edit must not manufacture a new job ID and a second message.
    if (latestReport.whatsAppOneTimeLockAt &&
        (clean(latestReport.whatsAppOneTimeLockJobId) !== jobId ||
         clean(latestReport.whatsAppOneTimeLockContentHash) !== contentHash)) {
      return "one_time_locked" as const;
    }
    if (jobSnapshot.exists && typeof existingJob.contentHash === "string" &&
        existingJob.contentHash && existingJob.contentHash !== contentHash) {
      return "one_time_locked" as const;
    }

    if (clean(latestReport.lastWhatsAppAcceptedMonth) === monthKey) {
      return "already_accepted" as const;
    }

    if (isSendingLocked(latestReport)) return "locked" as const;

    if (
      latestReport.whatsAppStatus === "failed" &&
      latestReport.whatsAppRetrySafe !== true
    ) {
      return "not_safe" as const;
    }

    if (
      jobSnapshot.exists &&
      existingJob.status === "prepared_for_vercel" &&
      existingJob.contentHash === contentHash
    ) {
      if (!oneTimeLockSnapshot.exists) {
        transaction.create(oneTimeLockRef, {
          kind: "monthly_report_whatsapp",
          tenantId: actor.email,
          teacherUid: actor.uid,
          classId,
          studentId,
          monthKey,
          jobId,
          contentHash,
          lockedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      transaction.update(reportRef, {
        whatsAppOneTimeLockAt: latestReport.whatsAppOneTimeLockAt ?? FieldValue.serverTimestamp(),
        whatsAppOneTimeLockJobId: jobId,
        whatsAppOneTimeLockContentHash: contentHash,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return "already_prepared" as const;
    }

    if (
      jobSnapshot.exists &&
      jobSnapshot.data()?.status === "failed" &&
      jobSnapshot.data()?.retrySafe !== true
    ) {
      return "not_safe" as const;
    }

    if (!oneTimeLockSnapshot.exists) {
      transaction.create(oneTimeLockRef, {
        kind: "monthly_report_whatsapp",
        tenantId: actor.email,
        teacherUid: actor.uid,
        classId,
        studentId,
        monthKey,
        jobId,
        contentHash,
        lockedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    transaction.set(jobRef, {
      schemaVersion: 1,
      kind: "monthly_report_pdf",
      provider: "postabi",
      dispatchEnabled: false,
      tenantId: actor.email,
      classId,
      className,
      studentId,
      monthKey,
      source,
      status: "prepared_for_vercel",
      contentHash,
      attemptCount: Number.isFinite(jobSnapshot.data()?.attemptCount)
        ? jobSnapshot.data()?.attemptCount
        : 0,
      retrySafe: false,
      createdAt: jobSnapshot.exists
        ? jobSnapshot.data()?.createdAt ?? FieldValue.serverTimestamp()
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    transaction.update(reportRef, {
      whatsAppStatus: "prepared_for_vercel",
      whatsAppProvider: "postabi",
      whatsAppRetrySafe: false,
      whatsAppAttemptHash: contentHash,
      whatsAppJobId: jobId,
      whatsAppOneTimeLockAt: latestReport.whatsAppOneTimeLockAt ?? FieldValue.serverTimestamp(),
      whatsAppOneTimeLockJobId: jobId,
      whatsAppOneTimeLockContentHash: contentHash,
      whatsAppPreparedAt: FieldValue.serverTimestamp(),
      whatsAppLastError: null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return "prepared" as const;
  });

  if (outcome === "missing_report") {
    throw new MonthlyReportPreparationError(404, "The saved monthly report no longer exists.");
  }

  if (outcome === "already_accepted") {
    throw new MonthlyReportPreparationError(409, "This monthly report was already accepted.");
  }

  if (outcome === "one_time_locked") {
    throw new MonthlyReportPreparationError(409, "This report/month already has a permanent WhatsApp one-time lock. Editing its contents cannot create a second broadcast.");
  }

  if (outcome === "locked") {
    throw new MonthlyReportPreparationError(409, "The previous request is still sending or has an unknown outcome.");
  }

  if (outcome === "not_safe") {
    throw new MonthlyReportPreparationError(409, "This report is not currently safe to retry.");
  }

  return {
    success: true,
    status: outcome === "already_prepared" ? "already_prepared" : "prepared_for_vercel",
    jobId,
    message: outcome === "already_prepared"
      ? "This monthly report is already prepared. No WhatsApp message was sent."
      : "Monthly report notification job prepared. PDF delivery has not been activated.",
    messageSent: false,
    pdfDelivered: false,
  };
}

export function sendMonthlyReportPreparationApiError(
  res: {
    status(code: number): { json(data: unknown): unknown };
  },
  error: unknown,
) {
  if (
    error instanceof TeacherApiAuthError ||
    error instanceof MonthlyReportPreparationError
  ) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
    });
  }

  console.error("[MonthlyReportPreparation] Request failed.", error);

  return res.status(500).json({
    success: false,
    error: "The monthly report notification could not be prepared.",
  });
}
