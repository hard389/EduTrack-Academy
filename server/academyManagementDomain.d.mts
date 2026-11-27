export const ACADEMY_PERMISSION_DEFINITIONS: ReadonlyArray<{ key: string; label: string; group: string; description: string }>;
export const ACADEMY_PERMISSION_KEYS: readonly string[];
export const EMPTY_TEACHER_PERMISSIONS: Readonly<Record<string, boolean>>;
export const LEGACY_FEATURE_PERMISSION_MAP: Readonly<Record<string, string>>;
export function hasAcademyFeaturePermission(permissions: Record<string, unknown>, featureKey: string): boolean;
export function makeClassCode(input: { name: string; section?: string; classId: string }): string;
export function normalizeSubjectAssignments(input: unknown): Array<{ subjectId: string; teacherUid: string; monthlyFee: number; currency: string; billingFrequency: string }>;
export function buildExpenseSnapshot(input: Record<string, unknown>): {
  title: string; description: string; category: string; amount: number; currency: string;
  expenseDate: string; vendor: string; paymentMethod: string; reference: string; status: 'draft' | 'posted';
};
export function normalizePermissionMap(input?: unknown): Record<string, boolean>;
export function normalizeIdList(value: unknown, fieldName?: string, maximum?: number): string[];
export function mergeTeacherAssignedIds(
  existingClassIds: unknown,
  existingSubjectIds: unknown,
  assignments: Array<{ classId: string; subjectId: string }>,
): { assignedClassIds: string[]; assignedSubjectIds: string[] };
export function nextClassRollNumber(existingRollNumbers: unknown[], currentNext?: number): number;
export function advanceClassRollSequence(currentNext: number, allocatedRollNumber: string): number;
export function normalizeBillingMonth(value: unknown): string;
export function buildInvoiceSnapshot(input: { invoiceId: string; academyId: string; student: Record<string, unknown>; month: string; enrollments: Array<Record<string, unknown>>; issuedAt: unknown }): Record<string, unknown>;
export function applyPaymentToInvoice(invoice: Record<string, any>, payment: Record<string, unknown>): { invoice: Record<string, any>; payment: Record<string, unknown> };
export function buildLegacyStudentProjection(student: Record<string, unknown>, extra?: Record<string, unknown>): Record<string, unknown>;
