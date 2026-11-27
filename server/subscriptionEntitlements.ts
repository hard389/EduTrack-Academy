import { createHash } from 'node:crypto';
import type { DocumentData, DocumentReference, Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirebaseAdminFirestore } from './firebaseAdmin.js';
import { verifyTeacherRequest, type TeacherApiRequest } from './teacherAuth.js';
import { FEATURE_PERMISSION_KEYS, normalizeFeaturePermissions } from './subscriptionFeaturePermissions.mjs';
import { hasAcademyFeaturePermission } from './academyManagementDomain.mjs';
import { featureStateAllowsAccess, isEntitlementProjectionCurrent, resolveEntitlementFromRecords, toDate } from './subscriptionEntitlementDomain.mjs';
import type { SubscriptionFeatureKey, SubscriptionFeaturePermissions } from './subscriptionFeaturePermissions.mjs';

type PlainRecord = Record<string, unknown>;
type ProjectionWriteGuard = { markerRef: DocumentReference<DocumentData>; markerData: DocumentData };
type ResolvedEntitlement = {
  active: boolean; status: string; planId: string | null; planName: string | null;
  billingPeriod: string | null; invoiceId: string | null; startedAt: Date | null; expiresAt: Date | null;
  featurePermissions: SubscriptionFeaturePermissions; source: string; periodId?: string;
  accessMode?: string; featureVisibilityMode?: 'hide' | 'locked'; featureSources?: Record<string, string>;
  addOns?: Array<{ id: string; name: string; featureKeys: string[]; startsAt: Date | null; expiresAt: Date | null }>;
  projectionNextRefreshAt?: Date | null;
};
export class TeacherSubscriptionError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'TeacherSubscriptionError'; }
}
const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const normalizeEmail = (value: unknown) => clean(value).toLowerCase();
const blockedRegistryStatuses = new Set(['deleted', 'disabled', 'inactive', 'suspended', 'revoked']);

async function resolveAdminRoot(db: Firestore, uid: string, email: string): Promise<DocumentReference<DocumentData>> {
  const matches = await db.collectionGroup('customers').where('uid', '==', uid).limit(30).get();
  const candidates = matches.docs.filter((doc) => {
    const registry = doc.data();
    const root = doc.ref.parent.parent;
    return doc.id === uid && root?.parent?.id === 'admins' &&
      normalizeEmail(registry.email) === email && registry.deleted !== true &&
      !blockedRegistryStatuses.has(clean(registry.status).toLowerCase());
  });
  const roots = new Map<string, DocumentReference<DocumentData>>();
  for (const doc of candidates) {
    const root = doc.ref.parent.parent;
    if (root) roots.set(root.path, root);
  }
  if (!roots.size) throw new TeacherSubscriptionError(403, 'Your teacher account is not linked to an active school subscription workspace. Contact the administrator.');
  if (roots.size > 1) throw new TeacherSubscriptionError(409, 'Your account is linked to more than one subscription workspace. Ask the administrator to resolve the mapping.');
  const root = [...roots.values()][0];
  const rootSnapshot = await root.get();
  const rootData = rootSnapshot.data() ?? {};
  if (!rootSnapshot.exists || normalizeEmail(rootData.email ?? root.id) !== normalizeEmail(root.id) || !clean(rootData.adminUid)) {
    throw new TeacherSubscriptionError(409, 'The school subscription workspace could not be verified.');
  }
  return root;
}

export async function resolveTeacherEntitlementForIdentity(
  db: Firestore, uid: string, email: string,
): Promise<{ rootRef: DocumentReference<DocumentData>; accountRef: DocumentReference<DocumentData>; entitlement: ResolvedEntitlement; projectionWriteGuard: ProjectionWriteGuard }> {
  const rootRef = await resolveAdminRoot(db, uid, email);
  const accountRef = rootRef.collection('subscriptionAccounts').doc(uid);
  const registryRef = rootRef.collection('customers').doc(uid);
  const [accountSnap, settingsSnap, registrySnap] = await Promise.all([
    accountRef.get(), rootRef.collection('subscriptionSettings').doc('general').get(), registryRef.get(),
  ]);
  const account = accountSnap.data() ?? (registrySnap.data() ?? {});
  // Canonical account identity is bound to the authenticated teacher UID/email.
  // Older account records may omit either metadata field, but a mismatch is never accepted.
  if ((clean(account.teacherUid) && clean(account.teacherUid) !== uid) ||
      (normalizeEmail(account.teacherEmail) && normalizeEmail(account.teacherEmail) !== normalizeEmail(email))) {
    throw new TeacherSubscriptionError(403, 'The assigned subscription account does not match your authenticated teacher identity.');
  }
  const settings = settingsSnap.data() ?? {};
  const now = new Date();
  const nowMs = now.getTime();
  const accountStatus = clean(account.status).toLowerCase();
  const awaitingApprovedPeriod = account.active === false && ['pending_payment', 'scheduled'].includes(accountStatus);
  const accountBlocked = (account.active === false && !awaitingApprovedPeriod) || account.deleted === true || account.disabled === true ||
    ['suspended', 'disabled', 'deleted', 'inactive', 'pending', 'cancelled', 'canceled', 'revoked', 'rejected', 'archived'].includes(accountStatus);
  const accessMode = clean(account.accessMode).toLowerCase();
  const unassignedFullAccess = !accountBlocked && accessMode === 'unassigned_full_access' && account.fullAccessGranted === true && settings.allowUnassignedFullAccess !== false;
  const postpaidSnapshot = account.postpaidPlanSnapshot && typeof account.postpaidPlanSnapshot === 'object' && !Array.isArray(account.postpaidPlanSnapshot)
    ? account.postpaidPlanSnapshot as Record<string, unknown> : null;
  const postpaidStart = toDate(account.postpaidUsageStartedAt ?? account.startedAt);
  const postpaidEnd = toDate(account.postpaidUsageExpiresAt ?? account.expiresAt);
  const postpaidPlanId = clean(account.postpaidPlanId ?? postpaidSnapshot?.id);
  const postpaidAllowed = !accountBlocked && accessMode === 'postpaid_monthly' && account.active === true && accountStatus === 'active' &&
    Boolean(postpaidSnapshot) && Boolean(postpaidPlanId) && clean(postpaidSnapshot?.id) === postpaidPlanId &&
    Boolean(postpaidStart && postpaidEnd && postpaidStart.getTime() <= nowMs && postpaidEnd.getTime() > nowMs && postpaidEnd.getTime() > postpaidStart.getTime());
  const legacyStart = toDate(account.startedAt);
  const legacyEnd = toDate(account.expiresAt);
  const legacyAllowed = accessMode !== 'postpaid_monthly' && !accountBlocked && account.active === true && legacyStart && legacyEnd &&
    legacyStart.getTime() <= nowMs && legacyEnd.getTime() > nowMs && legacyEnd.getTime() > legacyStart.getTime();

  let periods: Array<{ id: string; data: DocumentData }> = [];
  let eligiblePeriods: Array<{ id: string; data: DocumentData; startedAt: Date }> = [];
  if (!unassignedFullAccess && accessMode !== 'postpaid_monthly') {
    if (accountBlocked) {
      // A blocked account cannot gain access from period history. Only the latest row is
      // needed to preserve the existing status/plan summary returned by the domain resolver.
      const latestPeriod = await accountRef.collection('periods').orderBy('startedAt', 'desc').limit(1).get();
      periods = latestPeriod.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
    } else {
      // Current active/scheduled periods are the only documents that can grant access.
      // Historical rejected/expired periods are fetched only when the resolver needs their
      // fallback status (and not when a current legacy account window already decides access).
      const currentPeriods = await accountRef.collection('periods')
        .where('status', 'in', ['active', 'scheduled', 'ACTIVE', 'SCHEDULED']).get();
      periods = currentPeriods.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
      eligiblePeriods = periods.map(({ id, data }) => ({ id, data, startedAt: toDate(data.startedAt) }))
        .filter((period): period is { id: string; data: DocumentData; startedAt: Date } => {
          const start = period.startedAt;
          const end = toDate(period.data.expiresAt);
          const status = clean(period.data.status).toLowerCase();
          return period.data.approved !== false && period.data.paymentApproved !== false &&
            (status === 'active' || status === 'scheduled') && Boolean(start && end) &&
            end!.getTime() > start!.getTime() && start!.getTime() <= nowMs && end!.getTime() > nowMs;
        })
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      const hasFutureApprovedPeriod = periods.some(({ data }) => {
        const start = toDate(data.startedAt);
        const end = toDate(data.expiresAt);
        const status = clean(data.status).toLowerCase();
        return data.approved !== false && data.paymentApproved !== false && status === 'scheduled' &&
          Boolean(start && end && start.getTime() > nowMs && end.getTime() > start.getTime());
      });
      if (eligiblePeriods.length === 0 && !legacyAllowed && !hasFutureApprovedPeriod) {
        // The fallback resolver only consumes the most recent period for display/status.
        // Do not download the complete expired/rejected history on routine entitlement checks.
        const latestPeriod = await accountRef.collection('periods').orderBy('startedAt', 'desc').limit(1).get();
        periods = latestPeriod.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
      }
    }
  }
  const eligiblePeriod = eligiblePeriods[0];
  const latestPeriod = periods
    .filter(({ data }) => toDate(data.startedAt) && toDate(data.expiresAt))
    .sort((a, b) => (toDate(b.data.startedAt)?.getTime() ?? 0) - (toDate(a.data.startedAt)?.getTime() ?? 0))[0];
  // The resolver only consults a plan for the selected active period or the legacy/latest
  // fallback. Fetch those exact plan documents instead of scanning the entire plan catalog
  // for every teacher API request.
  const selectedPlanId = eligiblePeriod
    ? clean(eligiblePeriod.data.planId)
    : legacyAllowed
      ? clean(account.planId)
      : clean(latestPeriod?.data.planId) || clean(account.planId);
  const planIds = unassignedFullAccess || accessMode === 'postpaid_monthly' || !selectedPlanId ? [] : [selectedPlanId];
  const planSnapshots = await Promise.all(planIds.map((planId) => rootRef.collection('subscriptionPlans').doc(planId).get()));
  const plans = planSnapshots.filter((snapshot) => snapshot.exists).map((snapshot) => ({ id: snapshot.id, data: snapshot.data() ?? {} }));
  const hasFutureApprovedPeriod = periods.some(({ data }) => {
    const start = toDate(data.startedAt);
    const end = toDate(data.expiresAt);
    return data.approved !== false && data.paymentApproved !== false && clean(data.status).toLowerCase() === 'scheduled' &&
      Boolean(start && end && start.getTime() > nowMs && end.getTime() > start.getTime());
  });
  const needsAddOns = postpaidAllowed || eligiblePeriod !== undefined || Boolean(legacyAllowed) || hasFutureApprovedPeriod;
  const addOnSnapshots = needsAddOns
    ? await accountRef.collection('addOns').where('status', 'in', ['active', 'scheduled', 'ACTIVE', 'SCHEDULED']).get()
    : null;
  const addOns = (addOnSnapshots?.docs ?? []).map((doc) => ({ id: doc.id, data: doc.data() }));
  const resolved = resolveEntitlementFromRecords({
    account, periods, plans, addOns, registrationPolicy: { allowUnassignedFullAccess: settings.allowUnassignedFullAccess !== false }, now,
  }) as ResolvedEntitlement;
  const futureBoundaries: number[] = [];
  const addFutureBoundary = (value: unknown) => {
    const date = toDate(value);
    if (date && date.getTime() > nowMs) futureBoundaries.push(date.getTime());
  };
  if (!accountBlocked && accessMode !== 'unassigned_full_access') {
    if (accessMode === 'postpaid_monthly') {
      addFutureBoundary(account.postpaidUsageStartedAt ?? account.startedAt);
      addFutureBoundary(account.postpaidUsageExpiresAt ?? account.expiresAt);
    } else if (legacyAllowed || account.active === true) {
      addFutureBoundary(account.startedAt);
      addFutureBoundary(account.expiresAt);
    }
    for (const { data } of periods) {
      const status = clean(data.status).toLowerCase();
      if (data.approved === false || data.paymentApproved === false || !['active', 'scheduled'].includes(status)) continue;
      const periodStart = toDate(data.startedAt);
      const periodEnd = toDate(data.expiresAt);
      // Keep a started-but-still-scheduled period due until the minute scheduler promotes
      // its status/account snapshot. The entitlement resolver can grant access at the same
      // boundary, but it must not consume the scheduler's separate activation work item.
      if (status === 'scheduled' && periodStart && periodEnd && periodStart.getTime() <= nowMs && periodEnd.getTime() > nowMs) {
        futureBoundaries.push(periodStart.getTime());
      } else {
        addFutureBoundary(data.startedAt);
      }
      addFutureBoundary(data.expiresAt);
    }
    for (const { data } of addOns) {
      if (data.approved !== true || !['active', 'scheduled'].includes(clean(data.status).toLowerCase())) continue;
      addFutureBoundary(data.startsAt ?? data.startedAt);
      addFutureBoundary(data.expiresAt);
    }
  }
  const projectionNextRefreshAt = futureBoundaries.length ? new Date(Math.min(...futureBoundaries)) : null;
  return {
    rootRef,
    accountRef,
    entitlement: { ...resolved, featurePermissions: normalizeFeaturePermissions(resolved.featurePermissions, false), projectionNextRefreshAt },
    projectionWriteGuard: {
      markerRef: registrySnap.exists ? registryRef : accountRef,
      markerData: (registrySnap.data() ?? accountSnap.data() ?? {}) as DocumentData,
    },
  };
}

function stableFingerprintValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableFingerprintValue);
  if (value && typeof value === 'object') {
    const candidate = value as { toDate?: () => Date; toMillis?: () => number };
    if (typeof candidate.toDate === 'function') {
      try { return candidate.toDate().toISOString(); } catch { return null; }
    }
    if (typeof candidate.toMillis === 'function') {
      try { return candidate.toMillis(); } catch { return null; }
    }
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [
      key, stableFingerprintValue((value as Record<string, unknown>)[key]),
    ]));
  }
  return value;
}

export async function syncTeacherEntitlementProjection(
  db: Firestore, uid: string, email: string, entitlement: ResolvedEntitlement,
  writeGuard?: ProjectionWriteGuard,
): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new TeacherSubscriptionError(403, 'Teacher email is invalid.');
  const projection = {
    uid,
    email: normalizedEmail,
    active: entitlement.active === true,
    status: entitlement.status,
    planId: entitlement.planId,
    planName: entitlement.planName,
    billingPeriod: entitlement.billingPeriod,
    startedAt: entitlement.startedAt ?? null,
    expiresAt: entitlement.expiresAt ?? null,
    featurePermissions: normalizeFeaturePermissions(entitlement.featurePermissions, false),
    accessMode: entitlement.accessMode ?? 'paid_subscription',
    fullAccessGranted: entitlement.accessMode === 'unassigned_full_access',
    featureVisibilityMode: entitlement.featureVisibilityMode ?? 'hide',
    featureSources: entitlement.featureSources ?? {},
    addOns: entitlement.addOns ?? [],
    source: entitlement.source,
    projectionVersion: 1,
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(stableFingerprintValue(projection)))
    .digest('hex');
  const nextRefresh = entitlement.projectionNextRefreshAt ?? null;
  const storedNextRefresh = toDate(writeGuard?.markerData.projectionNextRefreshAt)?.getTime() ?? null;
  const desiredNextRefresh = nextRefresh?.getTime() ?? null;
  const scheduleChanged = storedNextRefresh !== desiredNextRefresh;
  const projectionChanged = writeGuard?.markerData.serverProjectionFingerprint !== fingerprint;
  // The registry fingerprint alone is not proof that the derived user projection exists.
  // Older deployments could persist the fingerprint before/without the projection document,
  // causing this no-op guard to leave Firestore Rules permanently unable to authorize the
  // teacher. A one-time readiness marker repairs those legacy rows without adding a projection
  // read to every authenticated request.
  const projectionReady = writeGuard?.markerData.serverProjectionReady === true;
  const shouldWriteProjection = projectionChanged || !projectionReady;
  if (writeGuard && !shouldWriteProjection && !scheduleChanged) return;

  const projectionRef = db.collection('users').doc(normalizedEmail).collection('subscriptionEntitlements').doc('current');
  if (writeGuard) {
    // Reuse the account/registry read already performed by the resolver. Write the derived
    // projection when its effective values changed or when the one-time readiness marker is
    // absent; after that, unchanged checks remain read-free at the projection document level.
    const batch = db.batch();
    if (shouldWriteProjection) {
      batch.set(projectionRef, { ...projection, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    batch.set(writeGuard.markerRef, {
      ...(shouldWriteProjection ? {
        serverProjectionFingerprint: fingerprint,
        serverProjectionReady: true,
      } : {}),
      projectionNextRefreshAt: nextRefresh ? nextRefresh : FieldValue.delete(),
    }, { merge: true });
    await batch.commit();
    return;
  }
  await projectionRef.set({ ...projection, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

type AcademyPermissionActor = { db: Firestore; uid: string; email: string; tenantData?: DocumentData };

async function resolveAcademyPermissionEntitlement(db: Firestore, uid: string, email: string) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new TeacherSubscriptionError(403, 'Teacher email is invalid.');
  const userRef = db.collection('users').doc(normalizedEmail);
  const membershipMapRef = db.collection('academyMemberships').doc(uid);
  const [userSnap, mappingSnap] = await Promise.all([userRef.get(), membershipMapRef.get()]);
  const user = userSnap.data() ?? {};
  const mapping = mappingSnap.data() ?? {};
  const academyId = clean(mapping.academyId ?? user.academyId);
  if (!userSnap.exists || !mappingSnap.exists || !/^\d{3,15}$/.test(academyId) || Number(academyId) < 100) {
    throw new TeacherSubscriptionError(403, 'Your active Academy membership could not be verified.');
  }
  const rootRef = db.collection('academies').doc(academyId);
  const accountRef = rootRef.collection('members').doc(uid);
  const [academySnap, memberSnap] = await Promise.all([rootRef.get(), accountRef.get()]);
  const academy = academySnap.data() ?? {};
  const member = memberSnap.data() ?? {};
  if (
    user.uid !== uid || normalizeEmail(user.email) !== normalizedEmail || user.role !== 'teacher' || user.active !== true ||
    mapping.academyId !== academyId || (mapping.uid !== undefined && mapping.uid !== uid) || mapping.role !== 'teacher' || mapping.active !== true ||
    normalizeEmail(mapping.email) !== normalizedEmail || !academySnap.exists || academy.status !== 'active' ||
    !memberSnap.exists || member.uid !== uid || member.academyId !== academyId || member.role !== 'teacher' ||
    member.active !== true || member.emailVerified !== true || normalizeEmail(member.email) !== normalizedEmail
  ) {
    throw new TeacherSubscriptionError(403, 'Your Academy teacher membership is inactive or invalid.');
  }
  const permissions = member.permissions && typeof member.permissions === 'object' ? member.permissions as Record<string, unknown> : {};
  const featurePermissions = normalizeFeaturePermissions(Object.fromEntries(
    FEATURE_PERMISSION_KEYS.map((key) => [key, hasAcademyFeaturePermission(permissions, key) ? 'enabled' : 'disabled']),
  ), false);
  const entitlement: ResolvedEntitlement = {
    active: true,
    status: 'active',
    planId: null,
    planName: 'Academy Admin permissions',
    billingPeriod: null,
    invoiceId: null,
    startedAt: null,
    expiresAt: null,
    featurePermissions,
    source: 'academy_membership_permissions',
    accessMode: 'academy_permissions',
    featureVisibilityMode: 'hide',
    featureSources: Object.fromEntries(FEATURE_PERMISSION_KEYS.map((key) => [key, hasAcademyFeaturePermission(permissions, key) ? 'academy_admin_permission' : 'denied'])),
    addOns: [],
    projectionNextRefreshAt: null,
  };
  return { rootRef, accountRef, entitlement, projectionWriteGuard: undefined, academyId, member };
}

/**
 * Compatibility API: older teacher handlers still consume an entitlement-shaped object.
 * Its values now derive exclusively from verified Academy membership permissions. No
 * subscription account/plan/add-on documents are read or written for teacher access.
 */
export async function getTeacherEntitlement(request: TeacherApiRequest) {
  const actor = await verifyTeacherRequest(request);
  const resolved = await resolveAcademyPermissionEntitlement(actor.db, actor.uid, actor.email);
  return { actor, ...resolved };
}

export async function assertTeacherActorFeatureEntitlement(
  actor: AcademyPermissionActor, featureKey: SubscriptionFeatureKey,
) {
  const resolved = await resolveAcademyPermissionEntitlement(actor.db, actor.uid, actor.email);
  if (!featureStateAllowsAccess(resolved.entitlement.featurePermissions, featureKey)) {
    throw new TeacherSubscriptionError(403, 'Your Academy Admin has not granted permission for this feature.');
  }
  return resolved;
}

export async function assertTeacherFeatureEntitlement(request: TeacherApiRequest, featureKey: SubscriptionFeatureKey) {
  const actor = await verifyTeacherRequest(request);
  const resolved = await assertTeacherActorFeatureEntitlement(actor, featureKey);
  return { actor, ...resolved };
}

/** Platform/SaaS subscription updates intentionally cannot alter Academy teacher access. */
export async function refreshTeacherEntitlementProjection(db: Firestore, uid: string, email: string) {
  // Platform billing changes are intentionally decoupled from Academy teacher permissions.
  // A legacy platform customer without an Academy membership is a normal no-op here.
  try {
    const resolved = await resolveAcademyPermissionEntitlement(db, uid, email);
    return resolved.entitlement;
  } catch {
    return null;
  }
}

export async function readProjectedFeatureEntitlement(db: Firestore, email: string, featureKey: SubscriptionFeatureKey): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;
  const userSnap = await db.collection('users').doc(normalizedEmail).get();
  const user = userSnap.data() ?? {};
  if (!userSnap.exists || user.role !== 'teacher' || user.active !== true || user.deleted === true || user.disabled === true || typeof user.uid !== 'string') return false;
  try {
    const resolved = await resolveAcademyPermissionEntitlement(db, user.uid, normalizedEmail);
    return featureStateAllowsAccess(resolved.entitlement.featurePermissions, featureKey);
  } catch {
    return false;
  }
}

export function canUseConfigurableEntitlement(entitlement: ResolvedEntitlement, featureKey: SubscriptionFeatureKey, enabled: boolean) {
  const permissions = normalizeFeaturePermissions(entitlement.featurePermissions, false);
  return entitlement.active && (permissions[featureKey] === 'enabled' || (permissions[featureKey] === 'configurable' && enabled));
}

export function entitlementIso(value: unknown): string | null {
  return toDate(value)?.toISOString() ?? null;
}

export function isPlainRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
