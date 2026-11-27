import {
  dispatchQuizResultsWhatsApp,
  QuizResultsWhatsAppError,
} from "../../server/quizResultsWhatsApp.js";
import { TeacherApiAuthError, type TeacherApiRequest } from "../../server/teacherAuth.js";
import type { ApiDispatchRequest, ApiDispatchResponse } from "../../server/apiRouteDispatcher.js";

export default async function handler(
  req: ApiDispatchRequest,
  res: ApiDispatchResponse,
): Promise<unknown> {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  try {
    const result = await dispatchQuizResultsWhatsApp(req as ApiDispatchRequest & TeacherApiRequest);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    const status = error instanceof TeacherApiAuthError || error instanceof QuizResultsWhatsAppError
      ? error.status
      : 500;
    if (status >= 500) {
      console.error("[QuizResultsWhatsAppRoute] Request failed.", error instanceof Error ? error.name : "UnknownError");
    }
    const message = error instanceof TeacherApiAuthError || error instanceof QuizResultsWhatsAppError
      ? error.message
      : "Quiz-result WhatsApp request could not be completed.";
    return res.status(status).json({ success: false, error: message });
  }
}
