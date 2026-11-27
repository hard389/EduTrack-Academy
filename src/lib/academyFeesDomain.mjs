const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

export const getPreviousBillingMonth = (month) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) throw new Error('Billing month must use YYYY-MM.');
  const [year, monthNumber] = String(month).split('-').map(Number);
  const previous = new Date(Date.UTC(year, monthNumber - 2, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
};

export const getClassLineItems = (invoice, classId) => {
  if (!invoice || !Array.isArray(invoice.lineItems)) return [];
  return invoice.lineItems.filter((item) => item && String(item.classId || '') === String(classId));
};

export const getExtraLineItems = (invoice) => {
  if (!invoice || !Array.isArray(invoice.lineItems)) return [];
  return invoice.lineItems.filter((item) => item && item.kind === 'extra_charge');
};

export const sumInvoiceLines = (lineItems) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return null;
  const parsed = lineItems.map((item) => {
    const billed = Number(item?.amount);
    const paid = Number(item?.paidAmount ?? 0);
    const due = item?.remainingBalance === undefined || item?.remainingBalance === null
      ? billed - paid
      : Number(item.remainingBalance);
    if (![billed, paid, due].every(Number.isFinite) || billed < 0 || paid < 0 || due < 0 || paid > billed + 0.004) return null;
    return { billed, paid, due };
  });
  if (parsed.some((row) => row === null)) return null;
  return parsed.reduce((totals, row) => ({
    billed: roundMoney(totals.billed + row.billed),
    paid: roundMoney(totals.paid + row.paid),
    due: roundMoney(totals.due + row.due),
  }), { billed: 0, paid: 0, due: 0 });
};

export const getLineItemStatus = (totals) => {
  if (!totals) return 'NOT_INVOICED';
  if (totals.billed <= 0.004) return 'NOT_INVOICED';
  if (totals.due <= 0.004) return 'PAID';
  if (totals.paid > 0.004) return 'PARTIAL';
  return 'UNPAID';
};

export const sumMonthlyEnrolmentPreview = (enrolments, classId) => {
  const rows = (Array.isArray(enrolments) ? enrolments : []).filter((item) =>
    String(item?.classId || '') === String(classId) && String(item?.billingFrequency || 'monthly').toLowerCase() === 'monthly'
  );
  const amounts = rows.map((item) => Number(item?.feeAmountMonthly));
  if (amounts.some((amount) => !Number.isFinite(amount) || amount < 0)) return null;
  return roundMoney(amounts.reduce((sum, amount) => sum + amount, 0));
};

export const hasUnsupportedMonthlyBillingCycle = (enrolments) =>
  (Array.isArray(enrolments) ? enrolments : []).some((item) => {
    const frequency = String(item?.billingFrequency || 'monthly').trim().toLowerCase();
    return !['', 'monthly'].includes(frequency);
  });

export const getStudentClassLineTotals = (invoice, classId) => sumInvoiceLines(getClassLineItems(invoice, classId));

export const getClassInvoiceTotals = (invoices, classId, month) => {
  const rows = (Array.isArray(invoices) ? invoices : []).filter((invoice) => invoice.billingMonth === month && invoice.status !== 'void');
  const total = { billed: 0, paid: 0, due: 0 };
  let available = false;
  for (const invoice of rows) {
    const classItems = getClassLineItems(invoice, classId);
    if (!classItems.length) continue;
    const lineTotals = sumInvoiceLines(classItems);
    if (!lineTotals) return null;
    available = true;
    total.billed = roundMoney(total.billed + lineTotals.billed);
    total.paid = roundMoney(total.paid + lineTotals.paid);
    total.due = roundMoney(total.due + lineTotals.due);
  }
  return available ? total : null;
};
