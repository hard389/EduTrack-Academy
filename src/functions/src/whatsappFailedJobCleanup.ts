import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore, type DocumentReference, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_PAGE_SIZE = 500;
const MAX_CLEANUP_PAGES = 20;

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function millis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (isRecord(value) && typeof value.toMillis === "function") {
    try {
      const result = (value.toMillis as () => unknown)();
      return typeof result === "number" && Number.isFinite(result) ? result : null;
    } catch { return null; }
  }
  if (isRecord(value) && typeof value.seconds === "number") {
    return value.seconds * 1000 + (typeof value.nanoseconds === "number" ? value.nanoseconds / 1_000_000 : 0);
  }
  return null;
}

function failedWindow(data: RecordLike) {
  const failedAt = millis(data.failedAt) ?? millis(data.completedAt) ?? millis(data.providerRespondedAt) ?? millis(data.updatedAt);
  if (failedAt === null) return null;
  const expiresAt = millis(data.expiresAt) ?? failedAt + DAY_MS;
  return { failedAt, expiresAt };
}

function pakistanDateKey(value: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(value));
}

function isExpiredAttendanceRetryJob(data: RecordLike, now: number): boolean {
  if (data.kind !== "attendance_absent" || data.status !== "failed" || data.retrySafe !== true) return false;
  const window = failedWindow(data);
  return window !== null && window.expiresAt <= now;
}

async function deleteExpiredRecordWithAggregate(input: {
  db: ReturnType<typeof getFirestore>;
  tenantId: string;
  sourceRef: DocumentReference;
  parentRef?: DocumentReference;
  aggregateField: string;
  expectedParentKind?: string;
  now: number;
}): Promise<boolean> {
  const tenantDocRef = input.parentRef
    ? input.parentRef.parent.parent!
    : input.sourceRef.parent.parent!;
  return input.db.runTransaction(async (transaction) => {
    const refs = [input.sourceRef, ...(input.parentRef ? [input.parentRef] : [])];
    const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
    const sourceSnapshot = snapshots[0];
    if (!sourceSnapshot.exists) return false;
    const sourceData = sourceSnapshot.data() as RecordLike;
    if (sourceData.status !== "provider_rejected") return false;
    const window = failedWindow(sourceData);
    if (!window || window.expiresAt > input.now) return false;
    if (sourceData.tenantId && sourceData.tenantId !== input.tenantId) return false;
    if (input.parentRef) {
      const parentSnapshot = snapshots[1];
      if (!parentSnapshot.exists) return false;
      const parent = parentSnapshot.data() as RecordLike;
      if (parent.tenantId !== input.tenantId || (input.expectedParentKind && parent.kind !== input.expectedParentKind)) return false;
      transaction.update(input.parentRef, {
        rejectedCount: Math.max(0, (Number(parent.rejectedCount) || 0) - 1),
        expiredProviderRejectedCount: FieldValue.increment(1),
      });
    }
    const aggregateDoc = tenantDocRef.collection("whatsappDailyAggregates").doc(pakistanDateKey(window.failedAt));
    transaction.set(aggregateDoc, {
      dateKey: pakistanDateKey(window.failedAt),
      [input.aggregateField]: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.delete(input.sourceRef);
    return true;
  });
}

async function forEachCleanupPage(
  baseQuery: Query,
  visit: (snapshot: QueryDocumentSnapshot) => Promise<void>,
): Promise<void> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (let page = 0; page < MAX_CLEANUP_PAGES; page += 1) {
    let query = baseQuery.limit(CLEANUP_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) return;
    for (const document of snapshot.docs) await visit(document);
    if (snapshot.size < CLEANUP_PAGE_SIZE) return;
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }
}

/**
 * Runs entirely server-side. Only expired definitive failure payloads and safe pre-provider
 * Attendance retry jobs are removed. A PII-free tenant/day counter is written in the same
 * transaction before deletion, so retry/recipient payloads do not remain operationally stored.
 */
export async function cleanupExpiredWhatsAppFailedJobs(now = Date.now()): Promise<number> {
  const db = getFirestore();
  let deleted = 0;
  const teacherTenantCache = new Map<string, Promise<boolean>>();
  const isTeacherTenant = (tenantRef: DocumentReference): Promise<boolean> => {
    const cached = teacherTenantCache.get(tenantRef.path);
    if (cached) return cached;
    const lookup = tenantRef.get().then((snapshot) => snapshot.exists && snapshot.data()?.role === "teacher");
    teacherTenantCache.set(tenantRef.path, lookup);
    return lookup;
  };

  // Query expired jobs across the teacher collection group. The previous implementation
  // first read every teacher profile and then issued four subcollection queries per teacher,
  // even when a teacher had no failed jobs. Collection-group indexes let Firestore return
  // only matching expired candidates; each candidate is still checked against its teacher
  // parent and revalidated transactionally before deletion.
  const attendanceBase = db.collectionGroup("whatsappNotificationJobs")
    .where("kind", "==", "attendance_absent")
    .where("status", "==", "failed")
    .where("retrySafe", "==", true);
  const attendanceQueries = [
    attendanceBase.where("expiresAt", "<=", Timestamp.fromMillis(now)).orderBy("expiresAt", "asc"),
    attendanceBase.where("updatedAt", "<=", Timestamp.fromMillis(now - DAY_MS)).orderBy("updatedAt", "asc"),
  ];
  for (const attendanceJobs of attendanceQueries) {
    await forEachCleanupPage(attendanceJobs, async (candidate) => {
      const path = candidate.ref.path.split("/");
      if (path.length !== 4 || path[0] !== "users" || path[2] !== "whatsappNotificationJobs") return;
      const tenantRef = candidate.ref.parent.parent;
      if (!tenantRef || !(await isTeacherTenant(tenantRef))) return;
      const tenantId = path[1];
      const data = candidate.data() as RecordLike;
      if (data.tenantId !== tenantId || !isExpiredAttendanceRetryJob(data, now)) return;
      const removed = await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(candidate.ref);
        if (!fresh.exists) return false;
        const current = fresh.data() as RecordLike;
        if (current.tenantId !== tenantId || !isExpiredAttendanceRetryJob(current, now)) return false;
        const window = failedWindow(current);
        if (!window) return false;
        const aggregateRef = tenantRef.collection("whatsappDailyAggregates").doc(pakistanDateKey(window.failedAt));
        transaction.set(aggregateRef, {
          dateKey: pakistanDateKey(window.failedAt),
          attendancePreProviderExpired: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.delete(candidate.ref);
        return true;
      });
      if (removed) deleted += 1;
    });
  }

  // Fee jobs are handled the same way: avoid enumerating every teacher before locating
  // expired candidates, but preserve the existing tenant validation, aggregate update and
  // delete transaction. Recipient-specific provider outcomes are never retried here.
  const feeBase = db.collectionGroup("feeAlertNotificationJobs")
    .where("kind", "==", "fee_due_reminder")
    .where("status", "==", "provider_rejected");
  const feeQueries = [
    feeBase.where("expiresAt", "<=", Timestamp.fromMillis(now)).orderBy("expiresAt", "asc"),
    feeBase.where("completedAt", "<=", Timestamp.fromMillis(now - DAY_MS)).orderBy("completedAt", "asc"),
  ];
  for (const feeJobs of feeQueries) {
    await forEachCleanupPage(feeJobs, async (candidate) => {
      const path = candidate.ref.path.split("/");
      if (path.length !== 4 || path[0] !== "users" || path[2] !== "feeAlertNotificationJobs") return;
      const tenantRef = candidate.ref.parent.parent;
      if (!tenantRef || !(await isTeacherTenant(tenantRef))) return;
      const tenantId = path[1];
      const data = candidate.data() as RecordLike;
      const window = failedWindow(data);
      if (data.tenantId !== tenantId || !window || window.expiresAt > now) return;
      const removed = await deleteExpiredRecordWithAggregate({
        db, tenantId, sourceRef: candidate.ref, aggregateField: "feesProviderRejected", now,
      });
      if (removed) deleted += 1;
    });
  }

  // Recipient failures are paged by server completion time. The expiry is calculated
  // from explicit expiresAt or legacy failedAt/completedAt + 24h, so records written before
  // the new expiry field was introduced are still cleaned.
  const recipientBase = db.collectionGroup("recipients").where("status", "==", "provider_rejected");
  const recipientQueries = [
    recipientBase.where("expiresAt", "<=", Timestamp.fromMillis(now)).orderBy("expiresAt", "asc"),
    recipientBase.where("completedAt", "<=", Timestamp.fromMillis(now - DAY_MS)).orderBy("completedAt", "asc"),
  ];
  const dispatchKinds: Record<string, { kind: string; aggregateField: string }> = {
    whatsappAnnouncementDispatches: { kind: "announcement_whatsapp", aggregateField: "announcementsProviderRejected" },
    whatsappQuizResultDispatches: { kind: "quiz_results_whatsapp", aggregateField: "quizProviderRejected" },
    whatsappLibraryLinkDispatches: { kind: "library_resource_link", aggregateField: "libraryProviderRejected" },
  };
  for (const expiredRecipients of recipientQueries) {
    await forEachCleanupPage(expiredRecipients, async (recipient) => {
      const data = recipient.data() as RecordLike;
      const window = failedWindow(data);
      if (!window || window.expiresAt > now) return;
      const path = recipient.ref.path.split("/");
      if (path.length !== 6 || path[0] !== "users" || path[4] !== "recipients") return;
      const tenantId = path[1];
      const definition = dispatchKinds[path[2]];
      const parentRef = recipient.ref.parent.parent;
      if (!definition || !parentRef || parentRef.id !== path[3]) return;
      const tenantRef = db.collection("users").doc(tenantId);
      if (!(await isTeacherTenant(tenantRef))) return;
      const removed = await deleteExpiredRecordWithAggregate({
        db,
        tenantId,
        sourceRef: recipient.ref,
        parentRef,
        aggregateField: definition.aggregateField,
        expectedParentKind: definition.kind,
        now,
      });
      if (removed) deleted += 1;
    });
  }

  return deleted;
}

export const cleanupExpiredWhatsAppFailedJobsSchedule = onSchedule({
  schedule: "every 5 minutes",
  region: "us-central1",
  timeoutSeconds: 540,
  memory: "512MiB",
}, async () => {
  try {
    const count = await cleanupExpiredWhatsAppFailedJobs();
    logger.info("Expired WhatsApp failed payloads cleaned up.", { deleted: count });
  } catch (error) {
    logger.error("Expired WhatsApp failed payload cleanup failed.", error);
    throw error;
  }
});
