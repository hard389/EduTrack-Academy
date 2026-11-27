import {
  defineApiRoute,
  dispatchApiRoutes,
  type ApiDispatchRequest,
  type ApiDispatchResponse,
  type ApiRouteDefinition
} from "./apiRouteDispatcher.js";

import attendanceDispatchHandler from "../api-handlers/teacher/attendance/dispatch.js";
import attendanceJobsHandler from "../api-handlers/teacher/attendance/jobs.js";
import attendanceQueueHandler from "../api-handlers/teacher/attendance/queue.js";
import attendanceReconcileHandler from "../api-handlers/teacher/attendance/reconcile.js";
import attendanceRetryHandler from "../api-handlers/teacher/attendance/retry.js";
import attendanceRetryableHandler from "../api-handlers/teacher/attendance/retryable.js";

import monthlyDispatchHandler from "../api-handlers/teacher/monthly-reports/dispatch.js";
import monthlyPrepareHandler from "../api-handlers/teacher/monthly-reports/prepare.js";
import monthlyReconcileHandler from "../api-handlers/teacher/monthly-reports/reconcile.js";
import announcementQuotaHandler from "../api-handlers/teacher/announcements/quota.js";
import libraryLinkDispatchHandler from "../api-handlers/teacher/library-links/dispatch.js";
import teacherMessageMetricsHandler from "../api-handlers/teacher/message-metrics.js";
import teacherWhatsAppAlertsDashboardHandler from "../api-handlers/teacher/whatsapp/alerts-dashboard.js";
import teacherWhatsAppReconcileHandler from "../api-handlers/teacher/whatsapp/reconcile.js";
import teacherStudentAddHandler from "../api-handlers/teacher/students-add.js";
import teacherGradingPresetsHandler from "../api-handlers/teacher/grading-presets.js";
import teacherAdminAnnouncementHandler from "../api-handlers/teacher/admin-announcement.js";

import whatsappNumberVerificationHandler from "../api-handlers/teacher/whatsapp-number-verification-check.js";
import registrationWhatsAppNumberCheckHandler from "../api-handlers/teacher/registration-whatsapp-number-check.js";
import { assertTeacherFeatureEntitlement } from "./subscriptionEntitlements.js";

function featureGuard(handler: unknown, feature: 'attendance_alerts' | 'monthly_reports') {
  return async (req: ApiDispatchRequest, res: ApiDispatchResponse) => {
    try {
      await assertTeacherFeatureEntitlement(req as Parameters<typeof assertTeacherFeatureEntitlement>[0], feature);
      return await (handler as (request: ApiDispatchRequest, response: ApiDispatchResponse) => unknown)(req, res);
    } catch (error) {
      const status = Number((error as { status?: unknown })?.status);
      const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
      const message = safeStatus >= 500 ? 'The request could not be completed.' : error instanceof Error ? error.message : 'Access denied.';
      res.setHeader('Cache-Control', 'no-store');
      return res.status(safeStatus).json({ success: false, error: message });
    }
  };
}

const routes: ApiRouteDefinition[] = [
  // These endpoints only operate the Attendance Alerts WhatsApp job pipeline.
  // Attendance CRUD remains available to every plan through the attendance data path.
  defineApiRoute(["attendance", "dispatch"], featureGuard(attendanceDispatchHandler, 'attendance_alerts')),
  defineApiRoute(["attendance", "jobs"], featureGuard(attendanceJobsHandler, 'attendance_alerts')),
  defineApiRoute(["attendance", "queue"], featureGuard(attendanceQueueHandler, 'attendance_alerts')),
  defineApiRoute(["attendance", "reconcile"], featureGuard(attendanceReconcileHandler, 'attendance_alerts')),
  defineApiRoute(["attendance", "retry"], featureGuard(attendanceRetryHandler, 'attendance_alerts')),
  defineApiRoute(["attendance", "retryable"], featureGuard(attendanceRetryableHandler, 'attendance_alerts')),

  defineApiRoute(["monthly-reports", "dispatch"], featureGuard(monthlyDispatchHandler, 'monthly_reports')),
  defineApiRoute(["monthly-reports", "prepare"], featureGuard(monthlyPrepareHandler, 'monthly_reports')),
  defineApiRoute(["monthly-reports", "reconcile"], featureGuard(monthlyReconcileHandler, 'monthly_reports')),
  defineApiRoute(["announcements", "quota"], announcementQuotaHandler),
  defineApiRoute(["library-links", "dispatch"], libraryLinkDispatchHandler),
  defineApiRoute(["message-metrics"], teacherMessageMetricsHandler),
  defineApiRoute(["whatsapp", "alerts-dashboard"], teacherWhatsAppAlertsDashboardHandler),
  // Server-side student creation revalidates Academy membership, assignment and permission.
  defineApiRoute(["students", "add"], teacherStudentAddHandler),
  // Teacher-owned reconciliation only updates the matching tenant's persistent queue record.
  defineApiRoute(["whatsapp", "reconcile"], teacherWhatsAppReconcileHandler),

  // Public WhatsApp number lookup used by Academy Registration (not teacher account creation).
  defineApiRoute(["registration", "whatsapp-number-check"], registrationWhatsAppNumberCheckHandler),
  // Authenticated teacher lookup for Add/Edit Student and Excel/CSV import.
  defineApiRoute(["whatsapp-number-verification", "check"], whatsappNumberVerificationHandler),
  defineApiRoute(["grading-presets"], featureGuard(teacherGradingPresetsHandler, 'monthly_reports')),
  defineApiRoute(["admin-announcement"], teacherAdminAnnouncementHandler)
];

export function dispatchTeacherApi(
  req: ApiDispatchRequest,
  res: ApiDispatchResponse
): Promise<unknown> {
  return dispatchApiRoutes(req, res, routes);
}
