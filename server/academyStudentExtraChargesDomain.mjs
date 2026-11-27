const clean = (value) => typeof value === 'string' ? value.trim() : '';

export function normalizeAcademyStudentExtraCharges(input) {
  if (!Array.isArray(input) || input.length > 20) {
    throw new Error('Extra charges must be a list containing no more than 20 entries.');
  }
  const ids = new Set();
  return input.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('An extra charge entry is invalid.');
    const id = clean(raw.id);
    const label = clean(raw.label);
    const amount = Number(raw.amount);
    const billingFrequency = clean(raw.billingFrequency || 'one_time').toLowerCase();
    const appliesToMonth = clean(raw.appliesToMonth);
    if (!id || id.length > 128 || /[\\/]/.test(id) || id.includes('..') || ids.has(id)) throw new Error('Every extra charge needs a unique valid identifier.');
    if (!label || label.length > 120) throw new Error('Extra charge title must contain 1 to 120 characters.');
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) throw new Error('Extra charge amount must be a positive valid amount.');
    if (!['one_time', 'monthly'].includes(billingFrequency)) throw new Error('Only one-time and monthly recurring extra charges are supported by the current invoice model.');
    if (billingFrequency === 'one_time' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(appliesToMonth)) throw new Error('A one-time extra charge needs a valid billing month (YYYY-MM).');
    ids.add(id);
    return {
      id,
      label,
      amount: Math.round((amount + Number.EPSILON) * 100) / 100,
      billingFrequency,
      appliesToMonth: billingFrequency === 'one_time' ? appliesToMonth : '',
    };
  });
}
