export type SubscriptionPaymentMethodType = 'bank' | 'mobile_wallet' | 'other';

export type SubscriptionPaymentMethod = {
  id: string;
  name: string;
  type: SubscriptionPaymentMethodType;
  providerName: string;
  accountTitle: string;
  accountNumber: string;
  iban: string;
  mobileNumber: string;
  branch: string;
  instructions: string;
};

export function normalizePaymentMethods(value: unknown): SubscriptionPaymentMethod[];
export function validatePaymentMethods(value: unknown):
  | { valid: true; paymentMethods: SubscriptionPaymentMethod[] }
  | { valid: false; error: string };
