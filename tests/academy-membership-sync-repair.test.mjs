import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Academy Students page imports every rendered Users icon', () => {
  const page = read('src/pages/academy-admin/AcademyStudentsPage.tsx');
  assert.match(page, /import\s*\{[\s\S]*\bUsers\b[\s\S]*\}\s*from\s*'lucide-react'/);
  assert.match(page, /<Users className=/);
});

test('UID-keyed membership mapping accepts existing records without a duplicate uid field', () => {
  const sync = read('src/functions/src/academyPortalSync.ts');
  const feature = read('src/functions/src/subscriptionEntitlements.ts');
  const serverFeature = read('server/subscriptionEntitlements.ts');
  const workspace = read('server/academyAdminWorkspace.ts');
  const compiledSync = read('src/functions/lib/academyPortalSync.js');
  const compiledFeature = read('src/functions/lib/subscriptionEntitlements.js');
  for (const source of [sync, feature, serverFeature, workspace, compiledSync, compiledFeature]) {
    assert.match(source, /mapping\.uid !== undefined && mapping\.uid !== uid|mapping\.uid !== undefined && mapping\.uid !== snapshot\.id/);
  }
  assert.match(sync, /db\.collection\("academyMemberships"\)\.doc\(uid\)/);
});

test('new membership records persist the document UID for consistent future writes', () => {
  const identity = read('server/academyIdentity.ts');
  const migration = read('scripts/migrate-academy-memberships.mjs');
  assert.match(identity, /transaction\.create\(mappingRef, \{\s*uid: identity\.uid/);
  assert.match(identity, /transaction\.create\(mappingRef, \{\s*uid: createdUser\.uid/);
  assert.match(migration, /transaction\.create\(mappingRef, \{\s*uid: plan\.uid/);
});

test('membership activation and permission changes trigger teacher projection rebuilds', () => {
  const sync = read('src/functions/src/academyPortalSync.ts');
  const index = read('src/functions/src/index.ts');
  const compiledIndex = read('src/functions/lib/index.js');
  assert.match(sync, /syncAcademyTeacherMembershipToTeacherPortal = onDocumentWritten\("academies\/\{academyId\}\/members\/\{memberUid\}"/);
  assert.match(sync, /rebuildTeacherClassProjection\(academyId, teacherUid, classId\)/);
  assert.match(index, /syncAcademyTeacherMembershipToTeacherPortal/);
  assert.match(compiledIndex, /syncAcademyTeacherMembershipToTeacherPortal/);
});


test('Storage rules require an active verified UID mapping and verified email', () => {
  const source = read('storage.rules');
  assert.match(source, /function activeAcademyMember\(academyId\)/);
  assert.match(source, /firestore\.get\(mappingPath\)\.data\.emailVerified == true/);
  assert.match(source, /firestore\.get\(mappingPath\)\.data\.email\.lower\(\) == request\.auth\.token\.email\.lower\(\)/);
});
