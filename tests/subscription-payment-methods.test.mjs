import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaymentMethods, validatePaymentMethods } from '../server/subscriptionPaymentMethods.mjs';

const validBank = {
  id: 'mcb-main',
  name: 'MCB Bank Transfer',
  type: 'bank',
  providerName: 'MCB Bank Limited',
  accountTitle: 'EduTrack Academy',
  accountNumber: '1234567890',
  iban: 'PK00TEST1234567890123456',
  mobileNumber: '',
  branch: 'Main Branch',
  instructions: 'Mention the academy name in the transfer reference.',
};

test('normalizes saved payment methods and ignores malformed or empty rows', () => {
  const result = normalizePaymentMethods([validBank, null, { name: 'Blank method', type: 'bank' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'MCB Bank Transfer');
  assert.equal(result[0].accountNumber, '1234567890');
});

test('accepts bank, mobile wallet and instruction-only payment methods', () => {
  const result = validatePaymentMethods([
    validBank,
    { name: 'Mobile Wallet', type: 'mobile_wallet', mobileNumber: '03001234567' },
    { name: 'Other method', type: 'other', instructions: 'Contact the school office for a payment reference.' },
  ]);
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.paymentMethods.length, 3);
});

test('rejects payment methods without a usable payment detail', () => {
  const result = validatePaymentMethods([{ name: 'Empty account', type: 'bank' }]);
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.error, /account number, IBAN, mobile number or payment instruction/i);
});

test('rejects invalid types, overlong fields and more than eight methods', () => {
  assert.equal(validatePaymentMethods([{ name: 'Invalid', type: 'crypto', iban: 'PK00' }]).valid, false);
  assert.equal(validatePaymentMethods([{ name: 'Long account', type: 'bank', accountNumber: '1'.repeat(81) }]).valid, false);
  assert.equal(validatePaymentMethods(Array.from({ length: 9 }, (_, index) => ({ name: `Method ${index}`, type: 'other', instructions: 'Contact office.' }))).valid, false);
});
