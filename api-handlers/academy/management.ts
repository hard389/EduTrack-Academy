import type { ApiDispatchRequest, ApiDispatchResponse } from '../../server/apiRouteDispatcher.js';
import { handleAcademyManagement } from '../../server/academyManagement.js';

export default function handler(request: ApiDispatchRequest, response: ApiDispatchResponse) {
  return handleAcademyManagement(request, response);
}
