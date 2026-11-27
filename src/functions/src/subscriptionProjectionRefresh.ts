import { createHash } from 'node:crypto';
import { FieldPath, getFirestore, Timestamp, FieldValue, type DocumentReference, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';

const FEATURE_KEYS = [
  'student_management', 'class_management', 'attendance_management', 'attendance_alerts',
  'monthly_reports', 'fortnightly_reports', 'weekly_reports', 'attendance_analytics',
  'advanced_analytics', 'fee_tracking', 'fee_alerts', 'custom_alerts', 'quiz_management',
  'quiz_result_notifications', 'notes_library', 'library_link_whatsapp', 'announcements',
] as const;
const BACKFILL_PAGE_SIZE = 100;
const DUE_PAGE_SIZE = 100;

type RecordLike = Record<string, unknown>;
type CustomerSnapshot = QueryDocumentSnapshot<RecordLike>;
const isRecord = (value: unknown): value is RecordLike => typeof value === 'object' && value !== null && !Array.isArray(value);
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

function asMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    const result = new Date(value).getTime();
    return Number.isFinite(result) ? result : null;
  }
  if (isRecord(value) && typeof value.toMillis === 'function') {
    try { const result = (value.toMillis as () => number)(); return Number.isFinite(result) ? result : null; } catch { return null; }
  }
  return null;
}

function stableFingerprintValue(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableFingerprintValue);
  if (isRecord(value)) {
    if (typeof value.toMillis === 'function') {
      try { return (value.toMillis as () => number)(); } catch { return null; }
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableFingerprintValue(value[key])]));
  }
  return value;
}

function projectionFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(stableFingerprintValue(value))).digest('hex');
}

function minFutureBoundary(values: Array<number | null>, now: number): Timestamp | null {
  const future = values.filter((value): value is number => value !== null && value > now);
  return future.length ? Timestamp.fromMillis(Math.min(...future)) : null;
}

/**
 * Seed the existing customer registry once, in bounded pages. The cursor is stored on the
 * already-read admin root document, avoiding a separate state-document read each minute.
 * Thereafter the scheduler queries only documents whose next boundary is due.
 */
async function backfillOneCustomerPage(
  root: DocumentReference,
  rootData: RecordLike,
  pageSize: number,
): Promise<{ scanned: number; customers: CustomerSnapshot[]; complete: boolean }> {
  if (rootData.subscriptionProjectionBackfillComplete === true) return { scanned: 0, customers: [], complete: true };

  let query = root.collection('customers').orderBy(FieldPath.documentId()).limit(pageSize);
  const cursor = clean(rootData.subscriptionProjectionBackfillCursor);
  if (cursor) query = query.startAfter(cursor);
  const page = await query.get();
  if (page.empty) {
    await root.set({
      subscriptionProjectionBackfillComplete: true,
      subscriptionProjectionBackfillCompletedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { scanned: 0, customers: [], complete: true };
  }

  // Only process customers that have not already been scheduled by a live subscription
  // request/mutation. Existing future/due markers remain authoritative.
  const customers = page.docs.filter((customer) => {
    const data = customer.data();
    const uid = clean(data.uid || customer.id);
    const email = clean(data.email).toLowerCase();
    return Boolean(uid && customer.id === uid && email && !data.deleted && !data.disabled && data.active !== false) &&
      asMillis(data.projectionNextRefreshAt) === null;
  }) as CustomerSnapshot[];
  const lastId = page.docs[page.docs.length - 1].id;
  await root.set({
    subscriptionProjectionBackfillCursor: lastId,
    subscriptionProjectionBackfillComplete: page.size < pageSize,
    ...(page.size < pageSize ? { subscriptionProjectionBackfillCompletedAt: FieldValue.serverTimestamp() } : {}),
  }, { merge: true });
  return { scanned: page.size, customers, complete: page.size < pageSize };
}

function isApprovedPeriod(data: RecordLike): boolean {
  const status = clean(data.status).toLowerCase();
  return data.approved !== false && data.paymentApproved !== false && (status === 'active' || status === 'scheduled') &&
    asMillis(data.startedAt) !== null && asMillis(data.expiresAt) !== null &&
    asMillis(data.expiresAt)! > asMillis(data.startedAt)!;
}

function isApprovedAddOn(data: RecordLike): boolean {
  return data.approved === true && ['active', 'scheduled'].includes(clean(data.status).toLowerCase()) &&
    asMillis(data.startsAt || data.startedAt) !== null && asMillis(data.expiresAt) !== null &&
    asMillis(data.expiresAt)! > asMillis(data.startsAt || data.startedAt)!;
}

async function processDueCustomer(
  customerDoc: CustomerSnapshot,
  allowFullAccessByRoot: Map<string, boolean>,
  now: number,
): Promise<{ activated: number; projectionChanged: number; writes: number }> {
  const db = getFirestore();
  const path = customerDoc.ref.path.split('/');
  if (path.length !== 4 || path[0] !== 'admins' || path[2] !== 'customers') return { activated: 0, projectionChanged: 0, writes: 0 };

  const registry = customerDoc.data();
  const uid = clean(registry.uid || customerDoc.id);
  const email = clean(registry.email).toLowerCase();
  const clearDueMarker = async () => {
    if (asMillis(registry.projectionNextRefreshAt) === null) {
      return { activated: 0, projectionChanged: 0, writes: 0 };
    }
    await customerDoc.ref.set({ projectionNextRefreshAt: FieldValue.delete() }, { merge: true });
    return { activated: 0, projectionChanged: 0, writes: 1 };
  };
  if (!uid || customerDoc.id !== uid || !email || registry.deleted === true || registry.disabled === true || registry.active === false) {
    return clearDueMarker();
  }

  const root = customerDoc.ref.parent.parent;
  if (!root) return clearDueMarker();
  const rootPath = root.path;
  let allowFullAccess = allowFullAccessByRoot.get(rootPath);
  const profileRef = db.collection('users').doc(email);
  const accountRef = root.collection('subscriptionAccounts').doc(uid);
  const [profileSnapshot, accountSnapshot] = await Promise.all([profileRef.get(), accountRef.get()]);
  if (!profileSnapshot.exists) return clearDueMarker();
  const profile = profileSnapshot.data() ?? {};
  if (profile.uid !== uid || clean(profile.email).toLowerCase() !== email || profile.role !== 'teacher' ||
      profile.active !== true || profile.disabled === true || profile.deleted === true) return clearDueMarker();

  const account = accountSnapshot.data() ?? registry;
  if ((clean(account.teacherUid) && clean(account.teacherUid) !== uid) ||
      (clean(account.teacherEmail) && clean(account.teacherEmail).toLowerCase() !== email)) return clearDueMarker();

  const accessMode = clean(account.accessMode) || 'unassigned_restricted';
  const accountStatus = clean(account.status).toLowerCase();
  const awaitingApprovedPeriod = account.active === false && ['pending_payment', 'scheduled'].includes(accountStatus);
  const accountBlocked = (account.active === false && !awaitingApprovedPeriod) || account.disabled === true || account.deleted === true ||
    ['suspended', 'disabled', 'deleted', 'inactive', 'revoked', 'rejected', 'archived', 'cancelled', 'canceled'].includes(accountStatus);

  if (accessMode === 'unassigned_full_access' && allowFullAccess === undefined) {
    const settingsSnapshot = await root.collection('subscriptionSettings').doc('general').get();
    allowFullAccess = (settingsSnapshot.data() ?? {}).allowUnassignedFullAccess !== false;
    allowFullAccessByRoot.set(rootPath, allowFullAccess);
  }
  allowFullAccess ??= true;

  const hasUnassignedFullAccess = !accountBlocked && accessMode === 'unassigned_full_access' && account.fullAccessGranted === true && allowFullAccess;
  const legacyStart = asMillis(account.startedAt);
  const legacyEnd = asMillis(account.expiresAt);
  const hasLegacyAccountWindow = account.active === true && legacyStart !== null && legacyEnd !== null && legacyEnd > legacyStart;
  const canQueryPeriods = !hasUnassignedFullAccess && !accountBlocked && accessMode !== 'postpaid_monthly';

  let periodDocs: Array<{ id: string; data: RecordLike }> = [];
  let selectedPeriod: { id: string; data: RecordLike } | undefined;
  if (canQueryPeriods) {
    const snapshot = await accountRef.collection('periods')
      .where('status', 'in', ['active', 'scheduled', 'ACTIVE', 'SCHEDULED']).get();
    periodDocs = snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
    const eligible = periodDocs.filter(({ data }) => {
      const start = asMillis(data.startedAt);
      const end = asMillis(data.expiresAt);
      return isApprovedPeriod(data) && start !== null && end !== null && start <= now && end > now;
    }).sort((a, b) => (asMillis(b.data.startedAt) ?? 0) - (asMillis(a.data.startedAt) ?? 0));
    selectedPeriod = eligible[0];
  }

  // Legacy account-date windows are resolved by the request-path entitlement domain. The
  // scheduler must not replace those richer projections with an inactive paid-period view.
  if (accessMode === 'postpaid_monthly' || (!selectedPeriod && hasLegacyAccountWindow)) {
    return clearDueMarker();
  }

  const hasFuturePeriod = periodDocs.some(({ data }) => isApprovedPeriod(data) &&
    clean(data.status).toLowerCase() === 'scheduled' && (asMillis(data.startedAt) ?? 0) > now);
  const addOnDocs = selectedPeriod || hasFuturePeriod
    ? (await accountRef.collection('addOns').where('status', 'in', ['active', 'scheduled', 'ACTIVE', 'SCHEDULED']).get()).docs
    : [];

  const futureBoundaries: Array<number | null> = [];
  for (const { data } of periodDocs) {
    if (!isApprovedPeriod(data)) continue;
    futureBoundaries.push(asMillis(data.startedAt), asMillis(data.expiresAt));
  }
  for (const doc of addOnDocs) {
    const data = doc.data();
    if (!isApprovedAddOn(data)) continue;
    futureBoundaries.push(asMillis(data.startsAt || data.startedAt), asMillis(data.expiresAt));
  }
  const nextRefresh = minFutureBoundary(futureBoundaries, now);

  let active = false;
  let status = 'inactive';
  let planId: string | null = null;
  let planName: string | null = null;
  let startedAt: Timestamp | null = null;
  let expiresAt: Timestamp | null = null;
  let featurePermissions: Record<string, unknown> = {};
  let featureVisibilityMode = clean(account.featureVisibilityModeOverride || account.featureVisibilityMode) === 'locked' ? 'locked' : 'hide';
  let featureSources: Record<string, string> = {};
  const activeAddOns: Array<Record<string, unknown>> = [];

  if (!accountBlocked && accessMode === 'unassigned_full_access' && account.fullAccessGranted === true && allowFullAccess) {
    active = true;
    status = 'active';
    featurePermissions = Object.fromEntries(FEATURE_KEYS.map((key) => [key, 'enabled']));
    featureSources = Object.fromEntries(FEATURE_KEYS.map((key) => [key, 'unassigned_full_access']));
  } else if (selectedPeriod && !accountBlocked && account.disabled !== true && account.deleted !== true) {
    const data = selectedPeriod.data;
    const periodStart = asMillis(data.startedAt)!;
    const periodEnd = asMillis(data.expiresAt)!;
    active = true;
    status = 'active';
    planId = clean(data.planId) || null;
    planName = clean(data.planName) || null;
    startedAt = Timestamp.fromMillis(periodStart);
    expiresAt = Timestamp.fromMillis(periodEnd);
    featurePermissions = isRecord(data.featurePermissions) ? { ...data.featurePermissions } : {};
    featureVisibilityMode = clean(account.featureVisibilityModeOverride) === 'locked'
      ? 'locked'
      : clean(data.featureVisibilityMode) === 'locked' ? 'locked' : 'hide';
    featureSources = Object.fromEntries(FEATURE_KEYS.map((key) => [key, 'plan']));
    for (const addOnDoc of addOnDocs) {
      const addOn = addOnDoc.data();
      const addOnStart = asMillis(addOn.startsAt || addOn.startedAt);
      const addOnEnd = asMillis(addOn.expiresAt);
      if (addOn.approved !== true || !['active', 'scheduled'].includes(clean(addOn.status).toLowerCase()) ||
          addOnStart === null || addOnEnd === null || addOnStart > now || addOnEnd <= now) continue;
      const keys = Array.isArray(addOn.featureKeys)
        ? addOn.featureKeys.filter((key): key is string => typeof key === 'string' && FEATURE_KEYS.includes(key as typeof FEATURE_KEYS[number]))
        : [];
      for (const key of keys) {
        featurePermissions[key] = 'enabled';
        featureSources[key] = `add_on:${addOnDoc.id}`;
      }
      activeAddOns.push({ id: addOnDoc.id, name: clean(addOn.name) || 'Feature add-on', featureKeys: keys,
        startsAt: Timestamp.fromMillis(addOnStart), expiresAt: Timestamp.fromMillis(addOnEnd) });
    }
  }

  const projection = {
    uid, email, active, status, planId, planName, billingPeriod: null, invoiceId: null,
    startedAt, expiresAt, featurePermissions, accessMode,
    fullAccessGranted: active && accessMode === 'unassigned_full_access', featureVisibilityMode,
    featureSources, addOns: activeAddOns,
    source: active ? (accessMode === 'unassigned_full_access' ? 'unassigned_full_access' : 'scheduled_subscription_projection') : 'scheduler_inactive',
    projectionVersion: 1,
  };
  const fingerprint = projectionFingerprint(projection);
  const projectionChanged = registry.schedulerProjectionFingerprint !== fingerprint;
  const currentNextRefresh = asMillis(registry.projectionNextRefreshAt);
  const desiredNextRefresh = nextRefresh?.toMillis() ?? null;
  const scheduleChanged = currentNextRefresh !== desiredNextRefresh;
  const batch = db.batch();
  if (projectionChanged) {
    batch.set(profileRef.collection('subscriptionEntitlements').doc('current'), {
      ...projection, updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  const registryPatch: Record<string, unknown> = {
    ...(projectionChanged ? {
      schedulerProjectionFingerprint: fingerprint,
      // The request-path resolver writes the authoritative billingPeriod/invoiceId/source
      // fields. If this scheduled projection changes first, let the next authorized request
      // repair that document once; the fingerprint then prevents repeated repairs.
      serverProjectionFingerprint: FieldValue.delete(),
    } : {}),
    ...(scheduleChanged ? { projectionNextRefreshAt: nextRefresh ?? FieldValue.delete() } : {}),
  };
  let writes = 0;
  if (Object.keys(registryPatch).length) {
    batch.set(customerDoc.ref, registryPatch, { merge: true });
    writes += 1;
  }

  let activated = 0;
  if (selectedPeriod && clean(selectedPeriod.data.status).toLowerCase() === 'scheduled') {
    batch.set(accountRef.collection('periods').doc(selectedPeriod.id), {
      status: 'active', activatedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    activated += 1;
    writes += 1;
  }
  if (selectedPeriod) {
    const data = selectedPeriod.data;
    const currentAccount = accountSnapshot.data() ?? {};
    const periodStart = asMillis(data.startedAt)!;
    const periodEnd = asMillis(data.expiresAt)!;
    const desiredPlanId = clean(data.planId) || null;
    const desiredPlanName = clean(data.planName) || null;
    const accountNeedsUpdate = !accountSnapshot.exists || currentAccount.active !== true ||
      clean(currentAccount.status).toLowerCase() !== 'active' || clean(currentAccount.accessMode) !== 'paid_subscription' ||
      clean(currentAccount.planId) !== (desiredPlanId ?? '') || clean(currentAccount.planName) !== (desiredPlanName ?? '') ||
      asMillis(currentAccount.startedAt) !== periodStart || asMillis(currentAccount.expiresAt) !== periodEnd ||
      clean(currentAccount.latestApprovedPeriod) !== selectedPeriod.id || clean(currentAccount.featureVisibilityMode) !== featureVisibilityMode ||
      currentAccount.fullAccessGranted !== false;
    if (accountNeedsUpdate) {
      batch.set(accountRef, {
        active: true, status: 'active', accessMode: 'paid_subscription', planId: desiredPlanId, planName: desiredPlanName,
        startedAt: Timestamp.fromMillis(periodStart), expiresAt: Timestamp.fromMillis(periodEnd),
        latestApprovedPeriod: selectedPeriod.id, featureVisibilityMode, fullAccessGranted: false,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      writes += 1;
    }
  }
  if (writes > 0) await batch.commit();
  return { activated, projectionChanged: projectionChanged ? 1 : 0, writes };
}

/**
 * Refresh only subscription projections whose known start/expiry boundary is due. Existing
 * customer registries are seeded once in bounded pages, then no all-customer scan is repeated.
 */
export async function refreshDueSubscriptionProjections(): Promise<{ roots: number; scanned: number; activated: number; projections: number; backfilled: number }> {
  const db = getFirestore();
  const now = Date.now();
  const roots = await db.collection('admins').get();
  let backfilled = 0;
  let backfillBudget = BACKFILL_PAGE_SIZE;
  const allowFullAccessByRoot = new Map<string, boolean>();
  let activated = 0;
  let projections = 0;
  let scanned = 0;
  for (const rootDoc of roots.docs) {
    if (backfillBudget <= 0) break;
    const data = rootDoc.data();
    const adminEmail = clean(data.email || rootDoc.id).toLowerCase();
    if (!adminEmail || !adminEmail.includes('@')) continue;
    const result = await backfillOneCustomerPage(rootDoc.ref, data, backfillBudget);
    backfillBudget -= result.scanned;
    backfilled += result.scanned;
    for (const customer of result.customers) {
      const processed = await processDueCustomer(customer, allowFullAccessByRoot, now);
      scanned += 1;
      activated += processed.activated;
      projections += processed.projectionChanged;
    }
  }

  const due = await db.collectionGroup('customers')
    .where('projectionNextRefreshAt', '<=', Timestamp.fromMillis(now))
    .orderBy('projectionNextRefreshAt', 'asc')
    .limit(DUE_PAGE_SIZE)
    .get();
  for (const customer of due.docs) {
    const result = await processDueCustomer(customer as CustomerSnapshot, allowFullAccessByRoot, now);
    scanned += 1;
    activated += result.activated;
    projections += result.projectionChanged;
  }
  logger.info('Due subscription projection refresh completed', {
    roots: roots.size, scanned, activated, projections, backfilled, moreDue: due.size === DUE_PAGE_SIZE,
  });
  return { roots: roots.size, scanned, activated, projections, backfilled };
}
