"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isOwnedActiveTeacherTenant = isOwnedActiveTeacherTenant;
exports.getAttendanceRetryAttemptCount = getAttendanceRetryAttemptCount;
exports.hasReachedAttendanceRetryLimit = hasReachedAttendanceRetryLimit;
exports.isSafeAttendanceRetryJob = isSafeAttendanceRetryJob;
function isRecord(value) {
    return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value);
}
function normalizeEmail(value) {
    if (typeof value !== "string")
        return null;
    const email = value.trim().toLowerCase();
    if (!email ||
        email.includes("/") ||
        email.includes("\\") ||
        /\s/.test(email) ||
        !email.includes("@") ||
        email.startsWith("@") ||
        email.endsWith("@")) {
        return null;
    }
    return email;
}
/**
 * Tenant ownership check shared by attendance retry callables.
 * The profile must belong to the signed-in UID/email and be an active teacher.
 */
function isOwnedActiveTeacherTenant(profile, authenticatedUid, authenticatedEmail) {
    const email = normalizeEmail(authenticatedEmail);
    if (!isRecord(profile) ||
        typeof authenticatedUid !== "string" ||
        !authenticatedUid.trim() ||
        !email) {
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
function getAttendanceRetryAttemptCount(job) {
    if (!isRecord(job))
        return 0;
    const count = job.attemptCount;
    if (typeof count !== "number" || !Number.isFinite(count))
        return 0;
    return count;
}
function hasReachedAttendanceRetryLimit(job) {
    return getAttendanceRetryAttemptCount(job) >= 3;
}
/**
 * Only explicitly safe, failed jobs below the retry limit can be requeued.
 * In particular, unknown_outcome and sending are never eligible.
 */
function isSafeAttendanceRetryJob(job) {
    if (!isRecord(job))
        return false;
    const attempts = getAttendanceRetryAttemptCount(job);
    return job.status === "failed" &&
        job.retrySafe === true &&
        attempts >= 0 &&
        attempts < 3;
}
//# sourceMappingURL=attendanceRetryPolicy.js.map