import type { Firestore } from "firebase-admin/firestore";
import { hasAttendanceDispatchAuthorization } from "./attendanceDispatchAuthorization.js";
import {
  resolveTeacherWhatsAppSender,
  TeacherWhatsAppSenderError,
} from "./teacherWhatsAppSender.js";
import { buildAttendanceDispatchReadiness } from "./attendanceDispatchReadinessDomain.mjs";

type Settings = Record<string, unknown>;

/**
 * Resolve the same sender that the actual dispatch endpoint will use.
 * This intentionally supports both a verified teacher-personal sender and
 * the central sender; checking only central Postabi credentials falsely
 * disables the UI/queue for teachers who selected a personal sender.
 */
export async function getAttendanceDispatchReadiness(
  db: Firestore,
  teacherUid: string,
  settings: Settings,
): Promise<{ available: boolean; blockers: string[] }> {
  const serverEnabled = process.env.WHATSAPP_ATTENDANCE_DISPATCH_ENABLED === "true";
  const adminAuthorized = hasAttendanceDispatchAuthorization(settings);

  if (!serverEnabled || !adminAuthorized) {
    return buildAttendanceDispatchReadiness({
      serverEnabled,
      adminAuthorized,
      senderReady: false,
    });
  }

  try {
    await resolveTeacherWhatsAppSender(db, teacherUid, settings);
    return buildAttendanceDispatchReadiness({
      serverEnabled,
      adminAuthorized,
      senderReady: true,
    });
  } catch (error) {
    const senderError = error instanceof TeacherWhatsAppSenderError
      ? error.message
      : "The configured WhatsApp sender could not be verified. No message was sent.";
    return buildAttendanceDispatchReadiness({
      serverEnabled,
      adminAuthorized,
      senderReady: false,
      senderError,
    });
  }
}
