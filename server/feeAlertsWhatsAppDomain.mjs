import { createHash } from "node:crypto";

const MONEY_EPSILON = 0.005;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseMoney(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const rounded = roundMoney(parsed);
  return Number.isSafeInteger(Math.round(rounded * 100)) ? rounded : null;
}

function monthOffset(monthKey, offset) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) return null;
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function admissionMonth(student) {
  const value = student?.joiningDate || student?.admissionDate || student?.createdAt || student?.date;
  if (value === undefined || value === null || value === "") return null;

  // Date-only values are calendar dates (not midnight UTC), matching the Fees page parser.
  if (typeof value === "string") {
    const text = value.trim();
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      const year = Number(iso[1]);
      const month = Number(iso[2]);
      const day = Number(iso[3]);
      const checked = new Date(Date.UTC(year, month - 1, day));
      if (checked.getUTCFullYear() !== year || checked.getUTCMonth() + 1 !== month || checked.getUTCDate() !== day) return null;
      return `${year}-${String(month).padStart(2, "0")}`;
    }
    const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
      const month = Number(slash[1]);
      const day = Number(slash[2]);
      const year = Number(slash[3]);
      const checked = new Date(Date.UTC(year, month - 1, day));
      if (checked.getUTCFullYear() !== year || checked.getUTCMonth() + 1 !== month || checked.getUTCDate() !== day) return null;
      return `${year}-${String(month).padStart(2, "0")}`;
    }
  }

  let date = null;
  if (value instanceof Date) date = value;
  else if (isRecord(value) && typeof value.toDate === "function") {
    try { date = value.toDate(); } catch { return null; }
  } else if (isRecord(value) && typeof value.seconds === "number") {
    date = new Date(value.seconds * 1000);
  } else if (typeof value === "number") {
    date = new Date(value);
  } else if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

export function isStudentEligibleForFeeMonth(student, monthKey) {
  if (!isRecord(student) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) return false;
  const enrolledMonth = admissionMonth(student);
  return !enrolledMonth || monthKey >= enrolledMonth;
}

export function normalizeFeeAlertPhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10) digits = `92${digits}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function hasCurrentFeeAlertsConsent(student) {
  if (!isRecord(student) || student.feeAlertsWhatsAppOptIn !== true) return false;
  if (typeof student.feeAlertsWhatsAppOptInAt !== "string" || !student.feeAlertsWhatsAppOptInAt.trim()) return false;
  const consentPhone = normalizeFeeAlertPhone(student.feeAlertsWhatsAppOptInPhone);
  const currentPhone = normalizeFeeAlertPhone(student.phone);
  return Boolean(consentPhone && currentPhone && consentPhone === currentPhone);
}

export function normalizeFeeReminderDays(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const days = value.map((item) => Number(item));
  if (days.some((day) => !Number.isInteger(day) || day < 1 || day > 28)) return null;
  if (days[0] === days[1]) return null;
  return days.sort((a, b) => a - b);
}

export function getPakistanCalendarParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("Could not resolve the Pakistan calendar date.");
  }
  return {
    year,
    month,
    day,
    monthKey: `${year}-${String(month).padStart(2, "0")}`,
  };
}

function validateMoneyField(record, field, context) {
  if (!Object.prototype.hasOwnProperty.call(record, field)) return null;
  const value = record[field];
  if (value === undefined || value === null || value === "") return null;
  const parsed = parseMoney(value);
  if (parsed === null) throw new Error(`${context} has invalid ${field}.`);
  return parsed;
}

function getDefaultMonthlyFee(student, classData) {
  const studentSpecific = student.studentFee ?? student.classFee ?? student.monthlyFee;
  if (studentSpecific !== undefined && studentSpecific !== null && studentSpecific !== "") {
    const parsed = parseMoney(studentSpecific);
    if (parsed === null) throw new Error("Student monthly fee is invalid.");
    return parsed;
  }
  for (const value of [classData.monthlyFee, classData.fee, classData.classFee]) {
    if (value === undefined || value === null || value === "") continue;
    const parsed = parseMoney(value);
    if (parsed !== null) return parsed;
  }
  return 0;
}

/** Mirrors the Fees page's historical allocation model and never trusts the cached status label alone. */
export function computeFeeOutstanding({ student, classData, currentRecord, previousRecord, monthKey }) {
  if (!isRecord(student) || !isRecord(classData)) return { valid: false, error: "Student or class data is malformed." };
  if (currentRecord !== undefined && currentRecord !== null && !isRecord(currentRecord)) {
    return { valid: false, error: "Current monthly fee record is malformed." };
  }
  if (previousRecord !== undefined && previousRecord !== null && !isRecord(previousRecord)) {
    return { valid: false, error: "Previous monthly fee record is malformed." };
  }
  const current = isRecord(currentRecord) ? currentRecord : {};
  const previous = isRecord(previousRecord) ? previousRecord : {};
  try {
    for (const field of ["paidAmount", "remainingDues", "previousMonthDues", "monthlyFeeDue", "paidTowardsCurrentMonth"]) {
      validateMoneyField(current, field, "Current fee record");
    }
    for (const field of ["paidAmount", "remainingDues", "previousMonthDues", "monthlyFeeDue"]) {
      validateMoneyField(previous, field, "Previous fee record");
    }
    const priorMonth = monthOffset(monthKey, -1);
    if (!priorMonth) throw new Error("Fee month is invalid.");
    const studentAdmissionMonth = admissionMonth(student);
    const canCarryPreviousDues = !studentAdmissionMonth || priorMonth >= studentAdmissionMonth;
    const oldPreviousRemaining = validateMoneyField(previous, "remainingDues", "Previous fee record") ?? 0;
    const legacyPreviousRemaining = validateMoneyField(current, "previousMonthDues", "Current fee record") ?? 0;
    const previousMonthDues = canCarryPreviousDues
      ? Math.max(oldPreviousRemaining, legacyPreviousRemaining)
      : 0;
    const monthlyFeeDue = validateMoneyField(current, "monthlyFeeDue", "Current fee record") ?? getDefaultMonthlyFee(student, classData);
    const storedRemaining = validateMoneyField(current, "remainingDues", "Current fee record");
    const storedAllocation = validateMoneyField(current, "paidTowardsCurrentMonth", "Current fee record");
    const paidAmount = validateMoneyField(current, "paidAmount", "Current fee record") ?? 0;
    let paidTowardsCurrentMonth;
    if (storedAllocation !== null) {
      paidTowardsCurrentMonth = Math.min(monthlyFeeDue, storedAllocation);
    } else if (storedRemaining !== null) {
      paidTowardsCurrentMonth = Math.min(
        monthlyFeeDue,
        Math.max(0, roundMoney(monthlyFeeDue + previousMonthDues - storedRemaining)),
      );
    } else {
      paidTowardsCurrentMonth = Math.min(monthlyFeeDue, paidAmount);
    }
    const totalObligation = roundMoney(previousMonthDues + monthlyFeeDue);
    const remainingDues = Math.max(0, roundMoney(totalObligation - paidTowardsCurrentMonth));
    const status = totalObligation <= MONEY_EPSILON
      ? "UNPAID"
      : remainingDues <= MONEY_EPSILON
        ? "PAID"
        : paidAmount > 0 || paidTowardsCurrentMonth > 0
          ? "PARTIAL"
          : "UNPAID";
    return {
      valid: true,
      monthlyFeeDue,
      previousMonthDues,
      totalObligation,
      paidAmount,
      paidTowardsCurrentMonth,
      remainingDues,
      status,
    };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : "Fee record validation failed." };
  }
}

export function createFeeAlertJobId({ tenantId, classId, monthKey, studentId, reminderDay }) {
  const source = [tenantId, classId, monthKey, studentId, String(reminderDay)].join("\u001f");
  return createHash("sha256").update(`edutrack-fee-alert:v1:${source}`).digest("hex");
}

export function feeMonthLabel(monthKey) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) return monthKey;
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function buildFeeReminderMessage({ studentName, className, monthKey, amountDue }) {
  const safeName = String(studentName || "Student").trim().slice(0, 100) || "Student";
  const safeClass = String(className || "Class").trim().slice(0, 100) || "Class";
  const safeAmount = roundMoney(Number(amountDue));
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) throw new Error("Fee reminder amount must be positive.");
  const formattedAmount = safeAmount.toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return [
    "Assalam-o-Alaikum,",
    "This is a school fee reminder from EduTrack.",
    `Student: ${safeName}`,
    `Class: ${safeClass}`,
    `Fee month: ${feeMonthLabel(monthKey)}`,
    `Outstanding balance: PKR ${formattedAmount}`,
    "If payment has already been made, please disregard this reminder and contact the school if the balance still appears outstanding.",
    "Thank you.",
  ].join("\n");
}

export function createFeeAlertRecipientHash(phone) {
  const normalized = normalizeFeeAlertPhone(phone);
  if (!normalized) throw new Error("Invalid fee-alert recipient number.");
  return createHash("sha256").update(`edutrack-fee-alert-recipient:v1:${normalized}`).digest("hex");
}
