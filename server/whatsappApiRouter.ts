import {
  defineApiRoute,
  dispatchApiRoutes,
  type ApiDispatchRequest,
  type ApiDispatchResponse,
  type ApiRouteDefinition
} from "./apiRouteDispatcher.js";

import monthlyReportMediaHandler from "../api-handlers/whatsapp/monthly-report-media.js";
import quizResultsHandler from "../api-handlers/whatsapp/quiz-results.js";
import feeAlertsCronHandler from "../api-handlers/whatsapp/fee-alerts-cron.js";
import announcementBroadcastHandler from "../api-handlers/whatsapp/announcement-broadcast.js";
import notificationImageHandler from "../api-handlers/whatsapp/notification-image.js";
import queueWorkerHandler from "../api-handlers/whatsapp/queue-worker.js";
import subscriptionProjectionCronHandler from "../api-handlers/whatsapp/subscription-projection-cron.js";
import failedJobCleanupCronHandler from "../api-handlers/whatsapp/failed-job-cleanup-cron.js";

const routes: ApiRouteDefinition[] = [
  defineApiRoute(["monthly-report-media"], monthlyReportMediaHandler),
  defineApiRoute(["quiz-results"], quizResultsHandler),
  defineApiRoute(["fee-alerts-cron"], feeAlertsCronHandler),
  defineApiRoute(["announcement-broadcast"], announcementBroadcastHandler),
  defineApiRoute(["notification-image"], notificationImageHandler),
  defineApiRoute(["queue-worker"], queueWorkerHandler),
  defineApiRoute(["subscription-projection-cron"], subscriptionProjectionCronHandler),
  defineApiRoute(["failed-job-cleanup-cron"], failedJobCleanupCronHandler)
];

export function dispatchWhatsAppApi(
  req: ApiDispatchRequest,
  res: ApiDispatchResponse
): Promise<unknown> {
  return dispatchApiRoutes(req, res, routes);
}
