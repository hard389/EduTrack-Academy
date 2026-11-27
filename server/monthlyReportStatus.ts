import {
  isMonthlyReportWhatsAppEnabled,
  MONTHLY_REPORT_WHATSAPP_DISABLED_MESSAGE,
} from "./monthlyReportFeature.js";
import { FieldValue } from "firebase-admin/firestore";
import {
  verifyTeacherRequest,
  TeacherApiAuthError,
  type TeacherApiRequest,
} from "./teacherAuth.js";
import { decryptWhatsAppCredential } from "./adminWhatsApp.js";

type RecordLike = Record<string, unknown>;

export class MonthlyReportStatusError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "MonthlyReportStatusError";
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

export async function reconcileMonthlyReportStatus(
  request: TeacherApiRequest & { body?: unknown },
) {
  const actor = await verifyTeacherRequest(request);

  if (!isMonthlyReportWhatsAppEnabled()) {
    throw new MonthlyReportStatusError(
      503,
      MONTHLY_REPORT_WHATSAPP_DISABLED_MESSAGE,
    );
  }

  if (!isRecord(request.body)) {
    throw new MonthlyReportStatusError(400, "A valid JSON request body is required.");
  }

  const jobId = clean(request.body.jobId);

  if (!/^[a-f0-9]{64}$/i.test(jobId)) {
    throw new MonthlyReportStatusError(400, "The monthly report job ID is invalid.");
  }

  const jobRef = actor.tenantRef
    .collection("whatsappNotificationJobs")
    .doc(jobId);

  const jobSnapshot = await jobRef.get();

  if (!jobSnapshot.exists) {
    throw new MonthlyReportStatusError(404, "The monthly report job was not found.");
  }

  const job = jobSnapshot.data();

  if (
    !job ||
    job.kind !== "monthly_report_pdf" ||
    job.tenantId !== actor.email
  ) {
    throw new MonthlyReportStatusError(404, "The monthly report job was not found.");
  }

  if (job.status === "delivered") {
    return {
      success: true,
      status: "delivered",
      jobId,
      message: "Provider delivery was already confirmed.",
      messageSent: true,
      pdfDelivered: true,
    };
  }

  // The legacy Web App send response often has no message ID. In that case,
  // do not call the separate Bearer-token REST status API; require manual review.
  // If Postabi supplies a message ID, the documented REST status lookup may be used.
  if (
    job.providerResponseContract === "postabi_webapp_send_message_v1" &&
    !clean(job.providerMessageId)
  ) {
    return {
      success: true,
      status: "unknown_outcome",
      jobId,
      message:
        "This Web App send has no usable message ID for the legacy status lookup. Check the provider dashboard and recipient manually; do not resend.",
      messageSent: "unconfirmed",
      pdfDelivered: false,
      manualReviewRequired: true,
    };
  }

  if (
    job.status !== "unknown_outcome" ||
    typeof job.providerHttpStatus !== "number" ||
    job.providerHttpStatus < 200 ||
    job.providerHttpStatus >= 300
  ) {
    throw new MonthlyReportStatusError(
      409,
      "This job has no eligible provider response to reconcile. Do not resend it automatically.",
    );
  }

  const messageId = clean(job.providerMessageId);

  if (!messageId || messageId.length > 200) {
    throw new MonthlyReportStatusError(
      409,
      "Postabi did not provide a usable message ID. Check the provider dashboard manually; do not resend.",
    );
  }

  const settingsSnapshot = await actor.db
    .collection("platformSettings")
    .doc("whatsapp")
    .get();

  const settings = settingsSnapshot.data() ?? {};

  if (settings.enabled !== true) {
    throw new MonthlyReportStatusError(409, "The central Postabi configuration is disabled.");
  }

  const token = decryptWhatsAppCredential(settings);

  if (!token) {
    throw new MonthlyReportStatusError(409, "The saved Postabi API token is unavailable.");
  }

  let response: Response;

  try {
    response = await fetch(
      `https://webapi.postabi.com/api/v1/status/${encodeURIComponent(messageId)}`,
      {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(12000),
      },
    );
  } catch {
    throw new MonthlyReportStatusError(
      502,
      "Postabi status could not be reached. The existing send outcome remains unknown.",
    );
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new MonthlyReportStatusError(
      502,
      `Postabi status lookup failed (HTTP ${response.status}). No new message was sent.`,
    );
  }

  if (
    !isRecord(payload) ||
    clean(payload.message_id) !== messageId ||
    typeof payload.status !== "string"
  ) {
    throw new MonthlyReportStatusError(
      502,
      "Postabi returned an unrecognized status response. The send outcome remains unknown.",
    );
  }

  const providerStatus = clean(payload.status).toLowerCase();

  // Only the exact documented delivery state is treated as confirmed.
  if (providerStatus !== "delivered") {
    return {
      success: true,
      status: "unknown_outcome",
      providerStatus: providerStatus.slice(0, 60),
      jobId,
      message: "Postabi has not returned the documented delivered state. Do not resend automatically.",
      messageSent: "unconfirmed",
      pdfDelivered: false,
    };
  }

  const classId = clean(job.classId);
  const studentId = clean(job.studentId);
  const monthKey = clean(job.monthKey);

  if (
    !classId || classId.includes("/") ||
    !studentId || studentId.includes("/") ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)
  ) {
    throw new MonthlyReportStatusError(409, "The saved report job metadata is invalid.");
  }

  const reportRef = actor.tenantRef
    .collection("classes")
    .doc(classId)
    .collection("reports")
    .doc(`${studentId}_${monthKey}`);

  const outcome = await actor.db.runTransaction(async (transaction) => {
    const [latestJobSnapshot, latestReportSnapshot] = await Promise.all([
      transaction.get(jobRef),
      transaction.get(reportRef),
    ]);

    if (!latestJobSnapshot.exists || !latestReportSnapshot.exists) {
      return "missing" as const;
    }

    const latestJob = latestJobSnapshot.data() ?? {};
    const latestReport = latestReportSnapshot.data() ?? {};

    if (
      latestJob.providerMessageId !== messageId ||
      latestJob.kind !== "monthly_report_pdf" ||
      latestJob.tenantId !== actor.email
    ) {
      return "conflict" as const;
    }

    if (latestJob.status === "delivered") {
      return "delivered" as const;
    }

    if (
      latestJob.status !== "unknown_outcome" ||
      latestReport.whatsAppJobId !== jobId ||
      latestReport.whatsAppStatus !== "unknown_outcome"
    ) {
      return "conflict" as const;
    }

    transaction.update(jobRef, {
      status: "delivered",
      dispatchEnabled: false,
      retrySafe: false,
      providerStatus: "delivered",
      deliveredAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.update(reportRef, {
      whatsAppStatus: "delivered",
      lastWhatsAppAcceptedMonth: monthKey,
      lastWhatsAppDeliveredMonth: monthKey,
      whatsAppLastDeliveredAt: FieldValue.serverTimestamp(),
      whatsAppRetrySafe: false,
      whatsAppLastError: null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return "delivered" as const;
  });

  if (outcome !== "delivered") {
    throw new MonthlyReportStatusError(
      409,
      "The report changed during reconciliation. Manual review is required.",
    );
  }

  return {
    success: true,
    status: "delivered",
    jobId,
    message: "Postabi confirmed delivery of the monthly report.",
    messageSent: true,
    pdfDelivered: true,
  };
}

export function sendMonthlyReportStatusApiError(
  res: {
    status(code: number): { json(data: unknown): unknown };
  },
  error: unknown,
) {
  if (
    error instanceof TeacherApiAuthError ||
    error instanceof MonthlyReportStatusError
  ) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
    });
  }

  console.error("[MonthlyReportStatus] Reconciliation failed.", error);

  return res.status(500).json({
    success: false,
    error: "The monthly report status could not be reconciled.",
  });
}
