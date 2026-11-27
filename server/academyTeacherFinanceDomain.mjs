const clean = (value) => typeof value === 'string' ? value.trim() : '';
const money = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Explicit invoice ownership wins. Legacy lines may fall back to a current active class/subject assignment. */
export function isTeacherInvoiceLine(line, teacherUid, activeAssignmentKeys) {
  const ownerUid = clean(line?.teacherUid);
  if (ownerUid) return ownerUid === teacherUid;
  const classId = clean(line?.classId);
  const subjectId = clean(line?.subjectId);
  return Boolean(classId && subjectId && activeAssignmentKeys.has(`${classId}:${subjectId}`));
}

/** Only allocations referencing this teacher's saved invoice line IDs are included. */
export function sumTeacherPaymentAllocations(allocations, teacherLineItemIds) {
  if (!Array.isArray(allocations)) return 0;
  const total = allocations.reduce((sum, allocation) => {
    const lineItemId = clean(allocation?.lineItemId);
    const amount = Number(allocation?.amount ?? 0);
    return lineItemId && teacherLineItemIds.has(lineItemId) && Number.isFinite(amount) && amount > 0
      ? sum + amount : sum;
  }, 0);
  return money(total);
}

/** Amounts are computed per teacher-owned line; never use an invoice total for a shared invoice. */
export function calculateTeacherFeeSummary(lines) {
  const totals = (Array.isArray(lines) ? lines : []).reduce((result, line) => {
    const amountValue = Number(line?.amount ?? 0);
    const paidValue = Number(line?.paidAmount ?? 0);
    const amount = Number.isFinite(amountValue) && amountValue > 0 ? amountValue : 0;
    const paid = Number.isFinite(paidValue) && paidValue > 0 ? Math.min(amount, paidValue) : 0;
    const balanceValue = line?.remainingBalance == null ? amount - paid : Number(line.remainingBalance);
    const balance = Number.isFinite(balanceValue) ? Math.min(amount, Math.max(0, balanceValue)) : Math.max(0, amount - paid);
    result.billed += amount;
    result.collected += paid;
    result.outstanding += balance;
    return result;
  }, { billed: 0, collected: 0, outstanding: 0 });
  return { billed: money(totals.billed), collected: money(totals.collected), outstanding: money(totals.outstanding) };
}
