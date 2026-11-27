import { FieldValue } from "firebase-admin/firestore";
import type { DocumentData, UpdateData } from "firebase-admin/firestore";
import {
  verifyTeacherRequest,
  TeacherApiAuthError,
  type TeacherApiRequest,
} from "./teacherAuth.js";
import { decryptWhatsAppCredential } from "./adminWhatsApp.js";

type RecordLike = Record<string, unknown>;

export class AttendanceStatusError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "AttendanceStatusError";
  }
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validProviderDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    return null;
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;

  return new Date(milliseconds).toISOString();
}

export async function reconcileAttendanceStatus(
  request: TeacherApiRequest & { body?: unknown },
) {
  const actor = await verifyTeacherRequest(request);

  if (!isRecord(request.body)) {
    throw new AttendanceStatusError(400, "A valid JSON request body is required.");
  }

  const jobId = clean(request.body.jobId);

  if (!/^[a-f0-9]{64}$/i.test(jobId)) {
    throw new AttendanceStatusError(400, "The attendance job ID is invalid.");
  }

  const jobRef = actor.tenantRef
    .collection("whatsappNotificationJobs")
    .doc(jobId);

  const jobSnapshot = await jobRef.get();

  if (!jobSnapshot.exists) {
    throw new AttendanceStatusError(404, "The attendance notification job was not found.");
  }

  const job = jobSnapshot.data();

  if (
    !job ||
    job.kind !== "attendance_absent" ||
    job.tenantId !== actor.email
  ) {
    throw new AttendanceStatusError(404, "The attendance notification job was not found.");
  }

  if (job.status === "delivered") {
    return {
      success: true,
      status: "delivered",
      jobId,
      message: "Postabi delivery was already confirmed.",
      messageSent: true,
      deliveryConfirmed: true,
      providerStatus: "delivered",
    };
  }

  if (
    job.status !== "accepted_by_postabi" &&
    job.status !== "unknown_outcome"
  ) {
    throw new AttendanceStatusError(
      409,
      "This job has no eligible provider response to reconcile. Do not resend it automatically.",
    );
  }

  const httpStatus = job.providerHttpStatus;
  if (
    typeof httpStatus !== "number" ||
    httpStatus < 200 ||
    httpStatus >= 300
  ) {
    throw new AttendanceStatusError(
      409,
      "There is no successful HTTP response to reconcile. Review this job manually; do not resend it.",
    );
  }

  const messageId = clean(job.providerMessageId);

  if (job.providerResponseContract === "postabi_webapp_send_message_v1" && !messageId) {
    return {
      success: true,
      status: "unknown_outcome",
      jobId,
      message: "The Postabi Web App response did not include a message ID. Check the Postabi dashboard and guardian manually; do not resend.",
      messageSent: "unconfirmed",
      deliveryConfirmed: false,
      manualReviewRequired: true,
    };
  }

  if (!messageId || messageId.length > 200) {
    throw new AttendanceStatusError(
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
    throw new AttendanceStatusError(
      409,
      "The central Postabi configuration is disabled. Status lookup is unavailable.",
    );
  }

  const token = decryptWhatsAppCredential(settings);

  if (!token) {
    throw new AttendanceStatusError(
      409,
      "The saved Postabi API token is unavailable.",
    );
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
    throw new AttendanceStatusError(
      502,
      "Postabi status could not be reached. The existing send outcome remains unchanged.",
    );
  }

  const responseText = await response.text().catch(() => "");

  if (!response.ok) {
    throw new AttendanceStatusError(
      502,
      `Postabi status lookup failed (HTTP ${response.status}). No new message was sent.`,
    );
  }

  let payload: unknown = null;

  try {
    payload = JSON.parse(responseText.slice(0, 8192));
  } catch {
    payload = null;
  }

  if (
    !isRecord(payload) ||
    clean(payload.message_id) !== messageId ||
    typeof payload.status !== "string"
  ) {
    throw new AttendanceStatusError(
      502,
      "Postabi returned an unrecognized status response. The send outcome remains unchanged.",
    );
  }

  const providerStatus = clean(payload.status).toLowerCase().slice(0, 60);
  const readAt = validProviderDate(payload.read_at);
  const isDelivered = providerStatus === "delivered";

  const outcome = await actor.db.runTransaction(async (transaction) => {
    const latestSnapshot = await transaction.get(jobRef);

    if (!latestSnapshot.exists) return "missing" as const;

    const latest = latestSnapshot.data() ?? {};

    if (
      latest.tenantId !== actor.email ||
      latest.kind !== "attendance_absent" ||
      latest.providerMessageId !== messageId
    ) {
      return "conflict" as const;
    }

    if (latest.status === "delivered") return "delivered" as const;

    if (
      latest.status !== "accepted_by_postabi" &&
      latest.status !== "unknown_outcome"
    ) {
      return "conflict" as const;
    }

    if (
      typeof latest.providerHttpStatus !== "number" ||
      latest.providerHttpStatus < 200 ||
      latest.providerHttpStatus >= 300
    ) {
      return "conflict" as const;
    }

    const update: UpdateData<DocumentData> = {
      providerStatus,
      providerStatusCheckedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...(readAt ? { providerReadAt: readAt } : {}),
    };

    if (isDelivered) {
      Object.assign(update, {
        status: "delivered",
        dispatchEnabled: false,
        retrySafe: false,
        deliveredAt: FieldValue.serverTimestamp(),
        lastError: null,
      });
    }

    transaction.update(jobRef, update);

    return isDelivered ? "delivered" as const : "not_delivered" as const;
  });

  if (outcome === "missing" || outcome === "conflict") {
    throw new AttendanceStatusError(
      409,
      "The attendance job changed during reconciliation. Manual review is required.",
    );
  }

  if (outcome === "delivered") {
    return {
      success: true,
      status: "delivered",
      providerStatus,
      providerReadAt: readAt,
      jobId,
      message: "Postabi confirmed delivery of the attendance notification.",
      messageSent: true,
      deliveryConfirmed: true,
    };
  }

  return {
    success: true,
    status: job.status,
    providerStatus,
    providerReadAt: readAt,
    jobId,
    message: "Postabi has not returned the documented delivered state. Do not resend automatically.",
    messageSent: "unconfirmed",
    deliveryConfirmed: false,
  };
}

export function sendAttendanceStatusApiError(
  res: {
    status(code: number): { json(data: unknown): unknown };
  },
  error: unknown,
) {
  if (
    error instanceof TeacherApiAuthError ||
    error instanceof AttendanceStatusError
  ) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
    });
  }

  console.error("[AttendanceStatus] Reconciliation failed.", error);

  return res.status(500).json({
    success: false,
    error: "The attendance notification status could not be reconciled.",
  });
}
