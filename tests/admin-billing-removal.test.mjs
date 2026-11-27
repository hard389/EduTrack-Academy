import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8');

test('legacy Admin Billing and customer invoice handlers are removed', () => {
  const retiredPaths = [
    'api/admin/billing.ts',
    'api-handlers/admin/billing/[...path].ts',
    'api-handlers/admin/billing/customers/[uid].ts',
    'api-handlers/admin/billing/customers/[uid]/rate.ts',
    'api-handlers/admin/invoices.ts',
    'api-handlers/admin/invoices/[invoiceId]/status.ts',
    'server/adminInvoices.ts',
    'src/functions/lib/adminBilling.js',
    'src/functions/lib/adminBillingFirebase.js',
  ];
  for (const path of retiredPaths) assert.equal(existsSync(resolve(process.cwd(), path)), false, `${path} must not exist`);
});

test('Admin API router has no legacy invoice/Billing routes and retains subscription endpoints', () => {
  const source = read('server/adminApiRouter.ts');
  assert.doesNotMatch(source, /adminInvoices|invoicesHandler|invoiceStatusHandler|defineApiRoute\(\["invoices"/);
  for (const route of ['subscriptions', 'subscription-settings', 'subscription-reviews', 'subscription-receipt']) {
    assert.match(source, new RegExp(`defineApiRoute\\(\\["${route}"\\]`), `${route} must remain registered`);
  }
});

test('Admin UI retires Billing while preserving the separate Subscriptions page', () => {
  const app = read('src/App.tsx');
  const adminDashboard = read('src/pages/admin/AdminDashboard.tsx');
  const adminAnalytics = read('src/pages/admin/Analytics.tsx');
  const subscriptionsPage = read('src/pages/admin/Subscriptions.tsx');
  assert.match(app, /<Route path="billing" element=\{<Navigate to="\/admin\/dashboard" replace \/>\} \/>/);
  assert.doesNotMatch(adminDashboard, /invoice|billing/i);
  assert.doesNotMatch(adminAnalytics, /invoice|billing|wallet/i);
  for (const academicPanel of ['Registration pulse', 'Class-count distribution', 'Enrolment distribution', 'Teacher intelligence table']) {
    assert.ok(adminAnalytics.includes(academicPanel), `Academic Analytics panel must remain: ${academicPanel}`);
  }
  assert.match(subscriptionsPage, /Subscription invoices/);
  assert.match(app, /<Route path="subscriptions" element=\{<AdminSubscriptionsRoute \/>\} \/>/);
});

test('Admin dashboard does not duplicate subscription payment reporting', () => {
  const dashboardApi = read('api-handlers/admin/dashboard.ts');
  assert.doesNotMatch(dashboardApi, /subscriptionPayments|paymentHistory|revenue/i);
  assert.match(dashboardApi, /registrationsByMonth: createRegistrationMonths\(profiles\)/);
  assert.match(dashboardApi, /coverage: \{[\s\S]*?complete: warnings.length === 0,[\s\S]*?warnings,/);
});

test('Admin WhatsApp navigation and dispatch routes remain present', () => {
  const adminDashboard = read('src/pages/admin/AdminDashboard.tsx');
  const router = read('server/adminApiRouter.ts');
  assert.match(adminDashboard, /path: '\/admin\/whatsapp'/);
  assert.match(adminDashboard, /Manage WhatsApp integrations and delivery controls/);
  assert.match(router, /defineApiRoute\(\["whatsapp", "attendance-dispatch"\]/);
  assert.match(router, /defineApiRoute\(\["whatsapp", "monthly-report-dispatch"\]/);
  assert.match(router, /defineApiRoute\(\["whatsapp", "settings"\]/);
});

test('Cloudflare scheduler retains Fee Alerts and queue-worker endpoints without unsupported Vercel cron entries', () => {
  const config = JSON.parse(read('vercel.json'));
  const schedulerConfig = JSON.parse(read('cloudflare/whatsapp-queue-scheduler/wrangler.jsonc'));
  const scheduler = read('cloudflare/whatsapp-queue-scheduler/index.mjs');
  assert.equal(config.crons, undefined);
  assert.deepEqual(schedulerConfig.triggers.crons, ['*/5 * * * *', '15 * * * *', '0 22 * * *', '0 4 * * *']);
  assert.match(scheduler, /controller\.cron === QUEUE_CRON_UTC[\s\S]*?QUEUE_WORKER_PATH/);
  assert.match(scheduler, /controller\.cron === FEE_ALERTS_CRON_UTC[\s\S]*?FEE_ALERTS_PATH/);
  assert.match(scheduler, /controller\.cron === FAILED_JOB_CLEANUP_CRON_UTC[\s\S]*?FAILED_JOB_CLEANUP_PATH/);
  assert.match(scheduler, /controller\.cron === SUBSCRIPTION_PROJECTION_CRON_UTC[\s\S]*?SUBSCRIPTION_PROJECTION_PATH/);
  const apiFiles = readdirSync(resolve(process.cwd(), 'api'), { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? [] : [entry.name])
    .sort();
  assert.deepEqual(apiFiles, ['admin.ts', 'health.ts', 'teacher.ts', 'whatsapp.ts']);
});

test('Firebase Functions TypeScript barrel no longer exports the retired Admin Billing function', () => {
  const tsSource = read('src/functions/src/index.ts');
  assert.doesNotMatch(tsSource, /adminBillingApi|adminBillingFirebase|adminBilling\.js/);
});
