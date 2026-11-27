import { randomUUID } from "node:crypto";
import { Timestamp, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import {
  verifyTeacherRequest,
  TeacherApiAuthError,
  type TeacherApiRequest,
} from "./teacherAuth.js";
import { assertTeacherActorFeatureEntitlement } from "./subscriptionEntitlements.js";
import {
  classifyWhatsAppOutcome,
  pakistanMonthBoundsUtc,
  previousPakistanMonthKey,
  validatePakistanMonthKey,
} from "./whatsappMonthlyAnalyticsDomain.mjs";

type RecordLike = Record<string, unknown>;
type DashboardQuerySnapshot = {
  docs: QueryDocumentSnapshot[];
  size: number;
};
type DashboardDocumentSnapshot = {
  exists: boolean;
  data(): unknown;
};
type Request = TeacherApiRequest & { query?: Record<string, unknown> };
type AnalyticsOutcome = "providerAccepted" | "deliveryConfirmed" | "failed" | "pending" | "unknown";
type CategoryKey = "attendance" | "fees" | "quiz" | "announcements" | "library";
type WhatsAppDashboardActor = Pick<Awaited<ReturnType<typeof verifyTeacherRequest>>, "uid" | "email" | "tenantRef" | "db">;


class DashboardStageError extends Error {
  constructor(
    public readonly stage: string,
    public readonly original: unknown,
  ) {
    super(`WhatsApp dashboard stage failed: ${stage}`);
    this.name = "DashboardStageError";
  }
}

async function withDashboardStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DashboardStageError) throw error;
    throw new DashboardStageError(stage, error);
  }
}

const TIME_ZONE = "Asia/Karachi";
const DAY_MS = 24 * 60 * 60 * 1000;
const FAILED_WINDOW_MS = DAY_MS;
const MONTHLY_QUERY_PAGE_SIZE = 50;
const MONTHLY_QUERY_MAX_PAGES = 2;
const FAILED_FEE_LIMIT = 25;
const FAILED_DISPATCH_LIMIT = 4;
const FAILED_RECIPIENT_LIMIT = 10;

const CATEGORY_DEFINITIONS: Array<{
  key: CategoryKey;
  label: string;
  collection: string;
  kind?: string;
  deliveryTracking: boolean;
}> = [
  { key: "attendance", label: "Attendance", collection: "whatsappNotificationJobs", kind: "attendance_absent", deliveryTracking: true },
  { key: "fees", label: "Fee Alerts", collection: "feeAlertNotificationJobs", kind: "fee_due_reminder", deliveryTracking: false },
  { key: "quiz", label: "Quiz Alerts", collection: "whatsappQuizResultDispatches", kind: "quiz_results_whatsapp", deliveryTracking: false },
  { key: "announcements", label: "Announcements", collection: "whatsappAnnouncementDispatches", kind: "announcement_whatsapp", deliveryTracking: false },
  { key: "library", label: "Library Links", collection: "whatsappLibraryLinkDispatches", kind: "library_resource_link", deliveryTracking: false },
];

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timestampMillis(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (isRecord(value)) {
    if (typeof value.toMillis === "function") {
      try {
        const result: unknown = (value.toMillis as () => unknown)();
        return typeof result === "number" && Number.isFinite(result) ? result : null;
      } catch {
        return null;
      }
    }
    if (typeof value.seconds === "number" && Number.isFinite(value.seconds)) {
      return value.seconds * 1000 + (typeof value.nanoseconds === "number" ? value.nanoseconds / 1_000_000 : 0);
    }
  }
  return null;
}

function pakistanDateKey(value: unknown, fallback: number): string {
  const millis = timestampMillis(value) ?? fallback;
  return dateFormatter.format(new Date(millis));
}

function validateMonthKey(raw: unknown, now = new Date()): string {
  return validatePakistanMonthKey(raw, now);
}

function monthBoundsUtc(monthKey: string): { start: Date; end: Date; days: number } {
  return pakistanMonthBoundsUtc(monthKey);
}

function previousMonthKey(monthKey: string): string {
  return previousPakistanMonthKey(monthKey);
}

function classifyOutcome(statusValue: unknown, data: RecordLike): AnalyticsOutcome | null {
  return classifyWhatsAppOutcome(statusValue, data) as AnalyticsOutcome | null;
}

function createEmptyCounts() {
  return { total: 0, providerAccepted: 0, deliveryConfirmed: 0, failed: 0, pending: 0, unknown: 0 };
}

type Counts = ReturnType<typeof createEmptyCounts>;

function addCount(counts: Counts, outcome: AnalyticsOutcome, count = 1) {
  if (!Number.isFinite(count) || count <= 0) return;
  counts.total += count;
  counts[outcome] += count;
  // A delivery receipt proves provider acceptance as well as delivery.
  if (outcome === "deliveryConfirmed") counts.providerAccepted += count;
}

function documentTimestamp(data: RecordLike, fallback: unknown): unknown {
  return data.startedAt ?? data.dispatchStartedAt ?? data.completedAt ?? data.providerRespondedAt ?? data.createdAt ?? fallback;
}

async function getMonthDocuments(
  collectionRef: Query,
  start: Date,
  end: Date,
  stage: string,
): Promise<{ docs: QueryDocumentSnapshot[]; truncated: boolean }> {
  const rows: QueryDocumentSnapshot[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (let page = 0; page < MONTHLY_QUERY_MAX_PAGES; page += 1) {
    // Query only the requested month and enforce a strict per-collection read budget.
    let query = collectionRef
      .where("updatedAt", ">=", Timestamp.fromDate(start))
      .where("updatedAt", "<", Timestamp.fromDate(end))
      .orderBy("updatedAt", "asc")
      .limit(MONTHLY_QUERY_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await withDashboardStage(`${stage}.page-${page + 1}`, () => query.get()) as unknown as DashboardQuerySnapshot;
    rows.push(...snapshot.docs);
    if (snapshot.size < MONTHLY_QUERY_PAGE_SIZE) return { docs: rows, truncated: false };
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }
  // Return bounded partial data with an explicit warning instead of failing the whole page.
  return { docs: rows, truncated: true };
}

function newCategoryAccumulator(definition: (typeof CATEGORY_DEFINITIONS)[number], days: number) {
  return {
    key: definition.key,
    label: definition.label,
    dataAvailable: true,
    deliveryTrackingAvailable: definition.deliveryTracking,
    counts: createEmptyCounts(),
    daily: Array.from({ length: days }, (_, index) => ({ day: index + 1, date: "", total: 0, providerAccepted: 0, deliveryConfirmed: 0, failed: 0, pending: 0, unknown: 0, expiredRetryJobs: 0 })),
    sourceDocuments: 0,
    expiredRetryJobs: 0,
  };
}

type CategoryAccumulator = ReturnType<typeof newCategoryAccumulator>;

async function addRecord(
  category: CategoryAccumulator,
  data: RecordLike,
  fallbackTimestamp: unknown,
  monthKey: string,
  count = 1,
) {
  const outcome = classifyOutcome(data.status, data);
  if (!outcome) return;
  const timestamp = documentTimestamp(data, fallbackTimestamp);
  const millis = timestampMillis(timestamp);
  if (millis === null) return;
  const dayKey = pakistanDateKey(timestamp, millis);
  if (!dayKey.startsWith(`${monthKey}-`)) return;
  const dayNumber = Number(dayKey.slice(-2));
  const daily = category.daily[dayNumber - 1];
  if (!daily) return;
  addCount(category.counts, outcome, count);
  addCount(daily, outcome, count);
  category.sourceDocuments += 1;
}

async function addDispatchSummary(
  category: CategoryAccumulator,
  parentSnapshot: QueryDocumentSnapshot,
  monthKey: string,
): Promise<boolean> {
  const parent = parentSnapshot.data() as RecordLike;
  if (category.key === "quiz" && parent.kind !== "quiz_results_whatsapp") return false;
  if (category.key === "announcements" && parent.kind !== "announcement_whatsapp") return false;
  if (category.key === "library" && parent.kind !== "library_resource_link") return false;

  const hasPersistedCounters = ["acceptedCount", "rejectedCount", "unknownOutcomeCount", "pendingCount"]
    .some((field) => Object.prototype.hasOwnProperty.call(parent, field));
  if (!hasPersistedCounters) {
    // Legacy dispatches without parent counters are deliberately not expanded into
    // per-recipient reads from a dashboard request. Report partial coverage instead;
    // a separate controlled backfill can handle these records without request fan-out.
    return true;
  }

  // Current dispatch writers persist status counters on the parent document. Use
  // those counters rather than issuing one unbounded subcollection read per dispatch.
  const accepted = Math.max(0, Number(parent.acceptedCount) || 0);
  const rejected = Math.max(0, Number(parent.rejectedCount) || 0);
  const unknown = Math.max(0, Number(parent.unknownOutcomeCount) || 0);
  const preProviderBlocked = Math.max(0, Number(parent.preProviderBlockedCount) || 0);
  const recipientCount = Math.max(0, Number(parent.recipientCount ?? parent.eligibleCount) || 0);
  const pendingValue = parent.pendingCount;
  const dispatching = Math.max(0, Number(parent.dispatchingCount) || 0);
  const pending = pendingValue !== undefined && pendingValue !== null
    ? Math.max(0, Number(pendingValue) || 0) + dispatching
    : Math.max(0, recipientCount - accepted - rejected - unknown - preProviderBlocked);
  const baseTime = parent.updatedAt ?? parent.createdAt;
  const baseMillis = timestampMillis(baseTime);
  if (baseMillis === null) return false;
  const dayKey = pakistanDateKey(baseTime, baseMillis);
  if (!dayKey.startsWith(`${monthKey}-`)) return false;
  const dayNumber = Number(dayKey.slice(-2));
  const daily = category.daily[dayNumber - 1];
  if (!daily) return false;

  const total = accepted + rejected + unknown + pending;
  category.counts.total += total;
  category.counts.providerAccepted += accepted;
  category.counts.failed += rejected;
  category.counts.unknown += unknown;
  category.counts.pending += pending;
  daily.total += total;
  daily.providerAccepted += accepted;
  daily.failed += rejected;
  daily.unknown += unknown;
  daily.pending += pending;
  if (total > 0) category.sourceDocuments += 1;
  return false;
}

async function loadMonthAnalytics(actor: WhatsAppDashboardActor, monthKey: string) {
  const { start, end, days } = monthBoundsUtc(monthKey);
  const categories = Object.fromEntries(
    CATEGORY_DEFINITIONS.map((definition) => [definition.key, newCategoryAccumulator(definition, days)]),
  ) as Record<CategoryKey, CategoryAccumulator>;
  let truncated = false;

  const directDefinitions: CategoryKey[] = ["attendance", "fees"];
  await Promise.all(directDefinitions.map(async (key) => {
    const definition = CATEGORY_DEFINITIONS.find((item) => item.key === key)!;
    const result = await withDashboardStage(
      `analytics.${monthKey}.${definition.collection}`,
      () => getMonthDocuments(
        actor.tenantRef.collection(definition.collection),
        start,
        end,
        `analytics.${monthKey}.${definition.collection}`,
      ),
    );
    truncated ||= result.truncated;
    const category = categories[key];
    for (const snapshot of result.docs) {
      const data = snapshot.data() as RecordLike;
      if (definition.kind && data.kind !== definition.kind) continue;
      await addRecord(category, data, data.createdAt, monthKey);
    }
  }));

  const dispatchDefinitions: CategoryKey[] = ["quiz", "announcements", "library"];
  await Promise.all(dispatchDefinitions.map(async (key) => {
    const definition = CATEGORY_DEFINITIONS.find((item) => item.key === key)!;
    const result = await withDashboardStage(
      `analytics.${monthKey}.${definition.collection}`,
      () => getMonthDocuments(
        actor.tenantRef.collection(definition.collection),
        start,
        end,
        `analytics.${monthKey}.${definition.collection}`,
      ),
    );
    truncated ||= result.truncated;
    const fallbackResults = await Promise.all(result.docs.map((snapshot) => addDispatchSummary(categories[key], snapshot, monthKey)));
    truncated ||= fallbackResults.some(Boolean);
  }));

  const [monthYear, monthNumber] = monthKey.split("-").map(Number);
  const nextMonthDate = new Date(Date.UTC(monthYear, monthNumber, 1));
  const nextMonth = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
  const aggregateSnapshots = await withDashboardStage(
    `analytics.${monthKey}.whatsappDailyAggregates`,
    () => actor.tenantRef.collection("whatsappDailyAggregates")
      .where("dateKey", ">=", `${monthKey}-01`)
      .where("dateKey", "<", `${nextMonth}-01`)
      .get(),
  ) as unknown as DashboardQuerySnapshot;
  for (const aggregateSnapshot of aggregateSnapshots.docs) {
    const aggregate = aggregateSnapshot.data() as RecordLike;
    const dateKey = clean(aggregate.dateKey);
    const dayNumber = Number(dateKey.slice(-2));
    const day = categories.attendance.daily[dayNumber - 1];
    const count = Math.max(0, Number(aggregate.attendancePreProviderExpired) || 0);
    if (day && dateKey.startsWith(`${monthKey}-`)) {
      day.expiredRetryJobs += count;
      categories.attendance.expiredRetryJobs += count;
    }
    const categoryAggregates: Array<{ key: CategoryKey; field: string }> = [
      { key: "fees", field: "feesProviderRejected" },
      { key: "quiz", field: "quizProviderRejected" },
      { key: "announcements", field: "announcementsProviderRejected" },
      { key: "library", field: "libraryProviderRejected" },
    ];
    for (const item of categoryAggregates) {
      const failedCount = Math.max(0, Number(aggregate[item.field]) || 0);
      if (!day || !dateKey.startsWith(`${monthKey}-`) || failedCount === 0) continue;
      addCount(categories[item.key].counts, "failed", failedCount);
      addCount(day, "failed", failedCount);
      categories[item.key].sourceDocuments += failedCount;
    }
  }

  for (const category of Object.values(categories)) {
    category.dataAvailable = category.sourceDocuments > 0;
    for (const day of category.daily) {
      day.date = `${monthKey}-${String(day.day).padStart(2, "0")}`;
    }
  }

  const summary = createEmptyCounts();
  const dailyMap = Array.from({ length: days }, (_, index) => ({
    day: index + 1,
    date: `${monthKey}-${String(index + 1).padStart(2, "0")}`,
    total: 0,
    providerAccepted: 0,
    deliveryConfirmed: 0,
    failed: 0,
    pending: 0,
    unknown: 0,
    expiredRetryJobs: 0,
  }));
  for (const category of Object.values(categories)) {
    for (const key of ["total", "providerAccepted", "deliveryConfirmed", "failed", "pending", "unknown"] as const) {
      summary[key] += category.counts[key];
    }
    category.daily.forEach((day, index) => {
      for (const key of ["total", "providerAccepted", "deliveryConfirmed", "failed", "pending", "unknown"] as const) {
        dailyMap[index][key] += day[key];
      }
      dailyMap[index].expiredRetryJobs += day.expiredRetryJobs;
    });
  }

  return {
    month: monthKey,
    timezone: TIME_ZONE,
    daysInMonth: days,
    summary: {
      ...summary,
      expiredRetryJobs: categories.attendance.expiredRetryJobs,
      dataCoverageComplete: Object.values(categories).every((category) => category.dataAvailable),
    },
    categories: Object.values(categories).map((category) => ({
      key: category.key,
      label: category.label,
      dataAvailable: category.dataAvailable,
      deliveryTrackingAvailable: category.deliveryTrackingAvailable,
      counts: {
        total: category.counts.total,
        providerAccepted: category.counts.providerAccepted,
        deliveryConfirmed: category.deliveryTrackingAvailable ? category.counts.deliveryConfirmed : null,
        failed: category.counts.failed,
        pending: category.counts.pending,
        unknown: category.counts.unknown,
      },
      sourceDocuments: category.sourceDocuments,
      expiredRetryJobs: category.expiredRetryJobs,
    })),
    dailyActivity: dailyMap,
    complete: !truncated,
  };
}

function dateIso(millis: number): string {
  return new Date(millis).toISOString();
}

function expiryForFailure(data: RecordLike): { failedAt: number | null; expiresAt: number | null } {
  const failedAt = timestampMillis(data.failedAt)
    ?? timestampMillis(data.completedAt)
    ?? timestampMillis(data.providerRespondedAt)
    ?? timestampMillis(data.updatedAt);
  const explicitExpiry = timestampMillis(data.expiresAt);
  return {
    failedAt,
    expiresAt: explicitExpiry ?? (failedAt === null ? null : failedAt + DAY_MS),
  };
}

function failedRow(input: {
  id: string;
  category: string;
  className?: unknown;
  studentName?: unknown;
  failedAt: number;
  expiresAt: number;
  attempts: unknown;
  reason: unknown;
  canRetry: boolean;
  retryJobId?: string;
  dispatchId?: string;
  recipientId?: string;
  alertId?: string;
}): RecordLike {
  return {
    id: input.id,
    category: input.category,
    className: clean(input.className) || "Class reference unavailable",
    studentName: clean(input.studentName) || null,
    failedAt: dateIso(input.failedAt),
    expiresAt: dateIso(input.expiresAt),
    attemptCount: Number.isFinite(Number(input.attempts)) ? Math.max(0, Number(input.attempts)) : 1,
    failureReason: clean(input.reason).slice(0, 240) || "The provider reported a definitive failure.",
    canRetry: input.canRetry,
    ...(input.retryJobId ? { retryJobId: input.retryJobId } : {}),
    ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
    ...(input.recipientId ? { recipientId: input.recipientId } : {}),
    ...(input.alertId ? { alertId: input.alertId } : {}),
  };
}

async function listFailedMessages(actor: WhatsAppDashboardActor) {
  const now = Date.now();
  const cutoff = Timestamp.fromMillis(now - FAILED_WINDOW_MS);
  const rows: RecordLike[] = [];
  let truncated = false;

  // Only definitive provider rejections are WhatsApp failures. Attendance jobs marked
  // `failed + retrySafe` failed before a provider request and are not message failures.
  const feeSnapshot = await withDashboardStage(
    "failedMessages.feeAlertNotificationJobs",
    () => actor.tenantRef.collection("feeAlertNotificationJobs")
      .where("status", "==", "provider_rejected")
      .where("completedAt", ">=", cutoff)
      .orderBy("completedAt", "desc")
      .limit(FAILED_FEE_LIMIT).get(),
  ) as unknown as DashboardQuerySnapshot;
  truncated ||= feeSnapshot.size === FAILED_FEE_LIMIT;
  for (const snapshot of feeSnapshot.docs) {
    const data = snapshot.data() as RecordLike;
    const expiry = expiryForFailure(data);
    if (expiry.failedAt === null || expiry.expiresAt === null || expiry.expiresAt <= now || expiry.failedAt < now - FAILED_WINDOW_MS) continue;
    rows.push(failedRow({
      id: `fees:${snapshot.id}`, category: "Fee Alerts", className: data.className,
      studentName: data.studentName, failedAt: expiry.failedAt, expiresAt: expiry.expiresAt,
      attempts: data.dispatchAttemptCount, reason: data.providerStatus || data.outcomeReason,
      canRetry: false,
    }));
  }

  const dispatchDefinitions: Array<{ collection: string; label: string; key: string }> = [
    { collection: "whatsappAnnouncementDispatches", label: "Announcements", key: "announcements" },
    { collection: "whatsappQuizResultDispatches", label: "Quiz Alerts", key: "quiz" },
    { collection: "whatsappLibraryLinkDispatches", label: "Library Links", key: "library" },
  ];
  for (const definition of dispatchDefinitions) {
    const parentSnapshots = await withDashboardStage(
      `failedMessages.${definition.collection}`,
      () => actor.tenantRef.collection(definition.collection)
        .where("updatedAt", ">=", cutoff).orderBy("updatedAt", "desc").limit(FAILED_DISPATCH_LIMIT).get(),
    ) as unknown as DashboardQuerySnapshot;
    truncated ||= parentSnapshots.size === FAILED_DISPATCH_LIMIT;
    for (const parentSnapshot of parentSnapshots.docs) {
      const parent = parentSnapshot.data() as RecordLike;
      if (parent.tenantId !== actor.email) continue;
      const expectedKind = definition.key === "announcements"
        ? "announcement_whatsapp"
        : definition.key === "quiz" ? "quiz_results_whatsapp" : "library_resource_link";
      if (parent.kind !== expectedKind) continue;
      const alertId = clean(parent.alertId);
      let alertOwnedByTeacher = false;
      if (definition.key === "announcements" && alertId) {
        const alertSnapshot = await withDashboardStage(
          "failedMessages.announcementAlertOwnership",
          () => actor.tenantRef.collection("notifications").doc(alertId).get(),
        ) as unknown as DashboardDocumentSnapshot;
        const alertData = alertSnapshot.data();
        const alert = isRecord(alertData) ? alertData : undefined;
        alertOwnedByTeacher = Boolean(alertSnapshot.exists
          && alert?.sourceType === "teacher_created"
          && alert?.createdByUid === actor.uid
          && alert?.createdByRole === "teacher");
      }
      const recipientSnapshot = await withDashboardStage(
        `failedMessages.${definition.collection}.recipients`,
        () => parentSnapshot.ref.collection("recipients")
          .where("status", "==", "provider_rejected").limit(FAILED_RECIPIENT_LIMIT).get(),
      ) as unknown as DashboardQuerySnapshot;
      truncated ||= recipientSnapshot.size === FAILED_RECIPIENT_LIMIT;
      for (const recipient of recipientSnapshot.docs) {
        const data = recipient.data() as RecordLike;
        const expiry = expiryForFailure(data);
        if (expiry.failedAt === null || expiry.expiresAt === null || expiry.expiresAt <= now || expiry.failedAt < now - FAILED_WINDOW_MS) continue;
        const providerHttpStatus = Number(data.providerHttpStatus);
        const attemptCount = Number(data.attemptCount) || 0;
        const explicitServerExpiry = timestampMillis(data.expiresAt) !== null;
        const announcementRetryEligible = definition.key === "announcements"
          && explicitServerExpiry
          && Number.isInteger(providerHttpStatus)
          && providerHttpStatus >= 400
          && providerHttpStatus < 500
          && ![408, 409, 425, 429].includes(providerHttpStatus)
          && attemptCount < 3
          && alertOwnedByTeacher
          && Boolean(alertId)
          && parent.teacherUid === actor.uid;
        rows.push(failedRow({
          id: `${definition.key}:${parentSnapshot.id}:${recipient.id}`,
          category: definition.label,
          className: parent.targetClass ?? parent.className ?? parent.classId ?? parent.resourceTitle,
          studentName: data.studentName,
          failedAt: expiry.failedAt,
          expiresAt: expiry.expiresAt,
          attempts: data.attemptCount ?? 1,
          reason: data.providerStatus || data.providerErrorName,
          canRetry: announcementRetryEligible,
          ...(announcementRetryEligible ? {
            dispatchId: parentSnapshot.id,
            recipientId: recipient.id,
            alertId,
          } : {}),
        }));
      }
    }
  }

  rows.sort((a, b) => String(b.failedAt).localeCompare(String(a.failedAt)));
  return { rows: rows.slice(0, 100), truncated };
}

export async function getWhatsAppAlertsDashboardForWorkspace(
  actor: WhatsAppDashboardActor,
  rawMonth: unknown,
) {
  const monthKey = validateMonthKey(rawMonth);
  const previousKey = previousMonthKey(monthKey);
  const [current, previous] = await Promise.all([
    withDashboardStage(`analytics.current.${monthKey}`, () => loadMonthAnalytics(actor, monthKey)),
    withDashboardStage(`analytics.previous.${previousKey}`, () => loadMonthAnalytics(actor, previousKey)),
  ]);
  const previousHasHistory = previous.summary.total > 0;
  const failedMessagesResult = await withDashboardStage("failedMessages", () => listFailedMessages(actor));
  return {
    success: true,
    analytics: {
      ...current,
      comparison: previousHasHistory ? {
        previousMonth: previous.month,
        previousTotal: previous.summary.total,
        currentTotal: current.summary.total,
        change: current.summary.total - previous.summary.total,
        percentChange: previous.summary.total > 0
          ? Math.round(((current.summary.total - previous.summary.total) / previous.summary.total) * 1000) / 10
          : null,
      } : null,
      historicalDataNote: previousHasHistory ? null : "No WhatsApp activity records were available for the previous month.",
      partialDataNote: !current.complete || !previous.complete
        ? "This report reached its safe Firestore read cap. Displayed totals are partial; narrow the period or use the persisted export/report for a complete historical count."
        : failedMessagesResult.truncated
          ? "The latest WhatsApp issues are shown; additional issue records were omitted to protect Firestore read quota."
          : null,
      countingPolicy: "Attendance and fee jobs are counted by their persisted event timestamp. Dispatch summaries use persisted parent counters and are grouped by the dispatch document update timestamp; in-flight announcement recipients are included with pending work. Legacy dispatches without parent counters are omitted from per-recipient expansion and marked partial rather than causing unbounded reads. Provider retry-attempt history is not reconstructed from attempt counters.",
    },
    failedMessages: failedMessagesResult.rows,
    failedMessagesMayBeIncomplete: failedMessagesResult.truncated,
  };
}

export async function getTeacherWhatsAppAlertsDashboard(request: Request) {
  const actor = await verifyTeacherRequest(request);
  await assertTeacherActorFeatureEntitlement(actor, "announcements");
  return getWhatsAppAlertsDashboardForWorkspace(actor, request.query?.month);
}

export function sendTeacherWhatsAppAlertsDashboardError(
  res: { status(code: number): { json(body: unknown): unknown } },
  error: unknown,
) {
  if (error instanceof TeacherApiAuthError) {
    return res.status(error.status).json({ success: false, error: error.message });
  }

  const original = error instanceof DashboardStageError ? error.original : error;
  const status = isRecord(original) && typeof original.status === "number" ? original.status : 500;
  const requestId = randomUUID();
  const code = isRecord(original) && typeof original.code === "string" ? original.code : null;
  const name = original instanceof Error ? original.name : "UnknownError";
  const message = original instanceof Error
    ? original.message
    : isRecord(original) && typeof original.message === "string"
      ? original.message
      : String(original);

  if (status >= 500) {
    // Log query stage and Firestore's code/message, but never request headers,
    // bearer tokens, recipient numbers, or provider credentials.
    console.error("[TeacherWhatsAppAlerts] Dashboard request failed.", {
      requestId,
      stage: error instanceof DashboardStageError ? error.stage : "request-or-authentication",
      errorName: name,
      errorCode: code,
      errorMessage: message.slice(0, 1200),
    });
  }

  return res.status(status).json({
    success: false,
    requestId,
    error: status >= 500
      ? `WhatsApp analytics and failed messages could not be loaded. Reference: ${requestId}`
      : original instanceof Error ? original.message : "The request could not be completed.",
  });
}
