export interface AttendanceDispatchReadinessInput {
  serverEnabled: boolean;
  adminAuthorized: boolean;
  senderReady: boolean;
  senderError?: string;
}

export interface AttendanceDispatchReadiness {
  available: boolean;
  blockers: string[];
}

export function buildAttendanceDispatchReadiness(
  input: AttendanceDispatchReadinessInput,
): AttendanceDispatchReadiness;
