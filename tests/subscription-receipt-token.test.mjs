import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionReceiptGrantToken, verifySubscriptionReceiptGrantToken } from '../server/subscriptionReceiptToken.mjs';

const secret = 'x'.repeat(48);
const sample = (overrides = {}) => ({
  action: 'upload', adminUid: 'admin-uid-1', adminEmail: 'admin@example.com',
  teacherUid: 'teacher-uid-1', teacherEmail: 'teacher@example.com',
  invoiceId: '2026-11_teacher-uid-1', receiptId: '123e4567-e89b-42d3-a456-426614174000',
  iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
  ...overrides,
});

test('receipt grant token signs and verifies a scoped upload capability', () => {
  const payload = sample();
  const token = createSubscriptionReceiptGrantToken(payload, secret);
  assert.equal(verifySubscriptionReceiptGrantToken(token, secret, { action: 'upload', receiptId: payload.receiptId })?.invoiceId, payload.invoiceId);
  assert.equal(verifySubscriptionReceiptGrantToken(token, 'wrong'.repeat(12)), null);
  assert.equal(verifySubscriptionReceiptGrantToken(token, secret, { action: 'read' }), null);
});

test('expired grants and too-short signing secrets are rejected', () => {
  const expired = createSubscriptionReceiptGrantToken(sample({ iat: Math.floor(Date.now() / 1000) - 300, exp: Math.floor(Date.now() / 1000) - 5 }), secret);
  assert.equal(verifySubscriptionReceiptGrantToken(expired, secret), null);
  assert.throws(() => createSubscriptionReceiptGrantToken(sample(), 'short'), /at least 32 bytes/);
});

test('grant cannot be altered to point to a different invoice or receipt', () => {
  const token = createSubscriptionReceiptGrantToken(sample(), secret);
  const [payload, signature] = token.split('.');
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), invoiceId: 'another-invoice' })).toString('base64url');
  assert.equal(verifySubscriptionReceiptGrantToken(`${changed}.${signature}`, secret), null);
});
