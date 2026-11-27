export function isValidPeriodKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  const date = new Date(`${value}-01T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 7) === value;
}

export function calculateDiscountPaisa(subtotalPaisa, offer) {
  if (!Number.isSafeInteger(subtotalPaisa) || subtotalPaisa < 0) {
    throw new TypeError('subtotalPaisa must be a non-negative safe integer');
  }
  if (!offer || !Number.isSafeInteger(offer.discountValue) || offer.discountValue < 0) {
    throw new TypeError('offer.discountValue must be a non-negative safe integer');
  }
  let discount = 0;
  if (offer.discountType === 'percentage') {
    if (offer.discountValue > 100) throw new RangeError('percentage discount cannot exceed 100');
    discount = Math.round((subtotalPaisa * offer.discountValue) / 100);
  } else if (offer.discountType === 'fixed') {
    discount = offer.discountValue;
  } else {
    throw new TypeError('unsupported discount type');
  }
  return Math.min(subtotalPaisa, discount);
}

export function makeSubscriptionInvoiceId(period, teacherUid) {
  if (!isValidPeriodKey(period)) throw new TypeError('Invalid subscription billing period');
  if (typeof teacherUid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(teacherUid)) {
    throw new TypeError('Invalid teacher UID');
  }
  return `${period}_${teacherUid}`;
}
