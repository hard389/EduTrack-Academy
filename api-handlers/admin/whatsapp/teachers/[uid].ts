import type { WhatsAppAdminRequest, WhatsAppAdminResponse } from "../../../../server/adminWhatsApp.js";
import {
  saveTeacherWhatsAppConnection,
  sendWhatsAppAdminApiError,
} from "../../../../server/adminWhatsApp.js";

export default async function handler(
  req: WhatsAppAdminRequest,
  res: WhatsAppAdminResponse,
): Promise<unknown> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "PUT" && req.method !== "DELETE") {
    res.setHeader("Allow", "PUT, DELETE");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
  try {
    const uid = req.query?.uid;
    if (typeof uid !== "string") {
      return res.status(400).json({ success: false, error: "A teacher UID is required." });
    }
    const body = req.method === "DELETE"
      ? { phoneNumber: "", selectedForPersonalRouting: false }
      : req.body;
    return res.status(200).json(await saveTeacherWhatsAppConnection({ ...req, body }, uid));
  } catch (error) {
    return sendWhatsAppAdminApiError(res, error);
  }
}
