import type { ApiDispatchRequest, ApiDispatchResponse } from "../../server/apiRouteDispatcher.js";
import {
  getAdminTeacherPortalAnnouncement,
  saveAdminTeacherPortalAnnouncement,
  sendTeacherPortalAnnouncementApiError,
} from "../../server/teacherPortalAnnouncement.js";

export default async function handler(req: ApiDispatchRequest, res: ApiDispatchResponse): Promise<unknown> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "PUT") {
    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
  try {
    const result = req.method === "GET"
      ? await getAdminTeacherPortalAnnouncement(req)
      : await saveAdminTeacherPortalAnnouncement(req);
    return res.status(200).json(result);
  } catch (error) {
    return sendTeacherPortalAnnouncementApiError(res, error);
  }
}
