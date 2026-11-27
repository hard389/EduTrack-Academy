import type { ApiDispatchRequest, ApiDispatchResponse } from "../../server/apiRouteDispatcher.js";
import {
  verifyRegistrationWhatsAppNumber,
  sendWhatsAppNumberVerificationError,
} from "../../server/whatsappNumberVerification.js";

export default async function handler(req: ApiDispatchRequest, res: ApiDispatchResponse): Promise<unknown> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
  try {
    return res.status(200).json(await verifyRegistrationWhatsAppNumber(req));
  } catch (error) {
    return sendWhatsAppNumberVerificationError(res, error);
  }
}
