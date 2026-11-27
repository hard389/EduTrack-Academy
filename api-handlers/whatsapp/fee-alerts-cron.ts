import type {
  ApiDispatchRequest,
  ApiDispatchResponse,
} from "../../server/apiRouteDispatcher.js";
import { runFeeAlertsWhatsAppCron } from "../../server/feeAlertsWhatsApp.js";

function readHeader(
  headers: ApiDispatchRequest["headers"] | undefined,
  name: string,
): string {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function safeInfrastructureError(error: unknown): { errorName: string; errorCode: string; quotaExceeded: boolean } {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown }
    : {};
  const rawCode = typeof candidate.code === "number" || typeof candidate.code === "string"
    ? String(candidate.code)
    : "";
  const rawMessage = typeof candidate.message === "string" ? candidate.message : "";
  const knownCodes = [
    "RESOURCE_EXHAUSTED", "DEADLINE_EXCEEDED", "UNAVAILABLE",
    "PERMISSION_DENIED", "FAILED_PRECONDITION", "ABORTED", "INVALID_ARGUMENT",
  ];
  const match = knownCodes.find((code) =>
    rawCode.toUpperCase() === code || rawMessage.toUpperCase().includes(code),
  );
  const errorCode = match ?? (rawCode === "8" ? "RESOURCE_EXHAUSTED" : "OTHER");
  return {
    errorName,
    errorCode,
    quotaExceeded: errorCode === "RESOURCE_EXHAUSTED" || /quota exceeded/i.test(rawMessage),
  };
}

export default async function feeAlertsCronHandler(
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
  if (!cronSecret) {
    return res.status(503).json({ success: false, error: "Cron authorization is not configured." });
  }
  const authorization = readHeader(req.headers, "authorization");
  if (authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ success: false, error: "Unauthorized cron request." });
  }

  try {
    const result = await runFeeAlertsWhatsAppCron();

    console.info("[FeeAlertsCron] Scheduled run summary.", {
      enabled: result.enabled,
      reason: typeof result.reason === "string"
        ? result.reason.slice(0, 180)
        : undefined,
      tenantsChecked: result.tenantsChecked,
      tenantsScanned: result.tenantsScanned,
      tenantBatchLimit: result.tenantBatchLimit,
      queued: result.queued,
      jobsProcessed: result.jobsProcessed,
      acceptedByProvider: result.acceptedByProvider,
      providerRejected: result.providerRejected,
      unknownOutcome: result.unknownOutcome,
      blocked: result.blocked,
      skipped: result.skipped,
    });

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("[FeeAlertsCron] Scheduled fee-alert run failed.", safeInfrastructureError(error));
    return res.status(500).json({
      success: false,
      error: "The scheduled fee-alert run could not complete. Check Vercel Runtime Logs.",
    });
  }
}
