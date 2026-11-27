import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PLAN_PERMISSION_MATRIX,
  FEATURE_PERMISSION_KEYS,
  createDefaultFeaturePermissions,
  isFeatureAvailable,
  isFeatureEnabled,
  migrateFeaturePermissionsForTier,
  normalizeFeaturePermissions,
} from '../server/subscriptionFeaturePermissions.mjs';

test('permission catalog contains every required stable entitlement key', () => {
  assert.equal(FEATURE_PERMISSION_KEYS.length, 17);
  for (const key of [
    'student_management', 'class_management', 'attendance_management', 'attendance_alerts',
    'monthly_reports', 'fortnightly_reports', 'weekly_reports', 'attendance_analytics',
    'advanced_analytics', 'fee_tracking', 'fee_alerts', 'custom_alerts', 'quiz_management',
    'quiz_result_notifications', 'notes_library', 'library_link_whatsapp', 'announcements',
  ]) assert.ok(FEATURE_PERMISSION_KEYS.includes(key), `missing ${key}`);
});

test('default Basic, Advance and Pro permission matrices match the requested states', () => {
  assert.deepEqual(createDefaultFeaturePermissions('basic'), DEFAULT_PLAN_PERMISSION_MATRIX.basic);
  assert.deepEqual(createDefaultFeaturePermissions('advance'), DEFAULT_PLAN_PERMISSION_MATRIX.advance);
  assert.deepEqual(createDefaultFeaturePermissions('pro'), DEFAULT_PLAN_PERMISSION_MATRIX.pro);
  assert.equal(DEFAULT_PLAN_PERMISSION_MATRIX.basic.student_management, 'enabled');
  assert.equal(DEFAULT_PLAN_PERMISSION_MATRIX.basic.attendance_alerts, 'configurable');
  assert.equal(DEFAULT_PLAN_PERMISSION_MATRIX.basic.fee_tracking, 'configurable');
  assert.equal(DEFAULT_PLAN_PERMISSION_MATRIX.basic.fee_alerts, 'disabled');
  assert.equal(DEFAULT_PLAN_PERMISSION_MATRIX.basic.announcements, 'disabled');
  assert.equal(DEFAULT_PLAN_PERMISSION_MATRIX.basic.fortnightly_reports, 'disabled');
  assert.equal(DEFAULT_PLAN_PERMISSION_MATRIX.advance.fortnightly_reports, 'enabled');
  assert.equal(DEFAULT_PLAN_PERMISSION_MATRIX.advance.weekly_reports, 'disabled');
  assert.equal(DEFAULT_PLAN_PERMISSION_MATRIX.advance.quiz_result_notifications, 'configurable');
  assert.equal(DEFAULT_PLAN_PERMISSION_MATRIX.pro.weekly_reports, 'enabled');
  assert.equal(DEFAULT_PLAN_PERMISSION_MATRIX.pro.advanced_analytics, 'enabled');
  assert.equal(DEFAULT_PLAN_PERMISSION_MATRIX.pro.quiz_result_notifications, 'disabled');
  assert.equal(DEFAULT_PLAN_PERMISSION_MATRIX.pro.fee_alerts, 'enabled');
});

test('missing permissions fail closed and legacy boolean snapshots remain readable', () => {
  const missing = normalizeFeaturePermissions(undefined, false);
  assert.ok(FEATURE_PERMISSION_KEYS.every((key) => missing[key] === 'disabled'));
  const legacy = normalizeFeaturePermissions({ student_management: true, attendance_management: false }, false);
  assert.equal(legacy.student_management, 'enabled');
  assert.equal(legacy.attendance_management, 'disabled');
  assert.equal(legacy.notes_library, 'disabled');
});

test('normalizer accepts tri-state and boolean values but ignores unknown keys', () => {
  const permissions = normalizeFeaturePermissions({
    student_management: true,
    attendance_management: false,
    fee_tracking: 'configurable',
    custom_alerts: 'disabled',
    made_up_feature: true,
  }, false);
  assert.equal(permissions.student_management, 'enabled');
  assert.equal(permissions.attendance_management, 'disabled');
  assert.equal(permissions.fee_tracking, 'configurable');
  assert.equal(permissions.custom_alerts, 'disabled');
  assert.equal(Object.hasOwn(permissions, 'made_up_feature'), false);
});

test('configurable permissions are available but require an enabled setting for dispatch', () => {
  const permissions = createDefaultFeaturePermissions('basic');
  assert.equal(isFeatureAvailable(permissions, 'fee_tracking'), true);
  assert.equal(isFeatureEnabled(permissions, 'fee_tracking', false), false);
  assert.equal(isFeatureEnabled(permissions, 'fee_tracking', true), true);
  assert.equal(isFeatureEnabled(permissions, 'attendance_alerts', true), true);
  assert.equal(isFeatureEnabled(permissions, 'custom_alerts', true), false);
});

test('migration fills missing keys from the selected tier while preserving existing explicit states', () => {
  const migrated = migrateFeaturePermissionsForTier({ student_management: false }, 'basic');
  assert.equal(migrated.student_management, 'disabled');
  assert.equal(migrated.class_management, 'enabled');
  assert.equal(migrated.fee_tracking, 'configurable');
});
