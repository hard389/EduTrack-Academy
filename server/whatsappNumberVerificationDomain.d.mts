export type WhatsAppNumberVerificationStatus = "registered" | "not_registered" | "invalid" | "verification_failed";
export function normalizeWhatsAppNumber(value: unknown): string | null;
export function validateScannerBaseUrl(value: unknown): { valid: boolean; value?: string; error?: string };
export function buildScannerEndpoint(baseUrl: string): string;
export function chunkUniqueNumbers(values: unknown[], maxSize?: number): string[][];
export function mapScannerResponse(payload: unknown, requestedNumbers: unknown[]): Array<{ number: string; status: WhatsAppNumberVerificationStatus }>;
export const WHATSAPP_NUMBER_PROVIDER_BATCH_SIZE: 50;
export const WHATSAPP_NUMBER_PROVIDER_PATH: "/api/whatsapp-web/check-number";
