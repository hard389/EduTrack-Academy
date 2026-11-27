import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Academy ID is allocated only inside a Firestore transaction', () => {
  const service = read('server/academyIdentity.ts');
  const domain = read('server/academyIdentityDomain.mjs');
  assert.match(service, /db\.runTransaction\(async \(transaction\)/);
  assert.match(service, /transaction\.get\(counterRef\)/);
  assert.match(service, /nextAcademyIdFromCounter\(counterData\)/);
  assert.match(service, /transaction\.create\(academyRef/);
  assert.match(service, /transaction\.create\(memberRef/);
  assert.match(domain, /counterData == null\) return 100/);
  assert.doesNotMatch(service, /body\.academyId|Date\.now\(\).*academyId|Math\.random\(\).*academyId/);
});

test('public registration derives the owner identity from a verified Firebase bearer token', () => {
  const service = read('server/academyIdentity.ts');
  assert.match(service, /auth\.verifyIdToken\(match\[1\], true\)/);
  assert.match(service, /auth\.getUser\(token\.uid\)/);
  assert.match(service, /authUser\.emailVerified/);
  assert.match(service, /role: "academy_admin"/);
  assert.match(service, /ownerUid: identity\.uid/);
  assert.match(service, /ownerEmail: identity\.email/);
  assert.doesNotMatch(service, /customClaims\s*:\s*\{\s*admin:\s*true/);
});

test('teacher creation uses Admin SDK and writes a pending Academy teacher without persisting credentials', () => {
  const service = read('server/academyIdentity.ts');
  assert.match(service, /auth\.createUser\(/);
  assert.match(service, /role: "teacher"/);
  assert.match(service, /registrationSource: "academy_admin_created"/);
  assert.match(service, /emailVerified: false/);
  assert.match(service, /status: "pending_email_verification"/);
  assert.match(service, /createdByUid: session\.uid/);
  assert.doesNotMatch(service, /password\s*:\s*String\(body\.password\)\s*,?\s*emailVerified:/);
  assert.doesNotMatch(service, /setCustomUserClaims|customClaims\s*:/);
});

test('session resolution enforces exact Academy ID, UID, email, verified status and protected role', () => {
  const service = read('server/academyIdentity.ts');
  assert.match(service, /requestedAcademyId !== undefined/);
  assert.match(service, /mapping\.role !== role/);
  assert.match(service, /member\.uid !== identity\.uid/);
  assert.match(service, /normalizeAcademyEmail\(member\.email\) !== identity\.email/);
  assert.match(service, /academy\.status !== "active"/);
  assert.match(service, /role === "academy_admin" && academy\.ownerUid !== identity\.uid/);
});

test('teacher API and Firestore access both require active verified Academy membership', () => {
  const teacherAuth = read('server/teacherAuth.ts');
  const rules = read('firestore.rules');
  assert.match(teacherAuth, /verifyActiveAcademyTeacher\(db, uid, email/);
  assert.match(teacherAuth, /authUser\.emailVerified !== true/);
  assert.match(rules, /request\.auth\.token\.email_verified == true/);
  assert.match(rules, /function activeAcademyTeacher/);
  assert.match(rules, /allow create: if false/);
  assert.match(rules, /match \/systemCounters\/\{counterId\} \{\s*allow read, write: if false;/);
  assert.match(rules, /match \/academyMemberships\/\{uid\} \{\s*allow get: if signedIn\(\) && request\.auth\.uid == uid;\s*allow list, create, update, delete: if false;/);
});

test('Academy and platform Super Admin routes remain role-separated', () => {
  const app = read('src/App.tsx');
  const platformGuard = read('src/components/AdminRouteGuard.tsx');
  const academyGuard = read('src/components/AcademyAdminRouteGuard.tsx');
  assert.match(app, /path="\/academy-admin" element=\{<AcademyAdminLayout \/>\}/);
  assert.match(app, /path="dashboard" element=\{<AcademyAdminOverview \/>\}/);
  assert.match(app, /<Route element=\{<AdminRouteGuard \/>\}>/);
  assert.match(platformGuard, /admin/);
  assert.match(academyGuard, /session\.role === "academy_admin"/);
  assert.doesNotMatch(academyGuard, /customClaims|admin === true/);
});
