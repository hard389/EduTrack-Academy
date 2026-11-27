import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';
import { verifyTeacherRequest, TeacherApiAuthError, type TeacherApiRequest } from './teacherAuth.js';
import { assertTeacherActorFeatureEntitlement } from './subscriptionEntitlements.js';

type RecordLike = Record<string, unknown>;
type Request = TeacherApiRequest & { body?: unknown };
type Response = { setHeader(name: string, value: string): void; status(code: number): Response; json(data: unknown): unknown };

export class AnnouncementQuotaError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'AnnouncementQuotaError';
  }
}

const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const isRecord = (value: unknown): value is RecordLike => typeof value === 'object' && value !== null && !Array.isArray(value);

function monthKeyInPakistan(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find((part) => part.type === 'year')?.value ?? ''}-${parts.find((part) => part.type === 'month')?.value ?? ''}`;
}

function classNameOf(data: RecordLike, fallback: string): string {
  return clean(data.name) || clean(data.className) || clean(data.title) || fallback;
}

async function reserveQuota(request: Request) {
  let actor;
  try { actor = await verifyTeacherRequest(request); }
  catch (error) {
    if (error instanceof TeacherApiAuthError) throw error;
    throw new AnnouncementQuotaError(401, 'Teacher authentication could not be verified.');
  }
  try { await assertTeacherActorFeatureEntitlement(actor, 'announcements'); }
  catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    throw new AnnouncementQuotaError(Number.isInteger(status) ? status : 403,
      error instanceof Error ? error.message : 'Your Academy Admin has not granted announcement permission.');
  }

  if (!isRecord(request.body)) throw new AnnouncementQuotaError(400, 'A valid request body is required.');
  const action = clean(request.body.action);
  const alertId = clean(request.body.alertId);
  const targetClass = clean(request.body.targetClass);
  if (!['reserve', 'commit', 'release'].includes(action)) throw new AnnouncementQuotaError(400, 'Unsupported announcement action.');
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(alertId)) throw new AnnouncementQuotaError(400, 'A valid alert ID is required.');
  if (!targetClass || targetClass.length > 120) throw new AnnouncementQuotaError(400, 'A valid target class is required.');

  const reservationRef = actor.tenantRef.collection('announcementQuotaReservations').doc(alertId);
  if (action !== 'reserve') {
    await actor.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reservationRef);
      if (!snapshot.exists) {
        if (action === 'release') return;
        throw new AnnouncementQuotaError(404, 'The announcement reservation was not found.');
      }
      const data = snapshot.data() ?? {};
      if (data.teacherUid !== actor.uid || data.tenantEmail !== actor.email || data.targetClass !== targetClass) {
        throw new AnnouncementQuotaError(403, 'The announcement reservation does not belong to this teacher/session.');
      }
      if (action === 'commit' && data.status !== 'released') {
        transaction.set(reservationRef, { status: 'committed', committedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      } else if (action === 'release' && data.status === 'reserved') {
        transaction.set(reservationRef, { status: 'released', releasedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
    });
    return { success: true, status: action === 'commit' ? 'committed' : 'released', accessMode: 'academy_permissions' };
  }

  const classSnapshot = await actor.tenantRef.collection('classes').limit(251).get();
  if (classSnapshot.size > 250) throw new AnnouncementQuotaError(413, 'This workspace has more than 250 classes; ask the Academy Admin to review the announcement target scope.');
  const allClasses = classSnapshot.docs.map((doc) => ({ id: doc.id, name: classNameOf(doc.data() as RecordLike, doc.id) }));
  const selectedClasses = targetClass === 'All Classes' ? allClasses : allClasses.filter((item) => item.name === targetClass);
  if (!selectedClasses.length) throw new AnnouncementQuotaError(409, 'The selected announcement class could not be verified.');
  if (targetClass !== 'All Classes' && selectedClasses.length !== 1) throw new AnnouncementQuotaError(409, 'Duplicate class names must be resolved before sending an announcement.');

  const result = await actor.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reservationRef);
    if (snapshot.exists) {
      const data = snapshot.data() ?? {};
      if (data.teacherUid === actor.uid && data.tenantEmail === actor.email && data.targetClass === targetClass && ['reserved', 'committed'].includes(clean(data.status))) {
        return { status: clean(data.status), idempotent: true };
      }
      throw new AnnouncementQuotaError(409, 'A conflicting announcement reservation exists for this request.');
    }
    transaction.create(reservationRef, {
      teacherUid: actor.uid,
      tenantEmail: actor.email,
      targetClass,
      classIds: selectedClasses.map((item) => item.id),
      billingPeriod: monthKeyInPakistan(),
      quota: null,
      unrestricted: true,
      status: 'reserved',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: 'reserved', idempotent: false };
  });
  return { success: true, ...result, accessMode: 'academy_permissions', classCount: selectedClasses.length };
}

export async function handleAnnouncementQuota(request: Request) {
  try { return await reserveQuota(request); }
  catch (error) {
    if (error instanceof TeacherApiAuthError || error instanceof AnnouncementQuotaError) throw error;
    const status = Number((error as { status?: unknown })?.status);
    throw new AnnouncementQuotaError(Number.isInteger(status) && status >= 400 ? status : 500,
      error instanceof Error && status < 500 ? error.message : 'The announcement request could not be completed.');
  }
}

export async function assertAnnouncementQuotaReservationForActor(
  actor: Awaited<ReturnType<typeof verifyTeacherRequest>>,
  alertId: string,
  targetClass: string,
) {
  await assertTeacherActorFeatureEntitlement(actor, 'announcements');
  const reservationRef = actor.tenantRef.collection('announcementQuotaReservations').doc(alertId);
  const snapshot = await reservationRef.get();
  const data = snapshot.data() ?? {};
  if (!snapshot.exists || data.teacherUid !== actor.uid || data.tenantEmail !== actor.email ||
      data.targetClass !== targetClass || !['reserved', 'committed'].includes(clean(data.status))) {
    throw new AnnouncementQuotaError(403, 'A valid Academy permission reservation is required before sending this announcement.');
  }
  return { quota: null, billingPeriod: clean(data.billingPeriod), accessMode: 'academy_permissions' };
}

export async function getAnnouncementQuotaUsage(request: Request) {
  let actor;
  try { actor = await verifyTeacherRequest(request); }
  catch (error) {
    if (error instanceof TeacherApiAuthError) throw error;
    throw new AnnouncementQuotaError(401, 'Teacher authentication could not be verified.');
  }
  await assertTeacherActorFeatureEntitlement(actor, 'announcements');
  const classesSnapshot = await actor.tenantRef.collection('classes').get();
  return {
    success: true,
    accessMode: 'academy_permissions',
    unrestricted: true,
    message: 'Announcement access is controlled by your Academy Admin permission, not by a subscription quota.',
    classes: classesSnapshot.docs.map((doc) => ({ classId: doc.id, className: classNameOf(doc.data() as RecordLike, doc.id), quota: null, used: null, remaining: null })),
  };
}

export function sendAnnouncementQuotaApiError(response: Response, error: unknown) {
  const status = Number((error as { status?: unknown })?.status);
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  response.setHeader('Cache-Control', 'no-store');
  return response.status(safeStatus).json({ success: false, error: safeStatus >= 500 ? 'The announcement request could not be completed.' : error instanceof Error ? error.message : 'Access denied.' });
}
