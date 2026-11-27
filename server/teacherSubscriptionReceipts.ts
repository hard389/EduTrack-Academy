import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { getFirebaseAdminFirestore } from './firebaseAdmin.js';
import { verifyTeacherRequest, type TeacherApiRequest } from './teacherAuth.js';
import { createSubscriptionReceiptGrantToken } from './subscriptionReceiptToken.mjs';

type RecordLike = Record<string, unknown>;
type ReceiptRequest = TeacherApiRequest & { body?: unknown; method?: string };
export type ReceiptApiResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): ReceiptApiResponse;
  json(data: unknown): ReceiptApiResponse;
};
export class SubscriptionReceiptError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'SubscriptionReceiptError'; }
}
const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const normalizeEmail = (value: unknown) => clean(value).toLowerCase();
const WORKER_BASE = (process.env.EDUTRACK_R2_WORKER_URL || process.env.R2_API_BASE_URL || '').replace(/\/+$/, '');
const MAX_GRANT_SECONDS = 10 * 60;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requestBody(request: ReceiptRequest): RecordLike {
  if (!isRecord(request.body)) throw new SubscriptionReceiptError(400, 'A valid JSON request body is required.');
  return request.body;
}
function safeInvoiceId(value: unknown): string {
  const id = clean(value);
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(id)) throw new SubscriptionReceiptError(400, 'A valid subscription invoice ID is required.');
  return id;
}
function safeReceiptId(value: unknown): string {
  const id = clean(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new SubscriptionReceiptError(400, 'A valid payment proof upload ID is required.');
  }
  return id;
}
function timestampSeconds(value: unknown): number | null {
  if (value && typeof value === 'object') {
    const timestamp = value as { toMillis?: unknown };
    if (typeof timestamp.toMillis === 'function') {
      try {
        const milliseconds = Number((timestamp.toMillis as () => number).call(value));
        return Math.floor(milliseconds / 1000);
      } catch {
        return null;
      }
    }
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }
  return null;
}
function receiptSecret(): string {
  const secret = process.env.SUBSCRIPTION_RECEIPT_SECRET || '';
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new SubscriptionReceiptError(503, 'Secure payment proof upload is not configured on the server.');
  }
  return secret;
}
function grantToken(action: 'upload' | 'verify' | 'read', context: { adminUid: string; adminEmail: string; teacherUid: string; teacherEmail: string; invoiceId: string; receiptId: string }, seconds = MAX_GRANT_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  return createSubscriptionReceiptGrantToken({ ...context, action, iat: now, exp: now + seconds }, receiptSecret());
}

async function resolveWorkspace(uid: string, email: string) {
  const db = getFirebaseAdminFirestore();
  const matches = await db.collectionGroup('customers').where('uid', '==', uid).limit(30).get();
  const roots = new Map<string, DocumentReference>();
  for (const doc of matches.docs) {
    const registry = doc.data();
    const root = doc.ref.parent.parent;
    if (!root || doc.id !== uid || root.parent.id !== 'admins') continue;
    if ((clean(registry.uid) && clean(registry.uid) !== uid) || normalizeEmail(registry.email) !== email || registry.deleted === true || registry.active === false) continue;
    if (['deleted', 'disabled', 'inactive', 'pending', 'rejected', 'archived'].includes(clean(registry.status).toLowerCase())) continue;
    const rootSnapshot = await root.get();
    const rootData = rootSnapshot.data() ?? {};
    if (!rootSnapshot.exists || !clean(rootData.adminUid) || normalizeEmail(rootData.email ?? root.id) !== root.id) continue;
    roots.set(root.path, root);
  }
  if (roots.size !== 1) {
    throw new SubscriptionReceiptError(roots.size > 1 ? 409 : 403,
      roots.size > 1 ? 'Your teacher account is linked to multiple school subscription workspaces.' : 'Your active school subscription workspace could not be verified.');
  }
  const root = [...roots.values()][0];
  const rootSnapshot = await root.get();
  return { root, adminUid: clean(rootSnapshot.data()?.adminUid) };
}

function assertInvoiceTeacher(invoice: RecordLike, uid: string) {
  if (clean(invoice.teacherUid) !== uid) throw new SubscriptionReceiptError(404, 'The subscription invoice was not found for this teacher account.');
  if (['paid', 'cancelled', 'void'].includes(clean(invoice.status).toLowerCase()) || clean(invoice.paymentStatus).toLowerCase() === 'paid') {
    throw new SubscriptionReceiptError(409, 'This invoice cannot accept another payment proof.');
  }
  if (clean(invoice.paymentStatus).toLowerCase() === 'pending_review') {
    throw new SubscriptionReceiptError(409, 'A payment proof for this invoice is already waiting for administrator review.');
  }
}

export async function createTeacherReceiptUploadGrant(request: ReceiptRequest) {
  const actor = await verifyTeacherRequest(request);
  const body = requestBody(request);
  const invoiceId = safeInvoiceId(body.invoiceId);
  const workspace = await resolveWorkspace(actor.uid, actor.email);
  const root = workspace.root;
  const db = getFirebaseAdminFirestore();
  const invoiceRef = root.collection('subscriptionInvoices').doc(invoiceId);
  const candidateId = randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = nowSeconds + MAX_GRANT_SECONDS;
  const result = await db.runTransaction(async (transaction) => {
    const invoiceSnapshot = await transaction.get(invoiceRef);
    if (!invoiceSnapshot.exists) throw new SubscriptionReceiptError(404, 'The subscription invoice was not found.');
    const invoice = invoiceSnapshot.data() ?? {};
    assertInvoiceTeacher(invoice, actor.uid);

    const existingId = clean(invoice.receiptUploadId);
    const existingExpiry = timestampSeconds(invoice.receiptUploadExpiresAt);
    if (clean(invoice.paymentStatus).toLowerCase() === 'upload_in_progress' && existingId && existingExpiry && existingExpiry > nowSeconds) {
      const existingRef = root.collection('subscriptionPaymentSubmissions').doc(existingId);
      const existingSnapshot = await transaction.get(existingRef);
      const submission = existingSnapshot.data() ?? {};
      if (existingSnapshot.exists && clean(submission.teacherUid) === actor.uid && clean(submission.teacherEmail) === actor.email && clean(submission.adminUid) === workspace.adminUid && clean(submission.adminEmail) === root.id && clean(submission.invoiceId) === invoiceId && clean(submission.status) === 'upload_authorized') {
        return { receiptId: existingId, expiresAt: existingExpiry };
      }
    }

    const submissionRef = root.collection('subscriptionPaymentSubmissions').doc(candidateId);
    transaction.set(submissionRef, {
      id: candidateId,
      adminUid: workspace.adminUid,
      adminEmail: root.id,
      teacherUid: actor.uid,
      teacherEmail: actor.email,
      invoiceId,
      status: 'upload_authorized',
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(expiresAtSeconds * 1000),
    });
    transaction.update(invoiceRef, {
      paymentStatus: 'upload_in_progress',
      receiptUploadId: candidateId,
      receiptUploadExpiresAt: Timestamp.fromMillis(expiresAtSeconds * 1000),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { receiptId: candidateId, expiresAt: expiresAtSeconds };
  });

  const token = grantToken('upload', {
    adminUid: workspace.adminUid,
    adminEmail: root.id,
    teacherUid: actor.uid,
    teacherEmail: actor.email,
    invoiceId,
    receiptId: result.receiptId,
  }, Math.max(1, result.expiresAt - nowSeconds));
  return { success: true, receiptId: result.receiptId, grantToken: token, expiresAt: new Date(result.expiresAt * 1000).toISOString() };
}

export async function submitTeacherPaymentProof(request: ReceiptRequest) {
  const actor = await verifyTeacherRequest(request);
  const body = requestBody(request);
  const invoiceId = safeInvoiceId(body.invoiceId);
  const receiptId = safeReceiptId(body.receiptId);
  const paymentReference = clean(body.paymentReference);
  if (paymentReference.length > 160) throw new SubscriptionReceiptError(400, 'Payment reference cannot exceed 160 characters.');
  const workspace = await resolveWorkspace(actor.uid, actor.email);
  const root = workspace.root;
  const db = getFirebaseAdminFirestore();
  const invoiceRef = root.collection('subscriptionInvoices').doc(invoiceId);
  const submissionRef = root.collection('subscriptionPaymentSubmissions').doc(receiptId);
  const [invoiceSnapshot, submissionSnapshot] = await Promise.all([invoiceRef.get(), submissionRef.get()]);
  if (!invoiceSnapshot.exists || !submissionSnapshot.exists) throw new SubscriptionReceiptError(404, 'The payment proof upload session was not found.');
  const invoice = invoiceSnapshot.data() ?? {};
  const submission = submissionSnapshot.data() ?? {};
  assertInvoiceTeacher(invoice, actor.uid);
  const uploadExpiresAt = timestampSeconds(submission.expiresAt);
  if (clean(invoice.receiptUploadId) !== receiptId || clean(submission.receiptId || submission.id) !== receiptId ||
      clean(submission.teacherUid) !== actor.uid || clean(submission.teacherEmail) !== actor.email ||
      clean(submission.invoiceId) !== invoiceId || clean(submission.status) !== 'upload_authorized' ||
      clean(submission.adminUid) !== workspace.adminUid || uploadExpiresAt === null || uploadExpiresAt <= Math.floor(Date.now() / 1000)) {
    throw new SubscriptionReceiptError(409, 'This proof upload does not match the current invoice upload session.');
  }
  const adminUid = clean(submission.adminUid);
  const adminEmail = normalizeEmail(submission.adminEmail);
  if (!adminUid || adminEmail !== root.id) throw new SubscriptionReceiptError(409, 'The receipt upload workspace identity could not be confirmed.');

  const verifyToken = grantToken('verify', { adminUid, adminEmail, teacherUid: actor.uid, teacherEmail: actor.email, invoiceId, receiptId }, 120);
  let verifyResponse: Response;
  try {
    verifyResponse = await fetch(`${WORKER_BASE}/internal/subscription-receipts/${encodeURIComponent(receiptId)}`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${verifyToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new SubscriptionReceiptError(503, 'Cloudflare R2 could not verify the uploaded payment screenshot. Please try again.');
  }
  if (verifyResponse.status !== 204) {
    throw new SubscriptionReceiptError(409, 'The payment screenshot is not present in the private receipt store yet. Upload it again and retry.');
  }

  await db.runTransaction(async (transaction) => {
    const [freshInvoiceSnapshot, freshSubmissionSnapshot] = await Promise.all([transaction.get(invoiceRef), transaction.get(submissionRef)]);
    if (!freshInvoiceSnapshot.exists || !freshSubmissionSnapshot.exists) throw new SubscriptionReceiptError(404, 'The payment proof upload session no longer exists.');
    const freshInvoice = freshInvoiceSnapshot.data() ?? {};
    const freshSubmission = freshSubmissionSnapshot.data() ?? {};
    assertInvoiceTeacher(freshInvoice, actor.uid);
    const freshExpiry = timestampSeconds(freshSubmission.expiresAt);
    if (clean(freshInvoice.receiptUploadId) !== receiptId || clean(freshSubmission.status) !== 'upload_authorized' ||
        freshExpiry === null || freshExpiry <= Math.floor(Date.now() / 1000)) {
      throw new SubscriptionReceiptError(409, 'The payment proof was already submitted or the invoice changed. Refresh the page.');
    }
    transaction.update(submissionRef, {
      status: 'pending_review',
      paymentReference: paymentReference || null,
      submittedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(invoiceRef, {
      status: 'payment_pending',
      paymentStatus: 'pending_review',
      receiptId,
      receiptStatus: 'submitted',
      paymentReference: paymentReference || null,
      receiptSubmittedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true, status: 'pending_review', message: 'Payment screenshot submitted. Your administrator must review and approve it before the subscription becomes active.' };
}

export function sendSubscriptionReceiptError(response: ReceiptApiResponse, error: unknown) {
  const statusValue = Number((error as { status?: unknown })?.status);
  const status = Number.isInteger(statusValue) && statusValue >= 400 && statusValue <= 599 ? statusValue : 500;
  const message = status >= 500 ? 'The subscription payment proof service could not complete the request.' : error instanceof Error ? error.message : 'The request is invalid.';
  response.setHeader('Cache-Control', 'no-store');
  return response.status(status).json({ success: false, error: message });
}
