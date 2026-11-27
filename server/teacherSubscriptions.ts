import type { DocumentData } from 'firebase-admin/firestore';
import { isValidPeriodKey } from './subscriptionDomain.mjs';
import { normalizeFeaturePermissions } from './subscriptionFeaturePermissions.mjs';
import { normalizePaymentMethods } from './subscriptionPaymentMethods.mjs';
import { getTeacherEntitlement } from './subscriptionEntitlements.js';
import type { TeacherApiRequest } from './teacherAuth.js';

type RecordLike = Record<string, unknown>;
export type TeacherSubscriptionResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): TeacherSubscriptionResponse;
  json(data: unknown): TeacherSubscriptionResponse;
};
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
function isRecord(value: unknown): value is RecordLike { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const asDate = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    try { const date = (value.toDate as () => Date)(); return Number.isFinite(date.getTime()) ? date : null; } catch { return null; }
  }
  if (typeof value === 'string' || typeof value === 'number') { const date = new Date(value); return Number.isFinite(date.getTime()) ? date : null; }
  return null;
};
const asIso = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    try { return (value.toDate as () => Date)().toISOString(); } catch { return null; }
  }
  return null;
};

function safePlan(id: string, data: DocumentData) {
  const pricingMode = clean(data.pricingMode) === 'per_student' ? 'per_student' : 'lump_sum';
  const legacyAmountPaisa = Number(data.amountPaisa) || 0;
  const perStudentAmountPaisa = Number.isSafeInteger(data.perStudentAmountPaisa)
    ? Math.max(0, Number(data.perStudentAmountPaisa))
    : (pricingMode === 'per_student' ? Math.max(0, legacyAmountPaisa) : 0);
  const lumpSumAmountPaisa = Number.isSafeInteger(data.lumpSumAmountPaisa)
    ? Math.max(0, Number(data.lumpSumAmountPaisa))
    : (pricingMode === 'lump_sum' ? Math.max(0, legacyAmountPaisa) : 0);
  return {
    id,
    name: clean(data.name),
    description: clean(data.description),
    amountPaisa: legacyAmountPaisa,
    pricingMode,
    perStudentAmountPaisa,
    lumpSumAmountPaisa,
    currency: 'PKR',
    billingPeriod: 'monthly',
    features: Array.isArray(data.features) ? data.features.filter((x: unknown) => typeof x === 'string') : [],
    featurePermissions: normalizeFeaturePermissions(data.featurePermissions, false),
    active: data.active === true && data.deleted !== true,
  };
}
function safeOffer(id: string, data: DocumentData) {
  return { id, name: clean(data.name), description: clean(data.description), discountType: clean(data.discountType), discountValue: Number(data.discountValue) || 0, validFrom: clean(data.validFrom), validUntil: clean(data.validUntil), planIds: Array.isArray(data.planIds) ? data.planIds.filter((x: unknown) => typeof x === 'string') : [] };
}
function safeInvoice(id: string, data: DocumentData) {
  return {
    id,
    invoiceNumber: clean(data.invoiceNumber),
    teacherUid: clean(data.teacherUid),
    billingPeriod: clean(data.billingPeriod),
    planSnapshot: data.planSnapshot ?? null,
    offerSnapshot: data.offerSnapshot ?? null,
    charges: Array.isArray(data.charges) ? data.charges : [],
    subtotalPaisa: Number(data.subtotalPaisa) || 0,
    discountPaisa: Number(data.discountPaisa) || 0,
    totalPaisa: Number(data.totalPaisa) || 0,
    currency: 'PKR',
    status: clean(data.status) || 'unpaid',
    paymentStatus: clean(data.paymentStatus) || 'unpaid',
    paymentReference: clean(data.paymentReference) || null,
    receiptStatus: clean(data.receiptStatus) || null,
    receiptUploadId: clean(data.receiptUploadId) || null,
    receiptId: clean(data.receiptId) || null,
    receiptUploadExpiresAt: asIso(data.receiptUploadExpiresAt),
    receiptSubmittedAt: asIso(data.receiptSubmittedAt),
    receiptReviewNote: clean(data.receiptReviewNote) || null,
    receiptReviewedAt: asIso(data.receiptReviewedAt),
    paymentApprovedAt: asIso(data.paymentApprovedAt),
    invoiceDate: clean(data.invoiceDate),
    dueDate: clean(data.dueDate),
    notes: clean(data.notes),
    createdAt: asIso(data.createdAt),
  };
}

export async function getTeacherSubscription(request: TeacherApiRequest) {
  const { actor, rootRef: root, accountRef, entitlement } = await getTeacherEntitlement(request);
  const [planSnapshot, offerSnapshot, invoiceSnapshot, settingsSnapshot, periodSnapshot] = await Promise.all([
    root.collection('subscriptionPlans').where('active', '==', true).get(),
    root.collection('subscriptionOffers').where('active', '==', true).get(),
    root.collection('subscriptionInvoices').where('teacherUid', '==', actor.uid).limit(100).get(),
    root.collection('subscriptionSettings').doc('general').get(),
    accountRef.collection('periods').get(),
  ]);
  const invoices = invoiceSnapshot.docs.map((doc) => safeInvoice(doc.id, doc.data())).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const plans = planSnapshot.docs.map((doc) => safePlan(doc.id, doc.data()));
  const today = new Date().toISOString().slice(0, 10);
  const offers = offerSnapshot.docs.map((doc) => safeOffer(doc.id, doc.data())).filter((offer) => offer.validFrom <= today && offer.validUntil >= today);
  const periodInvoices = invoices.filter((invoice) => isValidPeriodKey(invoice.billingPeriod));
  const approvedPeriods = periodSnapshot.docs.map((doc) => {
    const item = doc.data();
    const start = asDate(item.startedAt);
    const end = asDate(item.expiresAt);
    if (!start || !end || end.getTime() <= start.getTime() || !isValidPeriodKey(clean(item.billingPeriod) || doc.id)) return null;
    const status = Date.now() < start.getTime() ? 'scheduled' : Date.now() < end.getTime() ? 'active' : 'expired';
    return {
      billingPeriod: clean(item.billingPeriod) || doc.id,
      invoiceId: clean(item.invoiceId) || null,
      planId: clean(item.planId) || null,
      planName: clean(item.planName) || null,
      featurePermissions: normalizeFeaturePermissions(item.featurePermissions, false),
      startedAt: start.toISOString(),
      expiresAt: end.toISOString(),
      status,
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.billingPeriod.localeCompare(b.billingPeriod));
  const subscription = {
    active: entitlement.active,
    accessMode: entitlement.accessMode ?? 'paid_subscription',
    featureVisibilityMode: entitlement.featureVisibilityMode ?? 'hide',
    featureSources: entitlement.featureSources ?? {},
    addOns: entitlement.addOns ?? [],
    status: entitlement.status,
    planId: entitlement.planId,
    planName: entitlement.planName,
    featurePermissions: entitlement.featurePermissions,
    startedAt: entitlement.startedAt?.toISOString() ?? null,
    expiresAt: entitlement.expiresAt?.toISOString() ?? null,
    latestInvoiceId: entitlement.invoiceId,
    latestInvoicePeriod: entitlement.billingPeriod,
    entitlementSource: entitlement.source,
  };
  return {
    success: true,
    teacher: { uid: actor.uid, email: actor.email, name: clean(actor.tenantData.displayName) || clean(actor.tenantData.name) || actor.email },
    subscription,
    approvedPeriods,
    plans,
    offers,
    invoices: periodInvoices,
    paymentInstructions: clean(settingsSnapshot.data()?.paymentInstructions),
    paymentMethods: normalizePaymentMethods(settingsSnapshot.data()?.paymentMethods),
    generatedAt: new Date().toISOString(),
  };
}

export function sendTeacherSubscriptionError(response: TeacherSubscriptionResponse, error: unknown) {
  console.error('[EduTrack][teacher-subscription] backend failure:', error);
  const candidate = isRecord(error) ? error : {};
  const statusValue = Number(candidate.status);
  const status = Number.isInteger(statusValue) && statusValue >= 400 && statusValue <= 599 ? statusValue : 500;
  const message = status >= 500 ? 'The subscription service could not complete the request.' : error instanceof Error ? error.message : 'The request is invalid.';
  response.setHeader('Cache-Control', 'no-store');
  return response.status(status).json({ success: false, error: message });
}
