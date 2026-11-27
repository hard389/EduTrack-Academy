export type SubscriptionReceiptAction = 'upload' | 'verify' | 'read';
export type SubscriptionReceiptGrantInput = {
  action: SubscriptionReceiptAction;
  adminUid: string;
  adminEmail: string;
  teacherUid: string;
  teacherEmail: string;
  invoiceId: string;
  receiptId: string;
  iat: number;
  exp: number;
};
export function createSubscriptionReceiptGrantToken(input: SubscriptionReceiptGrantInput, secret: string): string;
export function verifySubscriptionReceiptGrantToken(token: string, secret: string, options?: { action?: SubscriptionReceiptAction; receiptId?: string }): SubscriptionReceiptGrantInput | null;
