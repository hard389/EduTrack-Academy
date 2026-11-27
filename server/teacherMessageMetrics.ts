import { verifyTeacherRequest, TeacherApiAuthError, type TeacherApiRequest } from './teacherAuth.js';
import { Timestamp, type CollectionReference, type DocumentData } from 'firebase-admin/firestore';
import { summarizeProviderStatuses } from './teacherFeaturePatchDomain.mjs';

type RecordLike = Record<string, unknown>;
const DAILY_METRIC_QUERY_LIMIT = 250;
const isRecord = (value: unknown): value is RecordLike => typeof value === 'object' && value !== null && !Array.isArray(value);
function pakistanDayBounds(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const start = new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00+05:00`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}
async function readToday(ref: CollectionReference<DocumentData>) {
  const { start, end } = pakistanDayBounds();
  // Filter on the stored timestamp in Firestore instead of reading thousands of
  // historical documents and discarding them after download.
  const snapshot = await ref
    .where('createdAt', '>=', Timestamp.fromDate(start))
    .where('createdAt', '<', Timestamp.fromDate(end))
    .orderBy('createdAt', 'asc')
    .limit(DAILY_METRIC_QUERY_LIMIT + 1)
    .get();
  return {
    rows: snapshot.docs.slice(0, DAILY_METRIC_QUERY_LIMIT).map((doc) => doc.data()),
    truncated: snapshot.size > DAILY_METRIC_QUERY_LIMIT,
  };
}

export async function getTeacherMessageMetrics(request: TeacherApiRequest) {
  const actor = await verifyTeacherRequest(request);
  // Verify the teacher still has an active workspace. Counts are private to this tenant.
  const tasks = [
    ['attendance', 'whatsappNotificationJobs'],
    ['fees', 'feeAlertNotificationJobs'],
    ['quiz', 'whatsappQuizResultDispatches'],
    ['announcements', 'whatsappAnnouncementDispatches'],
    ['library', 'whatsappLibraryLinkDispatches'],
  ] as const;
  const rows = await Promise.all(tasks.map(async ([, collectionName]) => {
    try { return await readToday(actor.tenantRef.collection(collectionName)); }
    catch (error) {
      // Missing optional collection or a missing timestamp field must not break the dashboard.
      console.warn(`[TeacherMessageMetrics] Could not read ${collectionName}.`, error instanceof Error ? error.name : 'UnknownError');
      return { rows: [] as RecordLike[], truncated: false };
    }
  }));
  const totals: Record<string, ReturnType<typeof summarizeProviderStatuses>> = {};
  tasks.forEach(([key], index) => {
    const expectedKind: Record<typeof key, string> = {
      attendance: 'attendance_absent',
      fees: 'fee_due_reminder',
      quiz: 'quiz_results_whatsapp',
      announcements: 'announcement_whatsapp',
      library: 'library_resource_link',
    };
    const matchingRows = rows[index].rows.filter((raw): raw is RecordLike => isRecord(raw) && raw.kind === expectedKind[key]);
    if (key === 'attendance' || key === 'fees') {
      totals[key] = summarizeProviderStatuses(matchingRows);
      return;
    }
    const target = { providerAccepted: 0, deliveryConfirmed: 0, rejected: 0, unknownOutcome: 0, pending: 0, inspected: 0 };
    for (const raw of matchingRows) {
      if (!isRecord(raw)) continue;
      const accepted = Math.max(0, Number(raw.acceptedCount) || 0);
      const rejected = Math.max(0, Number(raw.rejectedCount) || 0);
      const unknown = Math.max(0, Number(raw.unknownOutcomeCount) || 0);
      target.inspected += Math.max(1, accepted + rejected + unknown);
      target.providerAccepted += accepted;
      target.rejected += rejected;
      target.unknownOutcome += unknown;
      target.deliveryConfirmed += Math.max(0, Number(raw.deliveryConfirmedCount) || 0);
      const pendingValue = raw.pendingCount;
      const pending = pendingValue !== undefined && pendingValue !== null
        ? Math.max(0, Number(pendingValue) || 0)
        : Math.max(0, Number(raw.recipientCount ?? raw.eligibleCount) - accepted - rejected - unknown - Math.max(0, Number(raw.preProviderBlockedCount) || 0));
      target.pending += pending + Math.max(0, Number(raw.dispatchingCount) || 0);
    }
    totals[key] = target;
  });
  return {
    success: true,
    day: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
    timeZone: 'Asia/Karachi',
    metrics: totals,
    complete: rows.every((row) => !row.truncated),
    warnings: rows.some((row) => row.truncated) ? [`At least one notification collection exceeded the ${DAILY_METRIC_QUERY_LIMIT}-record daily metrics cap. Counts are partial for that collection to protect Firestore read quota.`] : [],
    note: 'Provider accepted is not the same as delivery confirmed. Delivery is counted only when an explicit delivery-confirmed status is stored.',
  };
}

export function sendTeacherMessageMetricsError(res: { status(code: number): { json(body: unknown): unknown } }, error: unknown) {
  const status = error instanceof TeacherApiAuthError ? error.status : 500;
  if (status >= 500) console.error('[TeacherMessageMetrics] Request failed.', error instanceof Error ? error.name : 'UnknownError');
  return res.status(status).json({ success: false, error: status < 500 && error instanceof Error ? error.message : 'Message metrics could not be loaded.' });
}
