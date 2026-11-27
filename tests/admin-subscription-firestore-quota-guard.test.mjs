import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server/adminSubscriptions.ts', import.meta.url), 'utf8');

test('admin subscription directory uses bounded teacher pages and concurrency', () => {
  assert.match(source, /collection\('customers'\)\.limit\(100\)/);
  assert.match(source, /const registryDocs\s*=\s*registrySnapshot\.docs/);
  assert.match(source, /mapLimit\(registryDocs,\s*5/);
  assert.match(source, /collection\('periods'\)\.orderBy\('startedAt',\s*'desc'\)\.limit\(12\)/);
  assert.match(source, /collection\('addOns'\)\.limit\(20\)/);
  assert.match(source, /collection\('addOnRequests'\)\.limit\(20\)/);
});

test('admin invoices, payments and audit history have explicit response caps', () => {
  assert.match(source, /subscriptionInvoices'\)\.orderBy\('createdAt',\s*'desc'\)\.limit\(100\)/);
  assert.match(source, /subscriptionPayments'\)\.orderBy\('approvedAt',\s*'desc'\)\.limit\(100\)/);
  assert.match(source, /subscriptionAuditLogs'\)\.orderBy\('createdAt', 'desc'\)\.limit\(50\)/);
  assert.match(source, /teacherLimit: 100/);
});
