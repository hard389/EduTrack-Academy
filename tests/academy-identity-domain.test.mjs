import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeAcademyEmail,
  isAllowedAcademyEmail,
  normalizeAcademyId,
  nextAcademyIdFromCounter,
  isStrongAcademyPassword,
  isActiveAcademyMembership,
} from '../server/academyIdentityDomain.mjs';

test('Academy ID allocator initializes at 100 and increments sequentially', () => {
  assert.equal(nextAcademyIdFromCounter(null), 100);
  assert.equal(nextAcademyIdFromCounter({ nextId: 100 }), 100);
  assert.equal(nextAcademyIdFromCounter({ nextId: 101 }), 101);
});

test('Academy ID validation accepts only safe numeric IDs from 100 onward', () => {
  assert.equal(normalizeAcademyId('100'), '100');
  assert.equal(normalizeAcademyId(101), '101');
  assert.equal(normalizeAcademyId('0100'), '100');
  for (const value of ['', '99', 'abc', '../100', '100/other', '1'.repeat(30)]) {
    assert.equal(normalizeAcademyId(value), '');
  }
});

test('invalid counter state fails closed rather than reusing an ID', () => {
  assert.throws(() => nextAcademyIdFromCounter({ nextId: 99 }));
  assert.throws(() => nextAcademyIdFromCounter({ nextId: '100' }));
});

test('Gmail validation normalizes case and whitespace', () => {
  assert.equal(normalizeAcademyEmail(' Owner@Gmail.com '), 'owner@gmail.com');
  assert.equal(isAllowedAcademyEmail(' Owner@Gmail.com '), true);
  assert.equal(isAllowedAcademyEmail('owner@example.com'), false);
});

test('strong-password policy requires length, uppercase and special character', () => {
  assert.equal(isStrongAcademyPassword('Strong!1'), true);
  assert.equal(isStrongAcademyPassword('weak!1'), false);
  assert.equal(isStrongAcademyPassword('Strong11'), false);
  assert.equal(isStrongAcademyPassword('Ab!'), false);
  assert.equal(isStrongAcademyPassword('A!' + 'x'.repeat(128)), false);
});

test('membership resolver accepts only matching active verified Academy relationships', () => {
  const value = {
    academy: { academyId: '100', status: 'active' },
    membership: { uid: 'uid-1', academyId: '100', email: 'owner@gmail.com', role: 'academy_admin', active: true, emailVerified: true },
    mapping: { academyId: '100', email: 'owner@gmail.com', role: 'academy_admin', active: true },
    uid: 'uid-1', email: 'Owner@gmail.com', role: 'academy_admin',
  };
  assert.equal(isActiveAcademyMembership(value), true);
  assert.equal(isActiveAcademyMembership({ ...value, mapping: { ...value.mapping, academyId: '101' } }), false);
  assert.equal(isActiveAcademyMembership({ ...value, membership: { ...value.membership, emailVerified: false } }), false);
  assert.equal(isActiveAcademyMembership({ ...value, academy: { ...value.academy, status: 'suspended' } }), false);
});

test('loading route session helper derives destination from the verified Academy session', () => {
  const source = readFileSync(new URL('../src/pages/LoadingPage.auth.tsx', import.meta.url), 'utf8');
  assert.match(source, /resolveAcademySession: \(user: LoadingGateUser\)/);
  assert.match(source, /session\.role === 'academy_admin' \? '\/academy-admin\/dashboard' : '\/dashboard'/);
  assert.doesNotMatch(source, /readTeacherProfile|users\/\$\{normalizedEmail\}/);
  assert.match(source, /isValidAcademySession/);
});
