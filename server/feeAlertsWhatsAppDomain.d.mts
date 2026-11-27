export type FeeOutstandingResult = {
  valid: boolean;
  error?: string;
  monthlyFeeDue?: number;
  previousMonthDues?: number;
  totalObligation?: number;
  paidAmount?: number;
  paidTowardsCurrentMonth?: number;
  remainingDues?: number;
  status?: "PAID" | "UNPAID" | "PARTIAL";
};

export function normalizeFeeAlertPhone(value: unknown): string | null;
export function hasCurrentFeeAlertsConsent(student: Record<string, unknown>): boolean;
export function isStudentEligibleForFeeMonth(student: Record<string, unknown>, monthKey: string): boolean;
export function normalizeFeeReminderDays(value: unknown): number[] | null;
export function getPakistanCalendarParts(value?: Date): { year: number; month: number; day: number; monthKey: string };
export function computeFeeOutstanding(input: {
  student: Record<string, unknown>;
  classData: Record<string, unknown>;
  currentRecord?: Record<string, unknown> | null;
  previousRecord?: Record<string, unknown> | null;
  monthKey: string;
}): FeeOutstandingResult;
export function createFeeAlertJobId(input: { tenantId: string; classId: string; monthKey: string; studentId: string; reminderDay: number }): string;
export function feeMonthLabel(monthKey: string): string;
export function buildFeeReminderMessage(input: { studentName: string; className: string; monthKey: string; amountDue: number }): string;
export function createFeeAlertRecipientHash(phone: string): string;
