import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type DocumentSnapshot } from 'firebase-admin/firestore';
import {
  getFirebaseAdminAuth,
  getFirebaseAdminFirestore,
  verifyAdminRequest,
} from './firebaseAdmin.js';
import { createSubscriptionReceiptGrantToken } from './subscriptionReceiptToken.mjs';
import { isValidPeriodKey } from './subscriptionDomain.mjs';
import { getSubscriptionPeriodBounds, getSubscriptionPeriodStatus, isReviewablePayment } from './subscriptionReviewDomain.mjs';
import { renewPostpaidUsageWindow } from './postpaidSubscriptionDomain.mjs';
import { FEATURE_PERMISSION_KEYS, normalizeFeaturePermissions } from './subscriptionFeaturePermissions.mjs';
import { resolveTeacherEntitlementForIdentity, syncTeacherEntitlementProjection } from './subscriptionEntitlements.js';

type RecordLike = Record<string, unknown>;
type ReviewRequest = {
  method?: string;
  headers: { authorization?: string | string[]; [key: string]: string | string[] | undefined };
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};
export type ReviewResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): ReviewResponse;
  json(data: unknown): ReviewResponse;
  send(data: Buffer): ReviewResponse;
};
export class SubscriptionReviewError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'SubscriptionReviewError'; }
}
type AdminContext = { uid: string; email: string; root: DocumentReference<DocumentData>; };
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const normalizeEmail = (value: unknown): string => clean(value).toLowerCase();
const WORKER_BASE = (process.env.EDUTRACK_R2_WORKER_URL || process.env.R2_API_BASE_URL || '').replace(/\/+$/, '');
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function bodyRecord(request: ReviewRequest): RecordLike {
  if (!isRecord(request.body)) throw new SubscriptionReviewError(400, 'A valid JSON request body is required.');
  return request.body;
}
function safeReceiptId(value: unknown): string {
  const id = clean(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new SubscriptionReviewError(400, 'A valid payment proof ID is required.');
  }
  return id;
}
function safeInvoiceId(value: unknown): string {
  const id = clean(value);
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(id)) throw new SubscriptionReviewError(400, 'A valid subscription invoice ID is required.');
  return id;
}
function queryString(request: ReviewRequest, key: string): string {
  const value = request.query?.[key];
  return typeof value === 'string' ? value : '';
}
function toIso(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    try { return (value.toDate as () => Date)().toISOString(); } catch { return null; }
  }
  return null;
}
function receiptSecret(): string {
  const secret = process.env.SUBSCRIPTION_RECEIPT_SECRET || '';
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new SubscriptionReviewError(503, 'Private payment receipt access is not configured on the server.');
  }
  return secret;
}

async function getAdminContext(request: ReviewRequest): Promise<AdminContext> {
  const actor = await verifyAdminRequest(request as Parameters<typeof verifyAdminRequest>[0]);
  const authUser = await getFirebaseAdminAuth().getUser(actor.uid);
  const email = normalizeEmail(authUser.email);
  if (!email || email !== normalizeEmail(actor.email) || authUser.disabled) {
    throw new SubscriptionReviewError(403, 'Administrator account verification failed.');
  }
  const db = getFirebaseAdminFirestore();
  const root = db.collection('admins').doc(email);
  const snapshot = await root.get();
  const rootData = snapshot.data() ?? {};
  if (!snapshot.exists || clean(rootData.adminUid) !== actor.uid || normalizeEmail(rootData.email ?? root.id) !== email) {
    throw new SubscriptionReviewError(403, 'This administrator workspace could not be verified.');
  }
  return { uid: actor.uid, email, root };
}

function makeGrant(context: AdminContext, submission: RecordLike, invoiceId: string, receiptId: string, action: 'verify' | 'read'): string {
  const now = Math.floor(Date.now() / 1000);
  return createSubscriptionReceiptGrantToken({
    action,
    adminUid: context.uid,
    adminEmail: context.email,
    teacherUid: clean(submission.teacherUid),
    teacherEmail: normalizeEmail(submission.teacherEmail),
    invoiceId,
    receiptId,
    iat: now,
    exp: now + 120,
  }, receiptSecret());
}

async function verifyReceiptObject(context: AdminContext, submission: RecordLike, invoiceId: string, receiptId: string): Promise<void> {
  const token = makeGrant(context, submission, invoiceId, receiptId, 'verify');
  let response: Response;
  try {
    response = await fetch(`${WORKER_BASE}/internal/subscription-receipts/${encodeURIComponent(receiptId)}`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new SubscriptionReviewError(503, 'Cloudflare R2 could not verify this payment screenshot. Try again.');
  }
  if (response.status !== 204) {
    throw new SubscriptionReviewError(409, 'The private payment screenshot is missing or its ownership could not be verified.');
  }
}

function paymentIsOwnedByAdmin(context: AdminContext, submission: RecordLike, invoice: RecordLike, invoiceId: string, receiptId: string): boolean {
  return clean(submission.id) === receiptId &&
    clean(submission.adminUid) === context.uid && normalizeEmail(submission.adminEmail) === context.email &&
    clean(submission.invoiceId) === invoiceId &&
    clean(invoice.teacherUid) !== '' && clean(submission.teacherUid) === clean(invoice.teacherUid) &&
    normalizeEmail(submission.teacherEmail) === normalizeEmail(invoice.teacherEmail) &&
    clean(invoice.receiptId) === receiptId;
}

export async function getAdminSubscriptionReviews(request: ReviewRequest) {
  const context = await getAdminContext(request);
  const snapshot = await context.root.collection('subscriptionPaymentSubmissions')
    .where('status', '==', 'pending_review').limit(100).get();
  const results = await Promise.all(snapshot.docs.map(async (doc) => {
    const submission = doc.data();
    const receiptId = doc.id;
    const invoiceIdValue = clean(submission.invoiceId);
    if (!/^[A-Za-z0-9_-]{1,180}$/.test(invoiceIdValue)) return null;
    const invoiceId = invoiceIdValue;
    if (clean(submission.id) !== receiptId || clean(submission.adminUid) !== context.uid ||
        normalizeEmail(submission.adminEmail) !== context.email) return null;
    const invoiceSnapshot = await context.root.collection('subscriptionInvoices').doc(invoiceId).get();
    if (!invoiceSnapshot.exists) return null;
    const invoice = invoiceSnapshot.data() ?? {};
    if (!isReviewablePayment({ ...invoice, id: invoiceId }, { ...submission, id: receiptId }, receiptId) ||
        !paymentIsOwnedByAdmin(context, submission, invoice, invoiceId, receiptId)) return null;
    return {
      receiptId,
      invoiceId,
      invoiceNumber: clean(invoice.invoiceNumber),
      teacherUid: clean(invoice.teacherUid),
      teacherEmail: normalizeEmail(invoice.teacherEmail),
      teacherName: clean(invoice.teacherName) || normalizeEmail(invoice.teacherEmail),
      billingPeriod: clean(invoice.billingPeriod),
      planName: clean((invoice.planSnapshot as RecordLike | null)?.name),
      totalPaisa: Number(invoice.totalPaisa) || 0,
      currency: 'PKR',
      paymentReference: clean(submission.paymentReference) || clean(invoice.paymentReference),
      submittedAt: toIso(submission.submittedAt),
    };
  }));
  const reviews = results.filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
  return { success: true, reviews, pendingCount: reviews.length, generatedAt: new Date().toISOString() };
}

export async function reviewAdminSubscriptionPayment(request: ReviewRequest) {
  const context = await getAdminContext(request);
  const body = bodyRecord(request);
  const action = clean(body.action);
  if (action !== 'approve' && action !== 'reject') throw new SubscriptionReviewError(400, 'Choose approve or reject.');
  const receiptId = safeReceiptId(body.receiptId);
  const reviewNote = clean(body.reviewNote);
  if (reviewNote.length > 500) throw new SubscriptionReviewError(400, 'The review note cannot exceed 500 characters.');
  const db = getFirebaseAdminFirestore();
  const submissionRef = context.root.collection('subscriptionPaymentSubmissions').doc(receiptId);
  const firstSubmissionSnapshot = await submissionRef.get();
  if (!firstSubmissionSnapshot.exists) throw new SubscriptionReviewError(404, 'The payment proof was not found in this administrator workspace.');
  const firstSubmission = firstSubmissionSnapshot.data() ?? {};
  if (clean(firstSubmission.adminUid) !== context.uid || normalizeEmail(firstSubmission.adminEmail) !== context.email || clean(firstSubmission.id) !== receiptId) {
    throw new SubscriptionReviewError(404, 'The payment proof was not found in this administrator workspace.');
  }
  const invoiceId = safeInvoiceId(firstSubmission.invoiceId);
  const invoiceRef = context.root.collection('subscriptionInvoices').doc(invoiceId);
  const firstInvoiceSnapshot = await invoiceRef.get();
  if (!firstInvoiceSnapshot.exists) throw new SubscriptionReviewError(404, 'The invoice associated with this payment proof was not found.');
  const firstInvoice = firstInvoiceSnapshot.data() ?? {};
  if (!paymentIsOwnedByAdmin(context, firstSubmission, firstInvoice, invoiceId, receiptId)) {
    throw new SubscriptionReviewError(409, 'The payment proof does not match the invoice ownership details.');
  }

  if (action === 'approve') {
    if (clean(firstSubmission.status) === 'approved' && clean(firstInvoice.paymentStatus) === 'paid') {
      return { success: true, action, idempotent: true, status: 'approved', invoiceId, receiptId };
    }
    if (!isValidPeriodKey(clean(firstInvoice.billingPeriod))) throw new SubscriptionReviewError(409, 'The invoice has an invalid billing month and cannot activate a subscription.');
    if (!isReviewablePayment({ ...firstInvoice, id: invoiceId }, { ...firstSubmission, id: receiptId }, receiptId)) {
      throw new SubscriptionReviewError(409, 'This payment proof is no longer waiting for review. Refresh the review queue.');
    }
    await verifyReceiptObject(context, firstSubmission, invoiceId, receiptId);
    const period = getSubscriptionPeriodBounds(clean(firstInvoice.billingPeriod));
    const teacherUid = clean(firstInvoice.teacherUid);
    const accountRef = context.root.collection('subscriptionAccounts').doc(teacherUid);
    const periodRef = accountRef.collection('periods').doc(period.billingPeriod);
    const paymentRef = context.root.collection('subscriptionPayments').doc(receiptId);
    const invoiceAddOns = Array.isArray(firstInvoice.addOnSnapshots) ? firstInvoice.addOnSnapshots : [];
    const addOnGrants = invoiceAddOns.map((raw) => {
      if (!isRecord(raw)) throw new SubscriptionReviewError(409, 'The invoice contains an invalid add-on snapshot.');
      const catalogId = clean(raw.catalogId);
      const featureKey = clean(raw.featureKey);
      const name = clean(raw.name);
      const monthlyPricePaisa = Number(raw.monthlyPricePaisa);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(catalogId) || !FEATURE_PERMISSION_KEYS.includes(featureKey as typeof FEATURE_PERMISSION_KEYS[number]) ||
          !name || !Number.isSafeInteger(monthlyPricePaisa) || monthlyPricePaisa < 1) {
        throw new SubscriptionReviewError(409, 'The invoice contains an invalid add-on snapshot.');
      }
      return {
        ref: accountRef.collection('addOns').doc(randomUUID()),
        catalogId,
        featureKey,
        name,
        description: clean(raw.description),
        monthlyPricePaisa,
      };
    });
    let addOnActivationWindow = period;
    const result = await db.runTransaction(async (transaction) => {
      const [submissionSnapshot, invoiceSnapshot, periodSnapshot, accountSnapshot] = await Promise.all([
        transaction.get(submissionRef), transaction.get(invoiceRef), transaction.get(periodRef), transaction.get(accountRef),
      ]);
      const addOnSnapshots: DocumentSnapshot<DocumentData>[] = await Promise.all(
        addOnGrants.map((grant) => transaction.get(grant.ref)),
      );
      if (!submissionSnapshot.exists || !invoiceSnapshot.exists) throw new SubscriptionReviewError(404, 'The payment or invoice record no longer exists.');
      const submission = submissionSnapshot.data() ?? {};
      const invoice = invoiceSnapshot.data() ?? {};
      const periodStatus = getSubscriptionPeriodStatus(period, new Date());
      if (clean(submission.status) === 'approved' && clean(invoice.paymentStatus) === 'paid') {
        return { idempotent: true, periodStatus };
      }
      if (!isReviewablePayment({ ...invoice, id: invoiceId }, { ...submission, id: receiptId }, receiptId) ||
          !paymentIsOwnedByAdmin(context, submission, invoice, invoiceId, receiptId)) {
        throw new SubscriptionReviewError(409, 'The payment proof changed while it was being reviewed. Refresh the page.');
      }
      if (periodSnapshot.exists && clean(periodSnapshot.data()?.invoiceId) !== invoiceId) {
        throw new SubscriptionReviewError(409, 'A different invoice has already activated this teacher for the selected month.');
      }
      const accountData = accountSnapshot.data() ?? {};
      const isPostpaidInvoice = clean(invoice.billingSource) === 'postpaid_monthly';
      if (isPostpaidInvoice && (!accountSnapshot.exists || clean(accountData.accessMode) !== 'postpaid_monthly' ||
          clean(accountData.postpaidInvoiceId) !== invoiceId || clean(accountData.postpaidUsageBillingPeriod) !== clean(invoice.billingPeriod) ||
          accountData.active !== true || clean(accountData.status) !== 'active')) {
        throw new SubscriptionReviewError(409, 'This postpaid invoice is no longer linked to an active matching teacher usage period. Review the customer account before approving payment.');
      }
      const nextPostpaidWindow = isPostpaidInvoice
        ? renewPostpaidUsageWindow({
          currentExpiresAt: accountData.postpaidUsageExpiresAt ?? accountData.expiresAt,
          now: new Date(),
        })
        : null;
      if (nextPostpaidWindow) addOnActivationWindow = nextPostpaidWindow;
      const approvedAt = FieldValue.serverTimestamp();
      transaction.update(submissionRef, {
        status: 'approved',
        reviewNote: reviewNote || null,
        reviewedAt: approvedAt,
        reviewedByUid: context.uid,
        reviewedByEmail: context.email,
      });
      transaction.update(invoiceRef, {
        status: 'paid',
        paymentStatus: 'paid',
        receiptStatus: 'approved',
        receiptReviewNote: reviewNote || null,
        receiptReviewedAt: approvedAt,
        receiptReviewedByUid: context.uid,
        receiptReviewedByEmail: context.email,
        paymentApprovedAt: approvedAt,
        paymentApprovedByUid: context.uid,
        paymentApprovedByEmail: context.email,
        paidAt: approvedAt,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(periodRef, {
        teacherUid,
        teacherEmail: normalizeEmail(invoice.teacherEmail),
        billingPeriod: period.billingPeriod,
        invoiceId,
        receiptId,
        planId: clean(invoice.planId) || null,
        planName: clean((invoice.planSnapshot as RecordLike | null)?.name) || 'Subscription plan',
        pricingMode: clean(invoice.pricingMode) === 'per_student' ? 'per_student' : 'lump_sum',
        planPricePaisa: Number((invoice.planSnapshot as RecordLike | null)?.amountPaisa) || 0,
        featurePermissions: normalizeFeaturePermissions((invoice.planSnapshot as RecordLike | null)?.featurePermissions, false),
        featureVisibilityMode: clean((invoice.planSnapshot as RecordLike | null)?.featureVisibilityMode) === 'locked' ? 'locked' : 'hide',
        announcementQuotaPerClass: Number.isSafeInteger((invoice.planSnapshot as RecordLike | null)?.announcementQuotaPerClass) ? Math.max(4, Number((invoice.planSnapshot as RecordLike | null)?.announcementQuotaPerClass)) : 4,
        announcementExtraPackSize: Number.isSafeInteger((invoice.planSnapshot as RecordLike | null)?.announcementExtraPackSize) ? Math.max(1, Number((invoice.planSnapshot as RecordLike | null)?.announcementExtraPackSize)) : 4,
        announcementExtraPackPricePaisa: Number.isSafeInteger((invoice.planSnapshot as RecordLike | null)?.announcementExtraPackPricePaisa) ? Math.max(0, Number((invoice.planSnapshot as RecordLike | null)?.announcementExtraPackPricePaisa)) : 0,
        startedAt: Timestamp.fromDate(period.startedAt),
        expiresAt: Timestamp.fromDate(period.expiresAt),
        status: periodStatus,
        approvedAt,
        approvedByUid: context.uid,
        approvedByEmail: context.email,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      for (let index = 0; index < addOnGrants.length; index += 1) {
        const grant = addOnGrants[index];
        const existingGrant = addOnSnapshots[index];
        if (existingGrant?.exists) {
          const existingData = existingGrant.data() ?? {};
          if (clean(existingData.invoiceId) !== invoiceId || clean(existingData.catalogId) !== grant.catalogId) {
            throw new SubscriptionReviewError(409, 'An add-on grant ID collided with another subscription record.');
          }
          continue;
        }
        transaction.create(grant.ref, {
          id: grant.ref.id,
          catalogId: grant.catalogId,
          invoiceId,
          billingPeriod: isPostpaidInvoice ? addOnActivationWindow.billingPeriod : period.billingPeriod,
          name: grant.name,
          description: grant.description,
          featureKeys: [grant.featureKey],
          monthlyPricePaisa: grant.monthlyPricePaisa,
          approved: true,
          status: 'active',
          grantSource: 'paid_addon_invoice',
          startsAt: Timestamp.fromDate(isPostpaidInvoice ? addOnActivationWindow.startedAt : period.startedAt),
          expiresAt: Timestamp.fromDate(isPostpaidInvoice ? addOnActivationWindow.expiresAt : period.expiresAt),
          approvedByUid: context.uid,
          approvedByEmail: context.email,
          approvedAt,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      const existingLatestPeriod = clean(accountData.latestApprovedPeriod);
      const accountPatch: RecordLike = {
        teacherUid,
        teacherEmail: normalizeEmail(invoice.teacherEmail),
        lastPaymentApprovedAt: approvedAt,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!existingLatestPeriod || period.billingPeriod >= existingLatestPeriod) {
        accountPatch.latestApprovedPeriod = period.billingPeriod;
        accountPatch.latestApprovedInvoiceId = invoiceId;
      }
      if (isPostpaidInvoice) {
        // A postpaid invoice settles the previous usage window. Approval starts the next month
        // at the old expiry when approval is early, or immediately when the usage window expired.
        const nextWindow = nextPostpaidWindow;
        if (!nextWindow) throw new SubscriptionReviewError(409, 'The next postpaid usage period could not be calculated.');
        const savedPlan = isRecord(invoice.planSnapshot) ? invoice.planSnapshot : {};
        const nextPlanSnapshot: RecordLike = { ...savedPlan };
        delete nextPlanSnapshot.billableStudentCount;
        delete nextPlanSnapshot.billableClassCount;
        delete nextPlanSnapshot.postpaidUsageBillingPeriod;
        delete nextPlanSnapshot.postpaidUsageStartedAt;
        delete nextPlanSnapshot.postpaidUsageExpiresAt;
        accountPatch.active = true;
        accountPatch.status = 'active';
        accountPatch.accessMode = 'postpaid_monthly';
        accountPatch.billingMode = 'postpaid_monthly';
        accountPatch.planId = clean(invoice.planId) || null;
        accountPatch.planName = clean(savedPlan.name) || 'Subscription plan';
        accountPatch.pricingMode = clean(invoice.pricingMode) === 'per_student' ? 'per_student' : 'lump_sum';
        accountPatch.planPricePaisa = Number(savedPlan.amountPaisa) || 0;
        accountPatch.postpaidPlanId = clean(invoice.planId) || null;
        accountPatch.postpaidPlanName = clean(savedPlan.name) || 'Subscription plan';
        accountPatch.postpaidPlanSnapshot = nextPlanSnapshot;
        accountPatch.featurePermissions = normalizeFeaturePermissions(savedPlan.featurePermissions, false);
        accountPatch.featureVisibilityMode = clean(savedPlan.featureVisibilityMode) === 'locked' ? 'locked' : 'hide';
        accountPatch.fullAccessGranted = false;
        accountPatch.startedAt = Timestamp.fromDate(nextWindow.startedAt);
        accountPatch.expiresAt = Timestamp.fromDate(nextWindow.expiresAt);
        accountPatch.postpaidUsageStartedAt = Timestamp.fromDate(nextWindow.startedAt);
        accountPatch.postpaidUsageExpiresAt = Timestamp.fromDate(nextWindow.expiresAt);
        accountPatch.postpaidUsageBillingPeriod = nextWindow.billingPeriod;
        accountPatch.postpaidInvoiceId = FieldValue.delete();
        accountPatch.postpaidInvoiceStatus = 'paid';
        accountPatch.postpaidLastPaidInvoiceId = invoiceId;
        accountPatch.postpaidLastPaidBillingPeriod = clean(invoice.billingPeriod);
        accountPatch.latestInvoiceId = invoiceId;
        accountPatch.latestInvoicePeriod = clean(invoice.billingPeriod);
        accountPatch.requestedPlanId = FieldValue.delete();
        accountPatch.requestedPlanName = FieldValue.delete();
      }
      // Only a currently applicable calendar-based paid period may replace the account's live status.
      // Future and past approvals stay in their own month records and do not interrupt another active month.
      if (!isPostpaidInvoice && periodStatus === 'active') {
        accountPatch.active = true;
        accountPatch.status = 'active';
        accountPatch.planId = clean(invoice.planId) || null;
        accountPatch.planName = clean((invoice.planSnapshot as RecordLike | null)?.name) || 'Subscription plan';
        accountPatch.pricingMode = clean(invoice.pricingMode) === 'per_student' ? 'per_student' : 'lump_sum';
        accountPatch.planPricePaisa = Number((invoice.planSnapshot as RecordLike | null)?.amountPaisa) || 0;
        accountPatch.startedAt = Timestamp.fromDate(period.startedAt);
        accountPatch.expiresAt = Timestamp.fromDate(period.expiresAt);
        accountPatch.latestInvoiceId = invoiceId;
        accountPatch.latestInvoicePeriod = period.billingPeriod;
        accountPatch.accessMode = 'paid_subscription';
        accountPatch.featureVisibilityMode = clean((invoice.planSnapshot as RecordLike | null)?.featureVisibilityMode) === 'locked' ? 'locked' : 'hide';
        accountPatch.requestedPlanId = FieldValue.delete();
        accountPatch.requestedPlanName = FieldValue.delete();
        accountPatch.fullAccessGranted = false;
      } else if (!isPostpaidInvoice && periodStatus === 'scheduled' && accountData.active !== true &&
          !['suspended', 'cancelled', 'canceled', 'revoked', 'disabled', 'deleted', 'rejected', 'archived']
            .includes(clean(accountData.status).toLowerCase())) {
        // Invoice generation creates an inactive account shell before payment review.
        // A newly approved future period must move that shell to `scheduled`, otherwise
        // the entitlement resolver's fail-closed inactive status would block its activation.
        accountPatch.active = false;
        accountPatch.status = 'scheduled';
      }
      transaction.set(accountRef, accountPatch, { merge: true });
      transaction.set(paymentRef, {
        receiptId,
        invoiceId,
        invoiceNumber: clean(invoice.invoiceNumber),
        teacherUid,
        teacherEmail: normalizeEmail(invoice.teacherEmail),
        teacherName: clean(invoice.teacherName),
        billingPeriod: period.billingPeriod,
        amountPaisa: Number(invoice.totalPaisa) || 0,
        currency: 'PKR',
        method: 'Manual receipt',
        paymentReference: clean(submission.paymentReference) || clean(invoice.paymentReference) || null,
        status: 'approved',
        submittedAt: submission.submittedAt ?? null,
        approvedAt,
        approvedByUid: context.uid,
        approvedByEmail: context.email,
        createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { idempotent: false, periodStatus };
    });
    if (!result.idempotent) {
      try {
        const email = normalizeEmail(firstInvoice.teacherEmail);
        const resolved = await resolveTeacherEntitlementForIdentity(db, teacherUid, email);
        await syncTeacherEntitlementProjection(db, teacherUid, email, resolved.entitlement, resolved.projectionWriteGuard);
      } catch (projectionError) {
        // Approval remains authoritative; the teacher subscription GET repairs the projection.
        console.error('[EduTrack][subscription-entitlement] projection refresh after approval failed:', projectionError);
      }
    }
    return { success: true, action, idempotent: result.idempotent, status: 'approved', subscriptionPeriodStatus: result.periodStatus, invoiceId, receiptId };
  }

  const result = await db.runTransaction(async (transaction) => {
    const [submissionSnapshot, invoiceSnapshot] = await Promise.all([transaction.get(submissionRef), transaction.get(invoiceRef)]);
    if (!submissionSnapshot.exists || !invoiceSnapshot.exists) throw new SubscriptionReviewError(404, 'The payment or invoice record no longer exists.');
    const submission = submissionSnapshot.data() ?? {};
    const invoice = invoiceSnapshot.data() ?? {};
    if (clean(submission.status) === 'rejected' && clean(invoice.paymentStatus) === 'rejected') return { idempotent: true };
    if (!isReviewablePayment({ ...invoice, id: invoiceId }, { ...submission, id: receiptId }, receiptId) ||
        !paymentIsOwnedByAdmin(context, submission, invoice, invoiceId, receiptId)) {
      throw new SubscriptionReviewError(409, 'This payment proof is no longer waiting for review. Refresh the review queue.');
    }
    const reviewedAt = FieldValue.serverTimestamp();
    const note = reviewNote || 'Payment proof was rejected by the administrator. Please contact the school and submit a new screenshot.';
    transaction.update(submissionRef, {
      status: 'rejected',
      reviewNote: note,
      reviewedAt,
      reviewedByUid: context.uid,
      reviewedByEmail: context.email,
    });
    transaction.update(invoiceRef, {
      status: 'unpaid',
      paymentStatus: 'rejected',
      receiptStatus: 'rejected',
      receiptReviewNote: note,
      receiptReviewedAt: reviewedAt,
      receiptReviewedByUid: context.uid,
      receiptReviewedByEmail: context.email,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { idempotent: false };
  });
  return { success: true, action, idempotent: result.idempotent, status: 'rejected', invoiceId, receiptId };
}

export async function getAdminSubscriptionReceiptImage(request: ReviewRequest): Promise<{ bytes: Buffer; mimeType: string }> {
  const context = await getAdminContext(request);
  const receiptId = safeReceiptId(queryString(request, 'receiptId'));
  const submissionRef = context.root.collection('subscriptionPaymentSubmissions').doc(receiptId);
  const submissionSnapshot = await submissionRef.get();
  if (!submissionSnapshot.exists) throw new SubscriptionReviewError(404, 'The payment screenshot was not found.');
  const submission = submissionSnapshot.data() ?? {};
  if (clean(submission.adminUid) !== context.uid || normalizeEmail(submission.adminEmail) !== context.email ||
      clean(submission.id) !== receiptId || !['pending_review', 'approved'].includes(clean(submission.status))) {
    throw new SubscriptionReviewError(404, 'The payment screenshot is not available for review.');
  }
  const invoiceId = safeInvoiceId(submission.invoiceId);
  const invoiceSnapshot = await context.root.collection('subscriptionInvoices').doc(invoiceId).get();
  if (!invoiceSnapshot.exists) throw new SubscriptionReviewError(404, 'The associated invoice was not found.');
  const invoice = invoiceSnapshot.data() ?? {};
  if (!paymentIsOwnedByAdmin(context, submission, invoice, invoiceId, receiptId)) {
    throw new SubscriptionReviewError(409, 'The payment screenshot does not match the invoice ownership details.');
  }
  const token = makeGrant(context, submission, invoiceId, receiptId, 'read');
  let upstream: Response;
  try {
    upstream = await fetch(`${WORKER_BASE}/internal/subscription-receipts/${encodeURIComponent(receiptId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new SubscriptionReviewError(503, 'Cloudflare R2 could not load the private payment screenshot. Try again.');
  }
  if (!upstream.ok) throw new SubscriptionReviewError(upstream.status === 404 ? 404 : 503, 'The private payment screenshot could not be retrieved.');
  const mimeType = (upstream.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new SubscriptionReviewError(415, 'The stored payment proof is not a supported image.');
  const contentLength = Number(upstream.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RECEIPT_BYTES) throw new SubscriptionReviewError(413, 'The stored payment screenshot is larger than the allowed size.');
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_RECEIPT_BYTES) throw new SubscriptionReviewError(413, 'The stored payment screenshot is empty or too large.');
  const jpeg = mimeType === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = mimeType === 'image/png' && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = mimeType === 'image/webp' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!jpeg && !png && !webp) throw new SubscriptionReviewError(415, 'The stored payment screenshot content is invalid.');
  return { bytes, mimeType };
}

export function sendSubscriptionReviewError(response: ReviewResponse, error: unknown) {
  const statusValue = Number((error as { status?: unknown })?.status);
  const status = Number.isInteger(statusValue) && statusValue >= 400 && statusValue <= 599 ? statusValue : 500;
  const message = status >= 500 ? 'The subscription payment review service could not complete the request.' : error instanceof Error ? error.message : 'The request is invalid.';
  response.setHeader('Cache-Control', 'no-store, private, max-age=0');
  return response.status(status).json({ success: false, error: message });
}
