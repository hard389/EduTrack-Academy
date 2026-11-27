type PolicyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PolicyRecord {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const email = value.trim().toLowerCase();
  if (
    !email ||
    email.includes("/") ||
    email.includes("\\") ||
    /\s/.test(email) ||
    !email.includes("@") ||
    email.startsWith("@") ||
    email.endsWith("@")
  ) {
    return null;
  }

  return email;
}

/**
 * Tenant ownership check shared by attendance retry callables.
 * The profile must belong to the signed-in UID/email and be an active teacher.
 */
export function isOwnedActiveTeacherTenant(
  profile: unknown,
  authenticatedUid: unknown,
  authenticatedEmail: unknown,
): boolean {
  const email = normalizeEmail(authenticatedEmail);

  if (
    !isRecord(profile) ||
    typeof authenticatedUid !== "string" ||
    !authenticatedUid.trim() ||
    !email
  ) {
    return false;
  }

  return profile.uid === authenticatedUid &&
    normalizeEmail(profile.email) === email &&
    profile.role === "teacher" &&
    profile.active === true &&
    profile.disabled !== true &&
    profile.deleted !== true;
}

/**
 * Preserve the current fallback of zero when legacy jobs lack a numeric
 * attemptCount; reject negative, non-finite and exhausted attempt counts.
 */
export function getAttendanceRetryAttemptCount(job: unknown): number {
  if (!isRecord(job)) return 0;

  const count = job.attemptCount;
  if (typeof count !== "number" || !Number.isFinite(count)) return 0;

  return count;
}

export function hasReachedAttendanceRetryLimit(job: unknown): boolean {
  return getAttendanceRetryAttemptCount(job) >= 3;
}

/**
 * Only explicitly safe, failed jobs below the retry limit can be requeued.
 * In particular, unknown_outcome and sending are never eligible.
 */
export function isSafeAttendanceRetryJob(job: unknown): boolean {
  if (!isRecord(job)) return false;

  const attempts = getAttendanceRetryAttemptCount(job);

  return job.status === "failed" &&
    job.retrySafe === true &&
    attempts >= 0 &&
    attempts < 3;
}
