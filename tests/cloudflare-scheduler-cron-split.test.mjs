import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import scheduler from '../cloudflare/whatsapp-queue-scheduler/index.mjs';

const env = {
  CRON_SECRET: 'x'.repeat(48),
  EDUTRACK_BASE_URL: 'https://example.invalid/',
};

async function invoke(cron) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, authorization: init?.headers?.Authorization });
    return { ok: true, status: 200 };
  };
  try {
    let pending;
    await scheduler.scheduled({ cron }, env, { waitUntil: (promise) => { pending = promise; } });
    await pending;
    return calls;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('five-minute queue cron invokes only the shared WhatsApp queue worker', async () => {
  const calls = await invoke('*/5 * * * *');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/whatsapp/queue-worker');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].authorization, `Bearer ${env.CRON_SECRET}`);
});

test('hourly subscription projection cron invokes only the projection endpoint', async () => {
  const calls = await invoke('15 * * * *');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/whatsapp/subscription-projection-cron');
  assert.equal(calls[0].authorization, `Bearer ${env.CRON_SECRET}`);
});

test('daily 03:00 Pakistan cleanup cron maps to 22:00 UTC', async () => {
  const calls = await invoke('0 22 * * *');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/whatsapp/failed-job-cleanup-cron');
  assert.equal(calls[0].authorization, `Bearer ${env.CRON_SECRET}`);
});

test('daily 09:00 Pakistan Fee Alerts cron maps to 04:00 UTC', async () => {
  const calls = await invoke('0 4 * * *');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/whatsapp/fee-alerts-cron');
  assert.equal(calls[0].authorization, `Bearer ${env.CRON_SECRET}`);
});

test('attendance notifications remain routed through the shared queue worker', () => {
  const worker = readFileSync(new URL('../server/whatsappQueueWorker.ts', import.meta.url), 'utf8');
  const queuePreparation = readFileSync(new URL('../server/attendanceNotifications.ts', import.meta.url), 'utf8');
  assert.match(queuePreparation, /status\s*=\s*!hasPhone\s*\?\s*"blocked_missing_phone"[\s\S]*?:\s*!optedIn[\s\S]*?:\s*"prepared_for_vercel"/);
  assert.match(worker, /where\("status",\s*"==",\s*"prepared_for_vercel"\)/);
  assert.match(worker, /kind\s*===\s*"attendance_absent"[\s\S]*?dispatchAttendanceNotification\(request\)/);
});

test('unknown cron does not call application endpoints', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, status: 200 }; };
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await scheduler.scheduled({ cron: '0 5 * * *' }, env, { waitUntil: () => undefined });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
