export function normalizeAnnouncementWhatsAppPhone(value: unknown): string | null;
export function getAnnouncementConsentedPhone(student: Record<string, unknown> | null | undefined): string | null;
export function createAnnouncementPhoneHash(phone: unknown): string;
export function createAnnouncementRecipientKey(phoneHash: unknown): string;
export function calculateAnnouncementContentHash(input: Record<string, unknown>): string;
export function createAnnouncementDispatchId(input: Record<string, unknown>): string;
export function buildAnnouncementMessage(input: Record<string, unknown>): string;
