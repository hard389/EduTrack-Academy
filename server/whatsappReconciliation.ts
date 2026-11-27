import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { verifyTeacherRequest, TeacherApiAuthError, type TeacherApiRequest } from "./teacherAuth.js";

type RecordLike = Record<string, unknown>;
type ReconcileRequest = TeacherApiRequest & { body?: unknown };

export class WhatsAppReconciliationError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "WhatsAppReconciliationError";
  }
}

const clean = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const isRecord = (value: unknown): value is RecordLike => typeof value === "object" && value !== null && !Array.isArray(value);

type ReconciliationOperator = { uid: string; email: string; role: "teacher" | "academy_admin" };
type TeacherWorkspaceActor = Awaited<ReturnType<typeof verifyTeacherRequest>>;

export async function reconcileWhatsAppNotification(request: ReconcileRequest) {
  const actor = await verifyTeacherRequest(request);
  return reconcileWhatsAppNotificationForActor(actor, request.body);
}

/**
 * Shared reconciliation core. Academy Admin calls this only after independently
 * verifying the teacher's active academy membership and workspace ownership.
 * The workspace actor remains the teacher so source queue ownership checks are unchanged;
 * operator metadata records the actual person who performed the review.
 */
export async function reconcileWhatsAppNotificationForActor(
  actor: TeacherWorkspaceActor,
  rawBody: unknown,
  operator?: ReconciliationOperator,
) {
  if (!isRecord(rawBody)) throw new WhatsAppReconciliationError(400, "A valid JSON request body is required.");
  const reconciledByUid = operator?.uid || actor.uid;
  const reconciledByEmail = operator?.email || actor.email;
  const reconciledByRole = operator?.role || "teacher";

  const alertId = clean(rawBody.alertId);
  const decision = clean(rawBody.decision);
  if (!/^wa_[a-f0-9]{48}$/.test(alertId)) throw new WhatsAppReconciliationError(400, "The WhatsApp alert ID is invalid.");
  if (decision !== "confirmed_sent" && decision !== "confirmed_not_sent") {
    throw new WhatsAppReconciliationError(400, "Choose either confirmed_sent or confirmed_not_sent.");
  }

  const alertRef = actor.tenantRef.collection("notifications").doc(alertId);
  const alertSnapshot = await alertRef.get();
  if (!alertSnapshot.exists || alertSnapshot.data()?.category !== "WhatsApp") {
    throw new WhatsAppReconciliationError(404, "The WhatsApp alert was not found in this teacher workspace.");
  }
  const alert = alertSnapshot.data() ?? {};
  const resolvedState = clean(alert.whatsappReconciliationStatus);
  if (resolvedState === "resolved_sent" || resolvedState === "requeued") {
    return { success: true, status: resolvedState, message: "This alert has already been reconciled." };
  }

  const queueType = clean(alert.whatsappQueueType);
  const sourceCollection = clean(alert.whatsappSourceCollection);
  const jobId = clean(alert.whatsappJobId);
  const dispatchId = clean(alert.whatsappDispatchId);
  const recipientId = clean(alert.whatsappRecipientId);
  if (!jobId || jobId.includes("/") || (dispatchId && dispatchId.includes("/")) || (recipientId && recipientId.includes("/"))) {
    throw new WhatsAppReconciliationError(409, "The saved queue reference is incomplete. Contact the administrator; no retry was made.");
  }

  let sourceRef: DocumentReference;
  let parentRef: DocumentReference | null = null;
  let reportRef: DocumentReference | null = null;
  let expectedSourceStatuses: string[];

  if (queueType === "notification_job" && sourceCollection === "whatsappNotificationJobs") {
    sourceRef = actor.tenantRef.collection(sourceCollection).doc(jobId);
    expectedSourceStatuses = ["unknown_outcome", "provider_rejected", "dispatching", "failed"];
  } else if (queueType === "fee_job" && sourceCollection === "feeAlertNotificationJobs") {
    sourceRef = actor.tenantRef.collection(sourceCollection).doc(jobId);
    expectedSourceStatuses = ["unknown_outcome", "provider_rejected", "blocked", "sending"];
  } else if (
    queueType === "announcement_recipient" && sourceCollection === "whatsappAnnouncementDispatches" && dispatchId && recipientId
  ) {
    parentRef = actor.tenantRef.collection(sourceCollection).doc(dispatchId);
    sourceRef = parentRef.collection("recipients").doc(recipientId);
    expectedSourceStatuses = ["unknown_outcome", "provider_rejected", "dispatching"];
  } else if (
    queueType === "quiz_recipient" && sourceCollection === "whatsappQuizResultDispatches" && dispatchId && recipientId
  ) {
    parentRef = actor.tenantRef.collection(sourceCollection).doc(dispatchId);
    sourceRef = parentRef.collection("recipients").doc(recipientId);
    expectedSourceStatuses = ["unknown_outcome", "provider_rejected", "dispatching", "pre_provider_blocked"];
  } else if (
    queueType === "library_recipient" && sourceCollection === "whatsappLibraryLinkDispatches" && dispatchId && recipientId
  ) {
    parentRef = actor.tenantRef.collection(sourceCollection).doc(dispatchId);
    sourceRef = parentRef.collection("recipients").doc(recipientId);
    expectedSourceStatuses = ["unknown_outcome", "provider_rejected", "dispatching"];
  } else {
    throw new WhatsAppReconciliationError(409, "This alert does not reference a supported WhatsApp queue record.");
  }

  await actor.db.runTransaction(async (transaction) => {
    const reads = await Promise.all([
      transaction.get(sourceRef),
      ...(parentRef ? [transaction.get(parentRef)] : []),
    ]);
    const sourceSnapshot = reads[0];
    const parentSnapshot = parentRef ? reads[1] : null;
    if (!sourceSnapshot.exists) throw new WhatsAppReconciliationError(404, "The referenced WhatsApp queue record no longer exists.");
    if (parentRef && (!parentSnapshot?.exists || parentSnapshot.data()?.tenantId !== actor.email || parentSnapshot.data()?.teacherUid !== actor.uid)) {
      throw new WhatsAppReconciliationError(403, "The dispatch does not belong to the active teacher workspace.");
    }
    const source = sourceSnapshot.data() ?? {};
    const status = clean(source.status);
    if ((status === "pre_provider_blocked" || (status === "failed" && source.retrySafe === true)) && decision === "confirmed_sent") {
      throw new WhatsAppReconciliationError(409, "This job was blocked before the WhatsApp provider was called, so it cannot be confirmed as sent. Choose verified not sent to return it to the queue.");
    }
    if (status === "failed" && source.retrySafe !== true && decision === "confirmed_not_sent") {
      throw new WhatsAppReconciliationError(409, "This failed job is not marked as a safe pre-provider failure. Check the provider before retrying.");
    }
    if (status === "operator_confirmed_sent" || status === "manually_reconciled_sent") return;
    if (status === "pending" || status === "queued" || status === "prepared_for_vercel" || status === "accepted_by_postabi" || status === "accepted_by_provider") {
      throw new WhatsAppReconciliationError(409, "This queue item is no longer in an uncertain/failed state. Refresh Alerts And Notification before changing it.");
    }
    if (!expectedSourceStatuses.includes(status)) {
      throw new WhatsAppReconciliationError(409, `This job is currently ${status || "unknown"} and cannot be reconciled from this alert.`);
    }

    const reconciliation = {
      reconciledAt: FieldValue.serverTimestamp(),
      reconciledByUid,
      reconciledByEmail,
      reconciledByRole,
      reconciliationDecision: decision,
      retrySafe: decision === "confirmed_not_sent",
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (decision === "confirmed_sent") {
      transaction.update(sourceRef, {
        status: "operator_confirmed_sent",
        dispatchEnabled: false,
        retrySafe: false,
        ...reconciliation,
      });
      if (parentRef) {
        const parent = parentSnapshot?.data() ?? {};
        const pendingCount = Math.max(0, Number(parent.pendingCount ?? 0));
        const retryWaitCount = Math.max(0, Number(parent.retryWaitCount ?? 0));
        const dispatchingCount = Math.max(0, Number(parent.dispatchingCount ?? 0));
        const nextParentStatus = queueType === "quiz_recipient"
          ? pendingCount > 0 ? "prepared" : dispatchingCount > 0 ? "dispatching" : "needs_review"
          : pendingCount > 0 || retryWaitCount > 0 ? "pending" : dispatchingCount > 0 ? "dispatching" : "needs_review";
        transaction.set(parentRef, {
          status: nextParentStatus,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    } else {
      const nextStatus = queueType === "notification_job"
        ? "prepared_for_vercel"
        : queueType === "fee_job"
          ? "pending"
          : queueType === "quiz_recipient"
            ? "queued"
            : "pending";
      transaction.update(sourceRef, {
        status: nextStatus,
        dispatchEnabled: false,
        retrySafe: false,
        operatorConfirmedNotSent: true,
        operatorRetryApprovedAt: FieldValue.serverTimestamp(),
        providerMessageId: FieldValue.delete(),
        providerHttpStatus: FieldValue.delete(),
        providerStatus: FieldValue.delete(),
        providerStatusCode: FieldValue.delete(),
        providerAccepted: FieldValue.delete(),
        dispatchStartedAt: FieldValue.delete(),
        startedAt: FieldValue.delete(),
        dispatchLeaseExpiresAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
        ...reconciliation,
      });
      if (parentRef) {
        transaction.set(parentRef, {
          status: queueType === "quiz_recipient" ? "dispatching" : "pending",
          ...(queueType === "quiz_recipient" ? { pendingCount: FieldValue.increment(1) } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }

    if (queueType === "notification_job" && source.kind === "monthly_report_pdf") {
      const classId = clean(source.classId);
      const studentId = clean(source.studentId);
      const monthKey = clean(source.monthKey);
      if (classId && studentId && monthKey) {
        reportRef = actor.tenantRef.collection("classes").doc(classId).collection("reports").doc(`${studentId}_${monthKey}`);
        transaction.update(reportRef, decision === "confirmed_sent" ? {
          whatsAppStatus: "operator_confirmed_sent",
          whatsAppRetrySafe: false,
          whatsAppLastError: "An operator confirmed the provider record; delivery was not independently verified by EduTrack.",
          updatedAt: FieldValue.serverTimestamp(),
        } : {
          whatsAppStatus: "prepared_for_vercel",
          whatsAppRetrySafe: false,
          whatsAppLastError: "An operator confirmed the previous attempt was not sent. The persistent queue may retry this same locked report payload.",
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }
  });

  await alertRef.update({
    isRead: true,
    whatsappReconciliationStatus: decision === "confirmed_sent" ? "resolved_sent" : "requeued",
    whatsappReconciliationDecision: decision,
    whatsappReconciledAt: FieldValue.serverTimestamp(),
    whatsappReconciledByUid: reconciledByUid,
    whatsappReconciledByEmail: reconciledByEmail,
    whatsappReconciledByRole: reconciledByRole,
    whatsappRetrySafe: decision === "confirmed_not_sent",
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    success: true,
    status: decision === "confirmed_sent" ? "resolved_sent" : "requeued",
    message: decision === "confirmed_sent"
      ? "Recorded as manually confirmed sent. EduTrack will not send it again."
      : "Recorded as confirmed not sent. The same persistent queue item was returned to the worker; it will be revalidated before sending.",
  };
}

export function sendWhatsAppReconciliationApiError(
  res: { status(code: number): { json(body: unknown): unknown } },
  error: unknown,
): unknown {
  const status = error instanceof TeacherApiAuthError || error instanceof WhatsAppReconciliationError
    ? error.status : 500;
  if (status >= 500) console.error("[WhatsAppReconciliation] Reconciliation failed.", error instanceof Error ? error.name : "UnknownError");
  const message = error instanceof TeacherApiAuthError || error instanceof WhatsAppReconciliationError
    ? error.message : "WhatsApp reconciliation could not be completed.";
  return res.status(status).json({ success: false, error: message });
}
