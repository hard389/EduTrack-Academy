import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('public registration creates an Academy Owner and does not expose teacher plan selection', () => {
  const page = read('src/pages/RegisterPage.tsx');
  const identity = read('server/academyIdentity.ts');
  const router = read('server/academyApiRouter.ts');
  assert.match(page, /registerAcademy/);
  assert.match(page, /Academy Name/);
  assert.match(page, /Academy ID/);
  assert.match(page, /sendEmailVerification/);
  assert.match(page, /Assigned automatically on registration/);
  assert.doesNotMatch(page, /View Plans|Teacher subscription plans|registrationChoice/);
  assert.match(identity, /academy_admin/);
  assert.match(identity, /systemCounters/);
  assert.match(identity, /runTransaction/);
  assert.match(router, /defineApiRoute\(\["register"\]/);
  assert.doesNotMatch(router, /teacherRegistration|subscription/);
});

test('public teacher self-registration and subscription UI/API files are retired', () => {
  assert.equal(existsSync(new URL('../server/teacherRegistration.ts', import.meta.url)), false);
  assert.equal(existsSync(new URL('../api-handlers/teacher/registration.ts', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/pages/subscription.tsx', import.meta.url)), false);
  assert.equal(existsSync(new URL('../api-handlers/teacher/subscription.ts', import.meta.url)), false);
  assert.equal(existsSync(new URL('../api-handlers/teacher/subscription', import.meta.url)), false);
});

test('teacher access is resolved by active Academy membership permissions, not subscription records', () => {
  const resolver = read('server/subscriptionEntitlements.ts');
  const domain = read('server/academyManagementDomain.mjs');
  const functions = read('src/functions/src/subscriptionEntitlements.ts');
  assert.match(resolver, /resolveAcademyPermissionEntitlement/);
  assert.match(resolver, /academy_membership_permissions/);
  assert.match(resolver, /permissions/);
  assert.match(domain, /LEGACY_FEATURE_PERMISSION_MAP/);
  assert.match(functions, /academyMemberships/);
  assert.match(functions, /permissions\[permissionKey\] === true/);
  assert.doesNotMatch(functions, /subscriptionEntitlements/);
});

test('existing Platform/SaaS subscription management remains under the platform Admin portal only', () => {
  const app = read('src/App.tsx');
  const guard = read('src/components/AdminRouteGuard.tsx');
  const adminPage = read('src/pages/admin/Subscriptions.tsx');
  assert.match(app, /path="\/admin" element=\{<AdminDashboard \/>\}/);
  assert.match(app, /path="subscriptions" element=\{<AdminSubscriptionsRoute \/>\}/);
  assert.match(guard, /admin/);
  assert.match(adminPage, /Admin Subscriptions/);
  assert.match(app, /path="subscription" element=\{<Navigate to="\/dashboard" replace \/>\}/);
});

test('Academy registration surfaces identity conflicts and does not create a fake teacher profile', () => {
  const page = read('src/pages/RegisterPage.tsx');
  const identity = read('server/academyIdentity.ts');
  assert.match(page, /Academy registration could not be completed/);
  assert.match(identity, /EXISTING_WORKSPACE/);
  assert.match(identity, /ACCOUNT_ALREADY_MAPPED/);
  assert.doesNotMatch(page, /teacher profile are already saved, but subscription setup did not complete/);
});
