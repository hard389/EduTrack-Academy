const clean = (value) => typeof value === 'string' ? value.trim() : '';
const PENDING_INVOICE_STATUSES = new Set(['unpaid', 'payment_pending', 'pending_review']);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BLOCKED_CUSTOMER_STATUSES = new Set(['suspended', 'cancelled', 'canceled', 'revoked', 'disabled', 'deleted', 'rejected', 'archived']);

/**
 * Resolve each customer's invoice terms from their saved subscription state.
 * Postpaid customers always retain their own completed usage month; ordinary
 * customers use the month selected by the administrator.
 */
export function buildBulkInvoiceTargets(teachers, billingPeriod, now = Date.now()) {
  if (!Array.isArray(teachers)) throw new Error('The customer directory is invalid.');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(clean(billingPeriod))) {
    throw new Error('Choose a valid monthly billing period.');
  }

  const targets = [];
  const skipped = [];
  for (const teacher of teachers) {
    const uid = clean(teacher?.uid);
    const email = clean(teacher?.email).toLowerCase();
    const isPostpaid = clean(teacher?.accessMode) === 'postpaid_monthly';
    const planId = clean(isPostpaid ? teacher?.postpaidPlanId : teacher?.planId);
    const skip = (reason) => skipped.push({
      teacherUid: uid || null,
      teacherEmail: email || null,
      teacherName: clean(teacher?.name) || email || 'Unknown customer',
      planName: clean(teacher?.planName) || clean(teacher?.postpaidPlanName) || null,
      status: 'skipped',
      reason,
    });

    if (!uid || !email || !SAFE_ID.test(uid)) {
      skip('Customer identity is incomplete.');
      continue;
    }
    if (!planId || !SAFE_ID.test(planId)) {
      skip('No saved subscription plan is assigned.');
      continue;
    }
    if (BLOCKED_CUSTOMER_STATUSES.has(clean(teacher?.subscriptionStatus).toLowerCase())) {
      skip('The customer subscription is suspended, cancelled or disabled.');
      continue;
    }

    let targetPeriod = clean(billingPeriod);
    if (isPostpaid) {
      targetPeriod = clean(teacher?.postpaidUsageBillingPeriod);
      const expiry = teacher?.postpaidUsageExpiresAt ? new Date(teacher.postpaidUsageExpiresAt).getTime() : NaN;
      if (!targetPeriod || !Number.isFinite(expiry)) {
        skip('The postpaid usage period or expiry date is missing.');
        continue;
      }
      if (expiry > now) {
        skip('The postpaid usage month has not ended yet.');
        continue;
      }
      if (PENDING_INVOICE_STATUSES.has(clean(teacher?.postpaidInvoiceStatus).toLowerCase())) {
        skip('A postpaid invoice is already awaiting payment or review.');
        continue;
      }
    }

    const pricingMode = clean(teacher?.pricingMode) === 'per_student' ? 'per_student' : 'lump_sum';
    const permissions = teacher?.featurePermissions && typeof teacher.featurePermissions === 'object'
      ? teacher.featurePermissions
      : {};
    const activeAddOnIds = Array.isArray(teacher?.activeAddOns)
      ? [...new Set(teacher.activeAddOns.filter((item) => {
        const featureKey = clean(item?.featureKey) || clean(item?.featureKeys?.[0]);
        return !featureKey || (permissions[featureKey] !== 'enabled' && permissions[featureKey] !== true);
      }).map((item) => clean(item?.catalogId)).filter((id) => SAFE_ID.test(id)))]
      : [];

    targets.push({
      teacherUid: uid,
      teacherEmail: email,
      teacherName: clean(teacher?.name) || email,
      planId,
      planName: clean(teacher?.planName) || clean(teacher?.postpaidPlanName) || 'Subscription plan',
      billingPeriod: targetPeriod,
      pricingMode,
      addOnCatalogIds: activeAddOnIds,
      isPostpaid,
    });
  }
  return { targets, skipped };
}
