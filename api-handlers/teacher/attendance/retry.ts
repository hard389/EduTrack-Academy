import type { TeacherApiRequest } from "../../../server/teacherAuth.js";
import {
  AttendanceQueueError,
  sendAttendanceQueueApiError,
} from "../../../server/attendanceNotifications.js";

type Request = TeacherApiRequest & {
  method?: string;
  body?: unknown;
};

type Response = {
  setHeader(name: string, value: string): void;
  status(code: number): Response;
  json(data: unknown): unknown;
};
import {
  retryAttendanceJob,
} from "../../../server/attendanceNotifications.js";

export default async function handler(
  req: Request,
  res: Response,
): Promise<unknown> {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      success: false,
      error: "Method not allowed.",
    });
  }

  try {
    return res.status(200).json(await retryAttendanceJob(req));
  } catch (error) {
    return sendAttendanceQueueApiError(res, error);
  }
}
