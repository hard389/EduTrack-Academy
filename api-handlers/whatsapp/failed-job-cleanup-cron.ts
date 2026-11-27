import type { ApiDispatchRequest, ApiDispatchResponse } from "../../server/apiRouteDispatcher.js";
import { getFirebaseAdminFirestore } from "../../server/firebaseAdmin.js";
import { cleanupExpiredWhatsAppFailedJobs } from "../../server/whatsappFailedJobCleanup.js";

function readHeader(headers: ApiDispatchRequest["headers"] | undefined, name: string): string {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

export default async function failedJobCleanupCronHandler(
  req: ApiDispatchRequest,
  res: ApiDispatchResponse,
): Promise<unknown> {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  const cronSecret = process.env.CRON_SECRET?.trim() ?? "";
  if (!cronSecret) return res.status(503).json({ success: false, error: "Cron authorization is not configured." });
  if (readHeader(req.headers, "authorization") !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ success: false, error: "Unauthorized cron request." });
  }

  try {
    const deleted = await cleanupExpiredWhatsAppFailedJobs(getFirebaseAdminFirestore());
    console.info("[WhatsAppFailedJobCleanupCron] Scheduled run summary.", { deleted });
    return res.status(200).json({ success: true, deleted });
  } catch (error) {
    const candidate = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
    const code = typeof candidate.code === "string" || typeof candidate.code === "number" ? String(candidate.code) : "OTHER";
    const message = typeof candidate.message === "string" ? candidate.message : "";
    const quotaExceeded = code === "8" || code.toUpperCase() === "RESOURCE_EXHAUSTED" || /quota exceeded/i.test(message);
    console.error("[WhatsAppFailedJobCleanupCron] Scheduled run failed.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: quotaExceeded ? "RESOURCE_EXHAUSTED" : code,
    });
    return res.status(500).json({ success: false, error: "Expired WhatsApp cleanup could not complete. Check Vercel Runtime Logs." });
  }
}
