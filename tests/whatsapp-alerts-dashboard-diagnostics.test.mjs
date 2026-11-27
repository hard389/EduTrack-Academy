import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync(new URL('../server/teacherWhatsAppAlerts.ts', import.meta.url), 'utf8');
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

test('monthly analytics queries identify their collection and page in backend diagnostics', () => {
  assert.match(dashboard, /class DashboardStageError extends Error/);
  assert.match(dashboard, /analytics\.\$\{monthKey\}\.\$\{definition\.collection\}/);
  assert.match(dashboard, /\.page-\$\{page \+ 1\}/);
  assert.match(dashboard, /failedMessages\.\$\{definition\.collection\}/);
});

test('500 responses return a request reference and server logs preserve safe error code/message', () => {
  assert.match(dashboard, /const requestId = randomUUID\(\)/);
  assert.match(dashboard, /errorCode: code/);
  assert.match(dashboard, /errorMessage: message\.slice\(0, 1200\)/);
  assert.match(dashboard, /Reference: \$\{requestId\}/);
  assert.doesNotMatch(dashboard, /console\.error\([^\n]*authorization|console\.error\([^\n]*appKey|console\.error\([^\n]*authKey/i);
});

test('multipurpose teacher API has a longer serverless execution window for analytics reads', () => {
  assert.equal(vercel.functions?.['api/teacher.ts']?.maxDuration, 60);
});

test('quiz dispatch declaration matches the caller object shape and avoids a known typecheck mismatch', () => {
  const declaration = readFileSync(new URL('../server/quizResultsWhatsAppDomain.d.mts', import.meta.url), 'utf8');
  assert.match(declaration, /createQuizResultsDispatchId\(input: \{ tenantId: string; classId: string; quizId: string; contentHash\?: string \}\)/);
});
