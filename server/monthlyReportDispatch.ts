import { isMonthlyReportWhatsAppEnabled } from "./monthlyReportFeature.js";
import { calculateMonthlyReportContentHash } from "./monthlyReportHash.js";
import { assertTeacherActorFeatureEntitlement } from "./subscriptionEntitlements.js";
import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import {
  verifyTeacherRequest,
  TeacherApiAuthError,
  type TeacherApiRequest,
} from "./teacherAuth.js";
import { createMonthlyReportMediaLink } from "./monthlyReportMedia.js";
import { sendPostabiWebAppMessage } from "./postabiWebApp.js";
import {
  resolveTeacherWhatsAppSender,
  TeacherWhatsAppSenderError,
} from "./teacherWhatsAppSender.js";

type RecordLike = Record<string, unknown>;

export class MonthlyReportDispatchError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "MonthlyReportDispatchError";
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
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
  if (student.parentWhatsAppOptIn !== true) return null;
  if (
    typeof student.parentWhatsAppOptInAt !== "string" ||
    !student.parentWhatsAppOptInAt.trim()
  ) return null;

  const consentPhone = normalizePhone(student.parentWhatsAppOptInPhone);
  if (!consentPhone) return null;

  const currentPhones = [
    student.phone,
    student.fatherPhone,
    student.parentPhone,
    student.guardianPhone,
  ].map(normalizePhone).filter((value): value is string => Boolean(value));

  return currentPhones.includes(consentPhone) ? consentPhone : null;
}

function phoneFingerprint(phone: string): string {
  return createHash("sha256")
    .update(`edutrack-monthly-report-recipient:v1:${phone}`)
    .digest("hex");
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

export async function dispatchMonthlyReportPdf(
  request: TeacherApiRequest & { body?: unknown },
) {
  const actor = await verifyTeacherRequest(request);
  try {
    await assertTeacherActorFeatureEntitlement(actor, "monthly_reports");
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    throw new MonthlyReportDispatchError(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 403,
      error instanceof Error ? error.message : "Your Academy Admin has not granted Monthly Reports permission.");
  }

  // Independent server-side kill switch. No browser flag can enable dispatch.
  if (
    !isMonthlyReportWhatsAppEnabled() ||
    process.env.WHATSAPP_DISPATCH_ENABLED !== "true"
  ) {
    throw new MonthlyReportDispatchError(
      503,
      "WhatsApp dispatch is disabled on this server. No message was sent.",
    );
  }

  if (!isRecord(request.body)) {
    throw new MonthlyReportDispatchError(400, "A valid JSON request body is required.");
  }

  const jobId = clean(request.body.jobId);

  if (!/^[a-f0-9]{64}$/i.test(jobId)) {
    throw new MonthlyReportDispatchError(400, "The monthly report job ID is invalid.");
  }

  const settingsRef = actor.db.collection("platformSettings").doc("whatsapp");
  const settingsSnapshot = await settingsRef.get();
  const settings = settingsSnapshot.data() ?? {};

  if (
    settings.enabled !== true ||
    settings.monthlyReportDispatchEnabled !== true ||
    settings.monthlyReportDispatchAuthorizationVersion !== 1 ||
    settings.monthlyReportDispatchAuthorizationScope !== "monthly_report_pdfs_only" ||
    typeof settings.monthlyReportDispatchAuthorizedAt !== "string" ||
    !clean(settings.monthlyReportDispatchAuthorizedAt) ||
    !clean(settings.monthlyReportDispatchAuthorizedByUid)
  ) {
    throw new MonthlyReportDispatchError(
      409,
      "Monthly report WhatsApp dispatch requires explicit administrator authorization and an enabled central configuration.",
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
      throw new MonthlyReportDispatchError(error.status, error.message);
    }

    console.error(
      "[MonthlyReportDispatch] Sender configuration could not be resolved.",
      error instanceof Error ? error.name : "UnknownError",
    );

    throw new MonthlyReportDispatchError(
      503,
      "The configured WhatsApp sender could not be resolved. No report image was sent.",
    );
  }

  const tenantRef = actor.tenantRef;
  const jobRef = tenantRef.collection("whatsappNotificationJobs").doc(jobId);
  const jobSnapshot = await jobRef.get();

  if (!jobSnapshot.exists) {
    throw new MonthlyReportDispatchError(404, "The monthly report job was not found.");
  }

  const job = jobSnapshot.data();

  if (
    !job ||
    job.kind !== "monthly_report_pdf" ||
    job.tenantId !== actor.email ||
    job.status !== "prepared_for_vercel" ||
    job.dispatchEnabled !== false
  ) {
    throw new MonthlyReportDispatchError(
      409,
      "This report is not in a dispatchable state. Do not retry an uncertain send.",
    );
  }

  const classId = clean(job.classId);
  const studentId = clean(job.studentId);
  const monthKey = clean(job.monthKey);

  if (
    !classId || classId.includes("/") ||
    !studentId || studentId.includes("/") ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)
  ) {
    throw new MonthlyReportDispatchError(409, "The saved report job is invalid.");
  }

  const classRef = tenantRef.collection("classes").doc(classId);
  const reportRef = classRef.collection("reports").doc(`${studentId}_${monthKey}`);

  const [classSnapshot, reportSnapshot] = await Promise.all([
    classRef.get(),
    reportRef.get(),
  ]);

  const classData = classSnapshot.data();
  const report = reportSnapshot.data();

  if (
    !classSnapshot.exists ||
    !reportSnapshot.exists ||
    !classData ||
    !report ||
    !isRecord(classData) ||
    !isRecord(report)
  ) {
    throw new MonthlyReportDispatchError(404, "The current class or saved report was not found.");
  }

  if (
    report.whatsAppStatus !== "prepared_for_vercel" ||
    report.whatsAppJobId !== jobId ||
    clean(report.lastWhatsAppAcceptedMonth) === monthKey
  ) {
    throw new MonthlyReportDispatchError(409, "The report is no longer eligible for dispatch.");
  }

  const student = readRoster(classData).get(studentId);
  if (!student) {
    throw new MonthlyReportDispatchError(404, "The student is not in the current class roster.");
  }

  const recipientPhone = getConsentedGuardianPhone(student);
  if (!recipientPhone) {
    throw new MonthlyReportDispatchError(409, "Current guardian consent and matching phone number are required.");
  }

  const className = clean(classData.name) ||
    clean(classData.className) ||
    clean(classData.title) ||
    "Class";

  const currentContentHash = calculateMonthlyReportContentHash(
    report,
    className,
    student,
  );

  if (
    typeof job.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(job.contentHash) ||
    currentContentHash !== job.contentHash ||
    report.whatsAppAttemptHash !== job.contentHash
  ) {
    throw new MonthlyReportDispatchError(
      409,
      "The saved report changed after preparation. Prepare it again before dispatch. No provider request was made.",
    );
  }

  const recipientHash = phoneFingerprint(recipientPhone);

  const claim = await actor.db.runTransaction(async (transaction) => {
    const [latestJobSnapshot, latestReportSnapshot, latestClassSnapshot] =
      await Promise.all([
        transaction.get(jobRef),
        transaction.get(reportRef),
        transaction.get(classRef),
      ]);

    if (!latestJobSnapshot.exists || !latestReportSnapshot.exists) {
      return "missing" as const;
    }

    const latestJob = latestJobSnapshot.data() ?? {};
    const latestReport = latestReportSnapshot.data() ?? {};
    const latestClassData = latestClassSnapshot.data();

    if (
      !latestClassSnapshot.exists ||
      !latestClassData ||
      !isRecord(latestClassData)
    ) {
      return "conflict" as const;
    }

    const latestStudent = readRoster(latestClassData).get(studentId);
    const latestPhone = latestStudent
      ? getConsentedGuardianPhone(latestStudent)
      : null;

    const latestClassName = clean(latestClassData.name) ||
      clean(latestClassData.className) ||
      clean(latestClassData.title) ||
      "Class";

    const latestContentHash = latestStudent
      ? calculateMonthlyReportContentHash(
          latestReport,
          latestClassName,
          latestStudent,
        )
      : null;

    if (
      !latestPhone ||
      phoneFingerprint(latestPhone) !== recipientHash ||
      typeof latestJob.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(latestJob.contentHash) ||
      latestJob.contentHash !== job.contentHash ||
      latestReport.whatsAppAttemptHash !== job.contentHash ||
      latestContentHash !== job.contentHash
    ) {
      return "conflict" as const;
    }

    if (
      latestJob.kind !== "monthly_report_pdf" ||
      latestJob.tenantId !== actor.email ||
      latestJob.status !== "prepared_for_vercel" ||
      latestJob.dispatchEnabled !== false ||
      latestReport.whatsAppStatus !== "prepared_for_vercel" ||
      latestReport.whatsAppJobId !== jobId ||
      clean(latestReport.lastWhatsAppAcceptedMonth) === monthKey
    ) {
      return "conflict" as const;
    }

    transaction.update(jobRef, {
      status: "dispatching",
      dispatchEnabled: true,
      recipientPhoneHash: recipientHash,
      dispatchStartedAt: FieldValue.serverTimestamp(),
      dispatchClaimedBy: actor.uid,
      dispatchAttemptCount: Number.isSafeInteger(latestJob.dispatchAttemptCount)
        ? Number(latestJob.dispatchAttemptCount) + 1
        : 1,
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.update(reportRef, {
      whatsAppStatus: "sending",
      whatsAppDispatchStartedAt: FieldValue.serverTimestamp(),
      whatsAppLastError: null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return "claimed" as const;
  });

  if (claim !== "claimed") {
    throw new MonthlyReportDispatchError(
      claim === "missing" ? 404 : 409,
      "The report could not be claimed. It may already be processing.",
    );
  }

  // Release a claim only before the external provider is invoked.
  const releaseClaimBeforeProvider = async (reason: string): Promise<boolean> => {
    try {
      return await actor.db.runTransaction(async (transaction) => {
        const [latestJobSnapshot, latestReportSnapshot] = await Promise.all([
          transaction.get(jobRef),
          transaction.get(reportRef),
        ]);

        if (!latestJobSnapshot.exists || !latestReportSnapshot.exists) {
          return false;
        }

        const latestJob = latestJobSnapshot.data() ?? {};
        const latestReport = latestReportSnapshot.data() ?? {};

        if (
          latestJob.status === "prepared_for_vercel" &&
          latestJob.dispatchEnabled === false &&
          latestReport.whatsAppStatus === "prepared_for_vercel" &&
          latestReport.whatsAppJobId === jobId
        ) {
          return true;
        }

        if (
          latestJob.status !== "dispatching" ||
          latestJob.dispatchEnabled !== true ||
          latestJob.tenantId !== actor.email ||
          latestReport.whatsAppStatus !== "sending" ||
          latestReport.whatsAppJobId !== jobId
        ) {
          return false;
        }

        transaction.update(jobRef, {
          status: "prepared_for_vercel",
          dispatchEnabled: false,
          recipientPhoneHash: FieldValue.delete(),
          dispatchPreparationError: reason.slice(0, 300),
          dispatchReleasedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        transaction.update(reportRef, {
          whatsAppStatus: "prepared_for_vercel",
          whatsAppLastError:
            `${reason} No provider request was made.`.slice(0, 500),
          updatedAt: FieldValue.serverTimestamp(),
        });

        return true;
      });
    } catch (error) {
      console.error(
        "[MonthlyReportDispatch] Safe pre-provider release failed; manual review required.",
        error,
      );
      return false;
    }
  };

  let mediaLink: Awaited<ReturnType<typeof createMonthlyReportMediaLink>>;

  try {
    mediaLink = await createMonthlyReportMediaLink({
      db: actor.db,
      tenantId: actor.email,
      jobId,
    });
  } catch (error) {
    const released = await releaseClaimBeforeProvider(
      "Signed media link creation failed.",
    );

    console.error(
      "[MonthlyReportDispatch] Signed media link creation failed.",
      error,
    );

    throw new MonthlyReportDispatchError(
      503,
      released
        ? "Secure report image access could not be prepared. No WhatsApp message was sent."
        : "Secure report image preparation failed. Manual review is required; no provider request was made.",
    );
  }

  // Re-read mutable data immediately before invoking the external provider.
  let preProviderFailure: string | null = null;

  try {
    const [latestJobSnapshot, latestClassSnapshot, latestReportSnapshot] =
      await Promise.all([
        jobRef.get(),
        classRef.get(),
        reportRef.get(),
      ]);

    const latestJob = latestJobSnapshot.data() ?? {};
    const latestClassData = latestClassSnapshot.data();
    const latestReport = latestReportSnapshot.data();

    if (
      !latestJobSnapshot.exists ||
      latestJob.status !== "dispatching" ||
      latestJob.dispatchEnabled !== true ||
      !latestClassSnapshot.exists ||
      !latestClassData ||
      !isRecord(latestClassData) ||
      !latestReportSnapshot.exists ||
      !latestReport ||
      !isRecord(latestReport)
    ) {
      preProviderFailure =
        "The dispatch state, class or saved report changed before provider invocation.";
    } else {
      const latestStudent = readRoster(latestClassData).get(studentId);
      const latestPhone = latestStudent
        ? getConsentedGuardianPhone(latestStudent)
        : null;

      if (
        !latestStudent ||
        !latestPhone ||
        phoneFingerprint(latestPhone) !== recipientHash
      ) {
        preProviderFailure =
          "Guardian consent or phone changed before provider invocation.";
      } else {
        const latestClassName = clean(latestClassData.name) ||
          clean(latestClassData.className) ||
          clean(latestClassData.title) ||
          "Class";

        const latestContentHash = calculateMonthlyReportContentHash(
          latestReport,
          latestClassName,
          latestStudent,
        );

        if (
          latestJob.tenantId !== actor.email ||
          latestJob.contentHash !== job.contentHash ||
          latestReport.whatsAppStatus !== "sending" ||
          latestReport.whatsAppJobId !== jobId ||
          latestReport.whatsAppAttemptHash !== job.contentHash ||
          latestContentHash !== job.contentHash
        ) {
          preProviderFailure =
            "The saved report changed before provider invocation. Prepare it again.";
        }
      }
    }
  } catch (error) {
    const released = await releaseClaimBeforeProvider(
      "Latest report or consent verification failed.",
    );

    console.error(
      "[MonthlyReportDispatch] Pre-provider verification failed.",
      error,
    );

    throw new MonthlyReportDispatchError(
      503,
      released
        ? "Current report verification failed. The claim was safely released; no provider request was made."
        : "Current report verification failed. Manual review is required; no provider request was made.",
    );
  }

  if (preProviderFailure) {
    const released = await releaseClaimBeforeProvider(preProviderFailure);

    throw new MonthlyReportDispatchError(
      released ? 409 : 503,
      released
        ? `${preProviderFailure} No provider request was made.`
        : "Pre-provider checks failed. Safe release could not be confirmed; manual review is required.",
    );
  }

  // A Web App response can indicate provider acceptance, but this is not
  // independent WhatsApp delivery confirmation. Never auto-retry after invocation.
  let providerHttpStatus: number | null = null;
  let providerMessageId: string | null = null;
  let providerStatus = "";
  let providerStatusCode: number | null = null;
  let providerAccepted = false;
  let senderIdentityMatched = sender.senderType === "central";
  let providerFromLast4: string | null = null;

  try {
    const result = await sendPostabiWebAppMessage({
      credentials: sender.credentials,
      to: recipientPhone,
      type: "image",
      url: mediaLink.url,
    });

    providerHttpStatus = result.httpStatus;
    providerStatus = result.providerStatus;
    providerStatusCode = result.providerStatusCode;
    providerMessageId = result.messageId;

    const providerFrom = normalizePhone(result.from);
    providerFromLast4 = providerFrom ? providerFrom.slice(-4) : null;

    senderIdentityMatched = providerFrom
      ? providerFrom === sender.senderNumber
      : sender.senderType === "central";

    providerAccepted = result.accepted && senderIdentityMatched;
  } catch (error) {
    console.warn(
      "[MonthlyReportDispatch] Provider request outcome is uncertain; automatic retry is blocked.",
      error instanceof Error ? error.name : "UnknownError",
    );
  }

  // Never claim accepted/delivered until Postabi confirms its /send-media
  // response schema and the applicable status lookup contract.
  await actor.db.runTransaction(async (transaction) => {
    const [latestJob, latestReport] = await Promise.all([
      transaction.get(jobRef),
      transaction.get(reportRef),
    ]);

    if (
      !latestJob.exists ||
      latestJob.data()?.status !== "dispatching" ||
      !latestReport.exists ||
      latestReport.data()?.whatsAppJobId !== jobId
    ) {
      throw new Error("Dispatch state changed after provider invocation; manual reconciliation is required.");
    }

    transaction.update(jobRef, {
      status: "unknown_outcome",
      dispatchEnabled: false,
      retrySafe: false,
      providerHttpStatus,
      providerMessageId,
      providerStatus: providerStatus || null,
      providerStatusCode,
      providerAccepted,
      providerSenderType: sender.senderType,
      providerSenderNumberLast4: sender.senderNumber.slice(-4),
      providerFromLast4,
      senderIdentityMatched,
      providerResponseContract: "postabi_webapp_send_message_v1",
      providerRespondedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.update(reportRef, {
      whatsAppStatus: "unknown_outcome",
      whatsAppRetrySafe: false,
      whatsAppProviderMessageId: providerMessageId,
      whatsAppProviderAccepted: providerAccepted,
      whatsAppSenderType: sender.senderType,
      whatsAppSenderNumberLast4: sender.senderNumber.slice(-4),
      whatsAppProviderFromLast4: providerFromLast4,
      whatsAppSenderIdentityMatched: senderIdentityMatched,
      whatsAppLastError: providerAccepted
        ? "Postabi accepted the report image request; WhatsApp delivery is not independently confirmed. Do not retry automatically."
        : "Provider acceptance or sender identity is unconfirmed. Do not retry automatically.",
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return {
    success: true,
    status: "unknown_outcome",
    jobId,
    providerHttpStatus,
    providerStatus,
    providerStatusCode,
    providerAccepted,
    senderType: sender.senderType,
    senderIdentityMatched,
    message: providerAccepted
      ? "Postabi accepted the report image request from the configured sender. WhatsApp delivery remains unconfirmed; check the provider dashboard before any retry."
      : "Provider acceptance or sender identity is unconfirmed. Check the provider dashboard before any retry.",
    messageSent: "unconfirmed",
    pdfDelivered: false, // Retained for response compatibility; the delivered media is now a PNG image.
  };
}

export function sendMonthlyReportDispatchApiError(
  res: {
    status(code: number): { json(data: unknown): unknown };
  },
  error: unknown,
) {
  if (
    error instanceof TeacherApiAuthError ||
    error instanceof MonthlyReportDispatchError
  ) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
    });
  }

  console.error("[MonthlyReportDispatch] Request failed.", error);

  return res.status(500).json({
    success: false,
    error: "The monthly report dispatch could not be completed.",
  });
}
