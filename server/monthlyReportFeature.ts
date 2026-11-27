/**
 * Monthly PDF WhatsApp is opt-in at deployment level.
 * It remains disabled unless the dedicated environment variable is
 * explicitly set to the exact string "true".
 *
 * The legacy WHATSAPP_DISPATCH_ENABLED variable alone cannot enable it.
 */
export function isMonthlyReportWhatsAppEnabled(): boolean {
  return process.env.WHATSAPP_MONTHLY_REPORTS_ENABLED === "true";
}

export const MONTHLY_REPORT_WHATSAPP_DISABLED_MESSAGE =
  "Monthly report WhatsApp delivery is disabled. No report was prepared, sent, reconciled, or served.";
