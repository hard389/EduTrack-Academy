import type { ApiDispatchRequest, ApiDispatchResponse } from "../../server/apiRouteDispatcher.js";
import { getFirebaseAdminFirestore } from "../../server/firebaseAdmin.js";
import { refreshDueSubscriptionProjections } from "../../server/subscriptionProjectionRefresh.js";

function readHeader(headers: ApiDispatchRequest["headers"] | undefined, name: string): string {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

export default async function subscriptionProjectionCronHandler(
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
    const result = await refreshDueSubscriptionProjections(getFirebaseAdminFirestore());
    console.info("[SubscriptionProjectionCron] Scheduled run summary.", result);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    const candidate = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
    const code = typeof candidate.code === "string" || typeof candidate.code === "number" ? String(candidate.code) : "OTHER";
    const message = typeof candidate.message === "string" ? candidate.message : "";
    const quotaExceeded = code === "8" || code.toUpperCase() === "RESOURCE_EXHAUSTED" || /quota exceeded/i.test(message);
    console.error("[SubscriptionProjectionCron] Scheduled run failed.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: quotaExceeded ? "RESOURCE_EXHAUSTED" : code,
    });
    return res.status(500).json({ success: false, error: "The scheduled subscription refresh could not complete. Check Vercel Runtime Logs." });
  }
}
