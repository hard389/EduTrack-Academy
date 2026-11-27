import { createHmac, timingSafeEqual } from 'node:crypto';

const AUDIENCE = 'edutrack-subscription-receipt';
const MIN_SECRET_BYTES = 32;

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value) {
  return Buffer.from(value, 'base64url');
}

export function createSubscriptionReceiptGrantToken(input, secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    throw new Error('SUBSCRIPTION_RECEIPT_SECRET must contain at least 32 bytes.');
  }
  const payload = {
    aud: AUDIENCE,
    v: 1,
    action: input.action,
    adminUid: input.adminUid,
    adminEmail: input.adminEmail,
    teacherUid: input.teacherUid,
    teacherEmail: input.teacherEmail,
    invoiceId: input.invoiceId,
    receiptId: input.receiptId,
    iat: input.iat,
    exp: input.exp,
  };
  const requiredStrings = ['adminUid', 'adminEmail', 'teacherUid', 'teacherEmail', 'invoiceId', 'receiptId'];
  if (!['upload', 'verify', 'read'].includes(payload.action) || requiredStrings.some((key) => typeof payload[key] !== 'string' || !payload[key])) {
    throw new TypeError('A complete subscription receipt grant is required.');
  }
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp <= payload.iat) {
    throw new TypeError('The subscription receipt grant validity window is invalid.');
  }
  const encoded = toBase64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifySubscriptionReceiptGrantToken(token, secret, options = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) return null;
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(encoded).digest();
  let received;
  try { received = fromBase64Url(signature); } catch { return null; }
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  let payload;
  try { payload = JSON.parse(fromBase64Url(encoded).toString('utf8')); } catch { return null; }
  if (!payload || payload.aud !== AUDIENCE || payload.v !== 1) return null;
  if (!['upload', 'verify', 'read'].includes(payload.action)) return null;
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (options.action && payload.action !== options.action) return null;
  if (options.receiptId && payload.receiptId !== options.receiptId) return null;
  return payload;
}
