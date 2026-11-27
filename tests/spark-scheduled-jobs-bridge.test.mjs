import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Spark scheduled jobs execute through the existing secured Vercel WhatsApp API entrypoint', () => {
  const router = read('../server/whatsappApiRouter.ts');
  const vercel = read('../vercel.json');
  const cronWorker = read('../cloudflare/whatsapp-queue-scheduler/index.mjs');
  const wrangler = read('../cloudflare/whatsapp-queue-scheduler/wrangler.jsonc');
  assert.match(router, /subscription-projection-cron/);
  assert.match(router, /failed-job-cleanup-cron/);
  assert.match(vercel, /"api\/whatsapp\.ts"\s*:\s*\{\s*"maxDuration"\s*:\s*300/s);
  assert.match(cronWorker, /SUBSCRIPTION_PROJECTION_PATH/);
  assert.match(cronWorker, /FAILED_JOB_CLEANUP_PATH/);
  assert.match(wrangler, /"\*\/5 \* \* \* \*"/);
  assert.match(wrangler, /"15 \* \* \* \*"/);
  assert.match(wrangler, /"0 22 \* \* \*"/);
  assert.match(wrangler, /"0 4 \* \* \*"/);
});

test('scheduled endpoints require the existing CRON_SECRET and reject non-GET requests', () => {
  for (const path of [
    '../api-handlers/whatsapp/subscription-projection-cron.ts',
    '../api-handlers/whatsapp/failed-job-cleanup-cron.ts',
  ]) {
    const source = read(path);
    assert.match(source, /req\.method !== "GET"/);
    assert.match(source, /process\.env\.CRON_SECRET/);
    assert.match(source, /Bearer \$\{cronSecret\}/);
  }
});

test('Vercel scheduled services use the shared Firebase Admin Firestore app, not firebase-functions', () => {
  const projection = read('../server/subscriptionProjectionRefresh.ts');
  const cleanup = read('../server/whatsappFailedJobCleanup.ts');
  assert.doesNotMatch(projection, /from ['"]firebase-functions/);
  assert.doesNotMatch(cleanup, /from ['"]firebase-functions/);
  assert.match(projection, /refreshDueSubscriptionProjections\(db: Firestore\)/);
  assert.match(cleanup, /cleanupExpiredWhatsAppFailedJobs\(db: Firestore/);
});

test('Firebase Functions export barrel no longer deploys duplicate scheduler triggers', () => {
  const index = read('../src/functions/src/index.ts');
  assert.doesNotMatch(index, /refreshSubscriptionProjections/);
  assert.doesNotMatch(index, /cleanupExpiredWhatsAppFailedJobsSchedule/);
});
