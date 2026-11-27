export type SubscriptionDiscount = {
  discountType: 'percentage' | 'fixed';
  discountValue: number;
};
export function isValidPeriodKey(value: unknown): value is string;
export function calculateDiscountPaisa(subtotalPaisa: number, offer: SubscriptionDiscount): number;
export function makeSubscriptionInvoiceId(period: string, teacherUid: string): string;
