export type PostpaidUsageWindow = { billingPeriod: string; startedAt: Date; expiresAt: Date };
export function pakistanBillingMonth(value: Date | string | number | { toDate(): Date }): string;
export function addCalendarMonth(value: Date | string | number | { toDate(): Date }): Date;
export function createPostpaidUsageWindow(startValue?: Date | string | number | { toDate(): Date }): PostpaidUsageWindow;
export function renewPostpaidUsageWindow(input: { currentExpiresAt?: Date | string | number | { toDate(): Date } | null; now?: Date | string | number | { toDate(): Date } }): PostpaidUsageWindow;
