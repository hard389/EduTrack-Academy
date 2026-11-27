import { dispatchWhatsAppApi } from "../server/whatsappApiRouter.js";
import type {
  ApiDispatchRequest,
  ApiDispatchResponse
} from "../server/apiRouteDispatcher.js";

export default function handler(
  req: ApiDispatchRequest,
  res: ApiDispatchResponse
) {
  return dispatchWhatsAppApi(req, res);
}
