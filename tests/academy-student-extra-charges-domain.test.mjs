import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAcademyStudentExtraCharges } from '../server/academyStudentExtraChargesDomain.mjs';

test('normalizes a one-time extra charge for a valid month', () => {
  assert.deepEqual(normalizeAcademyStudentExtraCharges([{ id: 'charge-1', label: 'Lab materials', amount: '750', billingFrequency: 'one_time', appliesToMonth: '2026-11' }]), [
    { id: 'charge-1', label: 'Lab materials', amount: 750, billingFrequency: 'one_time', appliesToMonth: '2026-11' },
  ]);
});

test('normalizes monthly recurring extra charges without a one-time month', () => {
  assert.deepEqual(normalizeAcademyStudentExtraCharges([{ id: 'charge-2', label: 'Locker', amount: 100, billingFrequency: 'monthly', appliesToMonth: '2026-11' }]), [
    { id: 'charge-2', label: 'Locker', amount: 100, billingFrequency: 'monthly', appliesToMonth: '' },
  ]);
});

test('rejects duplicate IDs, invalid months, unsupported cycles and invalid amounts', () => {
  assert.throws(() => normalizeAcademyStudentExtraCharges([
    { id: 'dup', label: 'A', amount: 1, billingFrequency: 'monthly' },
    { id: 'dup', label: 'B', amount: 1, billingFrequency: 'monthly' },
  ]), /unique valid identifier/);
  assert.throws(() => normalizeAcademyStudentExtraCharges([{ id: 'x', label: 'A', amount: 1, billingFrequency: 'one_time', appliesToMonth: '2026-13' }]), /YYYY-MM/);
  assert.throws(() => normalizeAcademyStudentExtraCharges([{ id: 'x', label: 'A', amount: 1, billingFrequency: 'termly' }]), /Only one-time and monthly/);
  assert.throws(() => normalizeAcademyStudentExtraCharges([{ id: 'x', label: 'A', amount: 0, billingFrequency: 'monthly' }]), /positive/);
});
