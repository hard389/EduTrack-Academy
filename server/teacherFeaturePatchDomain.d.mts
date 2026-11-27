export function calculateAnnouncementExtraCharge(input: {
  quotaPerClass: number;
  includedQuota?: number;
  extraPackSize?: number;
  extraPackPricePaisa?: number;
  billableClassCount?: number;
}): { extraPacks: number; amountPaisa: number };
export function summarizeProviderStatuses(rows: unknown[]): {
  providerAccepted: number; deliveryConfirmed: number; rejected: number; unknownOutcome: number; pending: number; inspected: number;
};
export function summarizeAnnouncementRecipientsByClass(recipients: unknown[]): Map<string, { accepted: number; rejected: number; unknown: number }>;
