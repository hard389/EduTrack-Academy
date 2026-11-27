export const ACADEMY_PERMISSION_DEFINITIONS = Object.freeze([
  { key: 'dashboard.view', label: 'View dashboard', group: 'Dashboard', description: 'View the existing Teacher Dashboard.' },
  { key: 'classes.view_assigned', label: 'View assigned classes', group: 'Classes & Subjects', description: 'View only assigned class and subject workspaces.' },
  { key: 'classes.create_assigned', label: 'Create assigned classes', group: 'Classes & Subjects', description: 'Create classes within the Academy policy.' },
  { key: 'classes.manage_all', label: 'Manage all classes', group: 'Classes & Subjects', description: 'Manage Academy-wide class records.' },
  { key: 'subjects.view_assigned', label: 'View assigned subjects', group: 'Classes & Subjects', description: 'View assigned subject offerings.' },
  { key: 'subjects.manage_all', label: 'Manage all subjects', group: 'Classes & Subjects', description: 'Configure Academy subject catalogue and fee structures.' },
  { key: 'students.view_assigned', label: 'View assigned students', group: 'Students', description: 'View student rosters for assigned class and subject enrolments.' },
  { key: 'students.create', label: 'Add students', group: 'Students', description: 'Add a student to assigned class and subject enrolments.' },
  { key: 'students.edit_assigned', label: 'Edit assigned students', group: 'Students', description: 'Edit profiles for assigned students.' },
  { key: 'students.manage_all', label: 'Manage all students', group: 'Students', description: 'Manage the Academy-wide student directory.' },
  { key: 'attendance.take_assigned', label: 'Take assigned attendance', group: 'Attendance', description: 'Record student attendance from the existing Teacher Portal page.' },
  { key: 'attendance.view_assigned', label: 'View assigned attendance', group: 'Attendance', description: 'View attendance for assigned classes.' },
  { key: 'attendance.view_all', label: 'View all attendance', group: 'Attendance', description: 'View Academy-wide student attendance analytics.' },
  { key: 'attendance.correct', label: 'Correct attendance', group: 'Attendance', description: 'Correct attendance with an audited reason.' },
  { key: 'attendance.substitute_session', label: 'Use substitute sessions', group: 'Attendance', description: 'Record attendance during an approved temporary substitute session.' },
  { key: 'fees.view_assigned', label: 'View assigned fees', group: 'Fees', description: 'View central invoice balances for assigned students.' },
  { key: 'fees.collect', label: 'Collect payments', group: 'Fees', description: 'Record payments against invoices for assigned students.' },
  { key: 'fees.view_all', label: 'View all fees', group: 'Fees', description: 'View Academy-wide invoices and payment history.' },
  { key: 'fees.issue_invoice', label: 'Issue invoices', group: 'Fees', description: 'Generate consolidated invoices.' },
  { key: 'fees.configure', label: 'Configure fees', group: 'Fees', description: 'Configure future-dated subject fee structures.' },
  { key: 'fees.adjust', label: 'Adjust invoices', group: 'Fees', description: 'Apply audited invoice adjustments.' },
  { key: 'fees.refund', label: 'Refund payments', group: 'Fees', description: 'Issue audited compensating refund entries.' },
  { key: 'fees.alerts', label: 'Manage fee alerts', group: 'Fees', description: 'Use permitted fee reminder workflows.' },
  { key: 'reports.view_assigned', label: 'View assigned reports', group: 'Reports & Analytics', description: 'View reports for assigned classes.' },
  { key: 'reports.view_all', label: 'View all reports', group: 'Reports & Analytics', description: 'View Academy-wide reports.' },
  { key: 'analytics.view_assigned', label: 'View assigned analytics', group: 'Reports & Analytics', description: 'View analytics for assigned classes.' },
  { key: 'analytics.view_all', label: 'View all analytics', group: 'Reports & Analytics', description: 'View Academy-wide analytics.' },
  { key: 'notes.view', label: 'View notes and library', group: 'Learning', description: 'View notes and library resources for assigned classes.' },
  { key: 'notes.manage', label: 'Manage own notes', group: 'Learning', description: 'Manage resources owned by this teacher.' },
  { key: 'quiz.view_assigned', label: 'View assigned quizzes', group: 'Learning', description: 'View quiz definitions for assigned classes.' },
  { key: 'quiz.manage_assigned', label: 'Administer assigned quizzes', group: 'Learning', description: "Administer permitted quizzes without changing another teacher definition." },
  { key: 'alerts.view', label: 'View alerts', group: 'Communication', description: 'View teacher alerts and notifications.' },
  { key: 'alerts.manage', label: 'Manage alerts', group: 'Communication', description: 'Manage authorized alert and announcement workflows.' },
  { key: 'settings.profile', label: 'Edit own profile settings', group: 'Account', description: 'Edit permitted personal profile settings.' },
]);

export const ACADEMY_PERMISSION_KEYS = Object.freeze(ACADEMY_PERMISSION_DEFINITIONS.map((item) => item.key));
export const EMPTY_TEACHER_PERMISSIONS = Object.freeze(Object.fromEntries(ACADEMY_PERMISSION_KEYS.map((key) => [key, key === 'dashboard.view'])));

export const LEGACY_FEATURE_PERMISSION_MAP = Object.freeze({
  student_management: 'students.view_assigned',
  class_management: 'classes.view_assigned',
  attendance_management: 'attendance.take_assigned',
  attendance_alerts: 'alerts.manage',
  monthly_reports: 'reports.view_assigned',
  fortnightly_reports: 'reports.view_assigned',
  weekly_reports: 'reports.view_assigned',
  attendance_analytics: 'analytics.view_assigned',
  advanced_analytics: 'analytics.view_all',
  fee_tracking: 'fees.view_assigned',
  fee_alerts: 'fees.alerts',
  custom_alerts: 'alerts.manage',
  quiz_management: 'quiz.view_assigned',
  quiz_result_notifications: 'quiz.manage_assigned',
  notes_library: 'notes.view',
  library_link_whatsapp: 'notes.manage',
  announcements: 'alerts.manage',
});

export function hasAcademyFeaturePermission(permissions, featureKey) {
  const permissionKey = LEGACY_FEATURE_PERMISSION_MAP[featureKey];
  return Boolean(permissionKey && permissions && permissions[permissionKey] === true);
}

export function makeClassCode({ name, section = '', classId }) {
  const slug = `${String(name ?? '').trim()} ${String(section ?? '').trim()}`
    .toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18);
  const suffix = String(classId ?? '').replace(/[^A-Z0-9]/gi, '').slice(-6).toUpperCase();
  if (!slug || suffix.length < 4) throw new Error('A unique class code could not be generated.');
  return `${slug}-${suffix}`;
}

export function normalizeSubjectAssignments(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 40) throw new Error('Add at least one subject and teacher assignment.');
  const seen = new Set();
  return input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('A subject assignment is invalid.');
    const subjectId = String(item.subjectId ?? '').trim();
    const teacherUid = String(item.teacherUid ?? '').trim();
    const monthlyFee = money(item.monthlyFee ?? 0, 'Monthly subject fee');
    if (!subjectId || subjectId.length > 128 || subjectId.includes('/') || !teacherUid || teacherUid.length > 128 || teacherUid.includes('/')) throw new Error('A subject and an assigned teacher are required.');
    if (seen.has(subjectId)) throw new Error('A subject can only be added once to this class.');
    seen.add(subjectId);
    return { subjectId, teacherUid, monthlyFee, currency: 'PKR', billingFrequency: 'monthly' };
  });
}

export function buildExpenseSnapshot(input) {
  if (!input || typeof input !== 'object') throw new Error('Expense details are required.');
  const title = String(input.title ?? '').trim();
  const category = String(input.category ?? '').trim();
  const currency = String(input.currency ?? 'PKR').trim().toUpperCase();
  const amount = money(input.amount, 'Expense amount');
  const expenseDate = String(input.expenseDate ?? '').trim();
  const paymentMethod = String(input.paymentMethod ?? 'cash').trim().toLowerCase();
  const status = String(input.status ?? 'posted').trim().toLowerCase();
  if (!title || title.length > 140 || !category || category.length > 80 || amount <= 0) throw new Error('A title, category and positive expense amount are required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate) || Number.isNaN(Date.parse(`${expenseDate}T00:00:00Z`))) throw new Error('Expense date must use YYYY-MM-DD.');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Expense currency must be a three-letter code.');
  if (!['cash', 'bank_transfer', 'card', 'online', 'cheque', 'other'].includes(paymentMethod)) throw new Error('Expense payment method is invalid.');
  if (!['draft', 'posted'].includes(status)) throw new Error('Expense status must be draft or posted.');
  return { title, description: String(input.description ?? '').trim().slice(0, 1000), category, amount, currency, expenseDate, vendor: String(input.vendor ?? '').trim().slice(0, 120), paymentMethod, reference: String(input.reference ?? '').trim().slice(0, 100), status };
}


export function normalizePermissionMap(input) {
  if (input === undefined || input === null) return { ...EMPTY_TEACHER_PERMISSIONS };
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Permissions must be an object.');
  const unknown = Object.keys(input).filter((key) => !ACADEMY_PERMISSION_KEYS.includes(key));
  if (unknown.length) throw new Error(`Unknown permission key: ${unknown[0]}`);
  const result = { ...EMPTY_TEACHER_PERMISSIONS };
  for (const key of ACADEMY_PERMISSION_KEYS) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`Permission ${key} must be true or false.`);
    result[key] = key === 'dashboard.view' || input[key] === true;
  }
  return result;
}

export function normalizeIdList(value, fieldName = 'IDs', maximum = 100) {
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array.`);
  const values = [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))];
  if (values.length > maximum || values.some((item) => item.length > 128 || item.includes('/') || item.includes('\\') || item.includes('..'))) {
    throw new Error(`${fieldName} contains an invalid value.`);
  }
  return values;
}

/**
 * Merge all newly-created class/subject assignments for one teacher into the
 * membership arrays in a single deterministic result. Callers should persist
 * this result once per teacher inside their existing transaction.
 */
export function mergeTeacherAssignedIds(existingClassIds, existingSubjectIds, assignments) {
  if (!Array.isArray(assignments)) throw new Error('Teacher assignments must be an array.');
  const classIds = normalizeIdList(existingClassIds, 'Assigned classes');
  const subjectIds = normalizeIdList(existingSubjectIds, 'Assigned subjects');
  const newClassIds = [];
  const newSubjectIds = [];

  for (const assignment of assignments) {
    if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
      throw new Error('A teacher assignment is invalid.');
    }
    const classId = String(assignment.classId ?? '').trim();
    const subjectId = String(assignment.subjectId ?? '').trim();
    if (!classId || !subjectId) throw new Error('A teacher assignment requires class and subject IDs.');
    newClassIds.push(classId);
    newSubjectIds.push(subjectId);
  }

  return {
    assignedClassIds: normalizeIdList([...classIds, ...newClassIds], 'Assigned classes'),
    assignedSubjectIds: normalizeIdList([...subjectIds, ...newSubjectIds], 'Assigned subjects'),
  };
}

/**
 * Return the next positive numeric roll number for a class.
 * The caller must run this against records read inside the same Firestore
 * transaction that reserves the resulting number.
 */
export function nextClassRollNumber(existingRollNumbers, currentNext = 1) {
  const safeCurrent = Number.isSafeInteger(Number(currentNext)) && Number(currentNext) > 0
    ? Number(currentNext)
    : 1;
  const maximumExisting = (Array.isArray(existingRollNumbers) ? existingRollNumbers : [])
    .map((value) => String(value ?? '').trim())
    .filter((value) => /^\d+$/.test(value))
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  return Math.max(safeCurrent, maximumExisting + 1);
}

/** Advance a class sequence after a manually entered numeric roll number. */
export function advanceClassRollSequence(currentNext, allocatedRollNumber) {
  const safeCurrent = Number.isSafeInteger(Number(currentNext)) && Number(currentNext) > 0
    ? Number(currentNext)
    : 1;
  const normalized = String(allocatedRollNumber ?? '').trim();
  if (!/^\d+$/.test(normalized)) return safeCurrent;
  const numeric = Number(normalized);
  return Number.isSafeInteger(numeric) && numeric > 0
    ? Math.max(safeCurrent, numeric + 1)
    : safeCurrent;
}

export function normalizeBillingMonth(value) {
  const month = String(value ?? '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Billing month must use YYYY-MM format.');
  return month;
}

const money = (value, label = 'Amount') => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000) throw new Error(`${label} is invalid.`);
  return Math.round((amount + Number.EPSILON) * 100) / 100;
};

export function buildInvoiceSnapshot({ invoiceId, academyId, student, month, enrollments, issuedAt }) {
  const normalizedMonth = normalizeBillingMonth(month);
  if (!student || typeof student !== 'object' || !student.studentId) throw new Error('A canonical student is required.');
  if (!Array.isArray(enrollments) || enrollments.length === 0) throw new Error('The student has no active subject enrolments.');
  const seen = new Set();
  const lineItems = enrollments.map((enrollment) => {
    const subjectId = String(enrollment.subjectId ?? '').trim();
    const classId = String(enrollment.classId ?? '').trim();
    if (!subjectId || !classId) throw new Error('An enrolment is missing its class or subject.');
    const identity = `${classId}:${subjectId}`;
    if (seen.has(identity)) throw new Error('Duplicate active class/subject enrolment found. Resolve it before issuing an invoice.');
    seen.add(identity);
    const amount = money(enrollment.feeAmountMonthly ?? enrollment.monthlyFee ?? 0, 'Subject monthly fee');
    return {
      lineItemId: identity,
      kind: 'tuition',
      classId,
      subjectId,
      subjectName: String(enrollment.subjectName ?? 'Subject').trim().slice(0, 120),
      teacherUid: String(enrollment.teacherUid ?? ''),
      amount,
      paidAmount: 0,
      remainingBalance: amount,
    };
  });
  const extras = (Array.isArray(student.extraCharges) ? student.extraCharges : []).filter((extra) => {
    const frequency = String(extra?.billingFrequency ?? 'one_time').toLowerCase();
    return frequency === 'monthly' || extra?.appliesToMonth === normalizedMonth;
  });
  for (const [index, extra] of extras.entries()) {
    const label = String(extra?.label ?? '').trim();
    const amount = money(extra?.amount, 'Extra charge amount');
    if (!label || label.length > 120 || amount <= 0) throw new Error('Extra charges require a label and positive amount.');
    lineItems.push({
      lineItemId: `extra:${index}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      kind: 'extra_charge', classId: '', subjectId: '', subjectName: label, teacherUid: '',
      amount, paidAmount: 0, remainingBalance: amount,
    });
  }
  const totalAmount = money(lineItems.reduce((sum, item) => sum + item.amount, 0), 'Invoice total');
  return {
    invoiceId, academyId, studentId: String(student.studentId),
    studentName: String(student.name ?? 'Student').trim().slice(0, 120),
    rollNo: String(student.rollNo ?? '').trim().slice(0, 64),
    billingMonth: normalizedMonth, lineItems,
    teacherUids: [...new Set(enrollments.map((item) => String(item.teacherUid ?? '')).filter(Boolean))],
    subtotal: totalAmount, discountAmount: 0, adjustmentAmount: 0,
    totalAmount, paidAmount: 0, remainingBalance: totalAmount,
    status: totalAmount === 0 ? 'PAID' : 'UNPAID', issuedAt, schemaVersion: 2,
  };
}

export function applyPaymentToInvoice(invoice, payment) {
  if (!invoice || typeof invoice !== 'object' || !Array.isArray(invoice.lineItems)) throw new Error('The invoice is invalid.');
  const amount = money(payment?.amount, 'Payment amount');
  if (amount <= 0) throw new Error('Payment amount must be greater than zero.');
  const total = money(invoice.totalAmount, 'Invoice total');
  const paidBefore = money(invoice.paidAmount ?? 0, 'Previously paid amount');
  const outstanding = Math.max(0, Math.round((total - paidBefore + Number.EPSILON) * 100) / 100);
  if (amount > outstanding + 0.004) throw new Error(`Payment exceeds the outstanding balance of ${outstanding.toFixed(2)}.`);
  if (outstanding <= 0) throw new Error('This invoice has no outstanding balance.');

  let unallocated = amount;
  const allocations = [];
  const lineItems = invoice.lineItems.map((line) => {
    const lineTotal = money(line.amount, 'Invoice line amount');
    const linePaid = money(line.paidAmount ?? 0, 'Invoice line paid amount');
    const lineOutstanding = Math.max(0, Math.round((lineTotal - linePaid + Number.EPSILON) * 100) / 100);
    const allocated = Math.min(lineOutstanding, unallocated);
    if (allocated > 0) {
      allocations.push({ lineItemId: line.lineItemId, classId: line.classId, subjectId: line.subjectId, amount: allocated });
      unallocated = Math.round((unallocated - allocated + Number.EPSILON) * 100) / 100;
    }
    const nextPaid = Math.round((linePaid + allocated + Number.EPSILON) * 100) / 100;
    return { ...line, paidAmount: nextPaid, remainingBalance: Math.max(0, Math.round((lineTotal - nextPaid + Number.EPSILON) * 100) / 100) };
  });
  if (unallocated > 0.004) throw new Error('Payment could not be allocated to invoice line items.');
  const paidAmount = Math.round((paidBefore + amount + Number.EPSILON) * 100) / 100;
  const remainingBalance = Math.max(0, Math.round((total - paidAmount + Number.EPSILON) * 100) / 100);
  return {
    invoice: { ...invoice, lineItems, paidAmount, remainingBalance, status: remainingBalance <= 0.004 ? 'PAID' : 'PARTIAL' },
    payment: {
      amount,
      allocations,
      invoiceId: invoice.invoiceId,
      studentId: invoice.studentId,
      academyId: invoice.academyId,
      collectorUid: String(payment.collectorUid ?? ''),
      collectorEmail: String(payment.collectorEmail ?? ''),
      collectorRole: String(payment.collectorRole ?? ''),
      paymentMethod: String(payment.paymentMethod ?? 'cash').toLowerCase(),
      paymentReference: String(payment.paymentReference ?? '').slice(0, 100),
    },
  };
}

export function buildLegacyStudentProjection(student, extra = {}) {
  return {
    id: String(student.studentId),
    studentId: String(student.studentId),
    canonicalStudentId: String(student.studentId),
    name: String(student.name ?? ''),
    rollNo: String(student.rollNo ?? ''),
    fatherName: String(student.fatherName ?? ''),
    phone: String(student.phone ?? ''),
    gender: String(student.gender ?? ''),
    admissionDate: String(student.admissionDate ?? ''),
    monthlyFee: Number(student.monthlyFee ?? extra.monthlyFee ?? 0),
    studentFee: String(student.studentFee ?? student.monthlyFee ?? extra.monthlyFee ?? 0),
    feeStatus: String(student.feeStatus ?? 'Unpaid'),
    avatar: String(student.avatar ?? ''),
    attendanceWhatsAppOptIn: student.attendanceWhatsAppOptIn === true,
    attendanceWhatsAppOptInAt: student.attendanceWhatsAppOptInAt ?? null,
    attendanceWhatsAppOptInPhone: student.attendanceWhatsAppOptInPhone ?? null,
    parentWhatsAppOptIn: student.parentWhatsAppOptIn === true,
    parentWhatsAppOptInAt: student.parentWhatsAppOptInAt ?? null,
    parentWhatsAppOptInPhone: student.parentWhatsAppOptInPhone ?? null,
    quizResultsWhatsAppOptIn: student.quizResultsWhatsAppOptIn === true,
    quizResultsWhatsAppOptInAt: student.quizResultsWhatsAppOptInAt ?? null,
    quizResultsWhatsAppOptInPhone: student.quizResultsWhatsAppOptInPhone ?? null,
    feeAlertsWhatsAppOptIn: student.feeAlertsWhatsAppOptIn === true,
    feeAlertsWhatsAppOptInAt: student.feeAlertsWhatsAppOptInAt ?? null,
    feeAlertsWhatsAppOptInPhone: student.feeAlertsWhatsAppOptInPhone ?? null,
    announcementWhatsAppOptIn: student.announcementWhatsAppOptIn === true,
    announcementWhatsAppOptInAt: student.announcementWhatsAppOptInAt ?? null,
    announcementWhatsAppOptInPhone: student.announcementWhatsAppOptInPhone ?? null,
    libraryLinkWhatsAppOptIn: student.libraryLinkWhatsAppOptIn === true,
    libraryLinkWhatsAppOptInAt: student.libraryLinkWhatsAppOptInAt ?? null,
    libraryLinkWhatsAppOptInPhone: student.libraryLinkWhatsAppOptInPhone ?? null,
    academyId: String(student.academyId ?? ''),
    ...extra,
  };
}
