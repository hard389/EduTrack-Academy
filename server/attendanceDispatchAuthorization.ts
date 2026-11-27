export function hasAttendanceDispatchAuthorization(
  settings: Record<string, unknown>,
): boolean {
  return settings.enabled === true &&
    settings.attendanceDispatchEnabled === true &&
    settings.configurationStatus === "admin_authorized_unverified" &&
    settings.attendanceDispatchAuthorizationVersion === 1 &&
    settings.attendanceDispatchAuthorizationScope === "attendance_alerts_only" &&
    typeof settings.attendanceDispatchAuthorizedAt === "string" &&
    settings.attendanceDispatchAuthorizedAt.trim().length > 0 &&
    typeof settings.attendanceDispatchAuthorizedByUid === "string" &&
    settings.attendanceDispatchAuthorizedByUid.trim().length > 0;
}
