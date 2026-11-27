export const STUDENT_CONSENT_CONFIG = Object.freeze([
  { input: 'attendanceWhatsAppOptIn', permissionKey: 'attendance_alerts', property: 'attendanceWhatsAppOptIn', timestamp: 'attendanceWhatsAppOptInAt', phone: 'attendanceWhatsAppOptInPhone' },
  { input: 'monthlyReportWhatsAppOptIn', permissionKey: 'monthly_reports', property: 'parentWhatsAppOptIn', timestamp: 'parentWhatsAppOptInAt', phone: 'parentWhatsAppOptInPhone' },
  { input: 'quizResultsWhatsAppOptIn', permissionKey: 'quiz_result_notifications', property: 'quizResultsWhatsAppOptIn', timestamp: 'quizResultsWhatsAppOptInAt', phone: 'quizResultsWhatsAppOptInPhone' },
  { input: 'feeAlertsWhatsAppOptIn', permissionKey: 'fee_alerts', property: 'feeAlertsWhatsAppOptIn', timestamp: 'feeAlertsWhatsAppOptInAt', phone: 'feeAlertsWhatsAppOptInPhone' },
  { input: 'announcementWhatsAppOptIn', permissionKey: 'announcements', property: 'announcementWhatsAppOptIn', timestamp: 'announcementWhatsAppOptInAt', phone: 'announcementWhatsAppOptInPhone' },
  { input: 'libraryLinkWhatsAppOptIn', permissionKey: 'library_link_whatsapp', property: 'libraryLinkWhatsAppOptIn', timestamp: 'libraryLinkWhatsAppOptInAt', phone: 'libraryLinkWhatsAppOptInPhone' },
]);

// Guardian-message consent is a separate, explicit parent choice. It is not a
// teacher module-access permission, so the shared teacher admission adapter
// must preserve the values selected in the existing form.
export const GUARDIAN_CONSENT_CAPABILITIES = Object.freeze(
  Object.fromEntries(STUDENT_CONSENT_CONFIG.map((field) => [field.permissionKey, true])),
);

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const RESERVED_CLASS_KEYS = new Set(['id', 'name', 'code', 'monthlyFee', 'className', 'title', 'fee', 'classFee', 'createdAt', 'createdDate', 'date', 'updatedAt', 'students']);
const isStudentRecord = (value) => isRecord(value) && (typeof value.name === 'string' || value.id !== undefined || value.studentId !== undefined);
const compareKeys = (a, b) => {
  const na = Number(a); const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
};

export function normalizePakistaniPhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.startsWith('92')) digits = digits.slice(2);
  if (digits.length !== 10 || !digits.startsWith('3')) return '';
  return `+92 ${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export function buildStudentRecord(raw, permissions, id, options = {}) {
  const input = isRecord(raw) ? raw : {};
  const permissionMap = isRecord(permissions) ? permissions : {};
  const name = String(input.name ?? '').trim();
  const rollNo = String(input.rollNo ?? '').trim();
  const phone = normalizePakistaniPhone(input.phone);
  const fatherName = String(input.fatherName ?? '').trim() || 'N/A';
  const gender = input.gender === 'Female' ? 'Female' : input.gender === 'Male' ? 'Male' : null;
  const feeRaw = String(input.studentFee ?? options.classMonthlyFee ?? '5000').trim();
  const fee = Number(feeRaw);
  if (!name) throw Object.assign(new Error('Student name is required.'), { status: 400, code: 'INVALID_STUDENT' });
  if (!rollNo) throw Object.assign(new Error('Roll number is required.'), { status: 400, code: 'INVALID_STUDENT' });
  if (!phone) throw Object.assign(new Error('A valid Pakistani guardian WhatsApp number is required.'), { status: 400, code: 'INVALID_PHONE' });
  if (!gender) throw Object.assign(new Error('Gender must be Male or Female.'), { status: 400, code: 'INVALID_GENDER' });
  if (!Number.isFinite(fee) || fee < 0) throw Object.assign(new Error('Monthly fee must be a non-negative number.'), { status: 400, code: 'INVALID_FEE' });

  const avatar = String(input.avatar ?? '').trim();
  const safeAvatar = avatar.length <= 900_000 && (/^https?:\/\//i.test(avatar) || /^data:image\/(png|jpeg|webp);base64,/i.test(avatar))
    ? avatar
    : (gender === 'Female'
      ? 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&auto=format&fit=crop&q=80'
      : 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&auto=format&fit=crop&q=80');

  const student = {
    id,
    name,
    fatherName,
    phone,
    rollNo,
    gender,
    avatar: safeAvatar,
    feeStatus: 'Unpaid',
    studentFee: String(feeRaw),
  };
  const ignoredConsentFeatures = [];
  let timestampOffset = 0;
  for (const field of STUDENT_CONSENT_CONFIG) {
    const allowed = permissionMap[field.permissionKey] === true;
    const requested = input[field.input] === true;
    const enabled = allowed && requested;
    if (requested && !allowed) ignoredConsentFeatures.push(field.permissionKey);
    student[field.property] = enabled;
    student[field.timestamp] = enabled ? new Date(Date.now() + timestampOffset++).toISOString() : null;
    student[field.phone] = enabled ? phone : null;
  }
  return { student, ignoredConsentFeatures };
}

export function listStudentRecords(classData) {
  if (!isRecord(classData)) return [];
  if (Array.isArray(classData.students)) return classData.students.filter(isRecord);
  if (isRecord(classData.students)) {
    return Object.entries(classData.students).filter(([, value]) => isStudentRecord(value)).sort(([a], [b]) => compareKeys(a, b)).map(([, value]) => value);
  }
  return Object.entries(classData)
    .filter(([key, value]) => !RESERVED_CLASS_KEYS.has(key) && isStudentRecord(value))
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([, value]) => value);
}

export function planStudentRosterAdd(classData, student) {
  if (!isRecord(classData)) throw Object.assign(new Error('Class data has an unsupported format.'), { status: 409, code: 'UNSUPPORTED_CLASS' });
  if (Array.isArray(classData.students)) return { type: 'array', students: [student, ...classData.students] };
  if (classData.students === undefined || classData.students === null) {
    const hasLegacyStudents = Object.entries(classData).some(([key, value]) => !RESERVED_CLASS_KEYS.has(key) && isStudentRecord(value));
    if (!hasLegacyStudents) return { type: 'array', students: [student] };
    const numericKeys = Object.keys(classData).filter((key) => !RESERVED_CLASS_KEYS.has(key) && isStudentRecord(classData[key]));
    const next = numericKeys.map(Number).filter(Number.isInteger).reduce((max, value) => Math.max(max, value), -1) + 1;
    return { type: 'topLevel', key: String(next), student };
  }
  if (isRecord(classData.students)) {
    const keys = Object.keys(classData.students).map(Number).filter((value) => Number.isInteger(value) && value >= 0);
    return { type: 'studentsMap', key: String(keys.length ? Math.max(...keys) + 1 : 0), student };
  }
  throw Object.assign(new Error('Students in this class use an unsupported storage format.'), { status: 409, code: 'UNSUPPORTED_STUDENTS' });
}

export function hasDuplicateRollNumber(classData, rollNo) {
  const wanted = String(rollNo ?? '').trim().toLowerCase();
  return listStudentRecords(classData).some((student) => String(student.rollNo ?? '').trim().toLowerCase() === wanted);
}
