import type { ApiDispatchRequest, ApiDispatchResponse } from "../../server/apiRouteDispatcher.js";
import { isAcademyApiRecord, registerAcademy, sendAcademyApiError } from "../../server/academyIdentity.js";

export default async function handler(req: ApiDispatchRequest, res: ApiDispatchResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
  if (!isAcademyApiRecord(req.body)) {
    return res.status(400).json({ success: false, error: "A valid JSON request body is required." });
  }
  try {
    return res.status(200).json(await registerAcademy(req, req.body));
  } catch (error) {
    return sendAcademyApiError(res, error);
  }
}
