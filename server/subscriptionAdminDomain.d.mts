export type AdminSubscriptionOperation = 'assign' | 'change' | 'extend' | 'suspend' | 'reactivate' | 'cancel';
export function parsePakistanStartDate(value: unknown, label?: string): Date;
export function parsePakistanEndDate(value: unknown, label?: string): Date;
export function validateAdminSubscriptionCommand(input: unknown, options?: { now?: Date }): {
  operation: AdminSubscriptionOperation;
  planId?: string;
  startsAt?: Date;
  expiresAt?: Date;
  reason: string;
};
export function selectReactivationPeriod<T extends { id: string; data: Record<string, unknown>; startsAt: Date | null; expiresAt: Date | null }>(
  periods: T[],
  now?: Date,
): T | null;
export function normalizeOfferMutation(input: unknown, existing?: Record<string, unknown>): Record<string, unknown>;
export type AddOnCatalogItem = {
  id: string;
  name: string;
  description?: string;
  featureKey: string;
  monthlyPricePaisa: number;
  active: boolean;
  deleted?: boolean;
};
export function buildAddOnInvoiceSnapshots(
  selectedIds: unknown,
  catalogItems: AddOnCatalogItem[],
): {
  snapshots: Array<{ catalogId: string; name: string; description: string; featureKey: string; monthlyPricePaisa: number; billingPeriod: 'monthly' }>;
  totalPaisa: number;
  lineItems: Array<{ description: string; amountPaisa: number }>;
};
