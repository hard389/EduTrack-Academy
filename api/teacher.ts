import { dispatchTeacherApi } from "../server/teacherApiRouter.js";
import type {
  ApiDispatchRequest,
  ApiDispatchResponse
} from "../server/apiRouteDispatcher.js";

export default function handler(
  req: ApiDispatchRequest,
  res: ApiDispatchResponse
) {
  return dispatchTeacherApi(req, res);
}
