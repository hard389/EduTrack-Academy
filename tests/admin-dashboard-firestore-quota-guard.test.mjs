import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('admin dashboard queries only a bounded teacher set', () => {
  const source = read('../api-handlers/admin/dashboard.ts');
  assert.match(source, /collection\("users"\)\s*\.where\("role",\s*"==",\s*"teacher"\)\s*\.limit\(101\)/);
  assert.match(source, /teacherProfiles\.docs\.slice\(0,\s*100\)/);
  assert.match(source, /hasMoreTeachers/);
});

test('admin dashboard never scans every nested student roster on page load', () => {
  const source = read('../api-handlers/admin/dashboard.ts');
  assert.match(source, /cachedAcademicCounts\(data\)/);
  assert.doesNotMatch(source, /collection\("students"\)\.get\(\)/);
  assert.match(source, /uniqueStudentCount: read\("uniqueStudentCount", "uniqueStudents"\)/);
});

test('admin dashboard and analytics polling are reduced to five minutes', () => {
  const dashboard = read('../src/pages/admin/AdminDashboard.tsx');
  const analytics = read('../src/pages/admin/Analytics.tsx');
  assert.match(dashboard, /POLL_INTERVAL_MS\s*=\s*5\s*\*\s*60_000/);
  assert.match(analytics, /REFRESH_INTERVAL_MS\s*=\s*5\s*\*\s*60_000/);
});
