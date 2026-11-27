import { FEATURE_PERMISSION_KEYS, normalizeFeaturePermissions } from './subscriptionFeaturePermissions.mjs';

const clean = (value) => typeof value === 'string' ? value.trim() : '';
const blockedStatuses = new Set(['suspended', 'disabled', 'deleted', 'inactive', 'pending', 'cancelled', 'canceled', 'revoked', 'rejected', 'archived']);

export function toDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (value && typeof value === 'object' && typeof value.toDate === 'function') {
    try {
      const result = value.toDate();
      return result instanceof Date && Number.isFinite(result.getTime()) ? result : null;
    } catch { return null; }
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const result = new Date(value);
    return Number.isFinite(result.getTime()) ? result : null;
  }
  return null;
}

export function resolveEntitlementFromRecords({ account = {}, periods = [], plans = [], addOns = [], registrationPolicy = {}, now = new Date() } = {}) {
  const nowDate = toDate(now) ?? new Date();
  const nowMs = nowDate.getTime();
  const accountStatus = clean(account.status).toLowerCase();
  const awaitingApprovedPeriod = account.active === false && ['pending_payment', 'scheduled'].includes(accountStatus);
  const accountBlocked = (account.active === false && !awaitingApprovedPeriod) || account.deleted === true || account.disabled === true || blockedStatuses.has(accountStatus);
  const accessMode = clean(account.accessMode).toLowerCase();
  const accountVisibility = clean(account.featureVisibilityModeOverride ?? account.featureVisibilityMode).toLowerCase();
  const featureVisibilityMode = accountVisibility === 'locked' ? 'locked' : 'hide';
  const planMap = new Map(plans.map((plan) => [clean(plan.id), plan.data ?? {}]));

  // Full teacher access is an explicit, separately recorded business-rule exception. It is
  // never inferred from a missing plan/account and is disabled when the trusted global policy
  // has been turned off. It grants no administrator role or admin API authority.
  if (!accountBlocked && accessMode === 'unassigned_full_access' &&
      account.fullAccessGranted === true && registrationPolicy.allowUnassignedFullAccess === true) {
    const featurePermissions = Object.fromEntries(FEATURE_PERMISSION_KEYS.map((key) => [key, 'enabled']));
    return {
      active: true, status: 'active', planId: null, planName: null, billingPeriod: null, invoiceId: null,
      startedAt: null, expiresAt: null, featurePermissions, accessMode, featureVisibilityMode,
      featureSources: Object.fromEntries(FEATURE_PERMISSION_KEYS.map((key) => [key, 'unassigned_full_access'])),
      addOns: [], source: 'unassigned_full_access',
    };
  }

  const activeAddOns = addOns.map((item) => ({ id: clean(item.id), data: item.data ?? {} }))
    .filter(({ id, data }) => {
      const status = clean(data.status).toLowerCase();
      const startsAt = toDate(data.startsAt ?? data.startedAt);
      const expiresAt = toDate(data.expiresAt);
      return Boolean(id && data.approved === true && status === 'active' && startsAt && expiresAt &&
        startsAt.getTime() <= nowMs && expiresAt.getTime() > nowMs);
    });

  const applyAddOns = (basePermissions) => {
    const permissions = normalizeFeaturePermissions(basePermissions, false);
    const sources = Object.fromEntries(FEATURE_PERMISSION_KEYS.map((key) => [key, 'plan']));
    const grants = [];
    for (const addon of activeAddOns) {
      const keys = Array.isArray(addon.data.featureKeys) ? addon.data.featureKeys : [];
      const granted = [];
      for (const key of keys) {
        if (FEATURE_PERMISSION_KEYS.includes(key)) {
          permissions[key] = 'enabled';
          sources[key] = `add_on:${addon.id}`;
          granted.push(key);
        }
      }
      grants.push({ id: addon.id, name: clean(addon.data.name) || 'Feature add-on', featureKeys: granted,
        startsAt: toDate(addon.data.startsAt ?? addon.data.startedAt), expiresAt: toDate(addon.data.expiresAt) });
    }
    return { featurePermissions: permissions, featureSources: sources, addOns: grants };
  };

  // Self-registered postpaid teachers receive one explicit, server-created monthly usage window.
  // This grants only the saved plan snapshot, never unassigned/full access, and expires closed.
  const postpaidSnapshot = account.postpaidPlanSnapshot && typeof account.postpaidPlanSnapshot === 'object' && !Array.isArray(account.postpaidPlanSnapshot)
    ? account.postpaidPlanSnapshot : null;
  const postpaidStart = toDate(account.postpaidUsageStartedAt ?? account.startedAt);
  const postpaidEnd = toDate(account.postpaidUsageExpiresAt ?? account.expiresAt);
  const postpaidPlanId = clean(account.postpaidPlanId ?? postpaidSnapshot?.id);
  const postpaidAllowed = !accountBlocked && accessMode === 'postpaid_monthly' && account.active === true &&
    accountStatus === 'active' && Boolean(postpaidSnapshot) && Boolean(postpaidPlanId) &&
    clean(postpaidSnapshot?.id) === postpaidPlanId && postpaidStart && postpaidEnd &&
    postpaidStart.getTime() <= nowMs && postpaidEnd.getTime() > nowMs && postpaidEnd.getTime() > postpaidStart.getTime();
  if (postpaidAllowed) {
    const grants = applyAddOns(postpaidSnapshot.featurePermissions);
    return {
      active: true,
      status: 'active',
      planId: postpaidPlanId,
      planName: clean(account.postpaidPlanName ?? postpaidSnapshot.name) || null,
      billingPeriod: clean(account.postpaidUsageBillingPeriod) || null,
      invoiceId: clean(account.postpaidInvoiceId) || null,
      startedAt: postpaidStart,
      expiresAt: postpaidEnd,
      ...grants,
      accessMode: 'postpaid_monthly',
      featureVisibilityMode: accountVisibility === 'locked'
        ? 'locked'
        : clean(postpaidSnapshot.featureVisibilityMode) === 'locked' ? 'locked' : 'hide',
      source: 'postpaid_monthly_usage',
    };
  }
  if (accessMode === 'postpaid_monthly') {
    // A postpaid account cannot fall through to a stale historical paid period or legacy dates.
    const expired = Boolean(postpaidEnd && postpaidEnd.getTime() <= nowMs);
    return {
      active: false,
      status: accountBlocked ? (accountStatus || 'suspended') : expired ? 'expired' : 'inactive',
      planId: postpaidPlanId || null,
      planName: clean(account.postpaidPlanName ?? postpaidSnapshot?.name) || null,
      billingPeriod: clean(account.postpaidUsageBillingPeriod) || null,
      invoiceId: clean(account.postpaidInvoiceId) || null,
      startedAt: postpaidStart,
      expiresAt: postpaidEnd,
      featurePermissions: normalizeFeaturePermissions({}, false),
      featureSources: {},
      addOns: [],
      accessMode,
      featureVisibilityMode,
      source: 'postpaid_monthly_expired',
    };
  }

  const eligiblePeriods = periods.map((period) => {
    const data = period.data ?? {};
    const startedAt = toDate(data.startedAt);
    const expiresAt = toDate(data.expiresAt);
    if (!startedAt || !expiresAt || expiresAt.getTime() <= startedAt.getTime()) return null;
    const status = clean(data.status).toLowerCase();
    // A period is authoritative only after an explicit approval workflow has marked
    // it active. Date overlap alone must never turn a pending/scheduled record active.
    if (data.approved === false || data.paymentApproved === false) return null;
    if (startedAt.getTime() > nowMs || expiresAt.getTime() <= nowMs) return null;
    // A future approved period is stored as scheduled by payment review. It becomes eligible
    // automatically at its start boundary; the scheduler also refreshes the Firestore projection.
    if (status !== 'active' && status !== 'scheduled') return null;
    const planId = clean(data.planId);
    const planPermissions = planMap.get(planId)?.featurePermissions;
    const snapshot = data.featurePermissions && typeof data.featurePermissions === 'object' && !Array.isArray(data.featurePermissions)
      ? data.featurePermissions : {};
    // If an approved period contains an entitlement snapshot, it is authoritative as-is.
    // Newly added catalog permissions must not silently flow into an older paid period.
    const permissionSource = Object.keys(snapshot).length > 0 ? snapshot : planPermissions;
    return {
      periodId: clean(period.id),
      billingPeriod: clean(data.billingPeriod) || clean(period.id),
      invoiceId: clean(data.invoiceId) || null,
      planId: planId || null,
      planName: clean(data.planName) || clean(planMap.get(planId)?.name) || null,
      startedAt,
      expiresAt,
      featurePermissions: normalizeFeaturePermissions(permissionSource, false),
      featureVisibilityMode: clean(data.featureVisibilityMode).toLowerCase() === 'locked' ? 'locked' : 'hide',
      source: 'approved_period',
    };
  }).filter(Boolean).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  if (!accountBlocked && eligiblePeriods.length) {
    const active = eligiblePeriods[0];
    const grants = applyAddOns(active.featurePermissions);
    return {
      active: true, status: 'active', ...active, ...grants, accessMode: 'paid_subscription',
      featureVisibilityMode: accountVisibility === 'locked' ? 'locked' : active.featureVisibilityMode, source: 'approved_period_snapshot',
    };
  }

  // Legacy compatibility is intentionally strict: both dates must exist and bound
  // the current instant. Missing expiry must never imply indefinite access.
  const legacyStart = toDate(account.startedAt);
  const legacyEnd = toDate(account.expiresAt);
  const legacyAllowed = !accountBlocked && account.active === true && legacyStart && legacyEnd &&
    legacyStart.getTime() <= nowMs && legacyEnd.getTime() > nowMs && legacyEnd.getTime() > legacyStart.getTime();
  if (legacyAllowed) {
    const planId = clean(account.planId);
    const planPermissions = planMap.get(planId)?.featurePermissions;
    const grants = applyAddOns(account.featurePermissions ?? planPermissions);
    return {
      active: true,
      status: 'active',
      planId: planId || null,
      planName: clean(account.planName) || clean(planMap.get(planId)?.name) || null,
      billingPeriod: clean(account.latestInvoicePeriod) || null,
      invoiceId: clean(account.latestInvoiceId) || null,
      startedAt: legacyStart,
      expiresAt: legacyEnd,
      ...grants,
      accessMode: accessMode || 'paid_subscription',
      featureVisibilityMode,
      source: 'legacy_account_dates',
    };
  }

  const latestPeriod = periods.map((period) => {
    const data = period.data ?? {};
    return { id: period.id, data, startedAt: toDate(data.startedAt), expiresAt: toDate(data.expiresAt) };
  }).filter((period) => period.startedAt && period.expiresAt)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  const status = accountBlocked ? (accountStatus || 'suspended') :
    latestPeriod?.expiresAt && latestPeriod.expiresAt.getTime() <= nowMs ? 'expired' :
      latestPeriod?.startedAt && latestPeriod.startedAt.getTime() > nowMs ? 'scheduled' :
        (accountStatus && accountStatus !== 'active' ? accountStatus : 'inactive');
  const fallbackData = latestPeriod?.data ?? account;
  const fallbackPlanId = clean(fallbackData.planId || account.planId);
  return {
    active: false,
    status,
    planId: fallbackPlanId || null,
    planName: clean(fallbackData.planName || account.planName) || clean(planMap.get(fallbackPlanId)?.name) || null,
    billingPeriod: clean(fallbackData.billingPeriod || account.latestInvoicePeriod) || null,
    invoiceId: clean(fallbackData.invoiceId || account.latestInvoiceId) || null,
    startedAt: toDate(fallbackData.startedAt),
    expiresAt: toDate(fallbackData.expiresAt),
    featurePermissions: normalizeFeaturePermissions(fallbackData.featurePermissions ?? account.featurePermissions, false),
    featureSources: {},
    addOns: [],
    accessMode: accessMode || 'paid_subscription',
    featureVisibilityMode,
    source: 'inactive',
  };
}

export function featureStateAllowsAccess(permissions, featureKey) {
  if (!FEATURE_PERMISSION_KEYS.includes(featureKey)) return false;
  const normalized = normalizeFeaturePermissions(permissions, false);
  return normalized[featureKey] !== 'disabled';
}

export function isEntitlementProjectionCurrent(projection, now = new Date()) {
  if (!projection || projection.active !== true || clean(projection.status).toLowerCase() !== 'active') return false;
  if (projection.disabled === true || projection.deleted === true) return false;
  if (clean(projection.accessMode) === 'unassigned_full_access') return projection.fullAccessGranted === true; 
  const start = toDate(projection.startedAt);
  const end = toDate(projection.expiresAt);
  const current = toDate(now) ?? new Date();
  return Boolean(start && end && start.getTime() <= current.getTime() && end.getTime() > current.getTime());
}
