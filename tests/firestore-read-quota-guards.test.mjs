import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('teacher message metrics filters the Pakistan day in Firestore and caps per-collection reads', () => {
  const source = read('server/teacherMessageMetrics.ts');
  assert.match(source, /DAILY_METRIC_QUERY_LIMIT = 250/);
  assert.match(source, /where\('createdAt', '>=', Timestamp\.fromDate\(start\)\)/);
  assert.match(source, /where\('createdAt', '<', Timestamp\.fromDate\(end\)\)/);
  assert.match(source, /limit\(DAILY_METRIC_QUERY_LIMIT \+ 1\)/);
  assert.doesNotMatch(source, /limit\(5000\)/);
});

test('monthly analytics has bounded pages and does not fan out to every recipient subcollection', () => {
  const source = read('server/teacherWhatsAppAlerts.ts');
  assert.match(source, /MONTHLY_QUERY_PAGE_SIZE = 50/);
  assert.match(source, /MONTHLY_QUERY_MAX_PAGES = 2/);
  assert.match(source, /FAILED_FEE_LIMIT = 25/);
  assert.match(source, /FAILED_DISPATCH_LIMIT = 4/);
  assert.match(source, /FAILED_RECIPIENT_LIMIT = 10/);
  assert.match(source, /Number\(parent\.dispatchingCount\) \|\| 0/);
  assert.match(source, /const baseTime = parent\.updatedAt \?\? parent\.createdAt/);
  const start = source.indexOf('async function addDispatchSummary(');
  const end = source.indexOf('\nasync function loadMonthAnalytics', start);
  assert.ok(start >= 0 && end > start, 'addDispatchSummary source range must exist');
  const summary = source.slice(start, end);
  assert.doesNotMatch(summary, /collection\("recipients"\)[\s\S]*?\.get\(\)/);
  assert.match(summary, /return true;/, 'legacy records without counters must report partial coverage');
});

test('queue worker limits teacher scans and keeps a separate resumable maintenance cursor', () => {
  const source = read('server/whatsappQueueWorker.ts');
  assert.match(source, /DEFAULT_MAX_TENANTS_PER_RUN = 1/);
  assert.match(source, /MAX_TENANTS_PER_RUN = 5/);
  assert.match(source, /MAINTENANCE_INTERVAL_MS = 24 \* 60 \* 60_000/);
  assert.match(source, /maintenanceCursorEmail/);
  assert.match(source, /MAX_QUERY_PAGES_PER_PASS = 1/);
  assert.match(source, /DEFAULT_BATCH_SIZE = 1/);
  assert.doesNotMatch(source, /\.limit\(1000\)/);
});
