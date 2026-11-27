import {
  defineApiRoute,
  dispatchApiRoutes,
  type ApiDispatchRequest,
  type ApiDispatchResponse,
  type ApiRouteDefinition,
} from "./apiRouteDispatcher.js";
import registerHandler from "../api-handlers/academy/register.js";
import sessionHandler from "../api-handlers/academy/session.js";
import teachersHandler from "../api-handlers/academy/teachers.js";
import managementHandler from "../api-handlers/academy/management.js";

const routes: ApiRouteDefinition[] = [
  defineApiRoute(["register"], registerHandler),
  defineApiRoute(["session"], sessionHandler),
  defineApiRoute(["teachers"], teachersHandler),
  defineApiRoute(["management"], managementHandler),
];

export function dispatchAcademyApi(req: ApiDispatchRequest, res: ApiDispatchResponse) {
  return dispatchApiRoutes(req, res, routes);
}
