const QUEUE_WORKER_PATH = "/api/whatsapp/queue-worker";
const FEE_ALERTS_PATH = "/api/whatsapp/fee-alerts-cron";
const SUBSCRIPTION_PROJECTION_PATH = "/api/whatsapp/subscription-projection-cron";
const FAILED_JOB_CLEANUP_PATH = "/api/whatsapp/failed-job-cleanup-cron";

// A single five-minute Cron Trigger dispatches all four Academy jobs.
// Cloudflare Cron Triggers use UTC; Pakistan is UTC+5.
// Queue: every five minutes.
// Subscription projection: hourly at minute 15.
// Failed-job cleanup: daily at 22:00 UTC (03:00 Asia/Karachi).
// Fee alerts: daily at 04:00 UTC (09:00 Asia/Karachi).

function resolveBaseUrl(value) {
  const base = new URL(String(value || ""));
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new Error("EDUTRACK_BASE_URL must be an HTTPS origin without embedded credentials.");
  }
  return base;
}

async function invokeEndpoint(baseUrl, path, cronSecret) {
  const url = new URL(path, baseUrl);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      "Cache-Control": "no-store",
      "User-Agent": "EduTrack-Academy-Cloudflare-Scheduler/1.0",
    },
    redirect: "manual",
  });

  if (!response.ok) {
    // Never log response bodies or authorization headers.
    throw new Error(`${path} returned HTTP ${response.status}.`);
  }
  return { path, status: response.status };
}

async function runScheduledEndpoint(env, path) {
  const cronSecret = String(env.CRON_SECRET || "").trim();
  if (cronSecret.length < 32) {
    throw new Error("Cloudflare secret CRON_SECRET is missing or too short.");
  }
  const baseUrl = resolveBaseUrl(env.EDUTRACK_BASE_URL);
  const result = await invokeEndpoint(baseUrl, path, cronSecret);
  console.log(JSON.stringify({ event: "edutrack_scheduled_endpoint_ok", ...result }));
}

async function runDueEndpoints(env, scheduledTime) {
  const hour = scheduledTime.getUTCHours();
  const minute = scheduledTime.getUTCMinutes();
  const paths = [QUEUE_WORKER_PATH];

  if (minute === 15) {
    paths.push(SUBSCRIPTION_PROJECTION_PATH);
  }
  if (minute === 0 && hour === 22) {
    paths.push(FAILED_JOB_CLEANUP_PATH);
  }
  if (minute === 0 && hour === 4) {
    paths.push(FEE_ALERTS_PATH);
  }

  const results = await Promise.allSettled(
    paths.map((path) => runScheduledEndpoint(env, path)),
  );

  const failures = results.filter((result) => result.status === "rejected");
  for (const failure of failures) {
    console.error(JSON.stringify({
      event: "edutrack_scheduled_endpoint_failed",
      message: String(failure.reason?.message || "Unknown scheduled endpoint failure"),
    }));
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${paths.length} scheduled endpoint(s) failed.`);
  }
}

export default {
  async scheduled(controller, env, ctx) {
    const scheduledTime = new Date(controller.scheduledTime);
    if (Number.isNaN(scheduledTime.getTime())) {
      throw new Error("Cloudflare supplied an invalid scheduledTime.");
    }
    ctx.waitUntil(runDueEndpoints(env, scheduledTime));
  },
};
