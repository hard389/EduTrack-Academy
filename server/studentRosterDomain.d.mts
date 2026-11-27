export interface StudentRosterAddPlan {
  type: 'array' | 'studentsMap' | 'topLevel';
  students?: unknown[];
  key?: string;
  student?: Record<string, unknown>;
}
export const STUDENT_CONSENT_CONFIG: ReadonlyArray<{
  input: string; permissionKey: string; property: string; timestamp: string; phone: string;
}>;
export const GUARDIAN_CONSENT_CAPABILITIES: Readonly<Record<string, boolean>>;
export function normalizePakistaniPhone(value: unknown): string;
export function buildStudentRecord(raw: Record<string, unknown>, permissions: Record<string, boolean>, id: number | string, options?: { classMonthlyFee?: string }): { student: Record<string, unknown>; ignoredConsentFeatures: string[] };
export function listStudentRecords(classData: unknown): Record<string, unknown>[];
export function planStudentRosterAdd(classData: unknown, student: Record<string, unknown>): StudentRosterAddPlan;
export function hasDuplicateRollNumber(classData: unknown, rollNo: string): boolean;
