/**
 * Pure attendance dispatch readiness contract. Never treats provider acceptance
 * as delivery; this only answers whether the server is allowed and configured
 * to attempt a provider request.
 */
export function buildAttendanceDispatchReadiness({
  serverEnabled,
  adminAuthorized,
  senderReady,
  senderError,
}) {
  const blockers = [];

  if (serverEnabled !== true) {
    blockers.push('Attendance WhatsApp dispatch is disabled on the server.');
  }
  if (adminAuthorized !== true) {
    blockers.push('Attendance WhatsApp dispatch has not been authorized by an administrator.');
  }
  if (serverEnabled === true && adminAuthorized === true && senderReady !== true) {
    blockers.push(
      typeof senderError === 'string' && senderError.trim()
        ? senderError.trim()
        : 'No verified WhatsApp sender with usable credentials is configured.',
    );
  }

  return { available: blockers.length === 0, blockers };
}
