import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import type { Firestore, DocumentData, DocumentReference, DocumentSnapshot, QueryDocumentSnapshot, Transaction } from "firebase-admin/firestore";
import { getFirebaseAdminFirestore } from "./firebaseAdmin.js";
import { refreshTeacherEntitlementProjection } from "./subscriptionEntitlements.js";
import { sendPostabiWebAppMessage } from "./postabiWebApp.js";
import { createWhatsAppNotificationImageLink } from "./whatsappNotificationImage.js";
import { formatNotificationDate } from "./whatsappNotificationImageDomain.mjs";
import {
  resolveTeacherWhatsAppSender,
  TeacherWhatsAppSenderError,
} from "./teacherWhatsAppSender.js";
import {
  computeFeeOutstanding,
  createFeeAlertJobId,
  createFeeAlertRecipientHash,
  getPakistanCalendarParts,
  feeMonthLabel,
  hasCurrentFeeAlertsConsent,
  isStudentEligibleForFeeMonth,
  normalizeFeeAlertPhone,
  normalizeFeeReminderDays,
} from "./feeAlertsWhatsAppDomain.mjs";

type RecordLike = Record<string, unknown>;

const MAX_PENDING_PER_TENANT = 25;
// Keep the hourly sweep bounded; the tenant cursor rotates fairly across invocations.
const DEFAULT_MAX_TENANTS_PER_RUN = 10;
const MAX_TENANTS_PER_RUN = 30;
const MAX_TOTAL_DISPATCH_PER_RUN = 10;
const DISPATCH_CONCURRENCY = 5;
const FEE_ALERTS_LOCK_LEASE_MS = 110_000;
const MONEY_EPSILON = 0.005;
const RESERVED_CLASS_KEYS = new Set([
  "id", "name", "code", "monthlyFee", "className", "title", "fee",
  "classFee", "createdAt", "createdDate", "date", "updatedAt", "students",
]);

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  if (!email || email.includes("/") || email.includes("\\") || /\s/.test(email) || !email.includes("@")) return "";
  return email;
}

function readRoster(classData: RecordLike): Map<string, RecordLike> {
  const raw = classData.students;
  let entries: Array<[string, unknown]> = [];
  const isArray = Array.isArray(raw);

  if (isArray) {
    entries = (raw as unknown[]).map((student, index) => [String(index), student]);
  } else if (isRecord(raw)) {
    entries = Object.entries(raw);
  } else {
    entries = Object.entries(classData).filter(([key, value]) =>
      !RESERVED_CLASS_KEYS.has(key) && isRecord(value) &&
      (typeof value.name === "string" || value.id !== undefined || value.studentId !== undefined),
    );
  }

  const result = new Map<string, RecordLike>();
  for (const [key, value] of entries) {
    if (!isRecord(value)) continue;
    const numericArrayKey = isArray && /^(0|[1-9]\d*)$/.test(key);
    const stableMapKey = !isArray && !/^(0|[1-9]\d*)$/.test(key) ? key : undefined;
    const rawId = value.id ?? value.studentId ?? stableMapKey;
    if (typeof rawId !== "string" && typeof rawId !== "number") continue;
    const studentId = String(rawId).trim();
    if (!studentId || studentId.includes("/") || result.has(studentId)) continue;
    // Array position is never used as a student identity.
    if (numericArrayKey && value.id === undefined && value.studentId === undefined) continue;
    result.set(studentId, value);
  }
  return result;
}

function readFeeRecords(
  snapshot: DocumentSnapshot,
  classId: string,
  monthKey: string,
): Record<string, RecordLike> {
  if (!snapshot.exists) return {};
  const data = snapshot.data() ?? {};
  if (data.classId !== undefined && String(data.classId) !== classId) {
    throw new Error("Fee ledger class ID does not match its document path.");
  }
  if (data.month !== undefined && String(data.month) !== monthKey) {
    throw new Error("Fee ledger month does not match its document path.");
  }
  if (!Object.prototype.hasOwnProperty.call(data, "feeRecords")) {
    throw new Error("Fee ledger is missing its feeRecords map.");
  }
  if (!isRecord(data.feeRecords)) throw new Error("Fee ledger student records are malformed.");
  const records: Record<string, RecordLike> = {};
  for (const [studentId, value] of Object.entries(data.feeRecords)) {
    if (!isRecord(value)) {
      throw new Error(`Fee ledger record for student ${studentId} is malformed.`);
    }
    records[studentId] = value;
  }
  return records;
}

function previousMonthKey(monthKey: string): string {
  const match = monthKey.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!match) throw new Error("The fee month is invalid.");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function classNameOf(classData: RecordLike, fallback: string): string {
  return clean(classData.name) || clean(classData.className) || clean(classData.title) || fallback;
}

function tenantIsActiveTeacher(data: RecordLike | undefined, tenantEmail: string): boolean {
  return Boolean(
    data &&
    data.role === "teacher" &&
    data.active === true &&
    data.disabled !== true &&
    data.deleted !== true &&
    normalizeEmail(data.email ?? tenantEmail) === tenantEmail &&
    clean(data.uid),
  );
}

function settingsDays(settings: RecordLike | undefined): number[] | null {
  if (!settings || settings.enabled !== true || settings.timezone !== "Asia/Karachi") return null;
  return normalizeFeeReminderDays(settings.reminderDays);
}

async function createFeeReminderJob(
  tenantRef: DocumentReference,
  input: {
    tenantId: string;
    classId: string;
    className: string;
    studentId: string;
    studentName: string;
    monthKey: string;
    reminderDay: number;
    amountDue: number;
  },
): Promise<boolean> {
  const jobId = createFeeAlertJobId(input);
  const jobRef = tenantRef.collection("feeAlertNotificationJobs").doc(jobId);
  try {
    await jobRef.create({
      kind: "fee_due_reminder",
      status: "pending",
      tenantId: input.tenantId,
      classId: input.classId,
      className: input.className,
      studentId: input.studentId,
      studentName: input.studentName,
      monthKey: input.monthKey,
      reminderDay: input.reminderDay,
      amountDueAtQueue: input.amountDue,
      retrySafe: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (error) {
    const code = isRecord(error) ? String(error.code ?? "") : "";
    if (code === "already-exists" || code === "6") return false;
    throw error;
  }
}

async function enqueueForTenant(
  db: Firestore,
  tenantRef: DocumentReference<DocumentData>,
  tenantEmail: string,
  settings: RecordLike,
  monthKey: string,
  reminderDay: number,
): Promise<number> {
  const classSnapshot = await tenantRef.collection("classes").get();
  const previousMonth = previousMonthKey(monthKey);

  // Process classes and individual idempotent job creates with bounded concurrency. This avoids
  // serial round trips while keeping the scheduled Hobby Function invocation within its 60-second cap.
  // Keep the Admin SDK query result explicitly typed at the Firestore boundary.
  const classDocuments = classSnapshot.docs as QueryDocumentSnapshot<DocumentData>[];
  const classQueuedCounts = await mapWithConcurrency(classDocuments, 4, async (classSnapshotItem) => {
    const classData = classSnapshotItem.data();
    if (!isRecord(classData)) return 0;
    const classId = classSnapshotItem.id;
    const classLabel = classNameOf(classData, classId);
    const currentFeeRef = tenantRef.collection("fees").doc(`${classId}_${monthKey}`);
    const previousFeeRef = tenantRef.collection("fees").doc(`${classId}_${previousMonth}`);

    let currentRecords: Record<string, RecordLike>;
    let previousRecords: Record<string, RecordLike>;
    try {
      const [currentFeeSnapshot, previousFeeSnapshot] = await Promise.all([
        currentFeeRef.get(),
        previousFeeRef.get(),
      ]);
      currentRecords = readFeeRecords(currentFeeSnapshot, classId, monthKey);
      previousRecords = readFeeRecords(previousFeeSnapshot, classId, previousMonth);
    } catch (error) {
      console.error("[FeeAlerts] Fee ledger validation failed; class was skipped.", {
        tenantId: tenantEmail,
        classId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return 0;
    }

    const eligibleRows = [...readRoster(classData).entries()].filter(([studentId, student]) => {
      const studentName = clean(student.name);
      return Boolean(
        studentId &&
        studentName &&
        studentName.toLowerCase() !== "unnamed student" &&
        isStudentEligibleForFeeMonth(student, monthKey) &&
        hasCurrentFeeAlertsConsent(student)
      );
    });

    const createdFlags = await mapWithConcurrency(eligibleRows, 8, async ([studentId, student]) => {
      const feeState = computeFeeOutstanding({
        student,
        classData,
        currentRecord: currentRecords[studentId],
        previousRecord: previousRecords[studentId],
        monthKey,
      });
      if (!feeState.valid || !Number.isFinite(feeState.remainingDues) || (feeState.remainingDues ?? 0) <= MONEY_EPSILON) {
        return 0;
      }
      const didCreate = await createFeeReminderJob(tenantRef, {
        tenantId: tenantEmail,
        classId,
        className: classLabel,
        studentId,
        studentName: clean(student.name),
        monthKey,
        reminderDay,
        amountDue: feeState.remainingDues ?? 0,
      });
      return didCreate ? 1 : 0;
    });

    return createdFlags.reduce((sum, value) => sum + value, 0);
  });

  return classQueuedCounts.reduce((sum, value) => sum + value, 0);
}

function skipJob(
  transaction: Transaction,
  jobRef: DocumentReference,
  status: string,
  reason: string,
): void {
  transaction.update(jobRef, {
    status,
    dispatchEnabled: false,
    retrySafe: false,
    outcomeReason: reason,
    completedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function processFeeReminderJob(
  db: Firestore,
  tenantRef: DocumentReference,
  tenantEmail: string,
  teacherUid: string,
  globalSettings: RecordLike,
  jobRef: DocumentReference,
  currentMonthKey: string,
): Promise<"accepted" | "rejected" | "unknown" | "skipped" | "blocked"> {
  const [initialJobSnapshot, initialSettingsSnapshot] = await Promise.all([
    jobRef.get(),
    tenantRef.collection("feeAlertSettings").doc("general").get(),
  ]);
  if (!initialJobSnapshot.exists) return "skipped";
  const initialJob = initialJobSnapshot.data() ?? {};
  if (initialJob.kind !== "fee_due_reminder" || initialJob.status !== "pending") return "skipped";
  const days = settingsDays(initialSettingsSnapshot.data());
  const reminderDay = Number(initialJob.reminderDay);
  if (!days || !days.includes(reminderDay)) return "skipped";
  if (clean(initialJob.monthKey) !== currentMonthKey) {
    await jobRef.update({
      status: "expired",
      dispatchEnabled: false,
      retrySafe: false,
      outcomeReason: "The fee reminder belongs to a previous calendar month.",
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return "skipped";
  }

  let sender;
  try {
    sender = await resolveTeacherWhatsAppSender(db, teacherUid, globalSettings);
  } catch (error) {
    // Configuration failures happen before provider invocation. Leave the job pending so a later
    // hourly run can retry after the admin fixes WhatsApp credentials or sender verification.
    console.warn("[FeeAlerts] Sender configuration is not ready; job remains pending.", {
      tenantId: tenantEmail,
      errorName: error instanceof Error ? error.name : "UnknownError",
      senderError: error instanceof TeacherWhatsAppSenderError,
    });
    return "blocked";
  }

  const classId = clean(initialJob.classId);
  const monthKey = clean(initialJob.monthKey);
  const studentId = clean(initialJob.studentId);
  if (!classId || classId.includes("/") || !studentId || studentId.includes("/")) {
    await jobRef.update({
      status: "blocked",
      dispatchEnabled: false,
      retrySafe: false,
      outcomeReason: "The saved class or student reference is invalid.",
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return "skipped";
  }

  const classRef = tenantRef.collection("classes").doc(classId);
  const currentFeeRef = tenantRef.collection("fees").doc(`${classId}_${monthKey}`);
  const previousFeeRef = tenantRef.collection("fees").doc(`${classId}_${previousMonthKey(monthKey)}`);
  const scheduleRef = tenantRef.collection("feeAlertSettings").doc("general");
  const tenantProfileRef = tenantRef;

  const claim = await db.runTransaction(async (transaction) => {
    const [jobSnapshot, classSnapshot, currentFeeSnapshot, previousFeeSnapshot, scheduleSnapshot, tenantSnapshot] = await Promise.all([
      transaction.get(jobRef),
      transaction.get(classRef),
      transaction.get(currentFeeRef),
      transaction.get(previousFeeRef),
      transaction.get(scheduleRef),
      transaction.get(tenantProfileRef),
    ]);

    if (!jobSnapshot.exists || jobSnapshot.data()?.status !== "pending") return { kind: "not_pending" as const };
    const liveJob = jobSnapshot.data() ?? {};
    if (liveJob.kind !== "fee_due_reminder" || liveJob.tenantId !== tenantEmail) {
      skipJob(transaction, jobRef, "blocked", "The fee reminder job ownership could not be verified.");
      return { kind: "skipped" as const };
    }
    const tenantData = tenantSnapshot.data() ?? {};
    if (!tenantIsActiveTeacher(tenantData, tenantEmail) || tenantData.uid !== teacherUid) {
      skipJob(transaction, jobRef, "blocked", "The teacher workspace is no longer active or owned by this identity.");
      return { kind: "skipped" as const };
    }
    const liveDays = settingsDays(scheduleSnapshot.data());
    if (!liveDays || !liveDays.includes(Number(liveJob.reminderDay))) {
      skipJob(transaction, jobRef, "skipped_schedule_changed", "Fee reminder settings were disabled or changed before dispatch.");
      return { kind: "skipped" as const };
    }
    if (clean(liveJob.monthKey) !== currentMonthKey) {
      skipJob(transaction, jobRef, "expired", "The fee reminder belongs to a previous calendar month.");
      return { kind: "skipped" as const };
    }
    if (!classSnapshot.exists) {
      skipJob(transaction, jobRef, "blocked", "The class no longer exists.");
      return { kind: "skipped" as const };
    }

    const classData = classSnapshot.data() ?? {};
    const student = readRoster(classData).get(studentId);
    if (!student) {
      skipJob(transaction, jobRef, "skipped_student_missing", "The student is no longer in the current class roster.");
      return { kind: "skipped" as const };
    }
    const studentName = clean(student.name);
    if (!studentName || studentName.toLowerCase() === "unnamed student" || !isStudentEligibleForFeeMonth(student, monthKey)) {
      skipJob(transaction, jobRef, "skipped_student_ineligible", "The student is not eligible for this fee month in the current roster.");
      return { kind: "skipped" as const };
    }
    if (!hasCurrentFeeAlertsConsent(student)) {
      skipJob(transaction, jobRef, "skipped_no_consent", "Current Fee Alerts WhatsApp consent for the saved contact number is not recorded.");
      return { kind: "skipped" as const };
    }

    let currentRecords: Record<string, RecordLike>;
    let previousRecords: Record<string, RecordLike>;
    try {
      currentRecords = readFeeRecords(currentFeeSnapshot, classId, monthKey);
      previousRecords = readFeeRecords(previousFeeSnapshot, classId, previousMonthKey(monthKey));
    } catch {
      skipJob(transaction, jobRef, "blocked", "The current fee ledger could not be validated.");
      return { kind: "skipped" as const };
    }
    const feeState = computeFeeOutstanding({
      student,
      classData,
      currentRecord: currentRecords[studentId],
      previousRecord: previousRecords[studentId],
      monthKey,
    });
    if (!feeState.valid) {
      skipJob(transaction, jobRef, "blocked", "The current fee ledger contains invalid values and was not used for messaging.");
      return { kind: "skipped" as const };
    }
    if ((feeState.remainingDues ?? 0) <= MONEY_EPSILON) {
      skipJob(transaction, jobRef, "skipped_paid", "The outstanding fee balance is now zero.");
      return { kind: "skipped" as const };
    }

    const phone = normalizeFeeAlertPhone(student.phone);
    if (!phone) {
      skipJob(transaction, jobRef, "skipped_invalid_phone", "The current guardian WhatsApp number is invalid.");
      return { kind: "skipped" as const };
    }

    transaction.update(jobRef, {
      status: "sending",
      dispatchEnabled: true,
      retrySafe: false,
      recipientPhoneHash: createFeeAlertRecipientHash(phone),
      amountDueAtDispatch: feeState.remainingDues,
      dispatchStartedAt: FieldValue.serverTimestamp(),
      dispatchClaimedBy: "vercel-cron",
      dispatchAttemptCount: Number(liveJob.dispatchAttemptCount ?? 0) + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      kind: "claimed" as const,
      phone,
      studentName: clean(student.name),
      studentAvatarUrl: clean(student.profileImage) || clean(student.photoURL) || clean(student.photoUrl) || clean(student.avatarUrl) || clean(student.avatar) || clean(student.imageUrl),
      fatherName: clean(student.fatherName),
      rollNumber: clean(student.rollNo) || clean(student.rollNumber),
      className: classNameOf(classData, ""),
      classCode: clean(classData.classCode) || clean(classData.code),
      monthKey,
      amountDue: feeState.remainingDues ?? 0,
      totalFee: feeState.totalObligation ?? 0,
      paymentStatus: feeState.status,
      savedDueDate: clean(currentRecords[studentId]?.dueDate),
    };
  });

  if (claim.kind !== "claimed") return "skipped";

  let providerInvoked = false;
  try {
    const profileSnapshot = await tenantRef.collection("settings").doc("profile_data").get();
    const profile = profileSnapshot.data() ?? {};
    const nestedProfile = isRecord(profile.profile) ? profile.profile : profile;
    const tenantSnapshot = await tenantRef.get();
    const tenantData = tenantSnapshot.data() ?? {};
    const tenantProfile = isRecord(tenantData.profile) ? tenantData.profile : {};
    const academyName = clean(nestedProfile.schoolName) || clean(nestedProfile.academyName) ||
      clean(profile.schoolName) || clean(profile.academyName) || clean(tenantData.schoolName) ||
      clean(tenantData.academyName) || clean(tenantProfile.schoolName);
    const dueDateMatch = /^(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.exec(claim.savedDueDate);

    // The current Fees UI does not collect or persist a per-student due date. Use a neutral
    // reminder card when none is saved; never invent a date or label the balance overdue.
    if (!academyName || !claim.studentName || !claim.className || !claim.classCode) {
      const missing = [
        !academyName ? "academy name" : "",
        !claim.studentName ? "student name" : "",
        !claim.className ? "class name" : "",
        !claim.classCode ? "class code" : "",
      ].filter(Boolean).join(", ");
      await jobRef.update({
        status: "pending",
        dispatchEnabled: false,
        retrySafe: true,
        outcomeReason: `WhatsApp fee image not sent: missing ${missing}. No provider request was made; correct the saved school/class profile and the next Cron run will retry.`,
        lastPreProviderFailureAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.warn("[FeeAlerts] Image dispatch is waiting for required identity data before provider invocation.", {
        tenantId: tenantEmail,
        jobId: jobRef.id,
        missing,
      });
      return "blocked";
    }

    let validSavedDueDate = "";
    if (dueDateMatch) {
      const dueDateCandidate = new Date(`${claim.savedDueDate}T00:00:00.000Z`);
      if (Number.isFinite(dueDateCandidate.getTime()) && dueDateCandidate.toISOString().slice(0, 10) === claim.savedDueDate) {
        validSavedDueDate = claim.savedDueDate;
      }
    }

    const today = getPakistanCalendarParts();
    const todayKey = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
    const todayUtc = new Date(`${todayKey}T00:00:00.000Z`);
    const dueDate = validSavedDueDate ? new Date(`${validSavedDueDate}T00:00:00.000Z`) : null;
    const daysOverdue = dueDate ? Math.floor((todayUtc.getTime() - dueDate.getTime()) / 86400000) : 0;
    const kind = !dueDate ? "fee_reminder" : daysOverdue > 0 ? "fee_overdue" : "fee_upcoming";
    const totalFeeLabel = `PKR ${Number(claim.totalFee).toLocaleString("en-PK", { maximumFractionDigits: 2 })}`;
    const link = await createWhatsAppNotificationImageLink({
      db,
      tenantId: tenantEmail,
      payload: {
        kind,
        academyName,
        teacherAvatarUrl: clean(nestedProfile.avatarUrl) || clean(nestedProfile.profileImage) ||
          clean(profile.avatarUrl) || clean(profile.profileImage) || clean(tenantData.profileImage) ||
          clean(tenantData.avatarUrl) || clean(tenantData.photoURL) || clean(tenantProfile.avatarUrl) || clean(tenantProfile.profileImage),
        studentAvatarUrl: claim.studentAvatarUrl,
        studentName: claim.studentName,
        fatherName: claim.fatherName,
        rollNumber: claim.rollNumber,
        className: claim.className,
        classCode: claim.classCode,
        feeMonth: feeMonthLabel(claim.monthKey),
        totalFee: claim.totalFee,
        totalFeeLabel,
        amountDue: claim.amountDue,
        currencyAmount: `PKR ${Number(claim.amountDue).toLocaleString("en-PK", { maximumFractionDigits: 2 })}`,
        dueDate: validSavedDueDate ? formatNotificationDate(validSavedDueDate) : "",
        daysOverdue: Math.max(0, daysOverdue),
        paymentStatus: kind === "fee_overdue" ? "OVERDUE" : claim.paymentStatus,
        paymentInstructions: clean(nestedProfile.paymentInstructions) || clean(profile.paymentInstructions),
        academyContactPhone: clean(nestedProfile.phone) || clean(profile.phone),
        academyContactEmail: clean(nestedProfile.email) || clean(profile.email),
      },
    });

    providerInvoked = true;
    const result = await sendPostabiWebAppMessage({
      credentials: sender.credentials,
      to: claim.phone,
      type: "image",
      url: link.url,
    });
    const providerFrom = normalizeFeeAlertPhone(result.from);
    const senderNumber = normalizeFeeAlertPhone(sender.senderNumber);
    const senderIdentityMatched = providerFrom
      ? providerFrom === senderNumber
      : sender.senderType === "central";
    const accepted = result.accepted && senderIdentityMatched;
    const definitiveProviderRejection = !result.accepted
      && result.httpStatus >= 400
      && result.httpStatus < 500
      && ![408, 409, 425, 429].includes(result.httpStatus);
    const finalStatus = accepted
      ? "accepted_by_provider"
      : definitiveProviderRejection ? "provider_rejected" : "unknown_outcome";
    const failedAt = finalStatus === "provider_rejected" ? Timestamp.now() : null;
    await jobRef.update({
      status: finalStatus,
      dispatchEnabled: false,
      retrySafe: false,
      providerHttpStatus: result.httpStatus,
      providerStatus: result.providerStatus || null,
      providerStatusCode: result.providerStatusCode,
      providerAccepted: accepted,
      providerSenderType: sender.senderType,
      providerSenderNumberLast4: senderNumber ? senderNumber.slice(-4) : null,
      providerFromLast4: providerFrom ? providerFrom.slice(-4) : null,
      senderIdentityMatched,
      providerResponseContract: "postabi_webapp_send_message_v1",
      providerRespondedAt: FieldValue.serverTimestamp(),
      ...(failedAt ? {
        failedAt,
        expiresAt: Timestamp.fromMillis(failedAt.toMillis() + 24 * 60 * 60 * 1000),
      } : {}),
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return accepted ? "accepted" : definitiveProviderRejection ? "rejected" : "unknown";
  } catch (error) {
    if (!providerInvoked) {
      // Rendering, signing, or metadata failures are safe to retry because the provider was
      // never called. Keep the deterministic job pending so a corrected configuration can drain it.
      await jobRef.update({
        status: "pending",
        dispatchEnabled: false,
        retrySafe: true,
        outcomeReason: `WhatsApp fee image could not be prepared: ${error instanceof Error ? error.name : "UnknownError"}. No provider request was made; the next Cron run may retry safely.`,
        lastPreProviderFailureAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }).catch((updateError) => {
        console.error("[FeeAlerts] Could not persist pre-provider image block.", {
          tenantId: tenantEmail,
          jobId: jobRef.id,
          errorName: updateError instanceof Error ? updateError.name : "UnknownError",
        });
      });
      console.warn("[FeeAlerts] Fee image preparation failed before provider invocation; job remains safely retryable.", {
        tenantId: tenantEmail,
        jobId: jobRef.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return "blocked";
    }

    // A timeout/network error after provider invocation has an uncertain outcome. Do not resend
    // automatically because that could duplicate a fee reminder to the parent.
    await jobRef.update({
      status: "unknown_outcome",
      dispatchEnabled: false,
      retrySafe: false,
      providerErrorName: error instanceof Error ? error.name.slice(0, 80) : "UnknownError",
      providerRespondedAt: FieldValue.serverTimestamp(),
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }).catch((updateError) => {
      console.error("[FeeAlerts] Could not persist uncertain provider outcome.", {
        tenantId: tenantEmail,
        jobId: jobRef.id,
        errorName: updateError instanceof Error ? updateError.name : "UnknownError",
      });
    });
    return "unknown";
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runFeeAlertsWhatsAppCron(): Promise<Record<string, number | string>> {
  if (process.env.WHATSAPP_DISPATCH_ENABLED !== "true") {
    return { enabled: 0, reason: "WHATSAPP_DISPATCH_ENABLED is not true.", tenantsChecked: 0, queued: 0, acceptedByProvider: 0, providerRejected: 0, unknownOutcome: 0, skipped: 0 };
  }
  if (process.env.FEE_ALERTS_DISPATCH_ENABLED !== "true") {
    return { enabled: 0, reason: "FEE_ALERTS_DISPATCH_ENABLED is not true.", tenantsChecked: 0, queued: 0, acceptedByProvider: 0, providerRejected: 0, unknownOutcome: 0, skipped: 0 };
  }

  const db = getFirebaseAdminFirestore();
  const lockRef = db.collection("platformLocks").doc("feeAlertsWhatsAppCron");
  const workerToken = randomUUID();
  const lockAcquired = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(lockRef);
    const lock = snapshot.data() ?? {};
    const lockedUntil = lock.lockedUntil instanceof Timestamp ? lock.lockedUntil.toMillis() : 0;
    if (lockedUntil > Date.now()) return false;
    transaction.set(lockRef, {
      workerToken,
      lockedUntil: Timestamp.fromMillis(Date.now() + FEE_ALERTS_LOCK_LEASE_MS),
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  });
  if (!lockAcquired) {
    return {
      enabled: 1,
      reason: "Another fee-alert run holds the processing lease.",
      skipped: 1,
      tenantsChecked: 0,
      queued: 0,
      acceptedByProvider: 0,
      providerRejected: 0,
      unknownOutcome: 0,
    };
  }

  try {
    const [globalSettingsSnapshot, cursorSnapshot] = await Promise.all([
      db.collection("platformSettings").doc("whatsapp").get(),
      lockRef.get(),
    ]);
    const cursorData = cursorSnapshot.data() ?? {};
    const previousTenantCursor = clean(cursorData.tenantCursorEmail);
    const configuredTenantLimit = Number.parseInt(process.env.FEE_ALERTS_MAX_TENANTS_PER_RUN ?? "", 10);
    const tenantLimit = Number.isFinite(configuredTenantLimit)
      ? Math.max(1, Math.min(MAX_TENANTS_PER_RUN, configuredTenantLimit))
      : DEFAULT_MAX_TENANTS_PER_RUN;
    const teacherQuery = db.collection("users")
      .where("role", "==", "teacher")
      .orderBy(FieldPath.documentId())
      .limit(tenantLimit);
    let teacherSnapshot = previousTenantCursor
      ? await teacherQuery.startAfter(previousTenantCursor).get()
      : await teacherQuery.get();
    if (teacherSnapshot.empty && previousTenantCursor) {
      teacherSnapshot = await teacherQuery.get();
    }
    console.info("[FeeAlerts] Bounded tenant page loaded.", {
      tenantsScanned: teacherSnapshot.size,
      tenantBatchLimit: tenantLimit,
      cursorPresent: Boolean(previousTenantCursor),
    });
    const globalSettings = globalSettingsSnapshot.data() ?? {};
  if (globalSettings.enabled !== true) {
    return { enabled: 0, reason: "The central WhatsApp integration is disabled.", tenantsChecked: 0, queued: 0, acceptedByProvider: 0, providerRejected: 0, unknownOutcome: 0, skipped: 0 };
  }

  const today = getPakistanCalendarParts();
  const perTenantCandidateQueues: Array<Array<{
    tenantRef: DocumentReference;
    tenantEmail: string;
    teacherUid: string;
    jobRef: DocumentReference;
  }>> = [];
  let tenantsChecked = 0;
  let queued = 0;
  let skipped = 0;

  for (const teacherDoc of teacherSnapshot.docs) {
    const tenantEmail = normalizeEmail(teacherDoc.id);
    const teacherData = teacherDoc.data() ?? {};
    if (!tenantEmail || !tenantIsActiveTeacher(teacherData, tenantEmail)) continue;
    const tenantRef = db.collection("users").doc(tenantEmail);
    const teacherUid = clean(teacherData.uid);
    let entitlement;
    try {
      entitlement = await refreshTeacherEntitlementProjection(db, teacherUid, tenantEmail);
    } catch (error) {
      console.warn("[FeeAlerts] Academy permission could not be verified; tenant dispatch skipped.", {
        tenantId: tenantEmail,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      entitlement = null;
    }
    if (!entitlement?.active || entitlement.featurePermissions.fee_alerts === "disabled") {
      const pending = await tenantRef.collection("feeAlertNotificationJobs")
        .where("status", "==", "pending").limit(MAX_PENDING_PER_TENANT).get();
      for (const job of pending.docs) {
        if (job.data()?.kind !== "fee_due_reminder") continue;
        await job.ref.update({
          status: "blocked_permission",
          dispatchEnabled: false,
          retrySafe: false,
          outcomeReason: "The Academy Admin has not granted Fee Alerts permission.",
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        skipped += 1;
      }
      continue;
    }
    const settingsSnapshot = await tenantRef.collection("feeAlertSettings").doc("general").get();
    const settings = settingsSnapshot.data() ?? {};
    const reminderDays = settingsDays(settings);
    if (!reminderDays) {
      // Turning reminders off must also cancel any still-pending jobs, not just future queueing.
      const disabledPending = await tenantRef
        .collection("feeAlertNotificationJobs")
        .where("status", "==", "pending")
        .limit(MAX_PENDING_PER_TENANT)
        .get();
      for (const pendingJob of disabledPending.docs) {
        const data = pendingJob.data() ?? {};
        if (data.kind !== "fee_due_reminder") continue;
        await pendingJob.ref.update({
          status: "skipped_settings_disabled",
          dispatchEnabled: false,
          retrySafe: false,
          outcomeReason: "Automatic fee alerts were disabled by the teacher before dispatch.",
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        skipped += 1;
      }
      continue;
    }
    tenantsChecked += 1;

    if (reminderDays.includes(today.day)) {
      try {
        queued += await enqueueForTenant(db, tenantRef, tenantEmail, settings, today.monthKey, today.day);
      } catch (error) {
        console.error("[FeeAlerts] Could not queue the tenant's scheduled fee reminders.", {
          tenantId: tenantEmail,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }

    // Previous versions marked image preparation failures as permanently blocked even though
    // the provider had never been invoked. Requeue only those explicit pre-provider reason codes;
    // provider_rejected and unknown_outcome jobs are deliberately never retried automatically.
    const blockedImageJobs = await tenantRef.collection("feeAlertNotificationJobs")
      .where("status", "==", "blocked")
      .limit(MAX_PENDING_PER_TENANT)
      .get();
    for (const blockedJob of blockedImageJobs.docs) {
      const blockedData = blockedJob.data() ?? {};
      const reason = clean(blockedData.outcomeReason);
      const isKnownPreProviderImageFailure =
        reason.startsWith("WhatsApp fee image not sent:") ||
        reason.startsWith("WhatsApp fee image could not be prepared:");
      if (blockedData.kind !== "fee_due_reminder" || !isKnownPreProviderImageFailure ||
          blockedData.providerRespondedAt || blockedData.providerHttpStatus !== undefined) continue;
      await blockedJob.ref.update({
        status: "pending",
        dispatchEnabled: false,
        retrySafe: true,
        lastPreProviderFailureReason: reason.slice(0, 300),
        outcomeReason: "Re-queued safely: the previous image attempt failed before any Postabi request. Eligibility and fee balance will be revalidated before sending.",
        preProviderRequeuedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    // Jobs live in a separate server-only subcollection. A single-field status query uses
    // Firestore's automatic index; no composite index or browser-visible queue is required.
    const pendingSnapshot = await tenantRef
      .collection("feeAlertNotificationJobs")
      .where("status", "==", "pending")
      .limit(MAX_PENDING_PER_TENANT)
      .get();
    const tenantCandidates: Array<{
      tenantRef: DocumentReference;
      tenantEmail: string;
      teacherUid: string;
      jobRef: DocumentReference;
    }> = [];

    for (const jobSnapshot of pendingSnapshot.docs) {
      const job = jobSnapshot.data() ?? {};
      if (job.kind !== "fee_due_reminder") continue;
      if (clean(job.monthKey) !== today.monthKey) {
        await jobSnapshot.ref.update({
          status: "expired",
          dispatchEnabled: false,
          retrySafe: false,
          outcomeReason: "The fee reminder belongs to a previous calendar month.",
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        skipped += 1;
        continue;
      }
      if (!reminderDays.includes(Number(job.reminderDay))) {
        await jobSnapshot.ref.update({
          status: "skipped_schedule_changed",
          dispatchEnabled: false,
          retrySafe: false,
          outcomeReason: "The teacher changed or removed this reminder date before dispatch.",
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        skipped += 1;
        continue;
      }
      if (tenantCandidates.length < MAX_TOTAL_DISPATCH_PER_RUN) {
        tenantCandidates.push({
          tenantRef,
          tenantEmail,
          teacherUid,
          jobRef: jobSnapshot.ref,
        });
      }
    }
    if (tenantCandidates.length) perTenantCandidateQueues.push(tenantCandidates);
  }

  const nextTenantCursor = teacherSnapshot.docs[teacherSnapshot.docs.length - 1]?.id ?? "";
  if (nextTenantCursor) {
    await lockRef.set({
      tenantCursorEmail: nextTenantCursor,
      tenantsScanned: teacherSnapshot.size,
      cursorUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  // Round-robin between tenants so a large school cannot starve every other school's queue.
  const queueCandidates: Array<{
    tenantRef: DocumentReference;
    tenantEmail: string;
    teacherUid: string;
    jobRef: DocumentReference;
  }> = [];
  for (let offset = 0; queueCandidates.length < MAX_TOTAL_DISPATCH_PER_RUN; offset += 1) {
    let addedAtOffset = false;
    for (const tenantQueue of perTenantCandidateQueues) {
      const candidate = tenantQueue[offset];
      if (!candidate) continue;
      queueCandidates.push(candidate);
      addedAtOffset = true;
      if (queueCandidates.length >= MAX_TOTAL_DISPATCH_PER_RUN) break;
    }
    if (!addedAtOffset) break;
  }

  const outcomes = await mapWithConcurrency(queueCandidates, DISPATCH_CONCURRENCY, async (candidate) => {
    try {
      return await processFeeReminderJob(
        db,
        candidate.tenantRef,
        candidate.tenantEmail,
        candidate.teacherUid,
        globalSettings,
        candidate.jobRef,
        today.monthKey,
      );
    } catch (error) {
      console.error("[FeeAlerts] A reminder job failed before its result could be confirmed.", {
        tenantId: candidate.tenantEmail,
        jobId: candidate.jobRef.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return "blocked" as const;
    }
  });

  const acceptedByProvider = outcomes.filter((value) => value === "accepted").length;
  const providerRejected = outcomes.filter((value) => value === "rejected").length;
  const unknownOutcome = outcomes.filter((value) => value === "unknown").length;
  const blocked = outcomes.filter((value) => value === "blocked").length;
  skipped += outcomes.filter((value) => value === "skipped").length;

  return {
    enabled: 1,
    timezone: "Asia/Karachi",
    calendarDate: `${today.monthKey}-${String(today.day).padStart(2, "0")}`,
    tenantsChecked,
    tenantsScanned: teacherSnapshot.size,
    tenantBatchLimit: tenantLimit,
    queued,
    jobsProcessed: outcomes.length,
    acceptedByProvider,
    providerRejected,
    unknownOutcome,
    blocked,
    skipped,
    remainingBatchPossible: outcomes.length >= MAX_TOTAL_DISPATCH_PER_RUN ? 1 : 0,
  };
  } finally {
    await db.runTransaction(async (transaction) => {
      const latest = await transaction.get(lockRef);
      if (latest.data()?.workerToken === workerToken) {
        transaction.set(lockRef, {
          workerToken: null,
          lockedUntil: Timestamp.fromMillis(0),
          finishedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }).catch((error) => {
      console.error("[FeeAlerts] Could not release the scheduled-run lease.", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });
  }
}
