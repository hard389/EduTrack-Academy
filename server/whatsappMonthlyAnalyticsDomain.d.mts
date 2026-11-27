export type AnalyticsOutcome = "providerAccepted" | "deliveryConfirmed" | "failed" | "pending" | "unknown";
export function currentPakistanMonthKey(now?: Date): string;
export function validatePakistanMonthKey(raw: unknown, now?: Date): string;
export function pakistanMonthBoundsUtc(monthKey: string): { start: Date; end: Date; days: number };
export function previousPakistanMonthKey(monthKey: string): string;
export function classifyWhatsAppOutcome(statusValue: unknown, data?: Record<string, unknown>): AnalyticsOutcome | null;
