import type { TeacherApiRequest } from "../../../server/teacherAuth.js";
import { listAttendanceNotificationJobs } from "../../../server/attendanceJobs.js";
import { TeacherApiAuthError } from "../../../server/teacherAuth.js";

type Request = TeacherApiRequest & {
  method?: string;
};

type Response = {
  setHeader(name: string, value: string): void;
  status(code: number): Response;
  json(data: unknown): unknown;
};

export default async function handler(
  req: Request,
  res: Response,
): Promise<unknown> {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      success: false,
      error: "Method not allowed.",
    });
  }

  try {
    return res.status(200).json(
      await listAttendanceNotificationJobs(req),
    );
  } catch (error) {
    if (error instanceof TeacherApiAuthError) {
      return res.status(error.status).json({
        success: false,
        error: error.message,
      });
    }

    console.error("[AttendanceJobs] Could not list notification jobs.", error);

    return res.status(500).json({
      success: false,
      error: "Attendance notification jobs could not be loaded.",
    });
  }
}
