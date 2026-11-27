import { createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { verifyTeacherRequest, TeacherApiAuthError, type TeacherApiRequest } from './teacherAuth.js';
import { assertTeacherActorFeatureEntitlement } from './subscriptionEntitlements.js';
import { resolveTeacherWhatsAppSender, TeacherWhatsAppSenderError } from './teacherWhatsAppSender.js';
import { sendPostabiWebAppMessage } from './postabiWebApp.js';

type RecordLike = Record<string, unknown>;
type Request = TeacherApiRequest & { body?: unknown };
type Actor = Awaited<ReturnType<typeof verifyTeacherRequest>>;
type Recipient = { key: string; phone: string; studentCount: number };

export class LibraryLinkWhatsAppError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'LibraryLinkWhatsAppError'; }
}
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const isRecord = (value: unknown): value is RecordLike => typeof value === 'object' && value !== null && !Array.isArray(value);

function normalizePhone(value: unknown): string {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10) digits = `92${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : '';
}

function readRecipients(classData: RecordLike): Recipient[] {
  const raw = classData.students;
  const entries: unknown[] = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : [];
  const unique = new Map<string, Recipient>();
  for (const value of entries) {
    if (!isRecord(value) || value.libraryLinkWhatsAppOptIn !== true) continue;
    const phone = normalizePhone(value.phone);
    const savedPhone = normalizePhone(value.libraryLinkWhatsAppOptInPhone);
    if (!phone || phone !== savedPhone || !clean(value.libraryLinkWhatsAppOptInAt)) continue;
    const key = createHash('sha256').update(phone).digest('hex');
    const existing = unique.get(key);
    if (existing) existing.studentCount += 1;
    else unique.set(key, { key, phone, studentCount: 1 });
  }
  return [...unique.values()];
}

function makeShareUrl(resourceId: string): string {
  const base = (process.env.R2_API_BASE_URL || process.env.R2_PUBLIC_BASE_URL || process.env.EDUTRACK_R2_WORKER_URL || '').replace(/\/+$/, '');
  const parsed = new URL(base);
  if (parsed.protocol !== 'https:') throw new LibraryLinkWhatsAppError(503, 'The configured resource share domain is not HTTPS. No WhatsApp message was sent.');
  return `${parsed.toString().replace(/\/+$/, '')}/share/${encodeURIComponent(resourceId)}`;
}

async function loadAuthorizedSender(actor: Actor) {
  if (process.env.WHATSAPP_DISPATCH_ENABLED !== 'true' || process.env.WHATSAPP_LIBRARY_LINKS_ENABLED !== 'true') {
    throw new LibraryLinkWhatsAppError(503, 'Library-link WhatsApp dispatch is disabled on the server. The resource remains saved; no WhatsApp message was sent.');
  }
  const snapshot = await actor.db.collection('platformSettings').doc('whatsapp').get();
  const settings = snapshot.data() ?? {};
  if (settings.enabled !== true || settings.libraryLinkDispatchEnabled !== true ||
      settings.libraryLinkDispatchAuthorizationVersion !== 1 ||
      settings.libraryLinkDispatchAuthorizationScope !== 'library_resource_links_to_opted_in_guardians_only' ||
      !clean(settings.libraryLinkDispatchAuthorizedAt) || !clean(settings.libraryLinkDispatchAuthorizedByUid)) {
    throw new LibraryLinkWhatsAppError(409, 'Library-link WhatsApp requires separate Admin authorization and current guardian consent. The resource remains saved; no message was sent.');
  }
  try { return { settings, sender: await resolveTeacherWhatsAppSender(actor.db, actor.uid, settings) }; }
  catch (error) {
    if (error instanceof TeacherWhatsAppSenderError) throw new LibraryLinkWhatsAppError(error.status, error.message);
    throw new LibraryLinkWhatsAppError(503, 'The authorized WhatsApp sender could not be resolved. No message was sent.');
  }
}

export async function dispatchLibraryLinkWhatsApp(request: Request) {
  let actor: Actor;
  try { actor = await verifyTeacherRequest(request); }
  catch (error) {
    if (error instanceof TeacherApiAuthError) throw error;
    throw new LibraryLinkWhatsAppError(401, 'Teacher authentication could not be verified.');
  }
  try { await assertTeacherActorFeatureEntitlement(actor, 'library_link_whatsapp'); }
  catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    throw new LibraryLinkWhatsAppError(Number.isInteger(status) ? status : 403,
      error instanceof Error ? error.message : 'Library Link WhatsApp is not included in the current plan.');
  }

  if (!isRecord(request.body)) throw new LibraryLinkWhatsAppError(400, 'A valid JSON request body is required.');
  const classId = clean(request.body.classId);
  const resourceId = clean(request.body.resourceId);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(classId) || !/^[A-Za-z0-9_-]{1,128}$/.test(resourceId)) {
    throw new LibraryLinkWhatsAppError(400, 'A valid class and resource ID are required.');
  }
  const { sender } = await loadAuthorizedSender(actor);
  const classRef = actor.tenantRef.collection('classes').doc(classId);
  const resourceRef = classRef.collection('documents').doc(resourceId);
  const [classSnapshot, resourceSnapshot] = await Promise.all([classRef.get(), resourceRef.get()]);
  if (!classSnapshot.exists || !resourceSnapshot.exists) throw new LibraryLinkWhatsAppError(404, 'The saved class resource could not be found in this teacher workspace.');
  const resource = resourceSnapshot.data() ?? {};
  if (clean(resource.id) !== resourceId || clean(resource.storagePath) !== `resources/${resourceId}`) {
    throw new LibraryLinkWhatsAppError(409, 'The saved resource metadata is invalid. No WhatsApp message was sent.');
  }
  const title = clean(resource.title).slice(0, 180) || 'New class resource';
  const shareUrl = makeShareUrl(resourceId);
  const recipients = readRecipients(classSnapshot.data() as RecordLike);
  if (recipients.length > 500) throw new LibraryLinkWhatsAppError(413, 'More than 500 opted-in guardians were found for this class. No WhatsApp message was sent.');

  const dispatchId = createHash('sha256').update(`${actor.email}|${classId}|${resourceId}`).digest('hex');
  const dispatchRef = actor.tenantRef.collection('whatsappLibraryLinkDispatches').doc(dispatchId);
  try {
    await dispatchRef.create({
      kind: 'library_resource_link', tenantId: actor.email, teacherUid: actor.uid,
      classId, resourceId, resourceTitle: title, eligibleCount: recipients.length,
      acceptedCount: 0, rejectedCount: 0, unknownOutcomeCount: 0,
      status: recipients.length ? 'dispatching' : 'no_eligible_recipients',
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
  } catch {
    const existing = await dispatchRef.get();
    if (existing.exists) {
      const data = existing.data() ?? {};
      if (data.teacherUid !== actor.uid || data.resourceId !== resourceId || data.classId !== classId) {
        throw new LibraryLinkWhatsAppError(409, 'A conflicting resource dispatch record exists.');
      }
      return { success: true, idempotent: true, status: clean(data.status), acceptedCount: Number(data.acceptedCount) || 0, deliveryConfirmedCount: 0, message: 'This resource-link dispatch was already recorded; duplicate messages were not sent. Provider acceptance is not delivery confirmation.' };
    }
    throw new LibraryLinkWhatsAppError(500, 'The resource-link dispatch could not be initialized.');
  }

  const batch = actor.db.batch();
  for (const recipient of recipients) {
    batch.create(dispatchRef.collection('recipients').doc(recipient.key), {
      recipientPhoneHash: recipient.key,
      recipientLast4: recipient.phone.slice(-4),
      studentCount: recipient.studentCount,
      status: 'pending', retrySafe: false,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
  }
  if (recipients.length) await batch.commit();

  let acceptedCount = 0;
  let rejectedCount = 0;
  let unknownOutcomeCount = 0;
  const recipientCollection = dispatchRef.collection('recipients');
  for (let offset = 0; offset < recipients.length; offset += 5) {
    const group = recipients.slice(offset, offset + 5);
    const outcomes = await Promise.all(group.map(async (recipient) => {
      const recipientRef = recipientCollection.doc(recipient.key);
      try {
        const provider = await sendPostabiWebAppMessage({
          credentials: sender.credentials,
          to: recipient.phone,
          type: 'text',
          message: `A new learning resource has been uploaded for your child's class.\n\n${title}\n${shareUrl}\n\nThis link is intended for the enrolled student and family.`,
        });
        const providerFrom = normalizePhone(provider.from);
        const senderPhone = normalizePhone(sender.senderNumber);
        const senderMatched = providerFrom ? providerFrom === senderPhone : sender.senderType === 'central';
        const status = provider.accepted && senderMatched ? 'provider_accepted'
          : provider.httpStatus >= 400 && provider.httpStatus < 500 && provider.httpStatus !== 429 ? 'provider_rejected' : 'unknown_outcome';
        const failedAt = status === 'provider_rejected' ? Timestamp.now() : null;
        await recipientRef.update({ status, providerAccepted: status === 'provider_accepted', senderIdentityMatched: senderMatched, providerHttpStatus: provider.httpStatus, providerStatus: provider.providerStatus || null, providerMessageId: provider.messageId, ...(failedAt ? { failedAt, expiresAt: Timestamp.fromMillis(failedAt.toMillis() + 24 * 60 * 60 * 1000) } : {}), completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
        return status;
      } catch (error) {
        await recipientRef.update({ status: 'unknown_outcome', providerErrorName: error instanceof Error ? error.name.slice(0, 80) : 'UnknownError', retrySafe: false, completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
        return 'unknown_outcome';
      }
    }));
    for (const status of outcomes) {
      if (status === 'provider_accepted') acceptedCount += 1;
      else if (status === 'provider_rejected') rejectedCount += 1;
      else unknownOutcomeCount += 1;
    }
  }
  const status = unknownOutcomeCount > 0 ? 'completed_with_unknown_outcomes' : rejectedCount > 0 ? 'completed_with_rejections' : 'completed';
  await dispatchRef.set({ status, acceptedCount, rejectedCount, unknownOutcomeCount, completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return {
    success: true, status, eligibleCount: recipients.length, acceptedCount, rejectedCount, unknownOutcomeCount,
    deliveryConfirmedCount: 0,
    message: recipients.length
      ? `${acceptedCount} messages were accepted by the WhatsApp provider. Provider acceptance is not delivery confirmation.`
      : 'The resource is saved, but no guardian has current Library Link WhatsApp consent for this contact number.',
  };
}

export function sendLibraryLinkWhatsAppApiError(res: { status(code: number): { json(body: unknown): unknown } }, error: unknown) {
  const status = error instanceof TeacherApiAuthError || error instanceof LibraryLinkWhatsAppError || error instanceof TeacherWhatsAppSenderError ? error.status : 500;
  const message = error instanceof TeacherApiAuthError || error instanceof LibraryLinkWhatsAppError || error instanceof TeacherWhatsAppSenderError ? error.message : 'Library-link WhatsApp dispatch could not be completed.';
  if (status >= 500) console.error('[LibraryLinkWhatsApp] Request failed.', error instanceof Error ? error.name : 'UnknownError');
  return res.status(status).json({ success: false, error: message });
}
