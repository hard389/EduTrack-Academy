import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Fee Alerts cron uses a bounded, resumable tenant page and a single-run lease", () => {
  const source = read("server/feeAlertsWhatsApp.ts");
  assert.match(source, /DEFAULT_MAX_TENANTS_PER_RUN = 10/);
  assert.match(source, /MAX_TENANTS_PER_RUN = 30/);
  assert.match(source, /where\("role", "==", "teacher"\)[\s\S]*?orderBy\(FieldPath\.documentId\(\)\)[\s\S]*?limit\(tenantLimit\)/);
  assert.match(source, /startAfter\(previousTenantCursor\)/);
  assert.match(source, /tenantCursorEmail/);
  assert.match(source, /feeAlertsWhatsAppCron/);
  assert.match(source, /FEE_ALERTS_LOCK_LEASE_MS = 110_000/);
  assert.match(source, /workerToken/);
});

test("Fee Alerts per-run pending scans and dispatch concurrency are bounded", () => {
  const source = read("server/feeAlertsWhatsApp.ts");
  assert.match(source, /MAX_PENDING_PER_TENANT = 25/);
  assert.match(source, /MAX_TOTAL_DISPATCH_PER_RUN = 10/);
  assert.match(source, /DISPATCH_CONCURRENCY = 5/);
});

test("Queue worker starts with one tenant and one dispatch batch per minute", () => {
  const source = read("server/whatsappQueueWorker.ts");
  assert.match(source, /DEFAULT_MAX_TENANTS_PER_RUN = 1/);
  assert.match(source, /DEFAULT_TENANT_BATCHES_PER_RUN = 1/);
  assert.match(source, /DEFAULT_BATCH_SIZE = 1/);
});

test("API handlers log safe Firestore error classification without dumping error contents", () => {
  for (const path of [
    "api-handlers/whatsapp/queue-worker.ts",
    "api-handlers/whatsapp/fee-alerts-cron.ts",
  ]) {
    const source = read(path);
    assert.match(source, /RESOURCE_EXHAUSTED/);
    assert.match(source, /quotaExceeded/);
    assert.match(source, /safeInfrastructureError\(error\)/);
  }
});

test("WhatsApp dashboard Firestore snapshots have explicit structural result types", () => {
  const source = read("server/teacherWhatsAppAlerts.ts");
  assert.match(source, /type DashboardQuerySnapshot =/);
  assert.match(source, /type DashboardDocumentSnapshot =/);
  assert.match(source, /as unknown as DashboardQuerySnapshot/);
  assert.match(source, /as unknown as DashboardDocumentSnapshot/);
});
