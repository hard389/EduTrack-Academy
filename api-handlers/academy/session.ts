import type { ApiDispatchRequest, ApiDispatchResponse } from "../../server/apiRouteDispatcher.js";
import { isAcademyApiRecord, resolveAcademySession, sendAcademyApiError } from "../../server/academyIdentity.js";

export default async function handler(req: ApiDispatchRequest, res: ApiDispatchResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
  const body = isAcademyApiRecord(req.body) ? req.body : {};
  const queryId = req.query?.academyId;
  const requestedAcademyId = body.academyId ?? queryId;
  try {
    return res.status(200).json(await resolveAcademySession(req, requestedAcademyId));
  } catch (error) {
    return sendAcademyApiError(res, error);
  }
}
