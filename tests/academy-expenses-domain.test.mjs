import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExpenseAllocationPlan,
  summarizeAcademyExpenses,
  summarizeTeacherAllocations,
} from '../server/academyExpensesDomain.mjs';

const teachers = [
  { uid: 'teacher-b', role: 'teacher', active: true, emailVerified: true, academyId: 'A-1', name: 'Beta', designation: 'Teacher' },
  { uid: 'teacher-a', role: 'teacher', active: true, emailVerified: true, academyId: 'A-1', name: 'Alpha', designation: 'Senior Teacher' },
  { uid: 'teacher-off', role: 'teacher', active: false, emailVerified: true, academyId: 'A-1', name: 'Inactive' },
];

test('no allocation leaves the complete amount unallocated', () => {
  const result = buildExpenseAllocationPlan({ amount: 1250.5, allocationMethod: 'none', teachers });
  assert.equal(result.allocationTotal, 0);
  assert.equal(result.unallocatedAmount, 1250.5);
  assert.deepEqual(result.teacherAllocations, []);
});

test('all-active equal allocation uses only active verified teachers', () => {
  const result = buildExpenseAllocationPlan({ amount: 30000, allocationMethod: 'all_active', teachers });
  assert.deepEqual(result.teacherAllocations.map((row) => row.teacherUid), ['teacher-a', 'teacher-b']);
  assert.deepEqual(result.teacherAllocations.map((row) => row.allocatedAmount), [15000, 15000]);
  assert.equal(result.allocationTotal, 30000);
  assert.equal(result.unallocatedAmount, 0);
});

test('equal allocation distributes cent remainder deterministically', () => {
  const result = buildExpenseAllocationPlan({
    amount: 100,
    allocationMethod: 'selected_equal',
    selectedTeacherUids: ['teacher-b', 'teacher-a'],
    teachers,
  });
  assert.deepEqual(result.teacherAllocations.map((row) => [row.teacherUid, row.allocatedAmount]), [
    ['teacher-a', 50], ['teacher-b', 50],
  ]);
  const three = buildExpenseAllocationPlan({
    amount: 100,
    allocationMethod: 'selected_equal',
    selectedTeacherUids: ['teacher-b', 'teacher-a', 'teacher-c'],
    teachers: [...teachers, { uid: 'teacher-c', role: 'teacher', active: true, emailVerified: true, academyId: 'A-1', name: 'Charlie' }],
  });
  assert.deepEqual(three.teacherAllocations.map((row) => row.allocatedAmount), [33.34, 33.33, 33.33]);
  assert.equal(three.allocationTotal, 100);
});

test('custom allocation must exactly match the expense amount', () => {
  const result = buildExpenseAllocationPlan({
    amount: 30000,
    allocationMethod: 'custom',
    selectedTeacherUids: ['teacher-a', 'teacher-b'],
    customAllocations: [
      { teacherUid: 'teacher-a', allocatedAmount: 10000 },
      { teacherUid: 'teacher-b', allocatedAmount: 20000 },
    ],
    teachers,
  });
  assert.equal(result.allocationTotal, 30000);
  assert.throws(() => buildExpenseAllocationPlan({
    amount: 30000,
    allocationMethod: 'custom',
    selectedTeacherUids: ['teacher-a', 'teacher-b'],
    customAllocations: [
      { teacherUid: 'teacher-a', allocatedAmount: 10000 },
      { teacherUid: 'teacher-b', allocatedAmount: 19000 },
    ],
    teachers,
  }), /must equal the full expense amount/);
});

test('inactive, unverified, or foreign teacher cannot be allocated', () => {
  assert.throws(() => buildExpenseAllocationPlan({ amount: 100, allocationMethod: 'selected_equal', selectedTeacherUids: ['teacher-off'], teachers }), /no longer active/);
  assert.throws(() => buildExpenseAllocationPlan({ amount: 100, allocationMethod: 'selected_equal', selectedTeacherUids: ['teacher-foreign'], teachers }), /no longer active/);
  assert.throws(() => buildExpenseAllocationPlan({ amount: 100, allocationMethod: 'selected_equal', selectedTeacherUids: ['teacher-a', 'teacher-a'], teachers }), /only be selected once/);
});

test('monthly expense summary excludes drafts and voids from posted cash flow', () => {
  const summary = summarizeAcademyExpenses([
    { id: '1', status: 'posted', amount: 1000, category: 'Rent', allocationTotal: 400 },
    { id: '2', status: 'draft', amount: 300, category: 'Utilities', allocationTotal: 0 },
    { id: '3', status: 'void', amount: 500, category: 'Rent', allocationTotal: 500 },
    { id: '4', status: 'posted', amount: 500, category: 'Utilities', allocationTotal: 0 },
  ]);
  assert.equal(summary.totalPosted, 1500);
  assert.equal(summary.totalDraft, 300);
  assert.equal(summary.totalVoided, 500);
  assert.equal(summary.postedCount, 2);
  assert.equal(summary.draftCount, 1);
  assert.equal(summary.voidCount, 1);
  assert.equal(summary.totalAllocated, 400);
  assert.equal(summary.totalUnallocated, 1100);
  assert.equal(summary.highestCategory.name, 'Rent');
});

test('teacher totals use posted allocation snapshots and preserve former teachers', () => {
  const result = summarizeTeacherAllocations([
    { id: 'e1', status: 'posted', expenseDate: '2026-11-04', teacherAllocations: [{ teacherUid: 't1', teacherNameSnapshot: 'Ali', allocatedAmount: 100 }] },
    { id: 'e2', status: 'posted', expenseDate: '2026-11-20', teacherAllocations: [{ teacherUid: 't1', teacherNameSnapshot: 'Ali', allocatedAmount: 50 }] },
    { id: 'e3', status: 'draft', expenseDate: '2026-11-22', teacherAllocations: [{ teacherUid: 't1', teacherNameSnapshot: 'Ali', allocatedAmount: 900 }] },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Ali');
  assert.equal(result[0].entries, 2);
  assert.equal(result[0].totalAllocated, 150);
  assert.equal(result[0].lastAllocationDate, '2026-11-20');
});


test('allocation snapshots that do not reconcile are marked incomplete', () => {
  const summary = summarizeAcademyExpenses([
    {
      id: 'bad-allocation', status: 'posted', amount: 100,
      allocationTotal: 75, unallocatedAmount: 25,
      teacherAllocations: [{ teacherUid: 't1', allocatedAmount: 70 }],
    },
  ]);
  assert.equal(summary.complete, false);
  assert.equal(summary.malformedAmountCount, 1);
});

test('legacy posted expenses without allocation fields remain unallocated, not malformed', () => {
  const summary = summarizeAcademyExpenses([
    { id: 'legacy', status: 'posted', amount: 150, category: 'Utilities' },
  ]);
  assert.equal(summary.complete, true);
  assert.equal(summary.totalAllocated, 0);
  assert.equal(summary.totalUnallocated, 150);
});
