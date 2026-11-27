import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import whatsappScheduler from "../cloudflare/whatsapp-queue-scheduler/index.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const worker = read("server/whatsappQueueWorker.ts");
const reconcile = read("server/whatsappReconciliation.ts");
const alerts = read("src/pages/alerts.tsx");
const firestoreRules = read("firestore.rules");
const quiz = read("server/quizResultsWhatsApp.ts");
const monthly = read("server/monthlyReportNotifications.ts");
const vercel = JSON.parse(read("vercel.json"));
const cloudflareScheduler = read("cloudflare/whatsapp-queue-scheduler/index.mjs");
const cloudflareSchedulerConfig = JSON.parse(read("cloudflare/whatsapp-queue-scheduler/wrangler.jsonc"));

test("queue worker has a Firestore lease and bounded, configurable batches", () => {
  assert.match(worker, /platformLocks/);
  assert.match(worker, /workerToken/);
  assert.match(worker, /WHATSAPP_QUEUE_BATCH_SIZE/);
  assert.match(worker, /MAX_BATCH_SIZE = 10/);
  assert.match(worker, /tenantCursorEmail/);
  assert.match(worker, /FieldPath\.documentId\(\)/);
  assert.match(worker, /LOCK_LEASE_MS = 110_000/);
});

test("stale provider claims become unknown outcomes and are never auto-requeued", () => {
  assert.match(worker, /status: "unknown_outcome"/);
  assert.match(worker, /retrySafe: false/);
  assert.match(worker, /Automatic retry was blocked to prevent duplicates/);
  assert.match(worker, /staleClaimsLastReconciledAt/);
});

test("WhatsApp failures are represented in Alerts and support teacher reconciliation", () => {
  assert.match(worker, /category: "WhatsApp"/);
  assert.match(worker, /whatsappReconciliationRequired/);
  assert.match(worker, /lastPreProviderFailureAt/);
  assert.match(alerts, /WhatsApp/);
  assert.match(alerts, /confirmed_not_sent/);
  assert.match(alerts, /confirmed_sent/);
  assert.match(reconcile, /verifyTeacherRequest/);
  assert.match(reconcile, /operator_confirmed_sent/);
  assert.match(reconcile, /operatorRetryApprovedAt/);
});

test("quiz results use a deterministic dispatch and immutable recipient claims; monthly reports keep permanent one-time locks", () => {
  assert.match(quiz, /createQuizResultsDispatchId\(/);
  assert.match(quiz, /whatsappQuizResultDispatches/);
  assert.match(quiz, /existing\.contentHash !== snapshot\.contentHash/);
  assert.match(quiz, /createQuizResultsRecipientKey\(studentId\)/);
  assert.match(quiz, /if \(recipientSnapshot\.exists\)/);
  assert.match(quiz, /Automatic retry is blocked to prevent duplicates/);
  assert.doesNotMatch(quiz, /whatsappOneTimeLocks/);
  assert.match(monthly, /whatsappOneTimeLocks/);
  assert.match(monthly, /monthly_report_whatsapp_v1/);
  assert.match(monthly, /whatsAppOneTimeLockContentHash/);
  assert.match(monthly, /operator_confirmed_sent/);
  assert.match(firestoreRules, /match \/whatsappOneTimeLocks\/\{lockId\}/);
  assert.match(firestoreRules, /allow read, write: if false;/);
});

test("announcement and library queues preserve stable recipient records and never auto-retry uncertain HTTP 429 outcomes", () => {
  const announcements = read("server/announcementsWhatsApp.ts");
  const library = read("server/libraryLinkWhatsApp.ts");
  assert.match(announcements, /createAnnouncementRecipientKey\(/);
  assert.match(announcements, /whatsappAnnouncementDispatches/);
  assert.match(announcements, /providerResult\.httpStatus !== 429/);
  assert.match(announcements, /else finalStatus = "unknown_outcome"/);
  assert.match(announcements, /retrySafe: false/);
  assert.match(announcements, /Only a definitive provider-rejected announcement can be retried/);
  assert.match(announcements, /\[408, 409, 425, 429\]\.includes\(providerHttpStatus\)/);
  assert.match(library, /whatsappLibraryLinkDispatches/);
  assert.match(library, /batch\.create\(dispatchRef\.collection\('recipients'\)/);
  assert.match(library, /provider\.httpStatus !== 429/);
  assert.match(library, /: 'unknown_outcome'/);
  assert.match(library, /recipients\.length > 500/);
  assert.doesNotMatch(announcements, /finalStatus = "retry_wait"/);
  assert.doesNotMatch(library, /status: 'retry_wait'/);
});

test("Cloudflare schedules persistent Vercel queue endpoints while Vercel Hobby has no unsupported Cron entries", () => {
  assert.equal(vercel.crons, undefined);
  assert.deepEqual(cloudflareSchedulerConfig.triggers.crons, ["*/5 * * * *", "15 * * * *", "0 22 * * *", "0 4 * * *"]);
  assert.match(cloudflareScheduler, /controller\.cron === QUEUE_CRON_UTC[\s\S]*?QUEUE_WORKER_PATH/);
  assert.match(cloudflareScheduler, /controller\.cron === FEE_ALERTS_CRON_UTC[\s\S]*?FEE_ALERTS_PATH/);
  assert.match(cloudflareScheduler, /controller\.cron === FAILED_JOB_CLEANUP_CRON_UTC[\s\S]*?FAILED_JOB_CLEANUP_PATH/);
  assert.match(cloudflareScheduler, /controller\.cron === SUBSCRIPTION_PROJECTION_CRON_UTC[\s\S]*?SUBSCRIPTION_PROJECTION_PATH/);
  assert.match(cloudflareScheduler, /Authorization: `Bearer \$\{cronSecret\}`/);
  assert.equal(vercel.functions["api/whatsapp.ts"].maxDuration, 300);
});


test("Cloudflare scheduler routes minute and hourly cron triggers to separate secured Vercel endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const secret = "s".repeat(48);
  const pending = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response("{\"success\":true}", { status: 200 });
  };

  try {
    for (const cron of ["*/5 * * * *", "15 * * * *", "0 22 * * *", "0 4 * * *"]) {
      await whatsappScheduler.scheduled(
        { cron },
        { CRON_SECRET: secret, EDUTRACK_BASE_URL: "https://edutrack.example" },
        { waitUntil(promise) { pending.push(promise); } },
      );
      await pending[pending.length - 1];
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests.map((request) => new URL(request.url).pathname).sort(), [
    "/api/whatsapp/queue-worker",
    "/api/whatsapp/subscription-projection-cron",
    "/api/whatsapp/failed-job-cleanup-cron",
    "/api/whatsapp/fee-alerts-cron",
  ].sort());
  for (const request of requests) {
    assert.equal(request.options.method, "GET");
    assert.equal(request.options.headers.Authorization, `Bearer ${secret}`);
    assert.equal(request.options.redirect, "manual");
  }
});

test("Cloudflare scheduler fails loudly when either scheduled endpoint fails", async () => {
  const originalFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });

  try {
    for (const cron of ["*/5 * * * *", "15 * * * *", "0 22 * * *", "0 4 * * *"]) {
      await whatsappScheduler.scheduled(
        { cron },
        { CRON_SECRET: "s".repeat(48), EDUTRACK_BASE_URL: "https://edutrack.example" },
        { waitUntil(promise) { pending.push(promise); } },
      );
    }
    await assert.rejects(Promise.all(pending), /returned HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
