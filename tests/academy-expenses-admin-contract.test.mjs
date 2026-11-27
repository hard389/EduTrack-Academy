import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const backend = await readFile(new URL('../server/academyManagement.ts', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/pages/academy-admin/AcademyExpensesPage.tsx', import.meta.url), 'utf8');
const allocationDomain = await readFile(new URL('../server/academyExpensesDomain.mjs', import.meta.url), 'utf8');

test('expense management actions are routed through the Academy Admin management endpoint', () => {
  for (const action of [
    "case 'expenses'",
    "case 'expense-teachers'",
    "case 'expense-details'",
    "case 'create-expense'",
    "case 'update-expense'",
    "case 'delete-draft-expense'",
    "case 'post-draft-expense'",
    "case 'void-expense'",
  ]) assert.ok(backend.includes(action), `Missing route ${action}`);
  assert.ok(page.includes("action: 'expenses'"));
  assert.ok(page.includes("action: 'expense-teachers'"));
  assert.ok(!page.includes('/api/teacher/'));
});

test('teacher allocation reads only members from the authenticated academy and requires active verified teachers', () => {
  assert.ok(backend.includes("academyRef(actor.db, actor.session.academyId)"));
  assert.ok(backend.includes("root.collection('members').where('role', '==', 'teacher')"));
  assert.ok(backend.includes("teacher.academyId === academyId && teacher.active && teacher.emailVerified"));
  assert.ok(backend.includes("actor.session.role !== 'academy_admin'"));
});

test('expense creation and lifecycle operations use transactions and audit records', () => {
  for (const contract of [
    'actor.db.runTransaction(async (transaction)',
    'transaction.create(expenseRef',
    'transaction.create(auditRef',
    'transaction.delete(ref)',
    "before.status !== 'draft'",
    "before.status !== 'posted'",
    'requestFingerprint',
    'teacherAllocations',
  ]) assert.ok(backend.includes(contract), `Missing safety contract: ${contract}`);
});

test('teacher allocation records are reporting snapshots and never payroll deductions', () => {
  assert.ok(page.includes('does not deduct salary or create teacher payments'));
  assert.ok(page.includes('does not create payroll or teacher-payment records'));
  assert.ok(allocationDomain.includes('teacherNameSnapshot'));
  assert.ok(allocationDomain.includes('designationSnapshot'));
});
