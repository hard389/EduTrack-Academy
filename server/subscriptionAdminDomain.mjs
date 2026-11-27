const clean = (value) => typeof value === 'string' ? value.trim() : '';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const FEATURE_KEYS = new Set([
  'student_management', 'class_management', 'attendance_management', 'attendance_alerts',
  'monthly_reports', 'fortnightly_reports', 'weekly_reports', 'attendance_analytics',
  'advanced_analytics', 'fee_tracking', 'fee_alerts', 'custom_alerts', 'quiz_management',
  'quiz_result_notifications', 'notes_library', 'announcements',
]);

function validDateKey(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parsePakistanStartDate(value, label = 'Start date') {
  if (!validDateKey(value)) throw new Error(`${label} must be a valid calendar date.`);
  return new Date(`${value}T00:00:00.000+05:00`);
}

export function parsePakistanEndDate(value, label = 'End date') {
  if (!validDateKey(value)) throw new Error(`${label} must be a valid calendar date.`);
  return new Date(`${value}T23:59:59.999+05:00`);
}

export function validateAdminSubscriptionCommand(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A valid subscription management request is required.');
  const operation = clean(input.operation);
  const allowed = new Set(['assign', 'change', 'extend', 'suspend', 'reactivate', 'cancel']);
  if (!allowed.has(operation)) throw new Error('Choose a valid customer subscription operation.');
  const reason = clean(input.reason);
  if (reason.length < 10 || reason.length > 500) throw new Error('An administrator reason of 10 to 500 characters is required.');
  if (input.adminConfirmed !== true) throw new Error('Confirm that you understand this administrator override before continuing.');
  const now = options.now instanceof Date ? options.now : new Date();

  if (operation === 'assign' || operation === 'change') {
    const planId = clean(input.planId);
    if (!ID_RE.test(planId)) throw new Error('Choose a valid active subscription plan.');
    const startsAt = parsePakistanStartDate(input.startsAt, 'Access start date');
    const expiresAt = parsePakistanEndDate(input.expiresAt, 'Access end date');
    if (expiresAt.getTime() <= startsAt.getTime()) throw new Error('Access end date must be after the start date.');
    if (startsAt.getTime() < now.getTime() - 86400000) throw new Error('The manual access start date cannot be more than one day in the past.');
    return { operation, planId, startsAt, expiresAt, reason };
  }

  if (operation === 'extend') {
    const expiresAt = parsePakistanEndDate(input.expiresAt, 'New access end date');
    if (expiresAt.getTime() <= now.getTime()) throw new Error('The new access end date must be in the future.');
    return { operation, expiresAt, reason };
  }

  return { operation, reason };
}


export function selectReactivationPeriod(periods, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  if (!Number.isFinite(nowMs) || !Array.isArray(periods)) return null;
  const eligible = periods.filter((item) => {
    const data = item?.data ?? {};
    const startsAt = item?.startsAt instanceof Date ? item.startsAt : new Date(item?.startsAt);
    const expiresAt = item?.expiresAt instanceof Date ? item.expiresAt : new Date(item?.expiresAt);
    return data.approved !== false && data.paymentApproved !== false &&
      ['active', 'scheduled'].includes(clean(data.status)) &&
      Number.isFinite(startsAt.getTime()) && Number.isFinite(expiresAt.getTime()) &&
      expiresAt.getTime() > nowMs && expiresAt.getTime() > startsAt.getTime();
  });
  eligible.sort((a, b) => {
    const aStart = a.startsAt instanceof Date ? a.startsAt.getTime() : new Date(a.startsAt).getTime();
    const bStart = b.startsAt instanceof Date ? b.startsAt.getTime() : new Date(b.startsAt).getTime();
    const aCurrent = aStart <= nowMs;
    const bCurrent = bStart <= nowMs;
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    return aCurrent ? bStart - aStart : aStart - bStart;
  });
  return eligible[0] ?? null;
}

export function normalizeOfferMutation(input, existing = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A valid offer update is required.');
  const merged = { ...existing, ...input };
  const patch = {};
  if (input.name !== undefined) {
    const name = clean(input.name);
    if (!name || name.length > 100) throw new Error('Offer name must contain 1 to 100 characters.');
    patch.name = name;
  }
  if (input.description !== undefined) {
    const description = clean(input.description);
    if (description.length > 600) throw new Error('Offer description is too long.');
    patch.description = description;
  }
  if (input.discountType !== undefined || input.discountValue !== undefined) {
    const discountType = clean(merged.discountType);
    const discountValue = Number(merged.discountValue);
    if (discountType !== 'percentage' && discountType !== 'fixed') throw new Error('Offer discount type must be percentage or fixed.');
    if (!Number.isSafeInteger(discountValue) || discountValue < 1 || discountValue > 1000000000 || (discountType === 'percentage' && discountValue > 100)) {
      throw new Error('Offer discount value is invalid.');
    }
    if (input.discountType !== undefined) patch.discountType = discountType;
    if (input.discountValue !== undefined) patch.discountValue = discountValue;
  }
  if (input.validFrom !== undefined || input.validUntil !== undefined) {
    const validFrom = clean(merged.validFrom);
    const validUntil = clean(merged.validUntil);
    if (!validDateKey(validFrom) || !validDateKey(validUntil) || validUntil < validFrom) {
      throw new Error('Offer dates must be valid and the end date cannot precede the start date.');
    }
    if (input.validFrom !== undefined) patch.validFrom = validFrom;
    if (input.validUntil !== undefined) patch.validUntil = validUntil;
  }
  if (input.planIds !== undefined) {
    if (!Array.isArray(input.planIds) || input.planIds.length > 50) throw new Error('Invalid offer plan selection.');
    const planIds = [...new Set(input.planIds.map((id) => clean(id)))];
    if (planIds.some((id) => !ID_RE.test(id))) throw new Error('Offer plan selection contains an invalid plan ID.');
    patch.planIds = planIds;
  }
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') throw new Error('Offer active must be true or false.');
    patch.active = input.active;
  }
  if (!Object.keys(patch).length) throw new Error('No offer changes were supplied.');
  return patch;
}

export function buildAddOnInvoiceSnapshots(selectedIds, catalogItems) {
  if (selectedIds === undefined) return { snapshots: [], totalPaisa: 0, lineItems: [] };
  if (!Array.isArray(selectedIds) || selectedIds.length > 20) throw new Error('Choose up to 20 add-ons per invoice.');
  const ids = [...new Set(selectedIds.map((id) => clean(id)))];
  if (ids.some((id) => !ID_RE.test(id))) throw new Error('The add-on selection contains an invalid ID.');
  const byId = new Map(catalogItems.map((item) => [clean(item.id), item]));
  const seenFeatureKeys = new Set();
  const snapshots = ids.map((id) => {
    const item = byId.get(id);
    if (!item || item.active !== true || item.deleted === true) throw new Error('One selected add-on is no longer active. Refresh the add-on catalog.');
    const featureKey = clean(item.featureKey);
    if (!FEATURE_KEYS.has(featureKey)) throw new Error('A selected add-on contains an unsupported feature key.');
    if (seenFeatureKeys.has(featureKey)) throw new Error('Only one paid add-on per ERP feature can be included in an invoice.');
    seenFeatureKeys.add(featureKey);
    const monthlyPricePaisa = Number(item.monthlyPricePaisa);
    if (!Number.isSafeInteger(monthlyPricePaisa) || monthlyPricePaisa < 1 || monthlyPricePaisa > 1000000000) {
      throw new Error(`The monthly price for ${clean(item.name) || 'an add-on'} is invalid.`);
    }
    const name = clean(item.name);
    if (!name || name.length > 100) throw new Error('An add-on name is invalid.');
    return {
      catalogId: id,
      name,
      description: clean(item.description),
      featureKey,
      monthlyPricePaisa,
      billingPeriod: 'monthly',
    };
  });
  const totalPaisa = snapshots.reduce((sum, item) => sum + item.monthlyPricePaisa, 0);
  if (!Number.isSafeInteger(totalPaisa) || totalPaisa > 1000000000) throw new Error('The selected add-on total is too large.');
  return {
    snapshots,
    totalPaisa,
    lineItems: snapshots.map((item) => ({ description: `Add-on: ${item.name} · ${item.billingPeriod}`, amountPaisa: item.monthlyPricePaisa })),
  };
}
