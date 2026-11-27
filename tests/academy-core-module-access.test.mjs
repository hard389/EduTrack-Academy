import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAcademyFeaturePermission } from '../server/academyManagementDomain.mjs';

test('every teacher module is denied until the Academy Admin explicitly grants its mapped permission', () => {
  const mapping = {
    attendance_management: 'attendance.take_assigned',
    monthly_reports: 'reports.view_assigned',
    fortnightly_reports: 'reports.view_assigned',
    weekly_reports: 'reports.view_assigned',
    attendance_analytics: 'analytics.view_assigned',
    quiz_management: 'quiz.view_assigned',
  };
  for (const [feature, permission] of Object.entries(mapping)) {
    assert.equal(hasAcademyFeaturePermission({}, feature), false, `${feature} must be denied by default`);
    assert.equal(hasAcademyFeaturePermission({ [permission]: true }, feature), true, `${feature} must open after an explicit grant`);
  }
});

test('optional teacher modules continue to require an explicit Academy permission', () => {
  assert.equal(hasAcademyFeaturePermission({}, 'fee_tracking'), false);
  assert.equal(hasAcademyFeaturePermission({}, 'custom_alerts'), false);
  assert.equal(hasAcademyFeaturePermission({ 'fees.view_assigned': true }, 'fee_tracking'), true);
});
