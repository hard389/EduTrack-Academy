export type SubscriptionPeriodBounds = { billingPeriod: string; startedAt: Date; expiresAt: Date };
export function getSubscriptionPeriodBounds(periodKey: string): SubscriptionPeriodBounds;
export function getSubscriptionPeriodStatus(bounds: SubscriptionPeriodBounds, now?: Date | number): 'scheduled' | 'active' | 'expired';
export function isReviewablePayment(invoice: Record<string, unknown> & { id: string }, submission: Record<string, unknown> & { id: string }, receiptId: string): boolean;
