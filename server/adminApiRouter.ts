import {
  defineApiRoute,
  dispatchApiRoutes,
  type ApiDispatchRequest,
  type ApiDispatchResponse,
  type ApiRouteDefinition
} from "./apiRouteDispatcher.js";

import dashboardHandler from "../api-handlers/admin/dashboard.js";
import healthHandler from "../api-handlers/admin/health.js";
import customerGroupsHandler from "../api-handlers/admin/customer-groups.js";
import customersHandler from "../api-handlers/admin/customers.js";
import passwordResetHandler from "../api-handlers/admin/customers/[uid]/password-reset.js";
import customerStatusHandler from "../api-handlers/admin/customers/[uid]/status.js";

import attendanceDispatchHandler from "../api-handlers/admin/whatsapp/attendance-dispatch.js";
import monthlyReportDispatchHandler from "../api-handlers/admin/whatsapp/monthly-report-dispatch.js";
import confirmTestHandler from "../api-handlers/admin/whatsapp/confirm-test-received.js";
import whatsappSettingsHandler from "../api-handlers/admin/whatsapp/settings.js";
import whatsappTeacherHandler from "../api-handlers/admin/whatsapp/teachers/[uid].js";
import testConnectionHandler from "../api-handlers/admin/whatsapp/test-connection.js";
import testSendHandler from "../api-handlers/admin/whatsapp/test-send.js";
import subscriptionsHandler from "../api-handlers/admin/subscriptions.js";
import subscriptionSettingsHandler from "../api-handlers/admin/subscription-settings.js";
import subscriptionReviewsHandler from "../api-handlers/admin/subscription-reviews.js";
import subscriptionReceiptHandler from "../api-handlers/admin/subscription-receipt.js";
import whatsappNumberScannerSettingsHandler from "../api-handlers/admin/whatsapp-number-verification-settings.js";
import gradingPresetsHandler from "../api-handlers/admin/grading-presets.js";
import teacherAnnouncementHandler from "../api-handlers/admin/teacher-announcement.js";

const routes: ApiRouteDefinition[] = [
  defineApiRoute(["dashboard"], dashboardHandler),
  defineApiRoute(["health"], healthHandler),
  defineApiRoute(["customer-groups"], customerGroupsHandler),
  defineApiRoute(["customers"], customersHandler),
  defineApiRoute(["customers", ":uid", "password-reset"], passwordResetHandler),
  defineApiRoute(["customers", ":uid", "status"], customerStatusHandler),

  defineApiRoute(["whatsapp", "attendance-dispatch"], attendanceDispatchHandler),
  defineApiRoute(["whatsapp", "monthly-report-dispatch"], monthlyReportDispatchHandler),
  defineApiRoute(["whatsapp", "confirm-test-received"], confirmTestHandler),
  defineApiRoute(["whatsapp", "settings"], whatsappSettingsHandler),
  defineApiRoute(["whatsapp", "teachers", ":uid"], whatsappTeacherHandler),
  defineApiRoute(["whatsapp", "test-connection"], testConnectionHandler),
  defineApiRoute(["whatsapp", "test-send"], testSendHandler),
  // Dedicated number-scanner configuration; separate from the WhatsApp message automation settings.
  defineApiRoute(["whatsapp-number-verification", "settings"], whatsappNumberScannerSettingsHandler),

  defineApiRoute(["subscriptions"], subscriptionsHandler),
  defineApiRoute(["subscription-settings"], subscriptionSettingsHandler),
  defineApiRoute(["subscription-reviews"], subscriptionReviewsHandler),
  defineApiRoute(["subscription-receipt"], subscriptionReceiptHandler),
  defineApiRoute(["grading-presets"], gradingPresetsHandler),
  defineApiRoute(["teacher-announcement"], teacherAnnouncementHandler)
];

export function dispatchAdminApi(
  req: ApiDispatchRequest,
  res: ApiDispatchResponse
): Promise<unknown> {
  return dispatchApiRoutes(req, res, routes);
}
