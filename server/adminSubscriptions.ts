import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
  FirebaseAdminConfigurationError,
  getFirebaseAdminAuth,
  getFirebaseAdminFirestore,
  verifyAdminRequest,
} from './firebaseAdmin.js';
import { calculateDiscountPaisa, isValidPeriodKey, makeSubscriptionInvoiceId } from './subscriptionDomain.mjs';
import { toSafeSubscriptionDate } from './subscriptionDateValue.mjs';
import { DEFAULT_PLAN_PERMISSION_MATRIX, FEATURE_PERMISSION_KEYS, FEATURE_PERMISSION_STATES, createDefaultFeaturePermissions, inferPlanTierForMigration, migrateFeaturePermissionsForTier, normalizeFeaturePermissions } from './subscriptionFeaturePermissions.mjs';
import { buildAddOnInvoiceSnapshots, normalizeOfferMutation, selectReactivationPeriod, validateAdminSubscriptionCommand } from './subscriptionAdminDomain.mjs';
import { buildBulkInvoiceTargets } from './subscriptionBulkInvoiceDomain.mjs';
import { refreshTeacherEntitlementProjection } from './subscriptionEntitlements.js';
import { calculateAnnouncementExtraCharge } from './teacherFeaturePatchDomain.mjs';

type RecordLike = Record<string, unknown>;
export type SubscriptionApiRequest = {
  method?: string;
  headers: { authorization?: string | string[]; [key: string]: string | string[] | undefined };
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
};
export type SubscriptionApiResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): SubscriptionApiResponse;
  json(data: unknown): SubscriptionApiResponse;
};

export class SubscriptionApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'SubscriptionApiError';
  }
}

type AdminContext = {
  uid: string;
  email: string;
  db: Firestore;
  root: DocumentReference<DocumentData>;
};
type TeacherIdentity = { uid: string; email: string; name: string; profileRef: DocumentReference<DocumentData> };

const normalizeEmail = (value: unknown): string => typeof value === 'string' ? value.trim().toLowerCase() : '';
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const isRecord = (value: unknown): value is RecordLike => typeof value === 'object' && value !== null && !Array.isArray(value);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function toIso(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    try { return (value.toDate as () => Date)().toISOString(); } catch { return null; }
  }
  return null;
}
function safeMoney(value: unknown, label: string, allowZero = true): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1) || number > 1_000_000_000) {
    throw new SubscriptionApiError(400, `${label} must be a valid PKR amount in paisa.`);
  }
  return number;
}
function safeId(value: unknown, label: string): string {
  const id = clean(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new SubscriptionApiError(400, `A valid ${label} is required.`);
  return id;
}
function statusOf(record: RecordLike): string {
  return clean(record.status).toLowerCase();
}
function registryIsActive(record: RecordLike): boolean {
  return record.deleted !== true && record.active !== false &&
    !['deleted', 'disabled', 'inactive', 'pending', 'rejected', 'archived'].includes(statusOf(record));
}

async function getAdminContext(request: SubscriptionApiRequest): Promise<AdminContext> {
  const actor = await verifyAdminRequest(request as Parameters<typeof verifyAdminRequest>[0]);
  const auth = getFirebaseAdminAuth();
  const db = getFirebaseAdminFirestore();
  const authUser = await auth.getUser(actor.uid);
  const email = normalizeEmail(authUser.email);
  if (!email || email !== normalizeEmail(actor.email) || authUser.disabled) {
    throw new SubscriptionApiError(403, 'Administrator account verification failed.');
  }

  const root = db.collection('admins').doc(email);
  const rootSnapshot = await root.get();
  const rootData = rootSnapshot.data() ?? {};
  const mappedUid = clean(rootData.adminUid);
  if (mappedUid && mappedUid !== actor.uid) {
    throw new SubscriptionApiError(403, 'This administrator workspace belongs to another account.');
  }
  if (!rootSnapshot.exists || !mappedUid) {
    await root.set({
      adminUid: actor.uid,
      email,
      managementSchemaVersion: 1,
      createdAt: rootData.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  return { uid: actor.uid, email, db, root };
}

async function resolveManagedTeacher(context: AdminContext, uidValue: unknown): Promise<TeacherIdentity> {
  const uid = safeId(uidValue, 'teacher UID');
  if (uid === context.uid) throw new SubscriptionApiError(404, 'The selected account is not a teacher customer.');

  const auth = getFirebaseAdminAuth();
  const db = getFirebaseAdminFirestore();
  let authUser;
  try { authUser = await auth.getUser(uid); }
  catch { throw new SubscriptionApiError(404, 'The selected teacher account was not found.'); }
  const email = normalizeEmail(authUser.email);
  if (!email || authUser.disabled) throw new SubscriptionApiError(409, 'The selected teacher account is not active.');

  const profiles = await db.collection('users').where('uid', '==', uid).limit(10).get();
  const matches = profiles.docs.filter((doc) => {
    const profile = doc.data();
    return profile.uid === uid && clean(profile.role).toLowerCase() === 'teacher' &&
      normalizeEmail(profile.email ?? doc.id) === email && profile.deleted !== true && profile.isDeleted !== true;
  });
  if (matches.length !== 1) {
    throw new SubscriptionApiError(matches.length > 1 ? 409 : 404,
      matches.length > 1 ? 'Duplicate teacher profiles must be resolved before billing.' : 'The selected account is not a verified teacher profile.');
  }
  const profile = matches[0].data();
  if (profile.active !== true || profile.disabled === true) throw new SubscriptionApiError(409, 'The selected teacher is not active.');

  const registrySnapshot = await context.root.collection('customers').doc(uid).get();
  if (!registrySnapshot.exists) throw new SubscriptionApiError(404, 'The teacher is not registered in this administrator customer directory.');
  const registry = registrySnapshot.data() ?? {};
  if (clean(registry.uid) && clean(registry.uid) !== uid) throw new SubscriptionApiError(409, 'Teacher registry ownership does not match.');
  if (normalizeEmail(registry.email) && normalizeEmail(registry.email) !== email) throw new SubscriptionApiError(409, 'Teacher registry email does not match the verified account.');
  if (!registryIsActive(registry)) throw new SubscriptionApiError(409, 'The teacher customer is inactive or archived.');

  return {
    uid,
    email,
    name: clean(registry.name) || clean(profile.displayName) || clean(profile.name) || clean(profile.fullName) || clean(authUser.displayName) || email,
    profileRef: matches[0].ref,
  };
}

const RESERVED_CLASS_FIELDS = new Set([
  'id', 'name', 'monthlyFee', 'monthlyFeePaisa', 'className', 'fee', 'classFee',
  'createdAt', 'createdDate', 'date', 'updatedAt', 'students', 'title', 'code',
  'classId', 'billable', 'includedByDefault', 'description', 'teacherId', 'teacherEmail',
]);

function isRosterStudent(value: unknown): value is RecordLike {
  return isRecord(value) && (
    typeof value.name === 'string' || value.id !== undefined ||
    value.studentId !== undefined || value.uid !== undefined
  );
}

async function getBillableClassCount(teacher: TeacherIdentity): Promise<number> {
  let classSnapshots;
  try {
    classSnapshots = await teacher.profileRef.collection('classes').get();
  } catch (error) {
    console.error('[EduTrack][subscription-billing] class roster read failed:', teacher.email, error);
    throw new SubscriptionApiError(503, 'Could not verify this teacher class roster. No announcement quota charge was calculated.');
  }
  if (classSnapshots.size > 500) {
    throw new SubscriptionApiError(413, 'This teacher has more than 500 classes. Verify the class roster before billing additional announcements.');
  }
  return classSnapshots.docs.filter((snapshot) => {
    const data = snapshot.data();
    return data.billable !== false && data.includedByDefault !== false;
  }).length;
}

async function getVerifiedBillableStudentCount(
  teacher: TeacherIdentity,
): Promise<{ studentCount: number; classCount: number }> {
  let classSnapshots;
  try {
    classSnapshots = await teacher.profileRef.collection('classes').get();
  } catch (error) {
    console.error('[EduTrack][subscription-billing] class roster read failed:', teacher.email, error);
    throw new SubscriptionApiError(503, 'Could not verify this teacher class roster. No per-student invoice was created.');
  }

  if (classSnapshots.size > 500) {
    throw new SubscriptionApiError(413, 'This teacher has more than 500 classes. Verify the roster before creating a per-student invoice.');
  }

  const uniqueStudents = new Map<string, string>();
  let billableClassCount = 0;

  for (const classSnapshot of classSnapshots.docs) {
    const classData = classSnapshot.data();
    if (classData.billable === false || classData.includedByDefault === false) continue;
    billableClassCount += 1;

    let rosterSnapshot;
    try {
      rosterSnapshot = await classSnapshot.ref.collection('students').get();
    } catch (error) {
      console.error('[EduTrack][subscription-billing] student roster read failed:', classSnapshot.ref.path, error);
      throw new SubscriptionApiError(503, `Could not verify the student roster for class ${classSnapshot.id}.`);
    }

    const records: Array<{ data: RecordLike; fallbackId: string | null }> = [];
    let embeddedRosterIsPresent = false;

    if (!rosterSnapshot.empty) {
      for (const studentSnapshot of rosterSnapshot.docs) {
        records.push({ data: studentSnapshot.data(), fallbackId: studentSnapshot.id });
      }
    } else if (Array.isArray(classData.students)) {
      embeddedRosterIsPresent = true;
      for (const item of classData.students) {
        if (isRosterStudent(item)) records.push({ data: item, fallbackId: null });
      }
    } else if (isRecord(classData.students)) {
      embeddedRosterIsPresent = true;
      for (const [key, item] of Object.entries(classData.students)) {
        if (isRosterStudent(item)) records.push({ data: item, fallbackId: key });
      }
    } else {
      for (const [key, item] of Object.entries(classData)) {
        if (!RESERVED_CLASS_FIELDS.has(key) && isRosterStudent(item)) {
          records.push({ data: item, fallbackId: key });
        }
      }
      embeddedRosterIsPresent = records.length > 0;
    }

    if (rosterSnapshot.empty && !embeddedRosterIsPresent) {
      throw new SubscriptionApiError(
        409,
        `The student roster for class ${clean(classData.name) || classSnapshot.id} is not verifiable. No per-student invoice was created.`,
      );
    }

    for (const row of records) {
      const rawId = row.data.id ?? row.data.studentId ?? row.data.uid ?? row.fallbackId;
      const studentId = rawId === undefined || rawId === null ? '' : String(rawId).trim();
      if (!studentId) {
        throw new SubscriptionApiError(
          409,
          `A student in class ${clean(classData.name) || classSnapshot.id} has no stable ID. Fix the roster before per-student billing.`,
        );
      }

      const studentName = clean(row.data.name ?? row.data.studentName);
      const previousName = uniqueStudents.get(studentId);
      if (previousName && studentName && previousName !== studentName) {
        throw new SubscriptionApiError(
          409,
          `Student ID ${studentId} has conflicting names across classes. Resolve the roster before billing.`,
        );
      }
      if (!previousName) uniqueStudents.set(studentId, studentName);
    }
  }

  if (billableClassCount === 0 || uniqueStudents.size === 0) {
    throw new SubscriptionApiError(409, 'No verified unique students were found in billable classes. A per-student invoice was not created.');
  }

  return { studentCount: uniqueStudents.size, classCount: billableClassCount };
}

async function mapLimit<T, R>(items: T[], limit: number, callback: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await callback(items[index]);
    }
  }));
  return results;
}

async function listManagedTeachers(context: AdminContext) {
  const db = getFirebaseAdminFirestore();
  const [registrySnapshot, plansSnapshot] = await Promise.all([
    context.root.collection('customers').limit(100).get(),
    context.root.collection('subscriptionPlans').get(),
  ]);
  const planCatalog = new Map<string, DocumentData>(
    plansSnapshot.docs.map((doc) => [doc.id, doc.data() as DocumentData] as const),
  );
  const registryDocs = registrySnapshot.docs as QueryDocumentSnapshot<DocumentData>[];
  const rows = await mapLimit(registryDocs, 5, async (doc) => {
    const registry = doc.data();
    const uid = clean(registry.uid) || doc.id;
    const email = normalizeEmail(registry.email);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !email || !registryIsActive(registry)) return null;
    const profileSnapshot = await db.collection('users').doc(email).get();
    if (!profileSnapshot.exists) return null;
    const profile = profileSnapshot.data() ?? {};
    if (profile.uid !== uid || normalizeEmail(profile.email ?? email) !== email || clean(profile.role).toLowerCase() !== 'teacher' || profile.active !== true || profile.disabled === true || profile.deleted === true) return null;
    const accountRef = context.root.collection('subscriptionAccounts').doc(uid);
    const [accountSnapshot, periodSnapshot, addOnSnapshot, requestSnapshot] = await Promise.all([
      accountRef.get(), accountRef.collection('periods').orderBy('startedAt', 'desc').limit(12).get(), accountRef.collection('addOns').limit(20).get(), accountRef.collection('addOnRequests').limit(20).get(),
    ]);
    const account = accountSnapshot.data() ?? {};
    const now = Date.now();
    const accountAccessMode = clean(account.accessMode);
    const postpaidStart = toSafeSubscriptionDate(account.postpaidUsageStartedAt);
    const postpaidEnd = toSafeSubscriptionDate(account.postpaidUsageExpiresAt);
    const postpaidWindowActive = accountAccessMode === 'postpaid_monthly' && account.active === true &&
      clean(account.status) === 'active' && postpaidStart && postpaidEnd && postpaidStart.getTime() <= now && postpaidEnd.getTime() > now;
    const postpaidWindowExpired = accountAccessMode === 'postpaid_monthly' && postpaidEnd && postpaidEnd.getTime() <= now;
    const postpaidPaymentDue = postpaidWindowExpired && clean(account.postpaidInvoiceId) &&
      ['unpaid', 'payment_pending', 'pending_review'].includes(clean(account.postpaidInvoiceStatus).toLowerCase());
    const currentPeriod = periodSnapshot.docs.map((periodDoc) => ({ id: periodDoc.id, data: periodDoc.data() }))
      .filter(({ data }) => {
        const start = data.startedAt && typeof data.startedAt.toDate === 'function' ? (data.startedAt.toDate as () => Date)().getTime() : new Date(data.startedAt as string).getTime();
        const end = data.expiresAt && typeof data.expiresAt.toDate === 'function' ? (data.expiresAt.toDate as () => Date)().getTime() : new Date(data.expiresAt as string).getTime();
        return data.approved !== false && data.paymentApproved !== false && (data.status === 'active' || data.status === 'scheduled') && Number.isFinite(start) && Number.isFinite(end) && start <= now && end > now;
      })
      .sort((a, b) => {
        const getStart = (value: unknown) => value && typeof (value as { toDate?: unknown }).toDate === 'function' ? ((value as { toDate: () => Date }).toDate()).getTime() : new Date(value as string).getTime();
        return getStart(b.data.startedAt) - getStart(a.data.startedAt);
      })[0];
    const approvedInvoiceId = clean(currentPeriod?.data.invoiceId || account.latestApprovedInvoiceId);
    const approvedInvoiceSnapshot = approvedInvoiceId
      ? await context.root.collection('subscriptionInvoices').doc(approvedInvoiceId).get()
      : null;
    const approvedInvoice = approvedInvoiceSnapshot?.data() ?? {};
    const approvedInvoicePlan = isRecord(approvedInvoice.planSnapshot) ? approvedInvoice.planSnapshot : {};
    const activeAddOns = addOnSnapshot.docs.filter((addonDoc) => {
      const addon = addonDoc.data();
      const start = addon.startsAt && typeof addon.startsAt.toDate === 'function' ? (addon.startsAt.toDate as () => Date)().getTime() : new Date(addon.startsAt as string).getTime();
      const end = addon.expiresAt && typeof addon.expiresAt.toDate === 'function' ? (addon.expiresAt.toDate as () => Date)().getTime() : new Date(addon.expiresAt as string).getTime();
      return addon.approved === true && addon.status === 'active' && Number.isFinite(start) && Number.isFinite(end) && start <= now && end > now;
    }).map((addonDoc) => {
      const addon = addonDoc.data();
      const featureKeys = Array.isArray(addon.featureKeys) ? addon.featureKeys.filter((value: unknown) => typeof value === 'string') : [];
      return {
        id: addonDoc.id,
        catalogId: clean(addon.catalogId) || null,
        name: clean(addon.name),
        description: clean(addon.description),
        featureKey: clean(addon.featureKey) || clean(featureKeys[0]),
        featureKeys,
        monthlyPricePaisa: Number.isSafeInteger(addon.monthlyPricePaisa) ? Number(addon.monthlyPricePaisa) : 0,
        expiresAt: toIso(addon.expiresAt),
      };
    });
    const pendingAddOnRequests = requestSnapshot.docs.filter((requestDoc) => clean(requestDoc.data().status) === 'pending')
      .map((requestDoc) => ({ id: requestDoc.id, featureKey: clean(requestDoc.data().featureKey), featureName: clean(requestDoc.data().featureName), requestedAt: toIso(requestDoc.data().requestedAt) }));
    const savedPostpaidPlan = isRecord(account.postpaidPlanSnapshot) ? account.postpaidPlanSnapshot : undefined;
    const currentPlanId = accountAccessMode === 'postpaid_monthly'
      ? clean(account.postpaidPlanId)
      : currentPeriod ? clean(currentPeriod.data.planId) : clean(account.planId || account.requestedPlanId);
    const catalogPlan = currentPlanId ? planCatalog.get(currentPlanId) : undefined;
    const savedPricingMode = accountAccessMode === 'postpaid_monthly'
      ? clean(savedPostpaidPlan?.pricingMode ?? account.pricingMode)
      : clean(currentPeriod?.data.pricingMode ?? approvedInvoice.pricingMode ?? account.pricingMode);
    const catalogPricingMode = clean(catalogPlan?.pricingMode);
    const pricingMode = savedPricingMode === 'per_student' || savedPricingMode === 'lump_sum'
      ? savedPricingMode
      : catalogPricingMode === 'per_student' ? 'per_student' : 'lump_sum';
    const configuredPlanPrice = pricingMode === 'per_student'
      ? Number(catalogPlan?.perStudentAmountPaisa)
      : Number(catalogPlan?.lumpSumAmountPaisa);
    const legacyPlanPrice = Number(catalogPlan?.amountPaisa) || 0;
    const savedPlanPrice = Number(accountAccessMode === 'postpaid_monthly'
      ? savedPostpaidPlan?.amountPaisa ?? account.planPricePaisa
      : currentPeriod?.data.planPricePaisa ?? approvedInvoicePlan.amountPaisa ?? account.planPricePaisa);
    return {
      uid,
      email,
      name: clean(registry.name) || clean(profile.displayName) || clean(profile.name) || clean(profile.fullName) || email,
      active: true,
      planId: currentPlanId || null,
      planName: accountAccessMode === 'postpaid_monthly'
        ? clean(account.postpaidPlanName || savedPostpaidPlan?.name) || null
        : currentPeriod ? clean(currentPeriod.data.planName) || null : clean(account.planName || account.requestedPlanName) || null,
      pricingMode,
      planPricePaisa: Number.isSafeInteger(savedPlanPrice) && savedPlanPrice > 0
        ? savedPlanPrice
        : Number.isSafeInteger(configuredPlanPrice) && configuredPlanPrice > 0
          ? configuredPlanPrice
          : (catalogPricingMode === pricingMode ? legacyPlanPrice : 0),
      featurePermissions: normalizeFeaturePermissions(
        (accountAccessMode === 'postpaid_monthly' ? savedPostpaidPlan?.featurePermissions : currentPeriod?.data.featurePermissions) ??
          savedPostpaidPlan?.featurePermissions ?? catalogPlan?.featurePermissions,
        false,
      ),
      subscriptionStatus: account.active === false
        ? clean(account.status) || 'inactive'
        : accountAccessMode === 'postpaid_monthly'
          ? postpaidWindowActive ? 'active' : postpaidPaymentDue ? 'payment_due' : postpaidWindowExpired ? 'expired' : 'inactive'
          : currentPeriod ? 'active' : clean(account.status) || 'no_plan',
      subscriptionStartedAt: toIso(currentPeriod?.data.startedAt ?? account.postpaidUsageStartedAt ?? account.startedAt),
      subscriptionExpiresAt: toIso(currentPeriod?.data.expiresAt ?? account.postpaidUsageExpiresAt ?? account.expiresAt),
      subscriptionPeriodId: currentPeriod?.id ?? null,
      accessMode: clean(account.accessMode) || 'legacy_unassigned',
      postpaidPlanId: clean(account.postpaidPlanId) || null,
      postpaidPlanName: clean(account.postpaidPlanName) || null,
      postpaidPlanSnapshot: savedPostpaidPlan ?? null,
      postpaidUsageBillingPeriod: clean(account.postpaidUsageBillingPeriod) || null,
      postpaidUsageStartedAt: toIso(account.postpaidUsageStartedAt),
      postpaidUsageExpiresAt: toIso(account.postpaidUsageExpiresAt),
      postpaidInvoiceId: clean(account.postpaidInvoiceId) || null,
      postpaidInvoiceStatus: clean(account.postpaidInvoiceStatus) || null,
      featureVisibilityMode: clean(account.featureVisibilityModeOverride || account.featureVisibilityMode) === 'locked' ? 'locked' : currentPeriod && currentPeriod.data.featureVisibilityMode === 'locked' ? 'locked' : 'hide',
      activeAddOns,
      pendingAddOnRequests,
    };
  });
  return rows.filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function planJson(id: string, data: DocumentData) {
  return {
    id,
    name: clean(data.name),
    description: clean(data.description),
    amountPaisa: Number(data.amountPaisa) || 0,
    // Legacy fields remain available for older registration and teacher clients.
    pricingMode: clean(data.pricingMode) === 'per_student' ? 'per_student' : 'lump_sum',
    perStudentAmountPaisa: Number.isSafeInteger(data.perStudentAmountPaisa)
      ? Number(data.perStudentAmountPaisa)
      : (clean(data.pricingMode) === 'per_student' ? Number(data.amountPaisa) || 0 : 0),
    lumpSumAmountPaisa: Number.isSafeInteger(data.lumpSumAmountPaisa)
      ? Number(data.lumpSumAmountPaisa)
      : (clean(data.pricingMode) === 'lump_sum' ? Number(data.amountPaisa) || 0 : 0),
    currency: 'PKR',
    billingPeriod: 'monthly',
    features: Array.isArray(data.features) ? data.features.filter((x: unknown) => typeof x === 'string') : [],
    extraFeatures: Array.isArray(data.extraFeatures) ? data.extraFeatures.filter((x: unknown) => typeof x === 'string') : [],
    parentPlanId: clean(data.parentPlanId) || null,
    featurePermissions: normalizeFeaturePermissions(data.featurePermissions, false),
    featureVisibilityMode: clean(data.featureVisibilityMode) === 'locked' ? 'locked' : 'hide',
    announcementQuotaPerClass: Number.isSafeInteger(data.announcementQuotaPerClass) ? Math.max(4, Number(data.announcementQuotaPerClass)) : 4,
    announcementExtraPackSize: Number.isSafeInteger(data.announcementExtraPackSize) ? Math.max(1, Number(data.announcementExtraPackSize)) : 4,
    announcementExtraPackPricePaisa: Number.isSafeInteger(data.announcementExtraPackPricePaisa) ? Math.max(0, Number(data.announcementExtraPackPricePaisa)) : 0,
    active: data.active === true && data.deleted !== true,
    deleted: data.deleted === true,
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
  };
}
function offerJson(id: string, data: DocumentData) {
  return {
    id,
    name: clean(data.name),
    description: clean(data.description),
    discountType: clean(data.discountType),
    discountValue: Number(data.discountValue) || 0,
    validFrom: clean(data.validFrom),
    validUntil: clean(data.validUntil),
    planIds: Array.isArray(data.planIds) ? data.planIds.filter((x: unknown) => typeof x === 'string') : [],
    active: data.active === true,
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
  };
}
function addOnCatalogJson(id: string, data: DocumentData) {
  return {
    id,
    name: clean(data.name),
    description: clean(data.description),
    featureKey: clean(data.featureKey),
    monthlyPricePaisa: Number(data.monthlyPricePaisa) || 0,
    billingPeriod: 'monthly',
    active: data.active === true && data.deleted !== true,
    deleted: data.deleted === true,
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
  };
}
function invoiceJson(id: string, data: DocumentData) {
  return {
    id,
    invoiceNumber: clean(data.invoiceNumber),
    teacherUid: clean(data.teacherUid),
    teacherEmail: clean(data.teacherEmail),
    teacherName: clean(data.teacherName),
    billingPeriod: clean(data.billingPeriod),
    planId: clean(data.planId) || null,
    planSnapshot: data.planSnapshot ?? null,
    pricingMode: clean(data.pricingMode) === 'per_student' ? 'per_student' : 'lump_sum',
    billableStudentCount: Number.isSafeInteger(data.billableStudentCount) ? Number(data.billableStudentCount) : null,
    offerId: clean(data.offerId) || null,
    offerSnapshot: data.offerSnapshot ?? null,
    addOnSnapshots: Array.isArray(data.addOnSnapshots) ? data.addOnSnapshots : [],
    charges: Array.isArray(data.charges) ? data.charges : [],
    subtotalPaisa: Number(data.subtotalPaisa) || 0,
    discountPaisa: Number(data.discountPaisa) || 0,
    totalPaisa: Number(data.totalPaisa) || 0,
    currency: 'PKR',
    status: clean(data.status) || 'unpaid',
    paymentStatus: clean(data.paymentStatus) || 'unpaid',
    paymentReference: clean(data.paymentReference) || null,
    paymentApprovedAt: toIso(data.paymentApprovedAt),
    invoiceDate: clean(data.invoiceDate),
    dueDate: clean(data.dueDate),
    notes: clean(data.notes),
    createdAt: toIso(data.createdAt),
  };
}

function paymentJson(id: string, data: DocumentData) {
  return {
    id,
    invoiceId: clean(data.invoiceId),
    invoiceNumber: clean(data.invoiceNumber),
    teacherUid: clean(data.teacherUid),
    teacherEmail: clean(data.teacherEmail),
    teacherName: clean(data.teacherName),
    billingPeriod: clean(data.billingPeriod),
    amountPaisa: Number(data.amountPaisa) || 0,
    currency: 'PKR',
    method: clean(data.method) || 'Manual receipt',
    paymentReference: clean(data.paymentReference) || null,
    status: clean(data.status) || 'approved',
    approvedAt: toIso(data.approvedAt),
  };
}

export async function getAdminSubscriptions(request: SubscriptionApiRequest) {
  const context = await getAdminContext(request);
  const [teachers, plansSnapshot, offersSnapshot, addOnCatalogSnapshot, invoicesSnapshot, paymentsSnapshot, auditSnapshot] = await Promise.all([
    listManagedTeachers(context),
    context.root.collection('subscriptionPlans').get(),
    context.root.collection('subscriptionOffers').get(),
    context.root.collection('subscriptionAddOnCatalog').get(),
    context.root.collection('subscriptionInvoices').orderBy('createdAt', 'desc').limit(100).get(),
    context.root.collection('subscriptionPayments').orderBy('approvedAt', 'desc').limit(100).get(),
    context.root.collection('subscriptionAuditLogs').orderBy('createdAt', 'desc').limit(50).get(),
  ]);
  const plans = plansSnapshot.docs.map((doc) => planJson(doc.id, doc.data())).sort((a, b) => a.name.localeCompare(b.name));
  const offers = offersSnapshot.docs.map((doc) => offerJson(doc.id, doc.data())).sort((a, b) => a.name.localeCompare(b.name));
  const addOnCatalog = addOnCatalogSnapshot.docs.map((doc) => addOnCatalogJson(doc.id, doc.data())).sort((a, b) => a.name.localeCompare(b.name));
  const invoices = invoicesSnapshot.docs.map((doc) => invoiceJson(doc.id, doc.data())).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const payments = paymentsSnapshot.docs.map((doc) => paymentJson(doc.id, doc.data()))
    .sort((a, b) => (b.approvedAt ?? '').localeCompare(a.approvedAt ?? ''));
  const auditLogs = auditSnapshot.docs.map((doc) => {
    const item = doc.data();
    return {
      id: doc.id,
      action: clean(item.action),
      teacherUid: clean(item.teacherUid),
      teacherEmail: normalizeEmail(item.teacherEmail),
      teacherName: clean(item.teacherName),
      adminEmail: normalizeEmail(item.adminEmail),
      reason: clean(item.reason),
      paymentBypassed: item.paymentBypassed === true,
      createdAt: toIso(item.createdAt),
      previous: item.previous ?? null,
      next: item.next ?? null,
    };
  });
  return {
    success: true,
    teachers,
    addOnRequests: teachers.flatMap((teacher) => (teacher.pendingAddOnRequests ?? []).map((request) => ({ ...request, teacherUid: teacher.uid, teacherEmail: teacher.email, teacherName: teacher.name }))),
    plans,
    offers,
    addOnCatalog,
    invoices,
    payments,
    auditLogs,
    coverage: {
      teacherLimit: 100,
      invoiceLimit: 100,
      paymentLimit: 100,
      auditLogLimit: 50,
      warnings: ["This overview returns the latest 100 invoices, 100 payments and 50 audit entries; older records remain stored but are not included in this response."],
    },
    summary: {
      teachers: teachers.length,
      activePlans: plans.filter((plan) => plan.active).length,
      activeOffers: offers.filter((offer) => offer.active).length,
      unpaidInvoices: invoices.filter((invoice) => invoice.status === 'unpaid' || invoice.status === 'payment_pending').length,
      outstandingPaisa: invoices.filter((invoice) => invoice.status !== 'paid' && invoice.status !== 'void').reduce((sum, invoice) => sum + invoice.totalPaisa, 0),
    },
    generatedAt: new Date().toISOString(),
  };
}

function requireBody(request: SubscriptionApiRequest): RecordLike {
  if (!isRecord(request.body)) throw new SubscriptionApiError(400, 'A valid JSON request body is required.');
  return request.body;
}
function requiredName(value: unknown, label: string): string {
  const name = clean(value);
  if (!name || name.length > 100) throw new SubscriptionApiError(400, `${label} must contain 1 to 100 characters.`);
  return name;
}
function optionalText(value: unknown, label: string, max = 600): string {
  const result = clean(value);
  if (result.length > max) throw new SubscriptionApiError(400, `${label} is too long.`);
  return result;
}
function parseFeatures(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new SubscriptionApiError(400, 'A plan can contain up to 12 feature items.');
  return value.map((item) => {
    const feature = clean(item);
    if (!feature || feature.length > 120) throw new SubscriptionApiError(400, 'Each plan feature must contain 1 to 120 characters.');
    return feature;
  });
}
function parseExtraFeatures(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new SubscriptionApiError(400, 'A plan can contain up to 20 exclusive feature items.');
  }
  const values = value.map((item) => {
    const feature = clean(item);
    if (!feature || feature.length > 120) {
      throw new SubscriptionApiError(400, 'Each exclusive feature must contain 1 to 120 characters.');
    }
    return feature;
  });
  return [...new Set(values)];
}

async function resolveParentPlanId(
  context: AdminContext,
  value: unknown,
  currentPlanId?: string,
): Promise<string | null> {
  const raw = clean(value);
  if (!raw) return null;
  const parentId = safeId(raw, 'parent plan ID');
  let cursor: string | null = parentId;
  const visited = new Set<string>();

  for (let depth = 0; cursor && depth < 50; depth += 1) {
    if (currentPlanId && cursor === currentPlanId) {
      throw new SubscriptionApiError(409, 'A plan cannot inherit from itself or one of its descendants.');
    }
    if (visited.has(cursor)) {
      throw new SubscriptionApiError(409, 'The selected plan inheritance chain already contains a cycle.');
    }
    visited.add(cursor);
    const parentSnapshot = await context.root.collection('subscriptionPlans').doc(cursor).get();
    if (!parentSnapshot.exists || parentSnapshot.data()?.deleted === true) {
      throw new SubscriptionApiError(404, 'The selected parent plan does not exist or has been archived.');
    }
    cursor = clean(parentSnapshot.data()?.parentPlanId) || null;
  }

  if (cursor) throw new SubscriptionApiError(409, 'The plan inheritance chain is too deep.');
  return parentId;
}

function parseFeaturePermissions(value: unknown, legacyDefault: boolean): Record<string, string> {
  if (value === undefined) return normalizeFeaturePermissions(undefined, legacyDefault);
  if (!isRecord(value)) throw new SubscriptionApiError(400, 'Plan feature permissions must be an object.');
  for (const key of FEATURE_PERMISSION_KEYS) {
    const permission = value[key];
    if (permission !== undefined && typeof permission !== 'boolean' &&
        !(typeof permission === 'string' && FEATURE_PERMISSION_STATES.includes(permission as never))) {
      throw new SubscriptionApiError(400, `Feature permission ${key} must be enabled, disabled, or configurable.`);
    }
  }
  return normalizeFeaturePermissions(value, false);
}

async function applyDefaultPermissionMatrix(context: AdminContext) {
  const snapshot = await context.root.collection('subscriptionPlans').get();
  const matched = snapshot.docs.flatMap((doc) => {
    const tier = inferPlanTierForMigration(doc.data().name);
    return tier ? [{ ref: doc.ref, id: doc.id, tier, existing: doc.data().featurePermissions }] : [];
  });
  const counts = { basic: 0, advance: 0, pro: 0 };
  for (const plan of matched) {
    const migrated = migrateFeaturePermissionsForTier(plan.existing, plan.tier);
    // Product-owner restrictions take precedence for these two conflicting defaults.
    // Every other explicitly configured state (especially Advance) is preserved.
    if (plan.tier === 'basic') {
      migrated.announcements = 'disabled';
      migrated.fee_alerts = 'disabled';
      migrated.quiz_result_notifications = 'disabled';
    }
    if (plan.tier === 'pro') migrated.quiz_result_notifications = 'disabled';
    await plan.ref.set({
      featurePermissions: migrated,
      featurePermissionsSchemaVersion: 2,
      permissionsMigratedAt: FieldValue.serverTimestamp(),
      permissionsMigratedByUid: context.uid,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: context.uid,
    }, { merge: true });
    counts[plan.tier] += 1;
  }
  return {
    success: true,
    updated: matched.length,
    counts,
    missingTiers: Object.keys(DEFAULT_PLAN_PERMISSION_MATRIX).filter((tier) => counts[tier as keyof typeof counts] === 0),
    note: 'Existing explicit plan permission states were preserved; missing keys were filled from tier defaults. Basic Fee Alerts, Basic Announcements, and Basic/Pro Quiz Result Notifications are disabled. Advance custom states are preserved. Historical invoice and approved-period snapshots were not changed.',
  };
}

function parsePlanIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new SubscriptionApiError(400, 'Invalid offer plan selection.');
  return [...new Set(value.map((item) => safeId(item, 'plan ID')))];
}

async function createPlan(context: AdminContext, body: RecordLike) {
  const hasDualPrices = body.perStudentAmountPaisa !== undefined || body.lumpSumAmountPaisa !== undefined;
  const legacyPricingMode = clean(body.pricingMode) === 'lump_sum' ? 'lump_sum' : 'per_student';
  const legacyAmountPaisa = hasDualPrices ? 0 : safeMoney(body.amountPaisa, 'Plan price', false);
  const perStudentAmountPaisa = hasDualPrices
    ? safeMoney(body.perStudentAmountPaisa, 'Per-student monthly price', false)
    : (legacyPricingMode === 'per_student' ? legacyAmountPaisa : 0);
  const lumpSumAmountPaisa = hasDualPrices
    ? safeMoney(body.lumpSumAmountPaisa, 'Lump-sum monthly price', false)
    : (legacyPricingMode === 'lump_sum' ? legacyAmountPaisa : 0);

  if (hasDualPrices && (!perStudentAmountPaisa || !lumpSumAmountPaisa)) {
    throw new SubscriptionApiError(400, 'Both Per Student and Lump Sum monthly prices are required.');
  }

  const amountPaisa = hasDualPrices ? perStudentAmountPaisa : legacyAmountPaisa;
  const pricingMode = hasDualPrices ? 'per_student' : legacyPricingMode;
  const parentPlanId = await resolveParentPlanId(context, body.parentPlanId);
  const ref = context.root.collection('subscriptionPlans').doc(randomUUID());
  const data = {
    name: requiredName(body.name, 'Plan name'),
    description: optionalText(body.description, 'Plan description'),
    amountPaisa,
    pricingMode,
    ...(hasDualPrices ? { perStudentAmountPaisa, lumpSumAmountPaisa } : {}),
    currency: 'PKR',
    billingPeriod: 'monthly',
    features: parseFeatures(body.features),
    extraFeatures: parseExtraFeatures(body.extraFeatures),
    parentPlanId,
    featurePermissions: parseFeaturePermissions(body.featurePermissions, false),
    featureVisibilityMode: clean(body.featureVisibilityMode) === 'locked' ? 'locked' : 'hide',
    announcementQuotaPerClass: Number.isSafeInteger(Number(body.announcementQuotaPerClass)) && Number(body.announcementQuotaPerClass) >= 4 && Number(body.announcementQuotaPerClass) <= 500
      ? Math.floor(Number(body.announcementQuotaPerClass)) : 4,
    announcementExtraPackSize: Number.isSafeInteger(Number(body.announcementExtraPackSize)) && Number(body.announcementExtraPackSize) >= 1 && Number(body.announcementExtraPackSize) <= 100
      ? Math.floor(Number(body.announcementExtraPackSize)) : 4,
    announcementExtraPackPricePaisa: safeMoney(body.announcementExtraPackPricePaisa ?? 0, 'Announcement extra pack price'),
    active: body.active !== false,
    deleted: false,
    createdByUid: context.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.create(data);
  const saved = await ref.get();
  return { success: true, plan: planJson(ref.id, saved.data() ?? {}) };
}

async function updatePlan(context: AdminContext, body: RecordLike) {
  const id = safeId(body.planId, 'plan ID');
  const ref = context.root.collection('subscriptionPlans').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new SubscriptionApiError(404, 'Subscription plan was not found.');
  const existing = snapshot.data() ?? {};
  const patch: RecordLike = { updatedAt: FieldValue.serverTimestamp(), updatedByUid: context.uid };

  if (body.name !== undefined) patch.name = requiredName(body.name, 'Plan name');
  if (body.description !== undefined) patch.description = optionalText(body.description, 'Plan description');

  const hasDualPrices = body.perStudentAmountPaisa !== undefined || body.lumpSumAmountPaisa !== undefined;
  if (hasDualPrices) {
    const legacyMode = clean(existing.pricingMode) === 'lump_sum' ? 'lump_sum' : 'per_student';
    const oldAmount = Number(existing.amountPaisa) || 0;
    const oldPerStudent = Number.isSafeInteger(existing.perStudentAmountPaisa)
      ? Number(existing.perStudentAmountPaisa) : (legacyMode === 'per_student' ? oldAmount : 0);
    const oldLumpSum = Number.isSafeInteger(existing.lumpSumAmountPaisa)
      ? Number(existing.lumpSumAmountPaisa) : (legacyMode === 'lump_sum' ? oldAmount : 0);
    const perStudentAmountPaisa = body.perStudentAmountPaisa === undefined
      ? oldPerStudent : safeMoney(body.perStudentAmountPaisa, 'Per-student monthly price', false);
    const lumpSumAmountPaisa = body.lumpSumAmountPaisa === undefined
      ? oldLumpSum : safeMoney(body.lumpSumAmountPaisa, 'Lump-sum monthly price', false);
    if (!perStudentAmountPaisa || !lumpSumAmountPaisa) {
      throw new SubscriptionApiError(400, 'Both Per Student and Lump Sum monthly prices are required.');
    }
    patch.perStudentAmountPaisa = perStudentAmountPaisa;
    patch.lumpSumAmountPaisa = lumpSumAmountPaisa;
    // The legacy default remains Per Student so old clients keep working.
    patch.amountPaisa = perStudentAmountPaisa;
    patch.pricingMode = 'per_student';
  } else {
    if (body.amountPaisa !== undefined) {
      const amountPaisa = safeMoney(body.amountPaisa, 'Plan price', false);
      const requestedMode = body.pricingMode === undefined
        ? (clean(existing.pricingMode) === 'lump_sum' ? 'lump_sum' : 'per_student')
        : clean(body.pricingMode);
      if (requestedMode !== 'per_student' && requestedMode !== 'lump_sum') {
        throw new SubscriptionApiError(400, 'Choose Per Student or Lump Sum pricing.');
      }
      patch.amountPaisa = amountPaisa;
      patch.pricingMode = requestedMode;
      if (requestedMode === 'per_student') patch.perStudentAmountPaisa = amountPaisa;
      else patch.lumpSumAmountPaisa = amountPaisa;
    } else if (body.pricingMode !== undefined) {
      const pricingMode = clean(body.pricingMode);
      if (pricingMode !== 'per_student' && pricingMode !== 'lump_sum') {
        throw new SubscriptionApiError(400, 'Choose Per Student or Lump Sum pricing.');
      }
      patch.pricingMode = pricingMode;
    }
  }

  if (body.features !== undefined) patch.features = parseFeatures(body.features);
  if (body.extraFeatures !== undefined) patch.extraFeatures = parseExtraFeatures(body.extraFeatures);
  if (body.parentPlanId !== undefined) patch.parentPlanId = await resolveParentPlanId(context, body.parentPlanId, id);
  if (body.featurePermissions !== undefined) patch.featurePermissions = parseFeaturePermissions(body.featurePermissions, false);
  if (body.featureVisibilityMode !== undefined) {
    const mode = clean(body.featureVisibilityMode);
    if (mode !== 'hide' && mode !== 'locked') throw new SubscriptionApiError(400, 'Feature visibility mode must be hide or locked.');
    patch.featureVisibilityMode = mode;
  }
  if (body.announcementQuotaPerClass !== undefined) {
    const quota = Number(body.announcementQuotaPerClass);
    if (!Number.isSafeInteger(quota) || quota < 4 || quota > 500) throw new SubscriptionApiError(400, 'Announcement quota must be an integer from 4 to 500 per class.');
    patch.announcementQuotaPerClass = quota;
  }
  if (body.announcementExtraPackSize !== undefined) {
    const packSize = Number(body.announcementExtraPackSize);
    if (!Number.isSafeInteger(packSize) || packSize < 1 || packSize > 100) throw new SubscriptionApiError(400, 'Announcement extra pack size must be an integer from 1 to 100.');
    patch.announcementExtraPackSize = packSize;
  }
  if (body.announcementExtraPackPricePaisa !== undefined) {
    patch.announcementExtraPackPricePaisa = safeMoney(body.announcementExtraPackPricePaisa, 'Announcement extra pack price');
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new SubscriptionApiError(400, 'Plan active must be true or false.');
    patch.active = body.active;
    if (body.active) patch.deleted = false;
  }
  await ref.set(patch, { merge: true });
  const saved = await ref.get();
  return { success: true, plan: planJson(ref.id, saved.data() ?? {}) };
}

async function deletePlan(context: AdminContext, body: RecordLike) {
  const id = safeId(body.planId, 'plan ID');
  const ref = context.root.collection('subscriptionPlans').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new SubscriptionApiError(404, 'Subscription plan was not found.');

  // Archive instead of physically deleting: old invoices and periods retain their snapshots.
  await ref.set({
    active: false,
    deleted: true,
    deletedAt: FieldValue.serverTimestamp(),
    deletedByUid: context.uid,
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: context.uid,
  }, { merge: true });

  const saved = await ref.get();
  return { success: true, archived: true, plan: planJson(ref.id, saved.data() ?? {}) };
}

async function createOffer(context: AdminContext, body: RecordLike) {
  let normalized: RecordLike;
  try {
    normalized = normalizeOfferMutation({
      name: body.name,
      description: body.description,
      discountType: body.discountType,
      discountValue: body.discountValue,
      validFrom: body.validFrom,
      validUntil: body.validUntil,
      planIds: body.planIds ?? [],
      active: body.active !== false,
    });
  } catch (error) {
    throw new SubscriptionApiError(400, error instanceof Error ? error.message : 'The offer is invalid.');
  }
  const planIds = await validateOfferPlanIds(context, normalized.planIds);
  const ref = context.root.collection('subscriptionOffers').doc(randomUUID());
  const data = {
    ...normalized,
    planIds,
    createdByUid: context.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.create(data);
  const saved = await ref.get();
  return { success: true, offer: offerJson(ref.id, saved.data() ?? {}) };
}
async function updateOffer(context: AdminContext, body: RecordLike) {
  const id = safeId(body.offerId, 'offer ID');
  const ref = context.root.collection('subscriptionOffers').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new SubscriptionApiError(404, 'Subscription offer was not found.');
  let patch: RecordLike;
  try {
    patch = normalizeOfferMutation(body, snapshot.data() ?? {});
  } catch (error) {
    throw new SubscriptionApiError(400, error instanceof Error ? error.message : 'The offer update is invalid.');
  }
  if (patch.planIds !== undefined) patch.planIds = await validateOfferPlanIds(context, patch.planIds);
  patch.updatedAt = FieldValue.serverTimestamp();
  patch.updatedByUid = context.uid;
  await ref.set(patch, { merge: true });
  const saved = await ref.get();
  return { success: true, offer: offerJson(ref.id, saved.data() ?? {}) };
}

async function validateOfferPlanIds(context: AdminContext, value: unknown): Promise<string[]> {
  const planIds = parsePlanIds(value);
  for (const id of planIds) {
    const snapshot = await context.root.collection('subscriptionPlans').doc(id).get();
    if (!snapshot.exists || snapshot.data()?.deleted === true) {
      throw new SubscriptionApiError(409, `Offer plan ${id} does not exist or has been archived.`);
    }
  }
  return planIds;
}

async function createAddOnCatalogItem(context: AdminContext, body: RecordLike) {
  const featureKey = clean(body.featureKey);
  if (!FEATURE_PERMISSION_KEYS.includes(featureKey as typeof FEATURE_PERMISSION_KEYS[number])) {
    throw new SubscriptionApiError(400, 'Choose a valid ERP feature for this add-on.');
  }
  const monthlyPricePaisa = safeMoney(body.monthlyPricePaisa, 'Add-on monthly price', false);
  const ref = context.root.collection('subscriptionAddOnCatalog').doc(randomUUID());
  await ref.create({
    name: requiredName(body.name, 'Add-on name'),
    description: optionalText(body.description, 'Add-on description'),
    featureKey,
    monthlyPricePaisa,
    billingPeriod: 'monthly',
    active: body.active !== false,
    deleted: false,
    createdByUid: context.uid,
    createdByEmail: context.email,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const saved = await ref.get();
  return { success: true, addOn: addOnCatalogJson(ref.id, saved.data() ?? {}) };
}

async function updateAddOnCatalogItem(context: AdminContext, body: RecordLike) {
  const id = safeId(body.addOnCatalogId, 'add-on catalog ID');
  const ref = context.root.collection('subscriptionAddOnCatalog').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new SubscriptionApiError(404, 'The add-on catalog item was not found.');
  const patch: RecordLike = { updatedAt: FieldValue.serverTimestamp(), updatedByUid: context.uid };
  if (body.name !== undefined) patch.name = requiredName(body.name, 'Add-on name');
  if (body.description !== undefined) patch.description = optionalText(body.description, 'Add-on description');
  if (body.featureKey !== undefined) {
    const featureKey = clean(body.featureKey);
    if (!FEATURE_PERMISSION_KEYS.includes(featureKey as typeof FEATURE_PERMISSION_KEYS[number])) {
      throw new SubscriptionApiError(400, 'Choose a valid ERP feature for this add-on.');
    }
    patch.featureKey = featureKey;
  }
  if (body.monthlyPricePaisa !== undefined) patch.monthlyPricePaisa = safeMoney(body.monthlyPricePaisa, 'Add-on monthly price', false);
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new SubscriptionApiError(400, 'Add-on active must be true or false.');
    patch.active = body.active;
    if (body.active) patch.deleted = false;
  }
  if (Object.keys(patch).length === 2) throw new SubscriptionApiError(400, 'No add-on changes were supplied.');
  await ref.set(patch, { merge: true });
  const saved = await ref.get();
  return { success: true, addOn: addOnCatalogJson(ref.id, saved.data() ?? {}) };
}

async function archiveAddOnCatalogItem(context: AdminContext, body: RecordLike) {
  const id = safeId(body.addOnCatalogId, 'add-on catalog ID');
  const ref = context.root.collection('subscriptionAddOnCatalog').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new SubscriptionApiError(404, 'The add-on catalog item was not found.');
  await ref.set({
    active: false,
    deleted: true,
    archivedAt: FieldValue.serverTimestamp(),
    archivedByUid: context.uid,
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: context.uid,
  }, { merge: true });
  const saved = await ref.get();
  return { success: true, archived: true, addOn: addOnCatalogJson(ref.id, saved.data() ?? {}) };
}

function dateFromUnknown(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    try {
      const date = (value.toDate as () => Date)();
      return date instanceof Date && Number.isFinite(date.getTime()) ? date : null;
    } catch { return null; }
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

function subscriptionAuditSnapshot(account: RecordLike, period?: RecordLike | null) {
  return {
    accountStatus: clean(account.status) || null,
    accountActive: account.active === true,
    planId: clean(period?.planId ?? account.planId) || null,
    planName: clean(period?.planName ?? account.planName) || null,
    startedAt: toIso(period?.startedAt ?? account.startedAt),
    expiresAt: toIso(period?.expiresAt ?? account.expiresAt),
    periodId: clean(period?.id) || null,
  };
}

async function manageCustomerSubscription(context: AdminContext, body: RecordLike) {
  const teacher = await resolveManagedTeacher(context, body.teacherUid);
  let command: ReturnType<typeof validateAdminSubscriptionCommand>;
  try {
    command = validateAdminSubscriptionCommand(body);
  } catch (error) {
    throw new SubscriptionApiError(400, error instanceof Error ? error.message : 'The subscription management request is invalid.');
  }

  const accountRef = context.root.collection('subscriptionAccounts').doc(teacher.uid);
  const periodsRef = accountRef.collection('periods');
  const [accountSnapshot, periodsSnapshot] = await Promise.all([accountRef.get(), periodsRef.get()]);
  const account = accountSnapshot.data() ?? {};
  const now = new Date();
  const nowMs = now.getTime();
  const currentPeriodRecord = periodsSnapshot.docs
    .map((doc) => ({ id: doc.id, ref: doc.ref, data: doc.data(), startsAt: dateFromUnknown(doc.data().startedAt), expiresAt: dateFromUnknown(doc.data().expiresAt) }))
    .filter((item) => item.data.approved !== false && item.data.paymentApproved !== false && ['active', 'scheduled'].includes(clean(item.data.status)) && item.startsAt && item.expiresAt && item.startsAt.getTime() <= nowMs && item.expiresAt.getTime() > nowMs)
    .sort((a, b) => (b.startsAt?.getTime() ?? 0) - (a.startsAt?.getTime() ?? 0))[0] ?? null;
  const scheduledPeriods = periodsSnapshot.docs
    .map((doc) => ({ ref: doc.ref, data: doc.data(), startsAt: dateFromUnknown(doc.data().startedAt) }))
    .filter((item) => item.data.status === 'scheduled' && item.startsAt && item.startsAt.getTime() > nowMs);
  const previous = subscriptionAuditSnapshot(account, currentPeriodRecord ? { ...currentPeriodRecord.data, id: currentPeriodRecord.id } : null);
  const auditRef = context.root.collection('subscriptionAuditLogs').doc(randomUUID());
  let resultStatus = '';

  if (command.operation === 'assign' || command.operation === 'change') {
    const planRef = context.root.collection('subscriptionPlans').doc(command.planId!);
    const planSnapshot = await planRef.get();
    if (!planSnapshot.exists || planSnapshot.data()?.active !== true || planSnapshot.data()?.deleted === true) {
      throw new SubscriptionApiError(409, 'The selected subscription plan is not active.');
    }
    const plan = planSnapshot.data() ?? {};
    const periodId = `admin-${randomUUID()}`;
    const periodRef = periodsRef.doc(periodId);
    const startsAt = command.startsAt!;
    const expiresAt = command.expiresAt!;
    resultStatus = startsAt.getTime() <= nowMs ? 'active' : 'scheduled';
    const featurePermissions = normalizeFeaturePermissions(plan.featurePermissions, false);
    const after = {
      accountStatus: resultStatus,
      accountActive: true,
      planId: command.planId,
      planName: clean(plan.name),
      startedAt: startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      periodId,
    };
    const periodsToSupersede = [
      ...scheduledPeriods.map((item) => ({ ref: item.ref, allowedStatuses: ['scheduled'] })),
      ...(startsAt.getTime() <= nowMs && currentPeriodRecord
        ? [{ ref: currentPeriodRecord.ref, allowedStatuses: ['active', 'scheduled'] }]
        : []),
    ];
    await context.db.runTransaction(async (transaction) => {
      const freshPeriods = await Promise.all(periodsToSupersede.map((item) => transaction.get(item.ref)));
      for (let index = 0; index < periodsToSupersede.length; index += 1) {
        const freshPeriod = freshPeriods[index];
        if (freshPeriod.exists && periodsToSupersede[index].allowedStatuses.includes(clean(freshPeriod.data()?.status))) {
          transaction.update(periodsToSupersede[index].ref, {
            status: 'superseded',
            supersededAt: FieldValue.serverTimestamp(),
            supersededByPeriodId: periodId,
            supersededByUid: context.uid,
            supersededReason: command.reason,
          });
        }
      }
      transaction.create(periodRef, {
        teacherUid: teacher.uid,
        teacherEmail: teacher.email,
        billingPeriod: clean(body.startsAt).slice(0, 7),
        invoiceId: null,
        receiptId: null,
        planId: command.planId,
        planName: clean(plan.name),
        featurePermissions,
        featureVisibilityMode: clean(plan.featureVisibilityMode) === 'locked' ? 'locked' : 'hide',
        startedAt: Timestamp.fromDate(startsAt),
        expiresAt: Timestamp.fromDate(expiresAt),
        status: resultStatus,
        approved: true,
        paymentApproved: true,
        paymentStatus: 'waived_by_admin',
        manualOverride: true,
        manualOverrideReason: command.reason,
        approvedAt: FieldValue.serverTimestamp(),
        approvedByUid: context.uid,
        approvedByEmail: context.email,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(accountRef, {
        teacherUid: teacher.uid,
        teacherEmail: teacher.email,
        active: true,
        status: resultStatus,
        planId: command.planId,
        planName: clean(plan.name),
        startedAt: Timestamp.fromDate(startsAt),
        expiresAt: Timestamp.fromDate(expiresAt),
        accessMode: 'paid_subscription',
        featureVisibilityMode: clean(plan.featureVisibilityMode) === 'locked' ? 'locked' : 'hide',
        featurePermissions,
        fullAccessGranted: false,
        manualOverride: true,
        manualOverrideReason: command.reason,
        manualOverrideByUid: context.uid,
        manualOverrideByEmail: context.email,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.create(auditRef, {
        action: command.operation === 'assign' ? 'manual_subscription_assign' : 'manual_subscription_change',
        teacherUid: teacher.uid,
        teacherEmail: teacher.email,
        teacherName: teacher.name,
        adminUid: context.uid,
        adminEmail: context.email,
        reason: command.reason,
        previous,
        next: after,
        paymentBypassed: true,
        periodId,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  } else if (command.operation === 'extend') {
    if (!currentPeriodRecord || !currentPeriodRecord.expiresAt) {
      throw new SubscriptionApiError(409, 'Only a currently active approved subscription period can be extended.');
    }
    const accountStatus = statusOf(account);
    if ((account.active !== true && accountStatus !== 'scheduled') || ['suspended', 'cancelled', 'canceled', 'revoked', 'disabled', 'deleted'].includes(accountStatus)) {
      throw new SubscriptionApiError(409, 'Reactivate the customer subscription before extending it.');
    }
    if (command.expiresAt!.getTime() <= currentPeriodRecord.expiresAt.getTime()) {
      throw new SubscriptionApiError(400, 'The new end date must be later than the current subscription expiry.');
    }
    const after = { ...previous, accountStatus: 'active', accountActive: true, expiresAt: command.expiresAt!.toISOString() };
    await context.db.runTransaction(async (transaction) => {
      const [freshAccount, freshPeriod] = await Promise.all([
        transaction.get(accountRef),
        transaction.get(currentPeriodRecord.ref),
      ]);
      const freshAccountData = freshAccount.data() ?? {};
      const freshAccountStatus = statusOf(freshAccountData);
      const freshPeriodData = freshPeriod.data() ?? {};
      if (!freshAccount.exists || !freshPeriod.exists ||
          (freshAccountData.active !== true && freshAccountStatus !== 'scheduled') ||
          ['suspended', 'cancelled', 'canceled', 'revoked', 'disabled', 'deleted'].includes(freshAccountStatus) ||
          freshPeriodData.approved === false || freshPeriodData.paymentApproved === false ||
          !['active', 'scheduled'].includes(statusOf(freshPeriodData))) {
        throw new SubscriptionApiError(409, 'The customer subscription changed. Refresh and try again.');
      }
      const freshStart = dateFromUnknown(freshPeriodData.startedAt);
      const freshExpiry = dateFromUnknown(freshPeriodData.expiresAt);
      if (!freshStart || freshStart.getTime() > Date.now() || !freshExpiry ||
          freshExpiry.getTime() !== currentPeriodRecord.expiresAt!.getTime()) {
        throw new SubscriptionApiError(409, 'The subscription dates changed. Refresh and try again.');
      }
      transaction.update(currentPeriodRecord.ref, {
        status: 'active',
        expiresAt: Timestamp.fromDate(command.expiresAt!),
        adminExtendedAt: FieldValue.serverTimestamp(),
        adminExtendedByUid: context.uid,
        adminExtendedByEmail: context.email,
        adminExtensionReason: command.reason,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(accountRef, {
        active: true,
        status: 'active',
        expiresAt: Timestamp.fromDate(command.expiresAt!),
        adminExtensionReason: command.reason,
        adminExtendedByUid: context.uid,
        adminExtendedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.create(auditRef, {
        action: 'manual_subscription_extend', teacherUid: teacher.uid, teacherEmail: teacher.email,
        teacherName: teacher.name, adminUid: context.uid, adminEmail: context.email,
        reason: command.reason, previous, next: after, periodId: currentPeriodRecord.id,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    resultStatus = 'active';
  } else if (command.operation === 'suspend' || command.operation === 'cancel') {
    const nextStatus = command.operation === 'suspend' ? 'suspended' : 'cancelled';
    await context.db.runTransaction(async (transaction) => {
      const reads = [transaction.get(accountRef)];
      if (command.operation === 'cancel') reads.push(...scheduledPeriods.map((item) => transaction.get(item.ref)));
      const snapshots = await Promise.all(reads);
      const freshAccount = snapshots[0];
      if (!freshAccount.exists) throw new SubscriptionApiError(409, 'The customer does not have a subscription account to update.');
      transaction.set(accountRef, {
        active: false,
        status: nextStatus,
        accessSuspendedAt: command.operation === 'suspend' ? FieldValue.serverTimestamp() : FieldValue.delete(),
        accessCancelledAt: command.operation === 'cancel' ? FieldValue.serverTimestamp() : FieldValue.delete(),
        accessBlockedByUid: context.uid,
        accessBlockedByEmail: context.email,
        accessBlockReason: command.reason,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      if (command.operation === 'cancel') {
        for (let index = 0; index < scheduledPeriods.length; index += 1) {
          const scheduled = snapshots[index + 1];
          if (scheduled.exists && clean(scheduled.data()?.status) === 'scheduled') {
            transaction.update(scheduledPeriods[index].ref, {
              status: 'cancelled',
              cancelledAt: FieldValue.serverTimestamp(),
              cancelledByUid: context.uid,
              cancellationReason: command.reason,
            });
          }
        }
      }
      transaction.create(auditRef, {
        action: command.operation === 'suspend' ? 'manual_subscription_suspend' : 'manual_subscription_cancel',
        teacherUid: teacher.uid, teacherEmail: teacher.email, teacherName: teacher.name,
        adminUid: context.uid, adminEmail: context.email, reason: command.reason,
        previous, next: { ...previous, accountActive: false, accountStatus: nextStatus },
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    resultStatus = nextStatus;
  } else {
    const eligiblePeriod = selectReactivationPeriod(
      periodsSnapshot.docs.map((doc) => ({ id: doc.id, data: doc.data(), startsAt: dateFromUnknown(doc.data().startedAt), expiresAt: dateFromUnknown(doc.data().expiresAt) })),
      now,
    );
    if (!eligiblePeriod) throw new SubscriptionApiError(409, 'No approved current or future subscription period is available to reactivate. Assign a plan or generate a paid invoice first.');
    resultStatus = eligiblePeriod.startsAt!.getTime() <= nowMs ? 'active' : 'scheduled';
    const after = { ...previous, accountActive: true, accountStatus: resultStatus };
    await context.db.runTransaction(async (transaction) => {
      const [freshAccount, freshPeriod] = await Promise.all([
        transaction.get(accountRef),
        transaction.get(periodsRef.doc(eligiblePeriod.id)),
      ]);
      if (!freshAccount.exists || !freshPeriod.exists) throw new SubscriptionApiError(404, 'The customer subscription or its approved period was not found.');
      const freshPeriodData = freshPeriod.data() ?? {};
      const freshStart = dateFromUnknown(freshPeriodData.startedAt);
      const freshEnd = dateFromUnknown(freshPeriodData.expiresAt);
      if (freshPeriodData.approved === false || freshPeriodData.paymentApproved === false ||
          !['active', 'scheduled'].includes(statusOf(freshPeriodData)) || !freshStart || !freshEnd || freshEnd.getTime() <= Date.now()) {
        throw new SubscriptionApiError(409, 'No eligible approved period remains for reactivation. Refresh and try again.');
      }
      const verifiedStatus = freshStart.getTime() <= Date.now() ? 'active' : 'scheduled';
      if (verifiedStatus !== resultStatus) {
        throw new SubscriptionApiError(409, 'The subscription start date changed. Refresh and try again.');
      }
      transaction.set(accountRef, {
        active: true,
        status: resultStatus,
        accessSuspendedAt: FieldValue.delete(),
        accessCancelledAt: FieldValue.delete(),
        accessBlockedByUid: FieldValue.delete(),
        accessBlockedByEmail: FieldValue.delete(),
        accessBlockReason: FieldValue.delete(),
        reactivatedAt: FieldValue.serverTimestamp(),
        reactivatedByUid: context.uid,
        reactivatedByEmail: context.email,
        reactivationReason: command.reason,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.create(auditRef, {
        action: 'manual_subscription_reactivate', teacherUid: teacher.uid, teacherEmail: teacher.email,
        teacherName: teacher.name, adminUid: context.uid, adminEmail: context.email,
        reason: command.reason, previous, next: after, createdAt: FieldValue.serverTimestamp(),
      });
    });
  }

  let projectionRefreshPending = false;
  try {
    await refreshTeacherEntitlementProjection(context.db, teacher.uid, teacher.email);
  } catch (error) {
    projectionRefreshPending = true;
    console.error('[EduTrack][subscription-admin] entitlement projection refresh failed:', teacher.email, error);
  }
  return {
    success: true,
    operation: command.operation,
    status: resultStatus,
    teacherUid: teacher.uid,
    auditLogId: auditRef.id,
    projectionRefreshPending,
    paymentBypassed: command.operation === 'assign' || command.operation === 'change',
  };
}

async function generateInvoice(context: AdminContext, body: RecordLike) {
  const teacher = await resolveManagedTeacher(context, body.teacherUid);
  const accountRef = context.root.collection('subscriptionAccounts').doc(teacher.uid);
  const accountSnapshot = await accountRef.get();
  const accountData = accountSnapshot.data() ?? {};
  const isPostpaidMonthly = clean(accountData.accessMode) === 'postpaid_monthly';
  const postpaidPlanSnapshot = isRecord(accountData.postpaidPlanSnapshot) ? accountData.postpaidPlanSnapshot : null;
  if (isPostpaidMonthly) {
    const savedPlanId = clean(accountData.postpaidPlanId);
    const savedPeriod = clean(accountData.postpaidUsageBillingPeriod);
    const usageEnd = toSafeSubscriptionDate(accountData.postpaidUsageExpiresAt ?? accountData.expiresAt);
    if (!postpaidPlanSnapshot || !savedPlanId || clean(postpaidPlanSnapshot.id) !== savedPlanId || !savedPeriod || !usageEnd) {
      throw new SubscriptionApiError(409, 'The teacher postpaid plan snapshot or usage window is incomplete. Review the customer record before billing.');
    }
    if (clean(body.planId) !== savedPlanId) {
      throw new SubscriptionApiError(409, 'This teacher must be invoiced against the plan selected during registration.');
    }
    if (clean(body.billingPeriod) !== savedPeriod) {
      throw new SubscriptionApiError(409, `This invoice must use the completed postpaid usage period ${savedPeriod}.`);
    }
    if (usageEnd.getTime() > Date.now()) {
      throw new SubscriptionApiError(409, 'The teacher is still inside the selected monthly usage period. An invoice can be generated after the full month ends.');
    }
    if (clean(accountData.postpaidInvoiceId) && ['unpaid', 'payment_pending', 'pending_review'].includes(clean(accountData.postpaidInvoiceStatus).toLowerCase())) {
      throw new SubscriptionApiError(409, 'A postpaid invoice is already awaiting payment or review for this usage period.');
    }
  }
  const billingPeriod = clean(body.billingPeriod);
  if (!isValidPeriodKey(billingPeriod)) throw new SubscriptionApiError(400, 'Choose a valid monthly billing period.');
  const invoiceDate = validDateKey(body.invoiceDate) ? String(body.invoiceDate) : new Date().toISOString().slice(0, 10);
  const dueDate = clean(body.dueDate);
  if (!validDateKey(dueDate) || dueDate < invoiceDate) throw new SubscriptionApiError(400, 'The due date must be valid and cannot be earlier than the invoice date.');
  const notes = optionalText(body.notes, 'Invoice notes', 2000);

  const chargesInput = body.charges === undefined ? [] : body.charges;
  if (!Array.isArray(chargesInput) || chargesInput.length > 30) throw new SubscriptionApiError(400, 'An invoice can contain up to 30 additional charges.');
  const charges: Array<{ description: string; amountPaisa: number }> = [];
  for (const [index, raw] of chargesInput.entries()) {
    if (!isRecord(raw)) throw new SubscriptionApiError(400, `Charge ${index + 1} is invalid.`);
    charges.push({
      description: requiredName(raw.description, `Charge ${index + 1} description`),
      amountPaisa: safeMoney(raw.amountPaisa, `Charge ${index + 1} amount`),
    });
  }

  let planSnapshot: RecordLike | null = null;
  let planId = '';
  let pricingMode: 'per_student' | 'lump_sum' = 'lump_sum';
  let billableStudentCount: number | null = null;
  const subtotalItems: Array<{ description: string; amountPaisa: number }> = [];
  if (clean(body.planId)) {
    planId = safeId(body.planId, 'plan ID');
    let plan: RecordLike;
    let legacyMode: 'per_student' | 'lump_sum';
    if (isPostpaidMonthly) {
      // The price and permissions were frozen when the teacher selected their plan.
      // Global plan edits/archives after registration must not rewrite this customer's terms.
      plan = postpaidPlanSnapshot ?? {};
      legacyMode = clean(plan.pricingMode) === 'per_student' ? 'per_student' : 'lump_sum';
    } else {
      const planRef = context.root.collection('subscriptionPlans').doc(planId);
      const planDoc = await planRef.get();
      if (!planDoc.exists || planDoc.data()?.active !== true || planDoc.data()?.deleted === true) throw new SubscriptionApiError(409, 'The selected subscription plan is not active.');
      plan = planDoc.data() ?? {};
      legacyMode = clean(plan.pricingMode) === 'per_student' ? 'per_student' : 'lump_sum';
    }
    const requestedMode = clean(body.pricingMode);
    if (requestedMode && requestedMode !== 'per_student' && requestedMode !== 'lump_sum') {
      throw new SubscriptionApiError(400, 'Choose Per Student or Lump Sum pricing for this invoice.');
    }
    if (isPostpaidMonthly && requestedMode && requestedMode !== legacyMode) {
      throw new SubscriptionApiError(409, 'The invoice pricing option must match the plan pricing saved at registration.');
    }
    const selectedPricingMode: 'per_student' | 'lump_sum' = isPostpaidMonthly
      ? legacyMode
      : requestedMode === 'per_student' ? 'per_student' : requestedMode === 'lump_sum' ? 'lump_sum' : legacyMode;
    pricingMode = selectedPricingMode;
    const configuredPrice = pricingMode === 'per_student'
      ? Number(plan.perStudentAmountPaisa)
      : Number(plan.lumpSumAmountPaisa);
    const legacyFallback = legacyMode === pricingMode ? Number(plan.amountPaisa) : 0;
    const unitPricePaisa = safeMoney(
      Number.isSafeInteger(configuredPrice) && configuredPrice > 0 ? configuredPrice : legacyFallback,
      pricingMode === 'per_student' ? 'Per-student plan price' : 'Lump-sum plan price',
      false,
    );
    let planTotalPaisa = unitPricePaisa;
    if (pricingMode === 'per_student') {
      // The authoritative unique roster check happens here, when Admin generates the invoice
      // after the postpaid month has finished—not during public teacher registration.
      const roster = await getVerifiedBillableStudentCount(teacher);
      billableStudentCount = roster.studentCount;
      planTotalPaisa = unitPricePaisa * roster.studentCount;
      if (!Number.isSafeInteger(planTotalPaisa) || planTotalPaisa > 1_000_000_000) {
        throw new SubscriptionApiError(400, 'The per-student invoice total is too large.');
      }
      planSnapshot = {
        id: planId, name: clean(plan.name), amountPaisa: unitPricePaisa, pricingMode,
        perStudentAmountPaisa: Number(plan.perStudentAmountPaisa) || (legacyMode === 'per_student' ? Number(plan.amountPaisa) || 0 : 0),
        lumpSumAmountPaisa: Number(plan.lumpSumAmountPaisa) || (legacyMode === 'lump_sum' ? Number(plan.amountPaisa) || 0 : 0),
        billableStudentCount: roster.studentCount, billableClassCount: roster.classCount, billingPeriod: 'monthly',
        featurePermissions: normalizeFeaturePermissions(plan.featurePermissions, false),
        featureVisibilityMode: clean(plan.featureVisibilityMode) === 'locked' ? 'locked' : 'hide',
        announcementQuotaPerClass: Number.isSafeInteger(plan.announcementQuotaPerClass) ? Math.max(4, Number(plan.announcementQuotaPerClass)) : 4,
        announcementExtraPackSize: Number.isSafeInteger(plan.announcementExtraPackSize) ? Math.max(1, Number(plan.announcementExtraPackSize)) : 4,
        announcementExtraPackPricePaisa: Number.isSafeInteger(plan.announcementExtraPackPricePaisa) ? Math.max(0, Number(plan.announcementExtraPackPricePaisa)) : 0,
      };
      subtotalItems.push({
        description: `${clean(plan.name)} · ${billingPeriod} · ${roster.studentCount} students × Rs ${(unitPricePaisa / 100).toLocaleString('en-PK')} per student`,
        amountPaisa: planTotalPaisa,
      });
    } else {
      planSnapshot = {
        id: planId, name: clean(plan.name), amountPaisa: unitPricePaisa, pricingMode,
        perStudentAmountPaisa: Number(plan.perStudentAmountPaisa) || (legacyMode === 'per_student' ? Number(plan.amountPaisa) || 0 : 0),
        lumpSumAmountPaisa: Number(plan.lumpSumAmountPaisa) || (legacyMode === 'lump_sum' ? Number(plan.amountPaisa) || 0 : 0),
        billingPeriod: 'monthly', featurePermissions: normalizeFeaturePermissions(plan.featurePermissions, false),
        featureVisibilityMode: clean(plan.featureVisibilityMode) === 'locked' ? 'locked' : 'hide',
        announcementQuotaPerClass: Number.isSafeInteger(plan.announcementQuotaPerClass) ? Math.max(4, Number(plan.announcementQuotaPerClass)) : 4,
        announcementExtraPackSize: Number.isSafeInteger(plan.announcementExtraPackSize) ? Math.max(1, Number(plan.announcementExtraPackSize)) : 4,
        announcementExtraPackPricePaisa: Number.isSafeInteger(plan.announcementExtraPackPricePaisa) ? Math.max(0, Number(plan.announcementExtraPackPricePaisa)) : 0,
      };
      subtotalItems.push({ description: `${clean(plan.name)} · ${billingPeriod} · Lump Sum`, amountPaisa: planTotalPaisa });
    }
    const announcementQuotaPerClass = Number.isSafeInteger(plan.announcementQuotaPerClass) ? Math.max(4, Number(plan.announcementQuotaPerClass)) : 4;
    const announcementExtraPackSize = Number.isSafeInteger(plan.announcementExtraPackSize) ? Math.max(1, Number(plan.announcementExtraPackSize)) : 4;
    const announcementExtraPackPricePaisa = Number.isSafeInteger(plan.announcementExtraPackPricePaisa) ? Math.max(0, Number(plan.announcementExtraPackPricePaisa)) : 0;
    if (announcementQuotaPerClass > 4) {
      if (announcementExtraPackPricePaisa < 1) {
        throw new SubscriptionApiError(409, 'This plan grants more than 4 announcements per class but has no configured extra-pack price. Set a price or reduce the quota before invoicing.');
      }
      // Per-student billing already verified the roster and captured its billable class count.
      // Lump-sum billing only needs the number of billable classes for this add-on; do not
      // accidentally impose the per-student non-empty roster requirement on a fixed-price plan.
      const quotaBillableClassCount = Number.isSafeInteger(planSnapshot?.billableClassCount)
        ? Number(planSnapshot?.billableClassCount)
        : await getBillableClassCount(teacher);
      let calculatedQuotaCharge: { extraPacks: number; amountPaisa: number };
      try {
        calculatedQuotaCharge = calculateAnnouncementExtraCharge({
          quotaPerClass: announcementQuotaPerClass,
          includedQuota: 4,
          extraPackSize: announcementExtraPackSize,
          extraPackPricePaisa: announcementExtraPackPricePaisa,
          billableClassCount: quotaBillableClassCount,
        });
      } catch (error) {
        throw new SubscriptionApiError(409, error instanceof Error ? error.message : 'The announcement extra quota could not be priced.');
      }
      if (calculatedQuotaCharge.amountPaisa > 0) {
        subtotalItems.push({
          description: `Additional announcements · ${announcementQuotaPerClass} per class (includes 4) · ${quotaBillableClassCount} classes × ${calculatedQuotaCharge.extraPacks} pack(s)`,
          amountPaisa: calculatedQuotaCharge.amountPaisa,
        });
      }
      if (planSnapshot) planSnapshot = { ...planSnapshot, billableClassCount: quotaBillableClassCount };
    }
    if (planSnapshot) planSnapshot = {
      ...planSnapshot,
      announcementQuotaPerClass, announcementExtraPackSize, announcementExtraPackPricePaisa,
    };
    if (isPostpaidMonthly) {
      planSnapshot = {
        ...planSnapshot,
        billingSource: 'postpaid_monthly',
        postpaidUsageBillingPeriod: clean(accountData.postpaidUsageBillingPeriod),
        postpaidUsageStartedAt: accountData.postpaidUsageStartedAt ?? accountData.startedAt ?? null,
        postpaidUsageExpiresAt: accountData.postpaidUsageExpiresAt ?? accountData.expiresAt ?? null,
      };
    }
  } else if (isPostpaidMonthly) {
    throw new SubscriptionApiError(409, 'The teacher has a saved postpaid plan. Generate the invoice for that plan rather than a charges-only invoice.');
  }
  let addOnSnapshots: Array<{ catalogId: string; name: string; description: string; featureKey: string; monthlyPricePaisa: number; billingPeriod: 'monthly' }> = [];
  if (body.addOnCatalogIds !== undefined) {
    if (!planId && Array.isArray(body.addOnCatalogIds) && body.addOnCatalogIds.length > 0) {
      throw new SubscriptionApiError(409, 'A paid add-on must be attached to a subscription plan invoice.');
    }
    try {
      if (!Array.isArray(body.addOnCatalogIds) || body.addOnCatalogIds.length > 20) {
        throw new Error('Choose up to 20 add-ons per invoice.');
      }
      const addOnIds = [...new Set(body.addOnCatalogIds.map((id) => safeId(id, 'add-on catalog ID')))];
      const addOnDocs = await Promise.all(addOnIds.map((id) => context.root.collection('subscriptionAddOnCatalog').doc(id).get()));
      const catalogItems = addOnDocs.map((doc) => ({ id: doc.id, ...(doc.data() ?? {}), active: doc.data()?.active === true, deleted: doc.data()?.deleted === true }));
      const built = buildAddOnInvoiceSnapshots(addOnIds, catalogItems as Parameters<typeof buildAddOnInvoiceSnapshots>[1]);
      const planPermissions = isRecord(planSnapshot?.featurePermissions) ? planSnapshot.featurePermissions : {};
      const alreadyIncluded = built.snapshots.filter((item) => planPermissions[item.featureKey] === 'enabled' || planPermissions[item.featureKey] === true);
      if (alreadyIncluded.length) {
        throw new Error(`These features are already included in the selected plan and cannot be billed as add-ons: ${alreadyIncluded.map((item) => item.name).join(', ')}.`);
      }
      addOnSnapshots = built.snapshots;
      subtotalItems.push(...built.lineItems);
    } catch (error) {
      throw new SubscriptionApiError(400, error instanceof Error ? error.message : 'The selected add-ons are invalid.');
    }
  }
  for (const charge of charges) subtotalItems.push(charge);
  if (!subtotalItems.length) throw new SubscriptionApiError(400, 'Select a plan or add at least one charge.');
  const subtotalPaisa = subtotalItems.reduce((sum, item) => sum + item.amountPaisa, 0);
  if (!Number.isSafeInteger(subtotalPaisa) || subtotalPaisa > 1_000_000_000) throw new SubscriptionApiError(400, 'The invoice total is too large.');

  let offerSnapshot: RecordLike | null = null;
  let offerId = '';
  let discountPaisa = 0;
  if (clean(body.offerId)) {
    offerId = safeId(body.offerId, 'offer ID');
    const offerDoc = await context.root.collection('subscriptionOffers').doc(offerId).get();
    if (!offerDoc.exists) throw new SubscriptionApiError(404, 'The selected offer was not found.');
    const offer = offerDoc.data() ?? {};
    const today = new Date().toISOString().slice(0, 10);
    if (offer.active !== true || !validDateKey(offer.validFrom) || !validDateKey(offer.validUntil) || today < String(offer.validFrom) || today > String(offer.validUntil)) {
      throw new SubscriptionApiError(409, 'The selected offer is inactive or outside its validity dates.');
    }
    const applicablePlans = Array.isArray(offer.planIds) ? offer.planIds.filter((id: unknown) => typeof id === 'string') : [];
    if (applicablePlans.length && (!planId || !applicablePlans.includes(planId))) throw new SubscriptionApiError(409, 'The selected offer does not apply to this plan.');
    const discountType = clean(offer.discountType);
    const discountValue = safeMoney(offer.discountValue, 'Offer discount', false);
    if (discountType !== 'percentage' && discountType !== 'fixed') throw new SubscriptionApiError(409, 'The selected offer has an invalid discount configuration.');
    if (discountType === 'percentage' && discountValue > 100) throw new SubscriptionApiError(409, 'The selected offer percentage is invalid.');
    discountPaisa = calculateDiscountPaisa(subtotalPaisa, { discountType, discountValue });
    offerSnapshot = { id: offerId, name: clean(offer.name), discountType, discountValue };
  }
  const totalPaisa = subtotalPaisa - discountPaisa;
  const invoiceId = makeSubscriptionInvoiceId(billingPeriod, teacher.uid);
  const invoiceRef = context.root.collection('subscriptionInvoices').doc(invoiceId);
  const invoiceNumber = `SUB-${billingPeriod.replace('-', '')}-${teacher.uid.slice(0, 8).toUpperCase()}`;
  const invoiceData = {
    invoiceNumber,
    teacherUid: teacher.uid,
    teacherEmail: teacher.email,
    teacherName: teacher.name,
    billingPeriod,
    billingSource: isPostpaidMonthly ? 'postpaid_monthly' : 'admin_generated',
    postpaidUsageBillingPeriod: isPostpaidMonthly ? clean(accountData.postpaidUsageBillingPeriod) : null,
    postpaidUsageStartedAt: isPostpaidMonthly ? (accountData.postpaidUsageStartedAt ?? accountData.startedAt ?? null) : null,
    postpaidUsageExpiresAt: isPostpaidMonthly ? (accountData.postpaidUsageExpiresAt ?? accountData.expiresAt ?? null) : null,
    planId: planId || null,
    planSnapshot,
    pricingMode,
    billableStudentCount,
    offerId: offerId || null,
    offerSnapshot,
    addOnSnapshots,
    charges: subtotalItems,
    subtotalPaisa,
    discountPaisa,
    totalPaisa,
    currency: 'PKR',
    status: 'unpaid',
    paymentStatus: 'unpaid',
    invoiceDate,
    dueDate,
    notes,
    createdByUid: context.uid,
    createdByEmail: context.email,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await context.db.runTransaction(async (transaction) => {
    const [existingInvoice, existingAccount] = await Promise.all([
      transaction.get(invoiceRef),
      transaction.get(accountRef),
    ]);
    if (existingInvoice.exists) throw new SubscriptionApiError(409, `An invoice already exists for ${teacher.name} for ${billingPeriod}. Refresh the invoice list instead of generating a duplicate.`);
    const currentAccount = existingAccount.data() ?? {};
    if (isPostpaidMonthly) {
      const currentExpiry = toSafeSubscriptionDate(currentAccount.postpaidUsageExpiresAt ?? currentAccount.expiresAt);
      if (!existingAccount.exists || clean(currentAccount.accessMode) !== 'postpaid_monthly' ||
          clean(currentAccount.postpaidUsageBillingPeriod) !== billingPeriod || !currentExpiry || currentExpiry.getTime() > Date.now() ||
          clean(currentAccount.postpaidPlanId) !== planId ||
          (clean(currentAccount.postpaidInvoiceId) && ['unpaid', 'payment_pending', 'pending_review'].includes(clean(currentAccount.postpaidInvoiceStatus).toLowerCase()))) {
        throw new SubscriptionApiError(409, 'The teacher postpaid account changed or is not ready for invoicing. Refresh the customer record and try again.');
      }
    }
    transaction.create(invoiceRef, invoiceData);
    const accountPatch: RecordLike = {
      teacherUid: teacher.uid,
      teacherEmail: teacher.email,
      teacherName: teacher.name,
      latestInvoiceId: invoiceId,
      latestInvoicePeriod: billingPeriod,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (isPostpaidMonthly) {
      accountPatch.postpaidInvoiceId = invoiceId;
      accountPatch.postpaidInvoiceStatus = 'unpaid';
      accountPatch.postpaidInvoiceBillingPeriod = billingPeriod;
    }
    if (!existingAccount.exists) {
      transaction.create(accountRef, {
        ...accountPatch,
        active: false,
        status: 'inactive',
        createdAt: FieldValue.serverTimestamp(),
      });
    } else {
      transaction.set(accountRef, accountPatch, { merge: true });
    }
  });
  const saved = await invoiceRef.get();
  return { success: true, created: true, invoice: invoiceJson(invoiceRef.id, saved.data() ?? {}) };
}

async function generateBulkInvoices(context: AdminContext, body: RecordLike) {
  const billingPeriod = clean(body.billingPeriod);
  if (!isValidPeriodKey(billingPeriod)) throw new SubscriptionApiError(400, 'Choose a valid monthly billing period.');
  const dueDate = clean(body.dueDate);
  const invoiceDate = validDateKey(body.invoiceDate) ? String(body.invoiceDate) : new Date().toISOString().slice(0, 10);
  if (!validDateKey(dueDate) || dueDate < invoiceDate) {
    throw new SubscriptionApiError(400, 'The due date must be valid and cannot be earlier than the invoice date.');
  }
  const notes = optionalText(body.notes, 'Invoice notes', 2000);

  let offerId = '';
  let offerPlanIds: string[] = [];
  if (clean(body.offerId)) {
    offerId = safeId(body.offerId, 'offer ID');
    const offerSnapshot = await context.root.collection('subscriptionOffers').doc(offerId).get();
    if (!offerSnapshot.exists) throw new SubscriptionApiError(404, 'The selected offer was not found.');
    const offer = offerSnapshot.data() ?? {};
    const today = new Date().toISOString().slice(0, 10);
    if (offer.active !== true || !validDateKey(offer.validFrom) || !validDateKey(offer.validUntil) ||
        today < String(offer.validFrom) || today > String(offer.validUntil)) {
      throw new SubscriptionApiError(409, 'The selected offer is inactive or outside its validity dates.');
    }
    offerPlanIds = Array.isArray(offer.planIds) ? offer.planIds.filter((value: unknown) => typeof value === 'string') : [];
  }

  const [teachers, addOnCatalogSnapshot] = await Promise.all([
    listManagedTeachers(context),
    context.root.collection('subscriptionAddOnCatalog').get(),
  ]);
  const activeAddOnCatalogIds = new Set(addOnCatalogSnapshot.docs
    .filter((doc) => doc.data().active === true && doc.data().deleted !== true)
    .map((doc) => doc.id));
  const built = buildBulkInvoiceTargets(teachers, billingPeriod);
  for (const target of built.targets) {
    target.addOnCatalogIds = target.addOnCatalogIds.filter((id) => activeAddOnCatalogIds.has(id));
  }
  const results: Array<RecordLike> = [...built.skipped];
  let createdCount = 0;
  let failedCount = 0;
  let offerNotAppliedCount = 0;

  // Reuse the exact same single-customer validation, price calculation, snapshots,
  // transaction and duplicate protection. Five concurrent invoices keep the bulk
  // operation bounded for Firestore and avoid a single giant write batch.
  for (let offset = 0; offset < built.targets.length; offset += 5) {
    const batch = built.targets.slice(offset, offset + 5);
    const batchResults = await Promise.all(batch.map(async (target) => {
      const targetOfferId = offerId && (!offerPlanIds.length || offerPlanIds.includes(target.planId)) ? offerId : '';
      const offerNotApplied = Boolean(offerId && !targetOfferId);
      try {
        const response = await generateInvoice(context, {
          teacherUid: target.teacherUid,
          billingPeriod: target.billingPeriod,
          planId: target.planId,
          pricingMode: target.pricingMode,
          offerId: targetOfferId || null,
          addOnCatalogIds: target.addOnCatalogIds,
          dueDate,
          invoiceDate,
          notes,
          charges: body.charges,
        });
        return {
          teacherUid: target.teacherUid,
          teacherEmail: target.teacherEmail,
          teacherName: target.teacherName,
          planName: target.planName,
          billingPeriod: target.billingPeriod,
          invoiceNumber: response.invoice.invoiceNumber,
          totalPaisa: response.invoice.totalPaisa,
          status: 'created',
          offerApplied: Boolean(targetOfferId),
          offerNotApplied,
          addOnsIncluded: target.addOnCatalogIds.length,
        };
      } catch (error) {
        const status = Number((error as { status?: unknown })?.status);
        const reason = error instanceof Error ? error.message : 'Invoice generation failed.';
        return {
          teacherUid: target.teacherUid,
          teacherEmail: target.teacherEmail,
          teacherName: target.teacherName,
          planName: target.planName,
          billingPeriod: target.billingPeriod,
          status: status === 409 ? 'skipped' : 'failed',
          reason,
          offerApplied: false,
          offerNotApplied,
        };
      }
    }));

    for (const result of batchResults) {
      if (result.status === 'created') createdCount += 1;
      else if (result.status === 'failed') failedCount += 1;
      if (result.offerNotApplied) offerNotAppliedCount += 1;
      results.push(result);
    }
  }

  return {
    success: true,
    billingPeriod,
    managedCustomers: teachers.length,
    eligibleCustomers: built.targets.length,
    createdCount,
    skippedCount: results.filter((item) => item.status === 'skipped').length,
    failedCount,
    offerNotAppliedCount,
    results,
  };
}


function activeSubscriptionExpiry(account: RecordLike, periods: QueryDocumentSnapshot[]): Date | null {
  const now = Date.now();
  const candidates = periods.map((doc) => doc.data()).filter((data) => {
    const start = data.startedAt && typeof data.startedAt.toDate === 'function' ? (data.startedAt.toDate as () => Date)().getTime() : new Date(data.startedAt as string).getTime();
    const end = data.expiresAt && typeof data.expiresAt.toDate === 'function' ? (data.expiresAt.toDate as () => Date)().getTime() : new Date(data.expiresAt as string).getTime();
    return data.approved !== false && data.paymentApproved !== false && (data.status === 'active' || data.status === 'scheduled') && Number.isFinite(start) && Number.isFinite(end) && start <= now && end > now;
  });
  const current = candidates.sort((a, b) => {
    const value = (v: unknown) => v && typeof (v as { toDate?: unknown }).toDate === 'function' ? ((v as { toDate: () => Date }).toDate()).getTime() : new Date(v as string).getTime();
    return value(b.startedAt) - value(a.startedAt);
  })[0];
  if (current) {
    const value = current.expiresAt;
    return value && typeof value.toDate === 'function' ? (value.toDate as () => Date)() : new Date(value as string);
  }
  const accountEnd = account.expiresAt;
  const end = toSafeSubscriptionDate(accountEnd);
  return end && end.getTime() > now && account.active === true ? end : null;
}

async function grantCustomerAddOn(context: AdminContext, body: RecordLike, requestId?: string) {
  const teacher = await resolveManagedTeacher(context, body.teacherUid);
  const featureKey = clean(body.featureKey);
  if (!FEATURE_PERMISSION_KEYS.includes(featureKey as typeof FEATURE_PERMISSION_KEYS[number])) throw new SubscriptionApiError(400, 'Choose a valid feature key for this add-on.');
  const accountRef = context.root.collection('subscriptionAccounts').doc(teacher.uid);
  const [accountSnapshot, periodSnapshot, activeAddOns] = await Promise.all([
    accountRef.get(),
    accountRef.collection('periods').where('status', 'in', ['active', 'scheduled']).get(),
    accountRef.collection('addOns').where('status', '==', 'active').get(),
  ]);
  const account = accountSnapshot.data() ?? {};
  const expiry = activeSubscriptionExpiry(account, periodSnapshot.docs);
  if (!expiry) throw new SubscriptionApiError(409, 'A customer must have an active approved subscription period before an add-on can be granted.');
  const now = new Date();
  const duplicate = activeAddOns.docs.find((doc) => {
    const addon = doc.data();
    return addon.approved === true && addon.status === 'active' && Array.isArray(addon.featureKeys) && addon.featureKeys.includes(featureKey) &&
      ((addon.expiresAt && typeof addon.expiresAt.toDate === 'function' ? (addon.expiresAt.toDate as () => Date)().getTime() : new Date(addon.expiresAt as string).getTime()) > now.getTime());
  });
  if (duplicate) return { success: true, id: duplicate.id, idempotent: true };
  const addOnRef = accountRef.collection('addOns').doc(requestId || randomUUID());
  await addOnRef.set({
    id: addOnRef.id,
    name: clean(body.name) || featureKey.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
    featureKeys: [featureKey],
    approved: true,
    status: 'active',
    grantSource: requestId ? 'approved_customer_request' : 'admin_grant',
    startsAt: Timestamp.fromDate(now),
    expiresAt: Timestamp.fromDate(expiry),
    approvedByUid: context.uid,
    approvedByEmail: context.email,
    approvedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  if (requestId) {
    await accountRef.collection('addOnRequests').doc(requestId).set({ status: 'approved', addOnId: addOnRef.id, reviewedByUid: context.uid, reviewedByEmail: context.email, reviewedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  await refreshTeacherEntitlementProjection(context.db, teacher.uid, teacher.email);
  return { success: true, id: addOnRef.id, expiresAt: expiry.toISOString(), idempotent: false };
}

async function reviewAddOnRequest(context: AdminContext, body: RecordLike) {
  const uid = safeId(body.teacherUid, 'teacher UID');
  const requestId = safeId(body.requestId, 'add-on request ID');
  const decision = clean(body.decision);
  if (!['approve', 'reject'].includes(decision)) throw new SubscriptionApiError(400, 'Choose approve or reject.');
  const teacher = await resolveManagedTeacher(context, uid);
  const requestRef = context.root.collection('subscriptionAccounts').doc(teacher.uid).collection('addOnRequests').doc(requestId);
  const snapshot = await requestRef.get();
  if (!snapshot.exists || clean(snapshot.data()?.status) !== 'pending') throw new SubscriptionApiError(409, 'This add-on request is no longer pending.');
  if (decision === 'approve') {
    const featureKey = clean(snapshot.data()?.featureKey);
    if (!FEATURE_PERMISSION_KEYS.includes(featureKey as typeof FEATURE_PERMISSION_KEYS[number])) throw new SubscriptionApiError(409, 'The requested feature key is no longer supported.');
    return grantCustomerAddOn(context, { ...body, featureKey }, requestId);
  }
  await requestRef.set({ status: 'rejected', reviewedByUid: context.uid, reviewedByEmail: context.email, reviewedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { success: true, id: requestId, status: 'rejected' };
}

async function revokeCustomerAddOn(context: AdminContext, body: RecordLike) {
  const teacher = await resolveManagedTeacher(context, body.teacherUid);
  const addOnId = safeId(body.addOnId, 'add-on ID');
  const ref = context.root.collection('subscriptionAccounts').doc(teacher.uid).collection('addOns').doc(addOnId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new SubscriptionApiError(404, 'The customer add-on was not found.');
  await ref.set({ status: 'revoked', approved: false, revokedByUid: context.uid, revokedByEmail: context.email, revokedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await refreshTeacherEntitlementProjection(context.db, teacher.uid, teacher.email);
  return { success: true, id: addOnId, status: 'revoked' };
}

export async function postAdminSubscriptions(request: SubscriptionApiRequest) {
  const context = await getAdminContext(request);
  const body = requireBody(request);
  const action = clean(body.action);
  switch (action) {
    case 'createPlan': return createPlan(context, body);
    case 'updatePlan': return updatePlan(context, body);
    case 'deletePlan': return deletePlan(context, body);
    case 'createOffer': return createOffer(context, body);
    case 'updateOffer': return updateOffer(context, body);
    case 'createAddOnCatalogItem': return createAddOnCatalogItem(context, body);
    case 'updateAddOnCatalogItem': return updateAddOnCatalogItem(context, body);
    case 'archiveAddOnCatalogItem': return archiveAddOnCatalogItem(context, body);
    case 'manageCustomerSubscription': return manageCustomerSubscription(context, body);
    case 'generateInvoice': return generateInvoice(context, body);
    case 'bulkGenerateInvoices': return generateBulkInvoices(context, body);
    case 'applyDefaultPermissionMatrix': return applyDefaultPermissionMatrix(context);
    case 'reviewAddOnRequest': return reviewAddOnRequest(context, body);
    case 'assignCustomerAddOn': return grantCustomerAddOn(context, body);
    case 'revokeCustomerAddOn': return revokeCustomerAddOn(context, body);
    default: throw new SubscriptionApiError(400, 'Unknown subscription management action.');
  }
}

export function sendSubscriptionApiError(response: SubscriptionApiResponse, error: unknown) {
  const candidate = isRecord(error) ? error : {};
  const statusValue = Number(candidate.status);
  const status = Number.isInteger(statusValue) && statusValue >= 400 && statusValue <= 599
    ? statusValue
    : error instanceof FirebaseAdminConfigurationError ? 503 : 500;
  const message = status >= 500
    ? error instanceof FirebaseAdminConfigurationError ? 'The server Firebase configuration is incomplete.' : 'The subscription service could not complete the request.'
    : error instanceof Error ? error.message : 'The request is invalid.';
  response.setHeader('Cache-Control', 'no-store');
  return response.status(status).json({ success: false, error: message });
}
