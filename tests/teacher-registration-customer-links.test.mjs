import test from 'node:test';
import assert from 'node:assert/strict';
import { isForeignCanonicalCustomerLink } from '../server/registrationCustomerLinks.mjs';

const uid = 'teacher-uid-123';
const workspace = 'admins/school-a@example.com';

const link = (path, overrides = {}) => isForeignCanonicalCustomerLink({
  path,
  documentId: uid,
  uid,
  workspaceRootPath: workspace,
  ...overrides,
});

test('same workspace canonical customer record is not foreign', () => {
  assert.equal(link(`${workspace}/customers/${uid}`), false);
});

test('customer-group membership under the same admin is not a foreign workspace', () => {
  assert.equal(link(`${workspace}/customerGroups/group-1/customers/${uid}`), false);
});

test('customer-group membership under another admin is not a canonical registry', () => {
  assert.equal(link('admins/school-b@example.com/customerGroups/group-1/customers/teacher-uid-123'), false);
});

test('a canonical customer registry under a different admin is a real conflict', () => {
  assert.equal(link('admins/school-b@example.com/customers/teacher-uid-123'), true);
});

test('deleted canonical customer records do not block safe registration recovery', () => {
  assert.equal(link('admins/school-b@example.com/customers/teacher-uid-123', { deleted: true }), false);
});

test('a different document id cannot be treated as this UID link', () => {
  assert.equal(link(`${workspace}/customerGroups/group-1/customers/some-other-id`, { documentId: 'some-other-id' }), false);
});
