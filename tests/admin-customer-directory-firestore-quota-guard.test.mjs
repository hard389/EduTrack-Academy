import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server/adminCustomers.ts', import.meta.url), 'utf8');

test('admin customer directory is based on a bounded teacher-profile query', () => {
  assert.match(source, /CUSTOMER_DIRECTORY_LIMIT\s*=\s*100/);
  assert.match(source, /collection\("users"\)\s*\.where\("role",\s*"==",\s*"teacher"\)\s*\.limit\(CUSTOMER_DIRECTORY_LIMIT\s*\+\s*1\)/);
  assert.match(source, /mapLimit\(Array\.from\(docsByUid\.values\(\)\),\s*5/);
  assert.match(source, /hasMoreTeachers/);
});

test('read-only customer refresh does not rewrite the admin root or every existing registry row', () => {
  assert.match(source, /if \(rootSnapshot\.exists\)[\s\S]*?await root\.create\(/);
  assert.doesNotMatch(source, /await root\.set\(/);
  assert.match(source, /CUSTOMER_REGISTRY_BACKFILL_PER_REQUEST\s*=\s*10/);
  assert.match(source, /if \(!registrySnapshot\.exists\)[\s\S]*?if \(registryBackfillsUsed < CUSTOMER_REGISTRY_BACKFILL_PER_REQUEST\)/);
});

test('customer directory uses cached academic aggregates rather than reading all class/student documents', () => {
  assert.match(source, /function getAcademicCounts\(profileData: DocumentData\)/);
  assert.doesNotMatch(source, /collection\("students"\)\.get\(\)/);
  assert.doesNotMatch(source, /async function listAllAuthUsers/);
});
