export function readTimestampMillis(value: unknown): number | null;
export function getFailedAtMillis(job: unknown): number | null;
export function getFailedExpiryMillis(job: unknown): number | null;
export function isSafeAttendanceRetryJob(job: unknown, now?: number): boolean;
export function isExpiredSafeAttendanceRetryJob(job: unknown, now?: number): boolean;
