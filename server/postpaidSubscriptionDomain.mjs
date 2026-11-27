const toDate = (value) => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (value && typeof value === 'object' && typeof value.toDate === 'function') {
    try {
      const date = value.toDate();
      return date instanceof Date && Number.isFinite(date.getTime()) ? date : null;
    } catch { return null; }
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
};

// Subscription billing is keyed to Pakistan-local calendar month, matching the teacher/admin UI.
export function pakistanBillingMonth(value) {
  const date = toDate(value);
  if (!date) throw new TypeError('A valid date is required to determine the billing month.');
  const shifted = new Date(date.getTime() + 5 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function addCalendarMonth(value) {
  const date = toDate(value);
  if (!date) throw new TypeError('A valid date is required to add one calendar month.');
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const targetLastDay = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  return new Date(Date.UTC(
    year,
    month + 1,
    Math.min(day, targetLastDay),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ));
}

export function createPostpaidUsageWindow(startValue = new Date()) {
  const startedAt = toDate(startValue);
  if (!startedAt) throw new TypeError('A valid usage start date is required.');
  const expiresAt = addCalendarMonth(startedAt);
  if (expiresAt.getTime() <= startedAt.getTime()) throw new RangeError('The postpaid usage window is invalid.');
  return {
    billingPeriod: pakistanBillingMonth(startedAt),
    startedAt,
    expiresAt,
  };
}

export function renewPostpaidUsageWindow({ currentExpiresAt, now = new Date() } = {}) {
  const currentExpiry = toDate(currentExpiresAt);
  const nowDate = toDate(now);
  if (!nowDate) throw new TypeError('A valid renewal date is required.');
  const startedAt = currentExpiry && currentExpiry.getTime() > nowDate.getTime() ? currentExpiry : nowDate;
  return createPostpaidUsageWindow(startedAt);
}
