const PAYMENT_METHOD_TYPES = new Set(['bank', 'mobile_wallet', 'other']);
const MAX_PAYMENT_METHODS = 8;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clean(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function toPaymentMethod(value, index) {
  if (!isRecord(value)) return null;
  const rawType = clean(value.type, 30);
  const method = {
    id: clean(value.id, 100) || `payment-method-${index + 1}`,
    name: clean(value.name, 80),
    type: PAYMENT_METHOD_TYPES.has(rawType) ? rawType : 'bank',
    providerName: clean(value.providerName, 100),
    accountTitle: clean(value.accountTitle, 120),
    accountNumber: clean(value.accountNumber, 80),
    iban: clean(value.iban, 60),
    mobileNumber: clean(value.mobileNumber, 40),
    branch: clean(value.branch, 80),
    instructions: clean(value.instructions, 1000),
  };
  if (!method.name) return null;
  if (!method.accountNumber && !method.iban && !method.mobileNumber && !method.instructions) return null;
  return method;
}

/** Read stored payment methods defensively; invalid/legacy rows are ignored. */
export function normalizePaymentMethods(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PAYMENT_METHODS)
    .map((item, index) => toPaymentMethod(item, index))
    .filter((item) => item !== null);
}

/** Validate administrator input before writing the public-facing payment method list. */
export function validatePaymentMethods(value) {
  if (!Array.isArray(value)) {
    return { valid: false, error: 'Payment methods must be a list.' };
  }
  if (value.length > MAX_PAYMENT_METHODS) {
    return { valid: false, error: `Add no more than ${MAX_PAYMENT_METHODS} payment methods.` };
  }

  const paymentMethods = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) {
      return { valid: false, error: `Payment method ${index + 1} is invalid.` };
    }

    const name = clean(item.name, 80);
    const type = clean(item.type, 30);
    if (typeof item.name === 'string' && item.name.trim().length > 80) {
      return { valid: false, error: `Payment method ${index + 1} name is too long (maximum 80 characters).` };
    }
    if (!name) {
      return { valid: false, error: `Enter a name for payment method ${index + 1}.` };
    }
    if (!PAYMENT_METHOD_TYPES.has(type)) {
      return { valid: false, error: `Choose a valid type for payment method ${index + 1}.` };
    }

    const rawFields = [
      ['providerName', 100], ['accountTitle', 120], ['accountNumber', 80],
      ['iban', 60], ['mobileNumber', 40], ['branch', 80], ['instructions', 1000],
    ];
    for (const [field, maxLength] of rawFields) {
      if (item[field] !== undefined && typeof item[field] !== 'string') {
        return { valid: false, error: `${field} in payment method ${index + 1} must be text.` };
      }
      if (typeof item[field] === 'string' && item[field].trim().length > maxLength) {
        return { valid: false, error: `${field} in payment method ${index + 1} is too long (maximum ${maxLength} characters).` };
      }
    }

    const paymentMethod = toPaymentMethod(item, index);
    if (!paymentMethod || (!paymentMethod.accountNumber && !paymentMethod.iban && !paymentMethod.mobileNumber && !paymentMethod.instructions)) {
      return { valid: false, error: `Add an account number, IBAN, mobile number or payment instruction to ${name}, or remove this method.` };
    }
    paymentMethods.push(paymentMethod);
  }

  return { valid: true, paymentMethods };
}
