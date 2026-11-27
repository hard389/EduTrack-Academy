import type { WhatsAppAdminRequest, WhatsAppAdminResponse } from "../../../server/adminWhatsApp.js";
import {
  getWhatsAppAdminSettings,
  saveWhatsAppAdminSettings,
  sendWhatsAppAdminApiError,
} from "../../../server/adminWhatsApp.js";

export default async function handler(
  req: WhatsAppAdminRequest,
  res: WhatsAppAdminResponse,
): Promise<unknown> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "PUT") {
    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
  try {
    if (req.method === "GET") return res.status(200).json(await getWhatsAppAdminSettings(req));
    return res.status(200).json(await saveWhatsAppAdminSettings(req));
  } catch (error) {
    return sendWhatsAppAdminApiError(res, error);
  }
}
