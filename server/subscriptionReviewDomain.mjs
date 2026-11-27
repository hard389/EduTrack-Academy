const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const PAKISTAN_UTC_OFFSET_MINUTES = 300;

export function getSubscriptionPeriodBounds(periodKey) {
  if (typeof periodKey !== 'string') throw new TypeError('A valid YYYY-MM billing period is required.');
  const match = PERIOD_RE.exec(periodKey);
  if (!match) throw new TypeError('A valid YYYY-MM billing period is required.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  // setUTCFullYear avoids Date.UTC's special handling of numeric years 0–99.
  const localStartAsUtc = new Date(0);
  localStartAsUtc.setUTCHours(0, 0, 0, 0);
  localStartAsUtc.setUTCFullYear(year, month - 1, 1);
  const localEndAsUtc = new Date(0);
  localEndAsUtc.setUTCHours(0, 0, 0, 0);
  localEndAsUtc.setUTCFullYear(year, month, 1);
  const offsetMs = PAKISTAN_UTC_OFFSET_MINUTES * 60 * 1000;
  return {
    billingPeriod: periodKey,
    startedAt: new Date(localStartAsUtc.getTime() - offsetMs),
    expiresAt: new Date(localEndAsUtc.getTime() - offsetMs),
  };
}

export function getSubscriptionPeriodStatus(bounds, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('A valid current time is required.');
  const startMs = bounds?.startedAt instanceof Date ? bounds.startedAt.getTime() : new Date(bounds?.startedAt).getTime();
  const endMs = bounds?.expiresAt instanceof Date ? bounds.expiresAt.getTime() : new Date(bounds?.expiresAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new TypeError('A valid subscription period window is required.');
  if (nowMs < startMs) return 'scheduled';
  if (nowMs < endMs) return 'active';
  return 'expired';
}

export function isReviewablePayment(invoice, submission, receiptId) {
  return Boolean(invoice && submission &&
    submission.status === 'pending_review' &&
    invoice.paymentStatus === 'pending_review' &&
    invoice.status === 'payment_pending' &&
    invoice.receiptId === receiptId &&
    submission.id === receiptId &&
    typeof invoice.teacherUid === 'string' && invoice.teacherUid &&
    submission.teacherUid === invoice.teacherUid &&
    submission.invoiceId && submission.invoiceId === invoice.id);
}
