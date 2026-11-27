import type { ApiDispatchRequest, ApiDispatchResponse } from "../../server/apiRouteDispatcher.js";
import {
  dispatchAnnouncementWhatsApp,
  sendAnnouncementWhatsAppApiError,
} from "../../server/announcementsWhatsApp.js";
import type { TeacherApiRequest } from "../../server/teacherAuth.js";

export default async function handler(
  req: ApiDispatchRequest,
  res: ApiDispatchResponse,
): Promise<unknown> {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  try {
    const result = await dispatchAnnouncementWhatsApp(req as ApiDispatchRequest & TeacherApiRequest);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return sendAnnouncementWhatsAppApiError(res, error);
  }
}
