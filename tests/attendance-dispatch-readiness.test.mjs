import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildAttendanceDispatchReadiness } from '../server/attendanceDispatchReadinessDomain.mjs';

const readinessSource = readFileSync(new URL('../server/attendanceDispatchReadiness.ts', import.meta.url), 'utf8');
const queueSource = readFileSync(new URL('../server/attendanceNotifications.ts', import.meta.url), 'utf8');
const jobsSource = readFileSync(new URL('../server/attendanceJobs.ts', import.meta.url), 'utf8');

test('readiness accepts any sender that the canonical resolver has verified', () => {
  assert.deepEqual(buildAttendanceDispatchReadiness({
    serverEnabled: true,
    adminAuthorized: true,
    senderReady: true,
  }), { available: true, blockers: [] });
});

test('server kill switch blocks dispatch', () => {
  const result = buildAttendanceDispatchReadiness({
    serverEnabled: false,
    adminAuthorized: true,
    senderReady: true,
  });
  assert.equal(result.available, false);
  assert.match(result.blockers.join(' '), /disabled on the server/i);
});

test('missing admin authorization blocks dispatch', () => {
  const result = buildAttendanceDispatchReadiness({
    serverEnabled: true,
    adminAuthorized: false,
    senderReady: true,
  });
  assert.equal(result.available, false);
  assert.match(result.blockers.join(' '), /authorized by an administrator/i);
});

test('unverified or missing sender blocks dispatch with a reason', () => {
  const result = buildAttendanceDispatchReadiness({
    serverEnabled: true,
    adminAuthorized: true,
    senderReady: false,
    senderError: 'The selected personal sender is not verified.',
  });
  assert.equal(result.available, false);
  assert.match(result.blockers.join(' '), /personal sender is not verified/i);
});

test('both queue preparation and job listing use the canonical personal-or-central sender resolver', () => {
  assert.match(readinessSource, /resolveTeacherWhatsAppSender\(db,\s*teacherUid,\s*settings\)/);
  assert.match(readinessSource, /WHATSAPP_ATTENDANCE_DISPATCH_ENABLED/);
  assert.match(queueSource, /getAttendanceDispatchReadiness\(/);
  assert.match(jobsSource, /getAttendanceDispatchReadiness\(/);
  assert.doesNotMatch(queueSource, /hasPostabiWebAppCredentials/);
  assert.doesNotMatch(jobsSource, /hasPostabiWebAppCredentials/);
});
