import { createHash, randomUUID } from "node:crypto";
import { FieldPath, FieldValue, Timestamp, type DocumentReference, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { getFirebaseAdminFirestore } from "./firebaseAdmin.js";
import { dispatchAttendanceNotification } from "./attendanceDispatch.js";
import { dispatchMonthlyReportPdf } from "./monthlyReportDispatch.js";
import { dispatchAnnouncementWhatsApp } from "./announcementsWhatsApp.js";
import { dispatchQuizResultsWhatsApp } from "./quizResultsWhatsApp.js";
import { dispatchLibraryLinkWhatsApp } from "./libraryLinkWhatsApp.js";
import type { TeacherApiRequest } from "./teacherAuth.js";

type QueueTask = { tenantEmail: string; label: string; run: () => Promise<unknown> };

const STALE_CLAIM_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 10;
const DEFAULT_TENANT_BATCHES_PER_RUN = 1;
const MAX_TENANT_BATCHES_PER_RUN = 4;
const DEFAULT_MAX_TENANTS_PER_RUN = 1;
const MAX_TENANTS_PER_RUN = 5;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_QUERY_PAGES_PER_PASS = 1;
const LOCK_LEASE_MS = 110_000;

const clean = (value: unknown): string => typeof value === "string" ? value.trim() : "";
function boundedEnvInteger(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function timestampMillis(value: unknown): number {
  if (value && typeof value === "object" && "toMillis" in value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    try { return (value as { toMillis: () => number }).toMillis(); } catch { return 0; }
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return 0;
}

// Process a bounded page per maintenance pass. Persistent records remain in
// Firestore and stale claims are moved out of the matching query as they are repaired.
async function forEachQueryPage(
  query: Query,
  pageSize: number,
  visit: (docs: QueryDocumentSnapshot[]) => Promise<void>,
  maxPages = MAX_QUERY_PAGES_PER_PASS,
): Promise<void> {
  let cursor: QueryDocumentSnapshot | null = null;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const pageQuery = cursor ? query.startAfter(cursor) : query;
    const page = await pageQuery.limit(pageSize).get();
    if (page.empty) break;
    await visit(page.docs);
    if (page.size < pageSize) break;
    cursor = page.docs[page.docs.length - 1];
  }
}

function internalRequest(tenantEmail: string, body: unknown): TeacherApiRequest & { body: unknown } {
  const secret = process.env.WHATSAPP_QUEUE_WORKER_SECRET?.trim() ?? "";
  return {
    headers: {
      "x-edutrack-worker-secret": secret,
      "x-edutrack-tenant": tenantEmail,
    },
    body,
  };
}

function stableAlertId(source: string): string {
  return `wa_${createHash("sha256").update(`edutrack-whatsapp-alert:v1:${source}`).digest("hex").slice(0, 48)}`;
}

async function upsertFailureAlert(input: {
  tenantRef: DocumentReference;
  tenantEmail: string;
  sourceKey: string;
  queueType: string;
  sourceCollection: string;
  jobId: string;
  dispatchId?: string;
  recipientId?: string;
  kind: string;
  status: string;
  last4?: string;
  targetClass?: string;
  reason?: string;
  retrySafe?: boolean;
  providerMessageId?: string;
}): Promise<void> {
  const alertRef = input.tenantRef.collection("notifications").doc(stableAlertId(input.sourceKey));
  const existing = await alertRef.get();
  const current = existing.data() ?? {};
  if (current.whatsappReconciliationStatus === "resolved_sent" ||
      current.whatsappReconciliationStatus === "requeued") {
    // Keep an operator's explicit reconciliation decision stable. A later independent
    // failure has a new sourceKey/attempt key and therefore creates a new alert.
    return;
  }
  const statusLabel = input.status.replace(/_/g, " ");
  const payload = {
    category: "WhatsApp",
    title: `WhatsApp ${input.kind.replace(/_/g, " ")} needs attention`,
    message: input.reason?.slice(0, 450) || `A WhatsApp notification is ${statusLabel}. Check the provider dashboard before deciding whether it is safe to retry.`,
    targetClass: input.targetClass || "WhatsApp queue",
    sender: "EduTrack WhatsApp Queue",
    priority: input.status === "unknown_outcome" || input.status === "dispatching" ? "high" : "medium",
    whatsappKind: input.kind,
    whatsappJobId: input.jobId,
    whatsappDispatchId: input.dispatchId ?? null,
    whatsappRecipientId: input.recipientId ?? null,
    whatsappQueueType: input.queueType,
    whatsappSourceCollection: input.sourceCollection,
    whatsappSourceStatus: input.status,
    whatsappRecipientLast4: input.last4 ?? null,
    whatsappProviderMessageId: input.providerMessageId ?? null,
    whatsappRetrySafe: input.retrySafe === true,
    whatsappReconciliationRequired: ["unknown_outcome", "dispatching", "pre_provider_blocked", "failed", "provider_rejected"].includes(input.status),
    whatsappReconciliationStatus: null,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (!existing.exists) {
    await alertRef.create({
      ...payload,
      isRead: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  } else {
    const sourceChanged = current.whatsappSourceStatus !== input.status;
    // This alert is a materialized view of the queue item. The read above already
    // provides every field needed to avoid rewriting an unchanged alert on each poll.
    const payloadUnchanged = Object.entries(payload).every(([key, value]) => {
      if (key === "updatedAt") return true;
      return current[key] === value;
    });
    if (payloadUnchanged && !sourceChanged) return;
    await alertRef.update({
      ...payload,
      ...(sourceChanged ? { isRead: false, createdAt: FieldValue.serverTimestamp() } : {}),
    });
  }
}

async function resolveWorkerFailureAlert(tenantRef: DocumentReference, sourceKey: string): Promise<void> {
  const alertRef = tenantRef.collection("notifications").doc(stableAlertId(sourceKey));
  const snapshot = await alertRef.get();
  if (!snapshot.exists || snapshot.data()?.whatsappReconciliationStatus) return;
  await alertRef.update({
    whatsappReconciliationStatus: "resolved_automatically",
    whatsappReconciliationRequired: false,
    isRead: true,
    message: "The persistent WhatsApp queue resumed processing this item. No manual retry was performed.",
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function staleNotificationJobs(tenantRef: DocumentReference): Promise<number> {
  let changed = 0;
  const query = tenantRef.collection("whatsappNotificationJobs")
    .where("status", "==", "dispatching")
    .orderBy(FieldPath.documentId());
  await forEachQueryPage(query, 25, async (docs) => {
    for (const doc of docs) {
      const job = doc.data() ?? {};
      const startedAt = timestampMillis(job.dispatchStartedAt);
      if (!startedAt || Date.now() - startedAt < STALE_CLAIM_MS) continue;
      await doc.ref.update({
        status: "unknown_outcome",
        dispatchEnabled: false,
        retrySafe: false,
        lastError: "Worker claim expired after the provider dispatch began. The send outcome is unknown; automatic retry was blocked to prevent duplicates.",
        staleClaimDetectedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (job.kind === "monthly_report_pdf") {
        const classId = clean(job.classId);
        const studentId = clean(job.studentId);
        const monthKey = clean(job.monthKey);
        if (classId && studentId && monthKey) {
          await tenantRef.collection("classes").doc(classId).collection("reports")
            .doc(`${studentId}_${monthKey}`).update({
              whatsAppStatus: "unknown_outcome",
              whatsAppRetrySafe: false,
              whatsAppLastError: "The worker claim expired after dispatch began. Check Postabi before deciding whether to retry.",
              updatedAt: FieldValue.serverTimestamp(),
            }).catch(() => undefined);
        }
      }
      changed += 1;
    }
  });
  return changed;
}

async function staleFeeJobs(tenantRef: DocumentReference): Promise<number> {
  let changed = 0;
  const query = tenantRef.collection("feeAlertNotificationJobs")
    .where("status", "==", "sending")
    .orderBy(FieldPath.documentId());
  await forEachQueryPage(query, 25, async (docs) => {
    for (const doc of docs) {
      const job = doc.data() ?? {};
      const startedAt = timestampMillis(job.dispatchStartedAt);
      if (!startedAt || Date.now() - startedAt < STALE_CLAIM_MS) continue;
      await doc.ref.update({
        status: "unknown_outcome", dispatchEnabled: false, retrySafe: false,
        outcomeReason: "Worker claim expired after provider dispatch began. Automatic retry was blocked to prevent duplicates.",
        staleClaimDetectedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      changed += 1;
    }
  });
  return changed;
}

async function staleRecipientClaims(
  tenantRef: DocumentReference,
  collectionName: "whatsappAnnouncementDispatches" | "whatsappQuizResultDispatches" | "whatsappLibraryLinkDispatches",
): Promise<number> {
  let changed = 0;
  const dispatchQuery = tenantRef.collection(collectionName)
    .where("status", "in", ["pending", "prepared", "dispatching", "needs_review"])
    .orderBy(FieldPath.documentId());
  await forEachQueryPage(dispatchQuery, 2, async (dispatchDocs) => {
    for (const dispatchDoc of dispatchDocs) {
      const recipientQuery = dispatchDoc.ref.collection("recipients")
        .where("status", "==", "dispatching")
        .orderBy(FieldPath.documentId());
      await forEachQueryPage(recipientQuery, 5, async (recipientDocs) => {
        for (const recipientDoc of recipientDocs) {
          const recipient = recipientDoc.data() ?? {};
          const startedAt = timestampMillis(recipient.dispatchStartedAt ?? recipient.startedAt);
          if (!startedAt || Date.now() - startedAt < STALE_CLAIM_MS) continue;
          await recipientDoc.ref.update({
            status: "unknown_outcome", retrySafe: false,
            outcomeReason: "The worker claim expired after provider dispatch began. Check provider records before any retry.",
            completedAt: FieldValue.serverTimestamp(),
            dispatchLeaseExpiresAt: FieldValue.delete(),
            staleClaimDetectedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          });
          changed += 1;
        }
      });

      // A stale in-flight recipient must not strand the rest of the same broadcast.
      // Recompute the parent state from its persistent child records after stale claims
      // have been marked unknown_outcome.
      const recipientsRef = dispatchDoc.ref.collection("recipients");
      const quizQueue = collectionName === "whatsappQuizResultDispatches";
      const [pending, retryWait, dispatching, failed] = await Promise.all([
        recipientsRef.where("status", "==", quizQueue ? "queued" : "pending").limit(1).get(),
        recipientsRef.where("status", "==", "retry_wait").limit(1).get(),
        recipientsRef.where("status", "==", "dispatching").limit(1).get(),
        recipientsRef.where("status", "in", ["unknown_outcome", "provider_rejected", "pre_provider_blocked"]).limit(1).get(),
      ]);
      const nextStatus = !pending.empty || !retryWait.empty
        ? (quizQueue ? "prepared" : "pending")
        : !dispatching.empty ? "dispatching"
        : !failed.empty ? "needs_review" : "completed";
      await dispatchDoc.ref.set({
        status: nextStatus,
        ...(nextStatus === "completed" || nextStatus === "needs_review" ? { completedAt: FieldValue.serverTimestamp() } : {}),
        staleClaimsLastReconciledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  });
  return changed;
}

async function syncTopLevelFailures(tenantRef: DocumentReference, tenantEmail: string): Promise<number> {
  let count = 0;
  const notificationQuery = tenantRef.collection("whatsappNotificationJobs")
    .where("status", "in", ["unknown_outcome", "provider_rejected", "failed", "blocked"])
    .orderBy(FieldPath.documentId());
  await forEachQueryPage(notificationQuery, 20, async (docs) => {
    for (const doc of docs) {
      const job = doc.data() ?? {};
      await upsertFailureAlert({
        tenantRef, tenantEmail,
        sourceKey: `notification_job:${doc.id}:${clean(job.status)}:${Number(job.attemptCount ?? job.dispatchAttemptCount ?? 0)}:${timestampMillis(job.updatedAt)}`,
        queueType: "notification_job", sourceCollection: "whatsappNotificationJobs",
        jobId: doc.id, kind: clean(job.kind) || "notification", status: clean(job.status),
        last4: clean(job.providerRecipientLast4 ?? job.recipientLast4),
        targetClass: clean(job.className) || clean(job.classId),
        reason: clean(job.lastError) || "The notification did not reach a confirmed provider-accepted state. Check the provider record before retrying.",
        retrySafe: job.retrySafe === true, providerMessageId: clean(job.providerMessageId),
      });
      count += 1;
    }
  });

  const feePreProviderQuery = tenantRef.collection("feeAlertNotificationJobs")
    .where("lastPreProviderFailureAt", ">", Timestamp.fromMillis(0))
    .orderBy("lastPreProviderFailureAt")
    .orderBy(FieldPath.documentId());
  await forEachQueryPage(feePreProviderQuery, 20, async (docs) => {
    for (const doc of docs) {
      const job = doc.data() ?? {};
      const sourceKey = `fee_job_pre_provider:${doc.id}`;
      if (job.status === "pending" && job.retrySafe === true) {
        await upsertFailureAlert({
          tenantRef, tenantEmail, sourceKey,
          queueType: "fee_job", sourceCollection: "feeAlertNotificationJobs",
          jobId: doc.id, kind: "fee_due_reminder", status: "queue_processing_error",
          last4: clean(job.recipientLast4), targetClass: clean(job.className),
          reason: clean(job.lastPreProviderFailureReason ?? job.outcomeReason) || "A fee reminder could not be prepared before the provider was called. It remains queued and will be revalidated before a safe retry.",
          retrySafe: true,
        });
      } else if (["accepted_by_provider", "provider_rejected", "unknown_outcome", "blocked", "blocked_subscription", "expired"].includes(clean(job.status))) {
        await resolveWorkerFailureAlert(tenantRef, sourceKey);
      }
    }
  });

  const feeFailureQuery = tenantRef.collection("feeAlertNotificationJobs")
    .where("status", "in", ["unknown_outcome", "provider_rejected", "blocked", "blocked_subscription"])
    .orderBy(FieldPath.documentId());
  await forEachQueryPage(feeFailureQuery, 20, async (docs) => {
    for (const doc of docs) {
      const job = doc.data() ?? {};
      if (job.retrySafe === true && job.status === "blocked") continue;
      await upsertFailureAlert({
        tenantRef, tenantEmail,
        sourceKey: `fee_job:${doc.id}:${clean(job.status)}:${Number(job.attemptCount ?? 0)}:${timestampMillis(job.updatedAt)}`,
        queueType: "fee_job", sourceCollection: "feeAlertNotificationJobs",
        jobId: doc.id, kind: "fee_due_reminder", status: clean(job.status),
        last4: clean(job.recipientLast4), targetClass: clean(job.className),
        reason: clean(job.outcomeReason) || "The fee reminder needs provider review before another send.",
        retrySafe: job.retrySafe === true, providerMessageId: clean(job.providerMessageId),
      });
      count += 1;
    }
  });
  return count;
}

async function syncRecipientFailures(
  tenantRef: DocumentReference,
  tenantEmail: string,
  collectionName: "whatsappAnnouncementDispatches" | "whatsappQuizResultDispatches" | "whatsappLibraryLinkDispatches",
  queueType: "announcement_recipient" | "quiz_recipient" | "library_recipient",
  kind: string,
): Promise<number> {
  let count = 0;
  const dispatchQuery = tenantRef.collection(collectionName)
    .where("status", "in", ["needs_review", "pending", "prepared", "dispatching"])
    .orderBy(FieldPath.documentId());
  await forEachQueryPage(dispatchQuery, 2, async (dispatchDocs) => {
    for (const dispatchDoc of dispatchDocs) {
      const recipientQuery = dispatchDoc.ref.collection("recipients")
        .where("status", "in", ["unknown_outcome", "provider_rejected", "pre_provider_blocked"])
        .orderBy(FieldPath.documentId());
      await forEachQueryPage(recipientQuery, 5, async (recipientDocs) => {
        for (const recipientDoc of recipientDocs) {
          const recipient = recipientDoc.data() ?? {};
          const status = clean(recipient.status);
          await upsertFailureAlert({
            tenantRef, tenantEmail,
            sourceKey: `${queueType}:${dispatchDoc.id}:${recipientDoc.id}:${status}:${Number(recipient.attemptCount ?? 0)}:${timestampMillis(recipient.completedAt)}`,
            queueType, sourceCollection: collectionName,
            jobId: recipientDoc.id, dispatchId: dispatchDoc.id, recipientId: recipientDoc.id,
            kind, status,
            last4: clean(recipient.recipientLast4 ?? recipient.providerRecipientLast4),
            targetClass: clean(dispatchDoc.data()?.targetClass ?? dispatchDoc.data()?.className ?? dispatchDoc.data()?.classId),
            reason: clean(recipient.outcomeReason ?? recipient.providerErrorName) || "The provider rejected the message or its outcome is unknown. Verify provider records before retrying.",
            retrySafe: recipient.retrySafe === true, providerMessageId: clean(recipient.providerMessageId),
          });
          count += 1;
        }
      });
    }
  });
  return count;
}

async function processTenantFailures(tenantRef: DocumentReference, tenantEmail: string): Promise<number> {
  const results = await Promise.all([
    syncTopLevelFailures(tenantRef, tenantEmail),
    syncRecipientFailures(tenantRef, tenantEmail, "whatsappAnnouncementDispatches", "announcement_recipient", "announcement"),
    syncRecipientFailures(tenantRef, tenantEmail, "whatsappQuizResultDispatches", "quiz_recipient", "quiz_result"),
    syncRecipientFailures(tenantRef, tenantEmail, "whatsappLibraryLinkDispatches", "library_recipient", "library_link"),
  ]);
  return results.reduce((sum, value) => sum + value, 0);
}

async function collectTenantTask(tenantRef: DocumentReference, tenantEmail: string, batchSize: number): Promise<QueueTask | null> {
  const headers = internalRequest(tenantEmail, {}).headers;

  const notificationJobs = await tenantRef.collection("whatsappNotificationJobs")
    .where("status", "==", "prepared_for_vercel").limit(batchSize).get();
  const dispatchableJobs = notificationJobs.docs.filter((doc) =>
    doc.data()?.kind === "attendance_absent" || doc.data()?.kind === "monthly_report_pdf",
  );
  if (dispatchableJobs.length) {
    return {
      tenantEmail,
      label: `attendance/monthly jobs (${dispatchableJobs.length})`,
      run: async () => {
        const results = await Promise.allSettled(dispatchableJobs.map(async (doc) => {
          const body = { jobId: doc.id };
          const request = { headers, body } as TeacherApiRequest & { body: unknown };
          if (doc.data()?.kind === "attendance_absent") return dispatchAttendanceNotification(request);
          return dispatchMonthlyReportPdf(request);
        }));
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          const jobDoc = dispatchableJobs[index];
          const sourceKey = `notification_job:${jobDoc.id}:worker_error`;
          if (result.status === "rejected") {
            const data = jobDoc.data() ?? {};
            await upsertFailureAlert({
              tenantRef, tenantEmail, sourceKey,
              queueType: "notification_job", sourceCollection: "whatsappNotificationJobs",
              jobId: jobDoc.id, kind: clean(data.kind) || "notification",
              status: "queue_processing_error", last4: clean(data.recipientLast4),
              targetClass: clean(data.className) || clean(data.classId),
              reason: result.reason instanceof Error ? result.reason.message : "The worker could not prepare this queued notification. The persistent job remains saved.",
              retrySafe: true,
            });
          } else {
            await resolveWorkerFailureAlert(tenantRef, sourceKey);
          }
        }
        return results;
      },
    };
  }

  const announcementSnapshot = await tenantRef.collection("whatsappAnnouncementDispatches")
    .where("status", "==", "pending").limit(1).get();
  if (!announcementSnapshot.empty) {
    const doc = announcementSnapshot.docs[0];
    const data = doc.data() ?? {};
    return {
      tenantEmail,
      label: `announcement ${doc.id}`,
      run: async () => {
        const sourceKey = `announcement_dispatch:${doc.id}:worker_error`;
        try {
          const result = await dispatchAnnouncementWhatsApp({
            headers,
            body: { action: "dispatch", alertId: clean(data.alertId), dispatchId: doc.id },
          });
          await resolveWorkerFailureAlert(tenantRef, sourceKey);
          return result;
        } catch (error) {
          await upsertFailureAlert({
            tenantRef, tenantEmail, sourceKey,
            queueType: "announcement_dispatch", sourceCollection: "whatsappAnnouncementDispatches",
            jobId: doc.id, dispatchId: doc.id, kind: "announcement",
            status: "queue_processing_error", targetClass: clean(data.targetClass),
            reason: error instanceof Error ? error.message : "The announcement queue could not be advanced. The persisted recipient records remain available for the next worker tick.",
            retrySafe: true,
          });
          throw error;
        }
      },
    };
  }

  const librarySnapshot = await tenantRef.collection("whatsappLibraryLinkDispatches")
    .where("status", "==", "pending").limit(1).get();
  if (!librarySnapshot.empty) {
    const doc = librarySnapshot.docs[0];
    const data = doc.data() ?? {};
    return {
      tenantEmail,
      label: `library link ${doc.id}`,
      run: async () => {
        const sourceKey = `library_dispatch:${doc.id}:worker_error`;
        try {
          const result = await dispatchLibraryLinkWhatsApp({
            headers,
            body: { classId: clean(data.classId), resourceId: clean(data.resourceId) },
          });
          await resolveWorkerFailureAlert(tenantRef, sourceKey);
          return result;
        } catch (error) {
          await upsertFailureAlert({
            tenantRef, tenantEmail, sourceKey,
            queueType: "library_dispatch", sourceCollection: "whatsappLibraryLinkDispatches",
            jobId: doc.id, dispatchId: doc.id, kind: "library_link",
            status: "queue_processing_error", targetClass: clean(data.classId),
            reason: error instanceof Error ? error.message : "The library-link queue could not be advanced. Recipient jobs remain persistent.",
            retrySafe: true,
          });
          throw error;
        }
      },
    };
  }

  const quizSnapshot = await tenantRef.collection("whatsappQuizResultDispatches")
    .where("status", "in", ["prepared", "dispatching"]).limit(5).get();
  for (const quizDoc of quizSnapshot.docs) {
    const quiz = quizDoc.data() ?? {};
    const queued = await quizDoc.ref.collection("recipients")
      .where("status", "==", "queued").limit(batchSize).get();
    if (queued.empty) continue;
    return {
      tenantEmail,
      label: `quiz results ${quizDoc.id} (${queued.size})`,
      run: async () => {
        const results = await Promise.allSettled(queued.docs.map((recipientDoc) =>
          dispatchQuizResultsWhatsApp({
            headers,
            body: {
              action: "send",
              classId: clean(quiz.classId),
              quizId: clean(quiz.quizId),
              dispatchId: quizDoc.id,
              studentId: clean(recipientDoc.data()?.studentId),
            },
          }),
        ));
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          if (result.status !== "rejected") continue;
          const recipientDoc = queued.docs[index];
          const latest = await recipientDoc.ref.get();
          if (!latest.exists || latest.data()?.status !== "queued") continue;
          const reason = result.reason instanceof Error ? result.reason.message : "Quiz result could not be prepared before the provider request. No message was sent for this recipient.";
          const markedBlocked = await getFirebaseAdminFirestore().runTransaction(async (transaction) => {
            const [latestRecipient, latestDispatch] = await Promise.all([
              transaction.get(recipientDoc.ref),
              transaction.get(quizDoc.ref),
            ]);
            if (!latestRecipient.exists || latestRecipient.data()?.status !== "queued" || !latestDispatch.exists) return false;
            const currentPending = Number(latestDispatch.data()?.pendingCount ?? 0);
            transaction.update(recipientDoc.ref, {
              status: "pre_provider_blocked",
              retrySafe: true,
              outcomeReason: reason.slice(0, 450),
              completedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
            transaction.update(quizDoc.ref, {
              status: currentPending > 1 ? "dispatching" : "needs_review",
              pendingCount: Math.max(0, currentPending - 1),
              preProviderBlockedCount: FieldValue.increment(1),
              updatedAt: FieldValue.serverTimestamp(),
            });
            return true;
          });
          if (!markedBlocked) continue;
          await upsertFailureAlert({
            tenantRef, tenantEmail,
            sourceKey: `quiz_recipient:${quizDoc.id}:${recipientDoc.id}:pre_provider_blocked:${Number(latest.data()?.attemptCount ?? 0)}`,
            queueType: "quiz_recipient", sourceCollection: "whatsappQuizResultDispatches",
            jobId: recipientDoc.id, dispatchId: quizDoc.id, recipientId: recipientDoc.id,
            kind: "quiz_result", status: "pre_provider_blocked",
            last4: clean(latest.data()?.recipientLast4), targetClass: clean(quiz.className) || clean(quiz.classId),
            reason, retrySafe: true,
          });
        }
        const [remainingQueued, remainingDispatching, remainingFailed] = await Promise.all([
          quizDoc.ref.collection("recipients").where("status", "==", "queued").limit(1).get(),
          quizDoc.ref.collection("recipients").where("status", "==", "dispatching").limit(1).get(),
          quizDoc.ref.collection("recipients").where("status", "in", ["unknown_outcome", "provider_rejected", "pre_provider_blocked"]).limit(1).get(),
        ]);
        const finalDispatchStatus = !remainingQueued.empty ? "prepared"
          : !remainingDispatching.empty ? "dispatching"
          : !remainingFailed.empty ? "needs_review" : "completed";
        await quizDoc.ref.set({
          status: finalDispatchStatus,
          ...(finalDispatchStatus === "completed" || finalDispatchStatus === "needs_review" ? { completedAt: FieldValue.serverTimestamp() } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return results;
      },
    };
  }
  return null;
}

export async function runWhatsAppQueueWorker(): Promise<Record<string, number | string | boolean>> {
  const workerSecret = process.env.WHATSAPP_QUEUE_WORKER_SECRET?.trim() ?? "";
  if (workerSecret.length < 32) {
    return { success: false, skipped: true, reason: "WHATSAPP_QUEUE_WORKER_SECRET must be configured with at least 32 characters.", tasksRun: 0 };
  }
  if (process.env.WHATSAPP_DISPATCH_ENABLED !== "true") {
    return { success: false, skipped: true, reason: "WHATSAPP_DISPATCH_ENABLED is not true.", tasksRun: 0 };
  }

  const db = getFirebaseAdminFirestore();
  const lockRef = db.collection("platformLocks").doc("whatsappQueueWorker");
  const workerToken = randomUUID();
  const acquired = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(lockRef);
    const lock = snapshot.data() ?? {};
    if (timestampMillis(lock.lockedUntil) > Date.now()) return false;
    transaction.set(lockRef, {
      workerToken,
      lockedUntil: Timestamp.fromMillis(Date.now() + LOCK_LEASE_MS),
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  });
  if (!acquired) return { success: true, skipped: true, reason: "Another WhatsApp queue worker holds the lease.", tasksRun: 0 };

  console.info("[WhatsAppQueueWorker] Worker lease acquired.");
  let scannedTenants = 0;
  let tasksRun = 0;
  let staleClaimsReconciled = 0;
  let failureAlertsSynced = 0;
  try {
    const lockSnapshot = await lockRef.get();
    const lockData = lockSnapshot.data() ?? {};
    const previousCursorEmail = clean(lockData.tenantCursorEmail);
    const lastMaintenanceAt = timestampMillis(lockData.lastMaintenanceAt);
    const maintenanceDue = !lastMaintenanceAt || Date.now() - lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS;
    const maintenanceCursorEmail = clean(lockData.maintenanceCursorEmail);
    const maxTenantsToScan = boundedEnvInteger(
      "WHATSAPP_QUEUE_MAX_TENANTS_PER_RUN",
      DEFAULT_MAX_TENANTS_PER_RUN,
      1,
      MAX_TENANTS_PER_RUN,
    );
    const teacherQuery = db.collection("users")
      .where("role", "==", "teacher")
      .orderBy(FieldPath.documentId())
      .limit(maxTenantsToScan);

    // Queue discovery and daily maintenance have independent cursors. This lets
    // maintenance sweep every tenant over short invocations instead of reading
    // every teacher and every failure collection on every minute-level tick.
    let teacherSnapshot = previousCursorEmail
      ? await teacherQuery.startAfter(previousCursorEmail).get()
      : await teacherQuery.get();
    if (teacherSnapshot.empty && previousCursorEmail) teacherSnapshot = await teacherQuery.get();

    console.info("[WhatsAppQueueWorker] Tenant page loaded.", {
      tenantDocumentsRead: teacherSnapshot.size,
      maxTenantsToScan,
      maintenanceDue,
    });
    let maintenanceCursorNext = maintenanceCursorEmail;
    let maintenanceCompleted = false;
    if (maintenanceDue) {
      const maintenanceSnapshot = maintenanceCursorEmail
        ? await teacherQuery.startAfter(maintenanceCursorEmail).get()
        : await teacherQuery.get();
      if (maintenanceSnapshot.empty) {
        maintenanceCompleted = true;
        maintenanceCursorNext = "";
      } else {
        let lastSuccessfulMaintenanceCursor = maintenanceCursorEmail;
        let maintenanceFailed = false;
        for (const teacherDoc of maintenanceSnapshot.docs) {
          const data = teacherDoc.data() ?? {};
          const tenantEmail = clean(data.email).toLowerCase();
          const isActiveTeacher = data.active === true && data.disabled !== true && data.deleted !== true &&
            tenantEmail === teacherDoc.id.toLowerCase() && tenantEmail.includes("@") && clean(data.uid);
          if (isActiveTeacher) {
            try {
              staleClaimsReconciled += await staleNotificationJobs(teacherDoc.ref);
              staleClaimsReconciled += await staleFeeJobs(teacherDoc.ref);
              staleClaimsReconciled += await staleRecipientClaims(teacherDoc.ref, "whatsappAnnouncementDispatches");
              staleClaimsReconciled += await staleRecipientClaims(teacherDoc.ref, "whatsappQuizResultDispatches");
              staleClaimsReconciled += await staleRecipientClaims(teacherDoc.ref, "whatsappLibraryLinkDispatches");
              failureAlertsSynced += await processTenantFailures(teacherDoc.ref, tenantEmail);
            } catch (error) {
              maintenanceFailed = true;
              console.error("[WhatsAppQueueWorker] Maintenance scan failed; this tenant will be retried on the next tick.", {
                tenantId: tenantEmail,
                errorName: error instanceof Error ? error.name : "UnknownError",
              });
              break;
            }
          }
          lastSuccessfulMaintenanceCursor = teacherDoc.id;
        }
        maintenanceCursorNext = lastSuccessfulMaintenanceCursor;
        if (!maintenanceFailed && maintenanceSnapshot.size < maxTenantsToScan) {
          maintenanceCompleted = true;
          maintenanceCursorNext = "";
        }
      }
    }

    const activeTeachers = teacherSnapshot.docs.filter((doc) => {
      const data = doc.data() ?? {};
      const email = clean(data.email).toLowerCase();
      return data.active === true && data.disabled !== true && data.deleted !== true &&
        email === doc.id.toLowerCase() && email.includes("@") && clean(data.uid);
    });
    const maxTenantBatches = boundedEnvInteger("WHATSAPP_QUEUE_TENANT_BATCHES_PER_RUN", DEFAULT_TENANT_BATCHES_PER_RUN, 1, MAX_TENANT_BATCHES_PER_RUN);
    const batchSize = boundedEnvInteger("WHATSAPP_QUEUE_BATCH_SIZE", DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
    const tenantConcurrency = boundedEnvInteger("WHATSAPP_QUEUE_TENANT_CONCURRENCY", 1, 1, 2);
    const tasks: QueueTask[] = [];
    let nextCursorEmail = teacherSnapshot.docs[teacherSnapshot.docs.length - 1]?.id ?? "";

    for (const teacherDoc of activeTeachers) {
      if (tasks.length >= maxTenantBatches) break;
      const tenantEmail = teacherDoc.id.toLowerCase();
      scannedTenants += 1;
      nextCursorEmail = teacherDoc.id;
      try {
        const task = await collectTenantTask(teacherDoc.ref, tenantEmail, batchSize);
        if (task) tasks.push(task);
      } catch (error) {
        console.error("[WhatsAppQueueWorker] Could not inspect a teacher queue.", {
          tenantId: tenantEmail,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }

    console.info("[WhatsAppQueueWorker] Queue batches prepared.", {
      scannedTenants,
      plannedTasks: tasks.length,
      maxTenantBatches,
      batchSize,
    });

    await lockRef.set({
      tenantCursorEmail: nextCursorEmail || null,
      ...(maintenanceDue ? {
        maintenanceCursorEmail: maintenanceCursorNext || null,
        ...(maintenanceCompleted ? { lastMaintenanceAt: FieldValue.serverTimestamp() } : {}),
      } : {}),
      lastScannedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    for (let offset = 0; offset < tasks.length; offset += tenantConcurrency) {
      const group = tasks.slice(offset, offset + tenantConcurrency);
      await Promise.all(group.map(async (task) => {
        try {
          await task.run();
          tasksRun += 1;
        } catch (error) {
          console.error("[WhatsAppQueueWorker] Queue batch failed; the persistent job was left in its safe saved state.", {
            tenantId: task.tenantEmail,
            queue: task.label,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        }
      }));
    }

    // Immediately sync failures for tenants that actually ran a queue batch. This
    // keeps new provider failures visible without scanning every tenant each minute.
    for (const task of tasks) {
      try {
        failureAlertsSynced += await processTenantFailures(
          db.collection("users").doc(task.tenantEmail),
          task.tenantEmail,
        );
      } catch (error) {
        console.error("[WhatsAppQueueWorker] Post-dispatch failure sync failed; daily maintenance will retry it.", {
          tenantId: task.tenantEmail,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }

    return {
      success: true,
      skipped: false,
      scannedTenants,
      tasksRun,
      staleClaimsReconciled,
      failureAlertsSynced,
      batchSize,
      tenantBatchesPerRun: maxTenantBatches,
      tenantConcurrency,
    };
  } finally {
    await db.runTransaction(async (transaction) => {
      const latest = await transaction.get(lockRef);
      if (latest.data()?.workerToken === workerToken) {
        transaction.set(lockRef, {
          lockedUntil: Timestamp.fromMillis(0),
          workerToken: null,
          finishedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }).catch((error) => {
      console.error("[WhatsAppQueueWorker] Could not release worker lease.", error instanceof Error ? error.name : "UnknownError");
    });
  }
}
