import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('teacher subscription purchase page is removed from the active application source', () => {
  assert.equal(existsSync(new URL('../src/pages/subscription.tsx', import.meta.url)), false);
  const app = read('src/App.tsx');
  assert.doesNotMatch(app, /TeacherSubscriptionPage/);
  assert.match(app, /path="subscription" element=\{<Navigate to="\/dashboard" replace \/>\}/);
});

test('Academy registration no longer shows plans, invoices or subscription proof upload', () => {
  const page = read('src/pages/RegisterPage.tsx');
  assert.match(page, /Academy Registration/);
  assert.match(page, /Academy Name/);
  assert.match(page, /Academy ID/);
  assert.doesNotMatch(page, /View Plans|Submit payment proof|subscription plan|proof-upload/);
});
