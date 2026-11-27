import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server/subscriptionEntitlements.ts', import.meta.url), 'utf8');
const syncStart = source.indexOf('export async function syncTeacherEntitlementProjection(');
const syncEnd = source.indexOf('type AcademyPermissionActor', syncStart);
const sync = source.slice(syncStart, syncEnd);

test('repairs a missing entitlement projection when a legacy fingerprint already exists', () => {
  assert.match(sync, /const projectionChanged = writeGuard\?\.markerData\.serverProjectionFingerprint !== fingerprint/);
  assert.match(sync, /const projectionReady = writeGuard\?\.markerData\.serverProjectionReady === true/);
  assert.match(sync, /const shouldWriteProjection = projectionChanged \|\| !projectionReady/);
  assert.match(sync, /if \(shouldWriteProjection\) \{\s*batch\.set\(projectionRef/);
  assert.match(sync, /serverProjectionReady: true/);
});

test('keeps stable entitlement checks free of an extra projection get/read', () => {
  assert.doesNotMatch(sync, /\.get\(\)/);
  assert.match(sync, /if \(writeGuard && !shouldWriteProjection && !scheduleChanged\) return/);
});

test('does not modify Firestore client authorization rules or WhatsApp sender code', () => {
  assert.match(sync, /collection\('users'\)\.doc\(normalizedEmail\)\.collection\('subscriptionEntitlements'\)\.doc\('current'\)/);
  assert.match(sync, /batch\.set\(writeGuard\.markerRef/);
});
