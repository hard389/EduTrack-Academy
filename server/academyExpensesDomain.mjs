const clean = (value) => typeof value === 'string' ? value.trim() : '';

export function moneyToCents(value, field = 'Amount') {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${field} is invalid.`);
  if (typeof value === 'string' && !value.trim()) throw new Error(`${field} is invalid.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100_000_000) throw new Error(`${field} is invalid.`);
  const cents = Math.round((number + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(cents)) throw new Error(`${field} is invalid.`);
  return cents;
}

export const centsToMoney = (cents) => Number((cents / 100).toFixed(2));

function normalizeTeacher(teacher) {
  const uid = clean(teacher?.uid);
  const name = clean(teacher?.name || teacher?.displayName) || 'Teacher';
  if (!uid || uid.includes('/') || uid.length > 128) throw new Error('A selected teacher is invalid.');
  if (teacher?.role !== 'teacher' || teacher?.active !== true || teacher?.emailVerified !== true) {
    throw new Error(`${name} is no longer an active, verified teacher. Refresh the teacher list.`);
  }
  return {
    uid,
    name,
    designation: clean(teacher.designation || teacher.jobTitle || teacher.position || teacher.title),
    photoUrl: clean(teacher.photoUrl || teacher.avatarUrl || teacher.photoURL || teacher.profileImage),
  };
}

function equalCents(totalCents, teachers, allocationMethod) {
  if (!teachers.length) throw new Error('No eligible active teachers are available for this allocation.');
  if (totalCents < teachers.length) throw new Error('The expense amount is too small to allocate at least one paisa to every selected teacher.');
  const ordered = [...teachers].sort((a, b) => a.uid.localeCompare(b.uid));
  const base = Math.floor(totalCents / ordered.length);
  const remainder = totalCents - base * ordered.length;
  return ordered.map((teacher, index) => ({
    teacherUid: teacher.uid,
    teacherNameSnapshot: teacher.name,
    designationSnapshot: teacher.designation,
    teacherPhotoUrlSnapshot: teacher.photoUrl,
    allocatedAmount: centsToMoney(base + (index < remainder ? 1 : 0)),
    allocationMethod,
  }));
}

/**
 * Builds an immutable teacher identity/amount snapshot for an expense write.
 * `teachers` must have been read and validated by the authenticated server route.
 */
export function buildExpenseAllocationPlan(input) {
  const amountCents = moneyToCents(input?.amount, 'Expense amount');
  const method = clean(input?.allocationMethod || 'none');
  if (!['none', 'all_active', 'selected_equal', 'custom'].includes(method)) {
    throw new Error('Choose a valid teacher allocation method.');
  }
  if (method === 'none') {
    return { allocationMethod: 'none', teacherAllocations: [], allocationTotal: 0, unallocatedAmount: centsToMoney(amountCents) };
  }

  const rawTeachers = Array.isArray(input?.teachers) ? input.teachers : [];
  const normalized = rawTeachers
    .filter((teacher) => teacher?.role === 'teacher' && teacher?.active === true && teacher?.emailVerified === true)
    .map(normalizeTeacher);
  const byUid = new Map(normalized.map((teacher) => [teacher.uid, teacher]));
  if (byUid.size !== normalized.length) throw new Error('The active teacher list contains duplicate identities.');

  const requestedUids = Array.isArray(input?.selectedTeacherUids)
    ? input.selectedTeacherUids.map((value) => clean(value)).filter(Boolean)
    : [];
  const uniqueRequested = [...new Set(requestedUids)];
  if (uniqueRequested.length !== requestedUids.length) throw new Error('A teacher can only be selected once.');

  const selected = method === 'all_active'
    ? normalized
    : uniqueRequested.map((uid) => {
      const teacher = byUid.get(uid);
      if (!teacher) throw new Error('A selected teacher is no longer active in this Academy. Refresh and retry.');
      return teacher;
    });

  if (!selected.length) throw new Error('Select at least one active teacher for this allocation.');

  let teacherAllocations;
  if (method === 'custom') {
    const raw = Array.isArray(input?.customAllocations) ? input.customAllocations : [];
    const amountByUid = new Map();
    for (const item of raw) {
      const uid = clean(item?.teacherUid);
      if (!uid || amountByUid.has(uid)) throw new Error('Custom teacher allocations contain a duplicate or invalid teacher.');
      amountByUid.set(uid, moneyToCents(item?.allocatedAmount, 'Custom allocation'));
    }
    if (amountByUid.size !== selected.length || selected.some((teacher) => !amountByUid.has(teacher.uid))) {
      throw new Error('Provide one custom amount for every selected teacher.');
    }
    teacherAllocations = selected.map((teacher) => {
      const cents = amountByUid.get(teacher.uid);
      if (cents <= 0) throw new Error(`Enter an amount greater than zero for ${teacher.name}.`);
      return {
        teacherUid: teacher.uid,
        teacherNameSnapshot: teacher.name,
        designationSnapshot: teacher.designation,
        teacherPhotoUrlSnapshot: teacher.photoUrl,
        allocatedAmount: centsToMoney(cents),
        allocationMethod: method,
      };
    });
  } else {
    teacherAllocations = equalCents(amountCents, selected, method);
  }

  const allocationCents = teacherAllocations.reduce((sum, item) => sum + moneyToCents(item.allocatedAmount), 0);
  if (allocationCents !== amountCents) {
    throw new Error('Teacher allocations must equal the full expense amount. Adjust the custom amounts before saving.');
  }
  return {
    allocationMethod: method,
    teacherAllocations,
    allocationTotal: centsToMoney(allocationCents),
    unallocatedAmount: 0,
  };
}

export function summarizeAcademyExpenses(expenses) {
  const records = Array.isArray(expenses) ? expenses : [];
  let postedCents = 0;
  let draftCents = 0;
  let voidedCents = 0;
  let allocatedCents = 0;
  let postedCount = 0;
  let draftCount = 0;
  let voidCount = 0;
  let unknownStatusCount = 0;
  const byCategoryCents = {};
  let malformedAmountCount = 0;

  for (const expense of records) {
    let amountCents;
    try { amountCents = moneyToCents(expense?.amount, 'Stored expense amount'); }
    catch { malformedAmountCount += 1; continue; }

    const status = clean(expense?.status).toLowerCase();
    if (status === 'posted') {
      postedCount += 1;
      postedCents += amountCents;
      const category = clean(expense?.category) || 'Other';
      byCategoryCents[category] = (byCategoryCents[category] || 0) + amountCents;

      let allocationCents = 0;
      try {
        allocationCents = moneyToCents(expense?.allocationTotal ?? 0, 'Stored allocation');
        if (allocationCents > amountCents) malformedAmountCount += 1;
      } catch {
        malformedAmountCount += 1;
      }

      const hasAllocationRows = Object.prototype.hasOwnProperty.call(expense ?? {}, 'teacherAllocations');
      const hasAllocationTotal = Object.prototype.hasOwnProperty.call(expense ?? {}, 'allocationTotal');
      const hasUnallocated = Object.prototype.hasOwnProperty.call(expense ?? {}, 'unallocatedAmount');
      let rowsCents = 0;
      if (hasAllocationRows) {
        if (!Array.isArray(expense.teacherAllocations)) {
          malformedAmountCount += 1;
        } else {
          for (const row of expense.teacherAllocations) {
            if (!clean(row?.teacherUid)) malformedAmountCount += 1;
            try { rowsCents += moneyToCents(row?.allocatedAmount, 'Stored teacher allocation'); }
            catch { malformedAmountCount += 1; }
          }
        }
      }
      if ((hasAllocationRows || hasAllocationTotal) && hasAllocationRows !== hasAllocationTotal) malformedAmountCount += 1;
      if (hasAllocationRows && hasAllocationTotal && rowsCents !== allocationCents) malformedAmountCount += 1;
      if (!hasAllocationRows && hasAllocationTotal && allocationCents > 0) malformedAmountCount += 1;
      if (hasUnallocated) {
        try {
          const unallocatedCents = moneyToCents(expense.unallocatedAmount, 'Stored unallocated amount');
          if (allocationCents + unallocatedCents !== amountCents) malformedAmountCount += 1;
        } catch {
          malformedAmountCount += 1;
        }
      }
      allocatedCents += allocationCents;
    } else if (status === 'draft') {
      draftCount += 1;
      draftCents += amountCents;
    } else if (status === 'void') {
      voidCount += 1;
      voidedCents += amountCents;
    } else {
      unknownStatusCount += 1;
      malformedAmountCount += 1;
    }
  }

  const byCategory = Object.fromEntries(Object.entries(byCategoryCents).map(([key, value]) => [key, centsToMoney(value)]));
  const highestCategory = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0] ?? null;
  return {
    totalPosted: centsToMoney(postedCents),
    totalDraft: centsToMoney(draftCents),
    totalVoided: centsToMoney(voidedCents),
    postedCount,
    draftCount,
    voidCount,
    unknownStatusCount,
    transactionCount: records.length,
    totalAllocated: centsToMoney(allocatedCents),
    totalUnallocated: centsToMoney(Math.max(0, postedCents - allocatedCents)),
    averagePosted: postedCount ? centsToMoney(Math.round(postedCents / postedCount)) : 0,
    highestCategory: highestCategory ? { name: highestCategory[0], amount: highestCategory[1] } : null,
    byCategory,
    malformedAmountCount,
    complete: malformedAmountCount === 0,
  };
}

export function summarizeTeacherAllocations(expenses) {
  const byTeacher = new Map();
  for (const expense of Array.isArray(expenses) ? expenses : []) {
    if (clean(expense?.status).toLowerCase() !== 'posted') continue;
    const rows = Array.isArray(expense?.teacherAllocations) ? expense.teacherAllocations : [];
    for (const allocation of rows) {
      const uid = clean(allocation?.teacherUid);
      if (!uid) continue;
      const current = byTeacher.get(uid) ?? {
        teacherUid: uid,
        name: clean(allocation.teacherNameSnapshot) || 'Former teacher',
        designation: clean(allocation.designationSnapshot),
        photoUrl: clean(allocation.teacherPhotoUrlSnapshot),
        totalCents: 0,
        entries: 0,
        lastAllocationDate: '',
        expenses: [],
      };
      let cents;
      try { cents = moneyToCents(allocation.allocatedAmount, 'Teacher allocation'); }
      catch { continue; }
      current.totalCents += cents;
      current.entries += 1;
      const date = clean(expense.expenseDate);
      if (date > current.lastAllocationDate) current.lastAllocationDate = date;
      current.expenses.push({
        expenseId: clean(expense.id || expense.expenseId),
        title: clean(expense.title),
        category: clean(expense.category),
        expenseDate: date,
        allocationMethod: clean(allocation.allocationMethod || expense.allocationMethod || 'custom'),
        allocatedAmount: centsToMoney(cents),
      });
      byTeacher.set(uid, current);
    }
  }
  return [...byTeacher.values()]
    .map((item) => ({ ...item, totalAllocated: centsToMoney(item.totalCents) }))
    .sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name))
    .map(({ totalCents, ...item }) => item);
}
