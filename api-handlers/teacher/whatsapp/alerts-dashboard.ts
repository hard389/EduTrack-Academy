import type { TeacherApiRequest } from "../../../server/teacherAuth.js";
import {
  getTeacherWhatsAppAlertsDashboard,
  sendTeacherWhatsAppAlertsDashboardError,
} from "../../../server/teacherWhatsAppAlerts.js";

type Request = TeacherApiRequest & {
  method?: string;
  query?: Record<string, unknown>;
};
type Response = {
  setHeader(name: string, value: string): void;
  status(code: number): Response;
  json(data: unknown): unknown;
};

export default async function handler(req: Request, res: Response): Promise<unknown> {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }
  try {
    return res.status(200).json(await getTeacherWhatsAppAlertsDashboard(req));
  } catch (error) {
    return sendTeacherWhatsAppAlertsDashboardError(res, error);
  }
}
