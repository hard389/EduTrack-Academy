import test from "node:test";
import assert from "node:assert/strict";
import scheduler from "../cloudflare/whatsapp-queue-scheduler/index.mjs";

async function runTick(cron) {
  const originalFetch = globalThis.fetch;
  const paths = [];
  let scheduledPromise;

  globalThis.fetch = async (url, options) => {
    const parsedUrl = new URL(String(url));
    paths.push({
      path: parsedUrl.pathname,
      method: options?.method,
      authorization: options?.headers?.Authorization,
    });
    return { ok: true, status: 200 };
  };

  try {
    await scheduler.scheduled(
      { cron },
      {
        CRON_SECRET: "unit-test-cron-secret-that-is-at-least-32-characters",
        EDUTRACK_BASE_URL: "https://example.test/",
      },
      { waitUntil(promise) { scheduledPromise = promise; } },
    );
    if (scheduledPromise) await scheduledPromise;
    return paths;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("five-minute tick invokes only the WhatsApp queue worker", async () => {
  const paths = await runTick("*/5 * * * *");
  assert.deepEqual(paths.map((entry) => entry.path), ["/api/whatsapp/queue-worker"]);
  assert.equal(paths[0].method, "GET");
  assert.match(paths[0].authorization, /^Bearer /);
});

test("hourly tick invokes only subscription projection", async () => {
  const paths = await runTick("15 * * * *");
  assert.deepEqual(paths.map((entry) => entry.path), ["/api/whatsapp/subscription-projection-cron"]);
});

test("daily 03:00 Pakistan tick invokes failed-job cleanup at 22:00 UTC", async () => {
  const paths = await runTick("0 22 * * *");
  assert.deepEqual(paths.map((entry) => entry.path), ["/api/whatsapp/failed-job-cleanup-cron"]);
});

test("daily 09:00 Pakistan tick invokes Fee Alerts at 04:00 UTC", async () => {
  const paths = await runTick("0 4 * * *");
  assert.deepEqual(paths.map((entry) => entry.path), ["/api/whatsapp/fee-alerts-cron"]);
});
