import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Teacher Portal routes and existing sidebar are guarded by Academy permissions', () => {
  const app = read('src/App.tsx');
  const sidebar = read('src/components/Layout.tsx');
  const routeGuard = read('src/components/FeatureRoute.tsx');
  const context = read('src/contexts/AppContext.tsx');
  assert.match(app, /path="departments" element=\{<FeatureRoute features=\{\["student_management"\]\}/);
  for (const key of ['attendance_management', 'fee_tracking', 'monthly_reports', 'attendance_analytics', 'notes_library', 'quiz_management']) {
    assert.ok(app.includes(`feature="${key}"`), `route missing ${key}`);
  }
  for (const key of ['attendance.take_assigned', 'fees.view_assigned', 'quiz.view_assigned', 'reports.view_assigned', 'analytics.view_assigned', 'notes.view', 'alerts.view', 'settings.profile']) {
    assert.ok(sidebar.includes(`permission: '${key}'`), `sidebar missing ${key}`);
  }
  assert.match(routeGuard, /Academy permissions/);
  assert.match(context, /getAcademyAccess/);
  assert.match(context, /access\.permissions\?\.\[permission\] === true/);
  assert.doesNotMatch(context, /fetch\(['"]\/api\/teacher\/subscription/);
});

test('Teacher Subscription route redirects away and old purchase/proof endpoints are not registered', () => {
  const app = read('src/App.tsx');
  const router = read('server/teacherApiRouter.ts');
  assert.match(app, /path="subscription" element=\{<Navigate to="\/dashboard" replace \/>\}/);
  assert.doesNotMatch(router, /teacherSubscriptionHandler|proof-upload|proof-submit|subscription.*addons/);
});

test('feature-specific controls use Academy permission state and remove add-on purchase messaging', () => {
  const fees = read('src/pages/fees.tsx');
  const quiz = read('src/pages/quiz.tsx');
  const alerts = read('src/pages/alerts.tsx');
  const appContext = read('src/contexts/AppContext.tsx');
  assert.match(read('src/App.tsx'), /FeatureRoute feature="fee_tracking"/);
  assert.match(fees, /canAccessFeature\('fee_alerts'\)/);
  assert.match(quiz, /canAccessFeature\('quiz_result_notifications'\)/);
  assert.match(alerts, /const hasCustomAlerts = canAccessFeature\('custom_alerts'\)/);
  assert.match(appContext, /This action requires permission from your Academy Admin/);
  assert.doesNotMatch(fees, /Request Add-on|Purchase add-on/);
  assert.doesNotMatch(quiz, /Request Add-on|Purchase add-on/);
});

test('teacher API routes use Academy permission guards and omit subscription purchase routes', () => {
  const router = read('server/teacherApiRouter.ts');
  assert.equal((router.match(/featureGuard\(attendance/g) ?? []).length, 6);
  assert.equal((router.match(/featureGuard\(monthly/g) ?? []).length, 3);
  assert.doesNotMatch(router, /defineApiRoute\(\["subscription"/);
  assert.match(router, /defineApiRoute\(\["registration", "whatsapp-number-check"\]/);
});

test('Firestore teacher authorization requires active verified Academy membership and permission grants', () => {
  const rules = read('firestore.rules');
  assert.match(rules, /function activeAcademyMembership\(academyId\)/);
  assert.match(rules, /request\.auth\.token\.email_verified == true/);
  assert.match(rules, /function hasAcademyPermission\(tenantId, permissionKey\)/);
  assert.match(rules, /member\.get\('permissions', \{\}\) is map[\s\S]*member\.get\('permissions', \{\}\)\.get\(permissionKey, false\) == true/);
  const permissionHelper = rules.match(/function hasAcademyPermission\(tenantId, permissionKey\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.ok(permissionHelper, 'Academy permission resolver must exist');
  assert.doesNotMatch(permissionHelper, /activeTeacherWorkspace\(tenantId\)/, 'permission resolver must not repeat the entire workspace lookup');
  assert.match(rules, /function academyPermissionForFeature\(featureKey\)/);
  assert.doesNotMatch(rules, /activeSubscriptionProjection|subscriptionEntitlements\/current|projection\.status == 'active'/);
  assert.match(rules, /match \/subscriptionEntitlements\/\{entitlementId\} \{\s*allow read, write: if false;/);
  assert.doesNotMatch(rules, /projection\.status == 'active'/);
});

test('teacher-facing WhatsApp permission failures use Academy Admin language, not subscription status', () => {
  const monthly = read('src/functions/src/monthlyReportWhatsApp.ts');
  const monthlyBuilt = read('src/functions/lib/monthlyReportWhatsApp.js');
  const dispatch = read('server/monthlyReportDispatch.ts');
  const quiz = read('server/quizResultsWhatsApp.ts');
  const announcements = read('server/announcementsWhatsApp.ts');
  assert.match(monthly, /whatsAppStatus: \"blocked_permission\"/);
  assert.match(monthlyBuilt, /whatsAppStatus: \"blocked_permission\"/);
  assert.match(monthly, /Academy Admin has not granted Monthly Reports permission/);
  assert.match(dispatch, /Academy Admin has not granted Monthly Reports permission/);
  assert.match(quiz, /Academy Admin has not granted Quiz Result Notification permission/);
  assert.match(announcements, /Academy Admin has not granted permission to send announcements/);
  assert.doesNotMatch(monthly, /not included in the current active subscription/);
});

test('Platform subscription editor remains separate from Academy Admin routes', () => {
  const app = read('src/App.tsx');
  const platformAdmin = read('src/pages/admin/Subscriptions.tsx');
  const academyLayout = read('src/pages/academy-admin/AcademyAdminLayout.tsx');
  assert.match(app, /AdminRouteGuard/);
  assert.match(platformAdmin, /Admin Subscriptions/);
  assert.doesNotMatch(academyLayout, /\/admin\/subscriptions/);
});


test('all Firestore Rules functions remain within the documented 10 let-binding limit', () => {
  const rules = read('firestore.rules');
  const functionStart = /function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/g;
  for (const match of rules.matchAll(functionStart)) {
    const name = match[1];
    let depth = 1;
    let index = match.index + match[0].length;
    const bodyStart = index;
    while (index < rules.length && depth > 0) {
      if (rules[index] === '{') depth += 1;
      else if (rules[index] === '}') depth -= 1;
      index += 1;
    }
    assert.equal(depth, 0, `function ${name} must close`);
    const body = rules.slice(bodyStart, index - 1);
    const bindings = (body.match(/\blet\s+/g) ?? []).length;
    assert.ok(bindings <= 10, `${name} declares ${bindings} let bindings (maximum 10)`);
  }
});
