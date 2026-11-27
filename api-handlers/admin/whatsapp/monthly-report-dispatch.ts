import type {
  WhatsAppAdminRequest,
  WhatsAppAdminResponse,
} from "../../../server/adminWhatsApp.js";
import {
  setMonthlyReportDispatchAuthorization,
  sendWhatsAppAdminApiError,
} from "../../../server/adminWhatsApp.js";

export default async function handler(
  req: WhatsAppAdminRequest,
  res: WhatsAppAdminResponse,
): Promise<unknown> {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      success: false,
      error: "Method not allowed.",
    });
  }

  try {
    return res.status(200).json(
      await setMonthlyReportDispatchAuthorization(req),
    );
  } catch (error) {
    return sendWhatsAppAdminApiError(res, error);
  }
}
