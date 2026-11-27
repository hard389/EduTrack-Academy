/** Converts Firestore Timestamp-like values, Dates, and serialized date values safely. */
export function toSafeSubscriptionDate(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  if (value !== null && typeof value === 'object' && 'toDate' in value) {
    const toDate = value.toDate;
    if (typeof toDate === 'function') {
      const parsed = toDate.call(value);
      return parsed instanceof Date && Number.isFinite(parsed.getTime()) ? parsed : null;
    }
  }

  return null;
}
