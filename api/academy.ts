import { dispatchAcademyApi } from "../server/academyApiRouter.js";
import type { ApiDispatchRequest, ApiDispatchResponse } from "../server/apiRouteDispatcher.js";

export default function handler(req: ApiDispatchRequest, res: ApiDispatchResponse) {
  return dispatchAcademyApi(req, res);
}
