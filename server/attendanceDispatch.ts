import { hasAttendanceDispatchAuthorization } from "./attendanceDispatchAuthorization.js";
import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  verifyTeacherRequest,
  TeacherApiAuthError,
  type TeacherApiRequest,
} from "./teacherAuth.js";
import {
  sendPostabiWebAppMessage,
} from "./postabiWebApp.js";
import {
  resolveTeacherWhatsAppSender,
  TeacherWhatsAppSenderError,
} from "./teacherWhatsAppSender.js";
import { createWhatsAppNotificationImageLink } from "./whatsappNotificationImage.js";
import { formatNotificationDate } from "./whatsappNotificationImageDomain.mjs";

type RecordLike = Record<string, unknown>;

export class AttendanceDispatchError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "AttendanceDispatchError";
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

function getConsentedGuardianPhone(student: RecordLike): string | null {
  if (student.attendanceWhatsAppOptIn !== true) return null;
  if (
    typeof student.attendanceWhatsAppOptInAt !== "string" ||
    !student.attendanceWhatsAppOptInAt.trim()
  ) return null;

  const consentPhone = normalizePhone(student.attendanceWhatsAppOptInPhone);
  if (!consentPhone) return null;

  const currentPhones = [
    student.phone,
    student.fatherPhone,
    student.parentPhone,
    student.guardianPhone,
  ].map(normalizePhone);

  return currentPhones.includes(consentPhone) ? consentPhone : null;
}

function readRoster(classData: RecordLike): Map<string, RecordLike> {
  const reserved = new Set([
    "id", "name", "code", "monthlyFee", "className", "title", "fee",
    "classFee", "createdAt", "createdDate", "date", "updatedAt", "students",
  ]);

  const raw = classData.students;
  let entries: Array<[string, unknown]> = [];
  let studentsAreArray = false;

  if (Array.isArray(raw)) {
    studentsAreArray = true;
    entries = raw.map((student, index) => [String(index), student]);
  } else if (isRecord(raw)) {
    entries = Object.entries(raw);
  } else if (raw === undefined || raw === null) {
    entries = Object.entries(classData).filter(([key, value]) =>
      !reserved.has(key) &&
      isRecord(value) &&
      (typeof value.name === "string" ||
        value.id !== undefined ||
        value.studentId !== undefined),
    );
  }

  const roster = new Map<string, RecordLike>();

  for (const [key, value] of entries) {
    if (!isRecord(value)) continue;
    const isIndex = /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
    const stableKey = !studentsAreArray && !isIndex ? key : undefined;
    const rawId = value.id ?? value.studentId ?? stableKey;

    if (typeof rawId !== "string" && typeof rawId !== "number") continue;
    const id = String(rawId).trim();

    if (id && !id.includes("/") && !roster.has(id)) {
      roster.set(id, value);
    }
  }

  return roster;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function attemptCount(job: RecordLike): number {
  const value = job.attemptCount;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export async function dispatchAttendanceNotification(
  request: TeacherApiRequest & { body?: unknown },
) {
  const actor = await verifyTeacherRequest(request);

  // Independent server-side kill switch. Browser requests cannot override it.
  if (process.env.WHATSAPP_ATTENDANCE_DISPATCH_ENABLED !== "true") {
    throw new AttendanceDispatchError(
      503,
      "Attendance WhatsApp dispatch is disabled on this server. No message was sent.",
    );
  }

  if (!isRecord(request.body)) {
    throw new AttendanceDispatchError(400, "A valid JSON request body is required.");
  }

  const jobId = clean(request.body.jobId);
  if (!/^[a-f0-9]{64}$/i.test(jobId)) {
    throw new AttendanceDispatchError(400, "The attendance job ID is invalid.");
  }

  const settingsSnapshot = await actor.db
    .collection("platformSettings")
    .doc("whatsapp")
    .get();
  const settings = settingsSnapshot.data() ?? {};

  if (!hasAttendanceDispatchAuthorization(settings)) {
    throw new AttendanceDispatchError(
      409,
      "Attendance dispatch must be explicitly authorized by the administrator.",
    );
  }

  let sender;
  try {
    sender = await resolveTeacherWhatsAppSender(
      actor.db,
      actor.uid,
      settings,
    );
  } catch (error) {
    if (error instanceof TeacherWhatsAppSenderError) {
      throw new AttendanceDispatchError(error.status, error.message);
    }

    console.error(
      "[AttendanceDispatch] Sender configuration could not be resolved.",
      error instanceof Error ? error.name : "UnknownError",
    );

    throw new AttendanceDispatchError(
      503,
      "The configured WhatsApp sender could not be resolved. No message was sent.",
    );
  }

  const jobRef = actor.tenantRef
    .collection("whatsappNotificationJobs")
    .doc(jobId);
  const initialJobSnapshot = await jobRef.get();

  if (!initialJobSnapshot.exists) {
    throw new AttendanceDispatchError(404, "The attendance notification job was not found.");
  }

  const initialJob = initialJobSnapshot.data();
  if (
    !initialJob ||
    initialJob.kind !== "attendance_absent" ||
    initialJob.tenantId !== actor.email ||
    initialJob.provider !== "postabi" ||
    initialJob.status !== "prepared_for_vercel" ||
    initialJob.dispatchEnabled !== false
  ) {
    throw new AttendanceDispatchError(
      409,
      "This attendance job is not in a dispatchable state. Do not retry an uncertain send.",
    );
  }

  const classId = clean(initialJob.classId);
  const studentId = clean(initialJob.studentId);
  const date = clean(initialJob.attendanceDate);
  const attendanceId = clean(initialJob.sourceAttendanceId);

  if (
    !classId || classId.includes("/") ||
    !studentId || studentId.includes("/") ||
    !validDate(date) ||
    attendanceId !== `${classId}_${date}`
  ) {
    throw new AttendanceDispatchError(409, "The attendance job metadata is invalid.");
  }

  const classRef = actor.tenantRef.collection("classes").doc(classId);
  const attendanceRef = actor.tenantRef.collection("attendance").doc(attendanceId);

  const [classSnapshot, attendanceSnapshot, tenantSnapshot, profileSettingsSnapshot] =
    await Promise.all([
      classRef.get(),
      attendanceRef.get(),
      actor.tenantRef.get(),
      actor.tenantRef.collection("settings").doc("profile_data").get(),
    ]);

  if (!classSnapshot.exists || !attendanceSnapshot.exists) {
    throw new AttendanceDispatchError(404, "The current class or attendance record no longer exists.");
  }

  const classData = classSnapshot.data();
  const attendance = attendanceSnapshot.data();

  if (
    !classData || !attendance ||
    !isRecord(classData) || !isRecord(attendance) ||
    attendance.classId !== classId ||
    attendance.date !== date ||
    !isRecord(attendance.attendanceMap) ||
    attendance.attendanceMap[studentId] !== false
  ) {
    throw new AttendanceDispatchError(
      409,
      "The saved attendance record no longer confirms this student as absent.",
    );
  }

  const student = readRoster(classData).get(studentId);
  if (!student) {
    throw new AttendanceDispatchError(404, "The student is no longer in the current class roster.");
  }

  const recipientPhone = getConsentedGuardianPhone(student);
  if (!recipientPhone) {
    throw new AttendanceDispatchError(
      409,
      "Current explicit guardian consent and a matching saved phone number are required.",
    );
  }

  const message = [
    "📢 Attendance Alert",
    "",
    "Dear Parent/Guardian,",
    "",
    "This is to inform you that your child has been marked ABSENT today.",
    "",
    "For any clarification, please contact the academy administration.",
    "",
    "Regards,",
    "EduTrack School Administration",
  ].join("\n");

  const recipientHash = createRecipientFingerprint(recipientPhone);

  // Claim the job exactly once. The latest job, class and attendance are read
  // in the same transaction before any write is made.
  const claim = await actor.db.runTransaction(async (transaction) => {
    const [latestJobSnapshot, latestClassSnapshot, latestAttendanceSnapshot] =
      await Promise.all([
        transaction.get(jobRef),
        transaction.get(classRef),
        transaction.get(attendanceRef),
      ]);

    if (
      !latestJobSnapshot.exists ||
      !latestClassSnapshot.exists ||
      !latestAttendanceSnapshot.exists
    ) {
      return "missing" as const;
    }

    const latestJob = latestJobSnapshot.data() ?? {};
    const latestClassData = latestClassSnapshot.data();
    const latestAttendance = latestAttendanceSnapshot.data();

    if (
      latestJob.kind !== "attendance_absent" ||
      latestJob.tenantId !== actor.email ||
      latestJob.status !== "prepared_for_vercel" ||
      latestJob.dispatchEnabled !== false ||
      !latestClassData ||
      !isRecord(latestClassData) ||
      !latestAttendance ||
      !isRecord(latestAttendance) ||
      latestAttendance.classId !== classId ||
      latestAttendance.date !== date ||
      !isRecord(latestAttendance.attendanceMap) ||
      latestAttendance.attendanceMap[studentId] !== false
    ) {
      return "conflict" as const;
    }

    const latestStudent = readRoster(latestClassData).get(studentId);
    const latestPhone = latestStudent
      ? getConsentedGuardianPhone(latestStudent)
      : null;

    if (!latestPhone || latestPhone !== recipientPhone) {
      return "consent_changed" as const;
    }

    const attempts = attemptCount(latestJob);
    if (attempts >= 3) return "max_attempts" as const;

    transaction.update(jobRef, {
      status: "dispatching",
      dispatchEnabled: true,
      recipientPhoneHash: recipientHash,
      dispatchStartedAt: FieldValue.serverTimestamp(),
      dispatchClaimedBy: actor.uid,
      attemptCount: attempts + 1,
      retrySafe: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return "claimed" as const;
  });

  if (claim !== "claimed") {
    if (claim === "missing") {
      throw new AttendanceDispatchError(404, "The attendance job or its source record was not found.");
    }
    if (claim === "consent_changed") {
      throw new AttendanceDispatchError(409, "Guardian consent or phone changed. Prepare and review the job again.");
    }
    if (claim === "max_attempts") {
      throw new AttendanceDispatchError(429, "This attendance job has reached the three-attempt limit.");
    }
    throw new AttendanceDispatchError(409, "The attendance job could not be claimed. It may already be processing.");
  }

  // Any failure here is still before the provider call, so it can be marked
  // safely retryable. A failed release stays locked for manual review.
  const releaseBeforeProvider = async (
    status: string,
    retrySafe: boolean,
    reason: string,
  ): Promise<boolean> => {
    try {
      return await actor.db.runTransaction(async (transaction) => {
        const latest = await transaction.get(jobRef);
        if (!latest.exists) return false;
        const current = latest.data() ?? {};

        if (
          current.status !== "dispatching" ||
          current.dispatchEnabled !== true ||
          current.tenantId !== actor.email
        ) {
          return false;
        }

        const failedAt = status === "failed" && retrySafe ? Timestamp.now() : null;
        transaction.update(jobRef, {
          status,
          dispatchEnabled: false,
          retrySafe,
          ...(failedAt ? {
            failedAt,
            expiresAt: Timestamp.fromMillis(failedAt.toMillis() + 24 * 60 * 60 * 1000),
          } : {}),
          recipientPhoneHash: FieldValue.delete(),
          lastError: reason.slice(0, 500),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return true;
      });
    } catch (error) {
      console.error(
        "[AttendanceDispatch] Pre-provider release failed; manual review required.",
        error,
      );
      return false;
    }
  };

  // Recheck the source attendance and guardian consent immediately before
  // invoking Postabi. No provider request is made if either has changed.
  let notificationImageUrl = "";
  try {
    const [latestClassSnapshot, latestAttendanceSnapshot] = await Promise.all([
      classRef.get(),
      attendanceRef.get(),
    ]);

    const latestClassData = latestClassSnapshot.data();
    const latestAttendance = latestAttendanceSnapshot.data();
    const latestStudent = latestClassData && isRecord(latestClassData)
      ? readRoster(latestClassData).get(studentId)
      : undefined;
    const latestPhone = latestStudent
      ? getConsentedGuardianPhone(latestStudent)
      : null;

    if (
      !latestClassSnapshot.exists ||
      !latestAttendanceSnapshot.exists ||
      !latestAttendance ||
      !isRecord(latestAttendance) ||
      latestAttendance.classId !== classId ||
      latestAttendance.date !== date ||
      !isRecord(latestAttendance.attendanceMap) ||
      latestAttendance.attendanceMap[studentId] !== false
    ) {
      const released = await releaseBeforeProvider(
        "blocked_attendance_changed",
        false,
        "Attendance no longer marks this student absent. No provider request was made.",
      );
      throw new AttendanceDispatchError(
        released ? 409 : 503,
        released
          ? "Attendance changed before dispatch. No message was sent."
          : "Attendance changed before dispatch, but job release could not be confirmed. Manual review is required.",
      );
    }

    if (!latestPhone || latestPhone !== recipientPhone) {
      const released = await releaseBeforeProvider(
        "blocked_missing_opt_in",
        false,
        "Guardian consent or matching phone changed before dispatch. No provider request was made.",
      );
      throw new AttendanceDispatchError(
        released ? 409 : 503,
        released
          ? "Guardian consent or phone changed. No message was sent."
          : "Guardian consent changed, but job release could not be confirmed. Manual review is required.",
      );
    }

    const profile = profileSettingsSnapshot.data() ?? {};
    const nestedProfile = isRecord(profile.profile) ? profile.profile : profile;
    const tenantData = tenantSnapshot.data() ?? {};
    const tenantProfile = isRecord(tenantData.profile) ? tenantData.profile : {};
    const academyName = clean(nestedProfile.schoolName) || clean(nestedProfile.academyName) ||
      clean(profile.schoolName) || clean(profile.academyName) || clean(tenantData.schoolName) ||
      clean(tenantData.academyName) || clean(tenantProfile.schoolName);
    const className = clean(latestClassData.name) || clean(latestClassData.className) || clean(latestClassData.title);
    const classCode = clean(latestClassData.classCode) || clean(latestClassData.code);
    const studentName = clean(latestStudent.name);
    if (!academyName || !className || !classCode || !studentName) {
      throw new Error("Attendance image requires configured academy name, student name, class and class code.");
    }

    const monthStart = `${date.slice(0, 7)}-01`;
    const historySnapshot = await actor.tenantRef.collection("attendance")
      .where("date", ">=", monthStart)
      .where("date", "<=", date)
      .get();
    const monthRows: RecordLike[] = [];
    for (const attendanceDoc of historySnapshot.docs) {
      const row = attendanceDoc.data();
      if (
        isRecord(row) &&
        row.classId === classId &&
        isRecord(row.attendanceMap) &&
        typeof row.attendanceMap[studentId] === "boolean"
      ) {
        monthRows.push(row);
      }
    }
    const presentDays = monthRows.filter((row) => row.attendanceMap[studentId] === true).length;
    const previousAbsentDays = monthRows.filter((row) => row.date !== date && row.date < date && row.attendanceMap[studentId] === false).length;
    const attendancePercentage = monthRows.length ? `${Math.round((presentDays / monthRows.length) * 100)}%` : "Not recorded";
    const attendanceTime = isRecord(latestAttendance.markedAtByStudent)
      ? clean(latestAttendance.markedAtByStudent[studentId]) : "";
    const imageLink = await createWhatsAppNotificationImageLink({
      db: actor.db,
      tenantId: actor.email,
      payload: {
        kind: "attendance_absent",
        academyName,
        teacherAvatarUrl: clean(nestedProfile.avatarUrl) || clean(nestedProfile.profileImage) ||
          clean(profile.avatarUrl) || clean(profile.profileImage) || clean(tenantData.profileImage) ||
          clean(tenantData.avatarUrl) || clean(tenantData.photoURL) || clean(tenantProfile.avatarUrl) || clean(tenantProfile.profileImage),
        studentAvatarUrl: clean(latestStudent.profileImage) || clean(latestStudent.photoURL) ||
          clean(latestStudent.photoUrl) || clean(latestStudent.avatarUrl) || clean(latestStudent.avatar) || clean(latestStudent.imageUrl),
        studentName,
        fatherName: clean(latestStudent.fatherName),
        rollNumber: clean(latestStudent.rollNo) || clean(latestStudent.rollNumber),
        className,
        classCode,
        attendanceDate: formatNotificationDate(date),
        attendanceTime,
        attendanceStatus: "ABSENT",
        previousAbsentDays,
        attendancePercentage,
        parentMessage: "Regular attendance is essential for your child's academic progress. Please ensure their presence in upcoming classes.",
        academyContactPhone: clean(nestedProfile.phone) || clean(profile.phone),
        academyContactEmail: clean(nestedProfile.email) || clean(profile.email),
      },
    });
    notificationImageUrl = imageLink.url;
  } catch (error) {
    if (error instanceof AttendanceDispatchError) throw error;

    const released = await releaseBeforeProvider(
      "failed",
      true,
      "Pre-provider attendance or consent verification failed. No provider request was made.",
    );

    console.error("[AttendanceDispatch] Pre-provider verification failed.", error);

    throw new AttendanceDispatchError(
      503,
      released
        ? "Attendance verification failed. The job was marked safely retryable; no provider request was made."
        : "Attendance verification failed. Safe release could not be confirmed; manual review is required.",
    );
  }

  // Once the provider request starts, uncertain outcomes are never auto-retried.
  let providerHttpStatus: number | null = null;
  let providerStatus = "";
  let providerStatusCode: number | null = null;
  let providerMessageId: string | null = null;
  let providerFromLast4: string | null = null;
  let senderIdentityMatched = sender.senderType === "central";
  let accepted = false;

  try {
    const result = await sendPostabiWebAppMessage({
      credentials: sender.credentials,
      to: recipientPhone,
      type: "image",
      url: notificationImageUrl,
    });

    providerHttpStatus = result.httpStatus;
    providerStatus = result.providerStatus;
    providerStatusCode = result.providerStatusCode;
    providerMessageId = result.messageId;

    const returnedFrom = normalizePhone(result.from);
    providerFromLast4 = returnedFrom ? returnedFrom.slice(-4) : null;

    senderIdentityMatched = returnedFrom
      ? returnedFrom === sender.senderNumber
      : sender.senderType === "central";

    // A personal sender must match the verified number configured by admin.
    // A mismatch after provider invocation is uncertain and is never retried.
    accepted = result.accepted && senderIdentityMatched;
  } catch (error) {
    console.warn(
      "[AttendanceDispatch] Postabi Web App outcome is uncertain; automatic retry is blocked.",
      error instanceof Error ? error.name : "UnknownError",
    );
  }

  const finalStatus = accepted ? "accepted_by_postabi" : "unknown_outcome";

  // If persistence fails after the provider call, the job remains dispatching
  // and cannot be automatically retried.
  await actor.db.runTransaction(async (transaction) => {
    const latest = await transaction.get(jobRef);

    if (
      !latest.exists ||
      latest.data()?.status !== "dispatching" ||
      latest.data()?.tenantId !== actor.email
    ) {
      throw new Error("Attendance dispatch state changed after provider invocation; manual review is required.");
    }

    transaction.update(jobRef, {
      status: finalStatus,
      dispatchEnabled: false,
      retrySafe: false,
      providerHttpStatus,
      providerMessageId,
      providerStatus: providerStatus || null,
      providerStatusCode,
      providerResponseContract: "postabi_webapp_send_message_v1",
      providerSenderType: sender.senderType,
      providerSenderNumberLast4: sender.senderNumber.slice(-4),
      providerFromLast4,
      senderIdentityMatched,
      providerRespondedAt: FieldValue.serverTimestamp(),
      lastError: accepted
        ? null
        : "Provider outcome is unconfirmed. Do not automatically retry this job.",
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return {
    success: true,
    status: finalStatus,
    jobId,
    providerHttpStatus,
    providerStatus,
    providerStatusCode,
    messageSent: accepted ? "accepted_by_postabi" as const : "unconfirmed" as const,
    deliveryConfirmed: false as const,
    message: accepted
      ? "Postabi accepted the Attendance Alert request. WhatsApp delivery is not independently confirmed."
      : "The Postabi outcome is unconfirmed. Do not retry this notification automatically.",
  };
}

function createRecipientFingerprint(phone: string): string {
  // A one-way fingerprint is stored instead of the recipient number.
  return createHash("sha256")
    .update(`edutrack-attendance-recipient:v1:${phone}`)
    .digest("hex");
}

export function sendAttendanceDispatchApiError(
  res: {
    status(code: number): { json(data: unknown): unknown };
  },
  error: unknown,
) {
  if (
    error instanceof TeacherApiAuthError ||
    error instanceof AttendanceDispatchError
  ) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
    });
  }

  console.error("[AttendanceDispatch] Request failed.", error);
  return res.status(500).json({
    success: false,
    error: "The attendance dispatch could not be completed. Check the job status before retrying.",
  });
}
