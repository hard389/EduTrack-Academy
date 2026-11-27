export function isTeacherInvoiceLine(line: Record<string, unknown>, teacherUid: string, activeAssignmentKeys: Set<string>): boolean;
export function sumTeacherPaymentAllocations(allocations: unknown, teacherLineItemIds: Set<string>): number;
export function calculateTeacherFeeSummary(lines: Array<Record<string, unknown>>): { billed: number; collected: number; outstanding: number };
