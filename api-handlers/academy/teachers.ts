import type { ApiDispatchRequest, ApiDispatchResponse } from "../../server/apiRouteDispatcher.js";
import { createAcademyTeacher, isAcademyApiRecord, listAcademyTeachers, sendAcademyApiError } from "../../server/academyIdentity.js";

export default async function handler(req: ApiDispatchRequest, res: ApiDispatchResponse) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") return res.status(200).json(await listAcademyTeachers(req));
    if (req.method === "POST") {
      if (!isAcademyApiRecord(req.body)) {
        return res.status(400).json({ success: false, error: "A valid JSON request body is required." });
      }
      return res.status(201).json(await createAcademyTeacher(req, req.body));
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  } catch (error) {
    return sendAcademyApiError(res, error);
  }
}
