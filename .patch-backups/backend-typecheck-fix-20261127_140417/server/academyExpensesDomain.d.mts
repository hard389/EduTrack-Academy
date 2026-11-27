export function moneyToCents(value: unknown, field?: string): number;
export function centsToMoney(cents: number): number;
export function buildExpenseAllocationPlan(input: {
  amount: number | string;
  allocationMethod?: 'none' | 'all_active' | 'selected_equal' | 'custom';
  selectedTeacherUids?: string[];
  customAllocations?: Array<{ teacherUid: string; allocatedAmount: number | string }>;
  teachers?: Array<Record<string, unknown>>;
}): {
  allocationMethod: string;
  teacherAllocations: Array<Record<string, unknown>>;
  allocationTotal: number;
  unallocatedAmount: number;
};
export function summarizeAcademyExpenses(expenses: Array<Record<string, unknown>>): Record<string, unknown>;
export function summarizeTeacherAllocations(expenses: Array<Record<string, unknown>>): Array<Record<string, unknown>>;
