
export const STUDENT_IMPORT_CORE_COLUMNS = Object.freeze([
  { key: 'name', label: 'Student Name', example: ['Ahmed Khan', 'Ayesha Bibi'], required: true, width: 22 },
  { key: 'fatherName', label: "Father's Name", example: ['Tariq Khan', 'Nasir Ali'], required: true, width: 20 },
  { key: 'phone', label: 'Parent/Guardian WhatsApp', example: ['0300 1234567', '0311 9876543'], required: true, width: 24 },
  { key: 'rollNo', label: 'Roll Number', example: ['001', '002'], required: true, width: 14 },
  { key: 'gender', label: 'Gender', example: ['Male', 'Female'], required: true, width: 12 },
  { key: 'fee', label: 'Monthly Fee (PKR)', example: ['5000', '5000'], required: true, width: 18 },
]);

export const STUDENT_CONSENT_COLUMNS = Object.freeze([
  {
    key: 'attendanceConsent',
    inputProperty: 'attendanceWhatsAppOptIn',
    label: 'Attendance Alert WhatsApp Consent',
    permissionKey: 'attendance_alerts',
    studentProperty: 'attendanceWhatsAppOptIn',
    timestampProperty: 'attendanceWhatsAppOptInAt',
    phoneProperty: 'attendanceWhatsAppOptInPhone',
    aliases: ['attendance alert whatsapp consent', 'attendance whatsapp consent', 'attendance alerts consent', 'attendance notification consent'],
    width: 34,
  },
  {
    key: 'monthlyReportConsent',
    inputProperty: 'monthlyReportWhatsAppOptIn',
    label: 'Monthly Report WhatsApp Consent',
    permissionKey: 'monthly_reports',
    studentProperty: 'monthlyReportWhatsAppOptIn',
    persistenceProperty: 'parentWhatsAppOptIn',
    timestampProperty: 'parentWhatsAppOptInAt',
    phoneProperty: 'parentWhatsAppOptInPhone',
    aliases: ['monthly report whatsapp consent', 'monthly reports whatsapp consent', 'monthly pdf whatsapp consent', 'monthly report consent'],
    width: 34,
  },
  {
    key: 'quizResultsConsent',
    inputProperty: 'quizResultsWhatsAppOptIn',
    label: 'Quiz Results WhatsApp Consent',
    permissionKey: 'quiz_result_notifications',
    studentProperty: 'quizResultsWhatsAppOptIn',
    timestampProperty: 'quizResultsWhatsAppOptInAt',
    phoneProperty: 'quizResultsWhatsAppOptInPhone',
    aliases: ['quiz results whatsapp consent', 'quiz result whatsapp consent', 'quiz results consent', 'quiz notification consent'],
    width: 32,
  },
  {
    key: 'feeAlertsConsent',
    inputProperty: 'feeAlertsWhatsAppOptIn',
    label: 'Fee Alerts WhatsApp Consent',
    permissionKey: 'fee_alerts',
    studentProperty: 'feeAlertsWhatsAppOptIn',
    timestampProperty: 'feeAlertsWhatsAppOptInAt',
    phoneProperty: 'feeAlertsWhatsAppOptInPhone',
    aliases: ['fee alerts whatsapp consent', 'fee alert whatsapp consent', 'fee reminder whatsapp consent', 'fee alerts consent'],
    width: 30,
  },
  {
    key: 'announcementConsent',
    inputProperty: 'announcementWhatsAppOptIn',
    label: 'Announcement WhatsApp Consent',
    permissionKey: 'announcements',
    studentProperty: 'announcementWhatsAppOptIn',
    timestampProperty: 'announcementWhatsAppOptInAt',
    phoneProperty: 'announcementWhatsAppOptInPhone',
    aliases: ['announcement whatsapp consent', 'announcements whatsapp consent', 'school announcements consent', 'announcement consent'],
    width: 32,
  },
  {
    key: 'libraryLinkConsent',
    inputProperty: 'libraryLinkWhatsAppOptIn',
    label: 'Library Links WhatsApp Consent',
    permissionKey: 'library_link_whatsapp',
    studentProperty: 'libraryLinkWhatsAppOptIn',
    timestampProperty: 'libraryLinkWhatsAppOptInAt',
    phoneProperty: 'libraryLinkWhatsAppOptInPhone',
    aliases: ['library links whatsapp consent', 'library link whatsapp consent', 'notes and library whatsapp consent', 'library resource whatsapp consent'],
    width: 32,
  },
]);

export const STUDENT_IMPORT_PHOTO_COLUMN = Object.freeze({
  key: 'photo', label: 'Photo URL', example: ['', ''], required: false, width: 34,
  aliases: ['photo url', 'photo', 'avatar url', 'image url', 'alternate photo url', 'photo url 2'],
});

export const STUDENT_IMPORT_REQUIRED_KEYS = Object.freeze(STUDENT_IMPORT_CORE_COLUMNS.map((column) => column.key));
export const STUDENT_IMPORT_FIELD_LABELS = Object.freeze(Object.fromEntries([
  ...STUDENT_IMPORT_CORE_COLUMNS.map(({ key, label }) => [key, label]),
  ...STUDENT_CONSENT_COLUMNS.map(({ key, label }) => [key, label]),
  [STUDENT_IMPORT_PHOTO_COLUMN.key, STUDENT_IMPORT_PHOTO_COLUMN.label],
]));

export function createEmptyStudentColumnMap() {
  return Object.fromEntries(Object.keys(STUDENT_IMPORT_FIELD_LABELS).map((key) => [key, '']));
}

export function isFeatureAccessible(canAccessFeature, permissionKey) {
  try {
    return typeof canAccessFeature === 'function' && canAccessFeature(permissionKey) === true;
  } catch {
    return false;
  }
}

export function getStudentTemplateColumns(canAccessFeature) {
  const consentColumns = STUDENT_CONSENT_COLUMNS.filter((column) => isFeatureAccessible(canAccessFeature, column.permissionKey));
  return [
    ...STUDENT_IMPORT_CORE_COLUMNS,
    ...consentColumns,
    STUDENT_IMPORT_PHOTO_COLUMN,
  ];
}

export function isPermissionStateAccessible(state) {
  return state === 'enabled' || state === 'configurable';
}

export function getIgnoredStudentConsentColumnLabels(columnMap, featurePermissions) {
  const map = columnMap && typeof columnMap === 'object' ? columnMap : {};
  const permissions = featurePermissions && typeof featurePermissions === 'object' ? featurePermissions : {};
  return STUDENT_CONSENT_COLUMNS
    .filter((column) => Boolean(map[column.key]) && !isPermissionStateAccessible(permissions[column.permissionKey]))
    .map((column) => column.label);
}

export function getStudentConsentFormValues(consents, featurePermissions) {
  const consentMap = consents && typeof consents === 'object' ? consents : {};
  const permissions = featurePermissions && typeof featurePermissions === 'object' ? featurePermissions : {};
  return Object.fromEntries(STUDENT_CONSENT_COLUMNS.map((column) => [
    column.inputProperty,
    isPermissionStateAccessible(permissions[column.permissionKey]) && consentMap[column.key] === true,
  ]));
}

export function getStudentColumnAliases() {
  const aliases = {
    name: ['student name', 'full name', 'name', 'student'],
    fatherName: ["father's name", 'father name', 'fathers name', 'guardian name', 'father'],
    phone: ['parent/guardian whatsapp', 'guardian whatsapp', 'parent whatsapp', 'whatsapp', 'whatsapp number', 'phone', 'phone number', 'mobile', 'mobile number', 'contact', 'contact number'],
    rollNo: ['roll number', 'roll no', 'rollno', 'roll', 'roll no.'],
    gender: ['gender', 'sex'],
    fee: ['monthly fee (pkr)', 'monthly fee', 'student fee', 'fee', 'fee (pkr)'],
    photo: STUDENT_IMPORT_PHOTO_COLUMN.aliases,
  };
  for (const column of STUDENT_CONSENT_COLUMNS) aliases[column.key] = [...column.aliases];
  return aliases;
}

export function autoDetectStudentColumnMap(headers) {
  const map = createEmptyStudentColumnMap();
  const normalizedHeaders = (Array.isArray(headers) ? headers : []).map((header) => ({
    raw: String(header ?? ''),
    normalized: String(header ?? '').toLowerCase().trim().replace(/\s+/g, ' '),
  }));
  const aliases = getStudentColumnAliases();
  for (const [field, fieldAliases] of Object.entries(aliases)) {
    const match = normalizedHeaders.find(({ normalized }) => fieldAliases.includes(normalized));
    if (match) map[field] = match.raw;
  }
  // Intentionally no generic "Consent" alias: legacy consent headings must map to attendance only.
  return map;
}

export function parseStudentConsent(value) {
  return String(value ?? '').trim().toLowerCase() === 'yes';
}

