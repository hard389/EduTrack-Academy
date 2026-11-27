import type { ApiDispatchRequest, ApiDispatchResponse } from "../../server/apiRouteDispatcher.js";
import {
  dismissTeacherPortalAnnouncement,
  getTeacherPortalAnnouncement,
  sendTeacherPortalAnnouncementApiError,
} from "../../server/teacherPortalAnnouncement.js";

export default async function handler(req: ApiDispatchRequest, res: ApiDispatchResponse): Promise<unknown> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
  try {
    const result = req.method === "GET"
      ? await getTeacherPortalAnnouncement(req)
      : await dismissTeacherPortalAnnouncement(req);
    return res.status(200).json(result);
  } catch (error) {
    return sendTeacherPortalAnnouncementApiError(res, error);
  }
}
