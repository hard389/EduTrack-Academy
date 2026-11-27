import { dispatchAdminApi } from "../server/adminApiRouter.js";
import type {
  ApiDispatchRequest,
  ApiDispatchResponse
} from "../server/apiRouteDispatcher.js";

export default function handler(
  req: ApiDispatchRequest,
  res: ApiDispatchResponse
) {
  return dispatchAdminApi(req, res);
}
