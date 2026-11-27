import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/edutrack-r2-worker-subscriptions.mjs';
import { createSubscriptionReceiptGrantToken } from '../server/subscriptionReceiptToken.mjs';

const secret = 'w'.repeat(48);
const receiptId = '123e4567-e89b-42d3-a456-426614174000';
const grantContext = {
  adminUid: 'admin-uid-1', adminEmail: 'admin@example.com',
  teacherUid: 'teacher-uid-1', teacherEmail: 'teacher@example.com',
  invoiceId: '2026-11_teacher-uid-1', receiptId,
};
const grant = (action) => createSubscriptionReceiptGrantToken({
  ...grantContext, action, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
}, secret);

class MemoryBucket {
  constructor() { this.objects = new Map(); }
  async head(key) {
    const item = this.objects.get(key);
    return item ? this.objectView(item, false) : null;
  }
  async put(key, bytes, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    if (this.objects.has(key)) return null;
    const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const item = { bytes: value, customMetadata: options.customMetadata, httpMetadata: options.httpMetadata };
    this.objects.set(key, item);
    return this.objectView(item, false);
  }
  async get(key) {
    const item = this.objects.get(key);
    return item ? this.objectView(item, true) : null;
  }
  objectView(item, withBody) {
    return {
      size: item.bytes.length,
      customMetadata: item.customMetadata,
      httpMetadata: item.httpMetadata,
      httpEtag: '"test-etag"',
      writeHttpMetadata(headers) {
        if (item.httpMetadata?.contentType) headers.set('Content-Type', item.httpMetadata.contentType);
      },
      ...(withBody ? { body: new Response(item.bytes).body } : {}),
    };
  }
}

function env(bucket = new MemoryBucket()) {
  return { EDUTRACK_BUCKET: bucket, SUBSCRIPTION_RECEIPT_SECRET: secret, APP_ORIGINS: 'https://edutrack.example' };
}
function imageBytes() { return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]); }
function uploadRequest(token, bytes = imageBytes(), type = 'image/jpeg') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), 'payment-proof.jpg');
  return new Request(`https://worker.example/api/subscription-receipts/${receiptId}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, Origin: 'https://edutrack.example' }, body: form,
  });
}

test('receipt uploads require a signed, invoice-bound token', async () => {
  const response = await worker.fetch(new Request(`https://worker.example/api/subscription-receipts/${receiptId}`, { method: 'PUT' }), env());
  assert.equal(response.status, 401);
});

test('valid screenshot is stored privately and can only be read with a separate scoped grant', async () => {
  const bucket = new MemoryBucket();
  const environment = env(bucket);
  const response = await worker.fetch(uploadRequest(grant('upload')), environment);
  assert.equal(response.status, 200);
  assert.equal(bucket.objects.size, 1);
  const [key, object] = [...bucket.objects.entries()][0];
  assert.equal(key, `subscription-receipts/${grantContext.adminUid}/${grantContext.teacherUid}/${grantContext.invoiceId}/${receiptId}`);
  assert.equal(object.customMetadata.kind, 'subscription-payment-proof');
  assert.equal(object.customMetadata.teacherUid, grantContext.teacherUid);

  const verify = await worker.fetch(new Request(`https://worker.example/internal/subscription-receipts/${receiptId}`, { method: 'HEAD', headers: { Authorization: `Bearer ${grant('verify')}` } }), environment);
  assert.equal(verify.status, 204);

  const read = await worker.fetch(new Request(`https://worker.example/internal/subscription-receipts/${receiptId}`, { method: 'GET', headers: { Authorization: `Bearer ${grant('read')}` } }), environment);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  assert.equal((await read.arrayBuffer()).byteLength, imageBytes().length);

  const publicShare = await worker.fetch(new Request(`https://worker.example/share/${receiptId}`), environment);
  assert.equal(publicShare.status, 404);
});

test('receipt object cannot be overwritten by replaying its upload token', async () => {
  const bucket = new MemoryBucket();
  const environment = env(bucket);
  assert.equal((await worker.fetch(uploadRequest(grant('upload')), environment)).status, 200);
  assert.equal((await worker.fetch(uploadRequest(grant('upload')), environment)).status, 409);
  assert.equal(bucket.objects.size, 1);
});

test('incorrect image magic bytes are rejected even when the browser MIME type claims JPEG', async () => {
  const response = await worker.fetch(uploadRequest(grant('upload'), new Uint8Array([0x41, 0x42, 0x43]), 'image/jpeg'), env());
  assert.equal(response.status, 415);
});

test('upload, verify and read grants cannot be interchanged', async () => {
  const environment = env();
  const response = await worker.fetch(uploadRequest(grant('read')), environment);
  assert.equal(response.status, 401);
  const wrongId = await worker.fetch(new Request(`https://worker.example/internal/subscription-receipts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, { method: 'HEAD', headers: { Authorization: `Bearer ${grant('verify')}` } }), environment);
  assert.equal(wrongId.status, 401);
});
