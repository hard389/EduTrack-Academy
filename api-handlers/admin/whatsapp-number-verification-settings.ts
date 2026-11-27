import type { ApiDispatchRequest, ApiDispatchResponse } from "../../server/apiRouteDispatcher.js";
import {
  getAdminWhatsAppNumberScannerSettings,
  saveAdminWhatsAppNumberScannerSettings,
  sendWhatsAppNumberVerificationError,
} from "../../server/whatsappNumberVerification.js";

export default async function handler(req: ApiDispatchRequest, res: ApiDispatchResponse): Promise<unknown> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "PUT") {
    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
  try {
    const result = req.method === "GET"
      ? await getAdminWhatsAppNumberScannerSettings(req)
      : await saveAdminWhatsAppNumberScannerSettings(req);
    return res.status(200).json(result);
  } catch (error) {
    return sendWhatsAppNumberVerificationError(res, error);
  }
}
