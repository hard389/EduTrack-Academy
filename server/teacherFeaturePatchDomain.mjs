export function calculateAnnouncementExtraCharge({
  quotaPerClass,
  includedQuota = 4,
  extraPackSize = 4,
  extraPackPricePaisa = 0,
  billableClassCount = 0,
}) {
  const quota = Number(quotaPerClass);
  const included = Number(includedQuota);
  const packSize = Number(extraPackSize);
  const packPrice = Number(extraPackPricePaisa);
  const classes = Number(billableClassCount);
  if (!Number.isSafeInteger(quota) || quota < included || quota > 500) throw new RangeError('Announcement quota must be a whole number between the included allowance and 500.');
  if (!Number.isSafeInteger(included) || included < 0 || included > 500) throw new RangeError('Included announcement quota is invalid.');
  if (!Number.isSafeInteger(packSize) || packSize < 1 || packSize > 100) throw new RangeError('Announcement extra pack size must be a whole number between 1 and 100.');
  if (!Number.isSafeInteger(packPrice) || packPrice < 0 || packPrice > 1_000_000_000) throw new RangeError('Announcement extra pack price is invalid.');
  if (!Number.isSafeInteger(classes) || classes < 0 || classes > 250) throw new RangeError('Billable class count is invalid.');
  if (quota <= included || classes === 0) return { extraPacks: 0, amountPaisa: 0 };
  if (packPrice < 1) throw new RangeError('An extra announcement quota requires a configured pack price.');
  const extraPacks = Math.ceil((quota - included) / packSize);
  const amountPaisa = extraPacks * packPrice * classes;
  if (!Number.isSafeInteger(amountPaisa) || amountPaisa > 1_000_000_000) throw new RangeError('Additional announcement quota charge is too large.');
  return { extraPacks, amountPaisa };
}

export function summarizeProviderStatuses(rows) {
  const summary = { providerAccepted: 0, deliveryConfirmed: 0, rejected: 0, unknownOutcome: 0, pending: 0, inspected: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    summary.inspected += 1;
    const status = typeof row.status === 'string' ? row.status.toLowerCase() : '';
    if (status === 'delivered' && row.deliveryConfirmed === true) summary.deliveryConfirmed += 1;
    else if (['accepted_by_postabi', 'accepted_by_meta', 'accepted_by_provider', 'provider_accepted'].includes(status) || row.providerAccepted === true) summary.providerAccepted += 1;
    else if (['provider_rejected', 'rejected', 'failed'].includes(status)) summary.rejected += 1;
    else if (['unknown_outcome', 'unknown'].includes(status)) summary.unknownOutcome += 1;
    else if (['pending', 'queued', 'dispatching', 'prepared', 'prepared_for_vercel'].includes(status)) summary.pending += 1;
  }
  return summary;
}

export function summarizeAnnouncementRecipientsByClass(recipients) {
  const output = new Map();
  for (const row of Array.isArray(recipients) ? recipients : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const rawIds = Array.isArray(row.classIds) ? row.classIds : [row.classId];
    const ids = [...new Set(rawIds.filter((value) => typeof value === 'string' && value.trim()))];
    for (const id of ids) {
      const count = output.get(id) || { accepted: 0, rejected: 0, unknown: 0 };
      if (row.status === 'provider_accepted') count.accepted += 1;
      else if (row.status === 'provider_rejected') count.rejected += 1;
      else if (row.status === 'unknown_outcome') count.unknown += 1;
      output.set(id, count);
    }
  }
  return output;
}
