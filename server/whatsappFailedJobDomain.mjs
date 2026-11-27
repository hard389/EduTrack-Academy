const DAY_MS = 24 * 60 * 60 * 1000;

export function readTimestampMillis(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object") {
    if (typeof value.toMillis === "function") {
      try {
        const result = value.toMillis();
        return typeof result === "number" && Number.isFinite(result) ? result : null;
      } catch {
        return null;
      }
    }
    if (typeof value.seconds === "number" && Number.isFinite(value.seconds)) {
      return value.seconds * 1000 + (typeof value.nanoseconds === "number" ? value.nanoseconds / 1_000_000 : 0);
    }
  }
  return null;
}

export function getFailedAtMillis(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return null;
  return readTimestampMillis(job.failedAt)
    ?? readTimestampMillis(job.updatedAt)
    ?? readTimestampMillis(job.createdAt);
}

export function getFailedExpiryMillis(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return null;
  const explicit = readTimestampMillis(job.expiresAt);
  if (explicit !== null) return explicit;
  const failedAt = getFailedAtMillis(job);
  return failedAt === null ? null : failedAt + DAY_MS;
}

export function isSafeAttendanceRetryJob(job, now = Date.now()) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return false;
  const attempts = Number(job.attemptCount ?? 0);
  const expiresAt = getFailedExpiryMillis(job);
  return job.kind === "attendance_absent"
    && job.status === "failed"
    && job.retrySafe === true
    && Number.isSafeInteger(attempts)
    && attempts >= 0
    && attempts < 3
    && expiresAt !== null
    && expiresAt > now;
}

export function isExpiredSafeAttendanceRetryJob(job, now = Date.now()) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return false;
  const expiresAt = getFailedExpiryMillis(job);
  return job.kind === "attendance_absent"
    && job.status === "failed"
    && job.retrySafe === true
    && expiresAt !== null
    && expiresAt <= now;
}
