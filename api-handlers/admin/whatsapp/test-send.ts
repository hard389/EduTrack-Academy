import type {
  WhatsAppAdminRequest,
  WhatsAppAdminResponse,
} from "../../../server/adminWhatsApp.js";

export default async function handler(
  req: WhatsAppAdminRequest,
  res: WhatsAppAdminResponse,
): Promise<unknown> {
  void req;
  res.setHeader("Cache-Control", "no-store");
  return res.status(410).json({
    success: false,
    code: "LEGACY_ENDPOINT_RETIRED",
    error: "The standalone WhatsApp test-send endpoint is retired. Use the normal attendance workflow only after explicit attendance authorization.",
  });
}
