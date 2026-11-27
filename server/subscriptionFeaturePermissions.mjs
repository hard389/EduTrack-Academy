// Canonical subscription feature catalog shared by all server-side entitlement decisions.
// `configurable` means the plan exposes the feature controls; existing tenant settings,
// consent, and administrator/global switches must still be enabled before dispatch.
export const FEATURE_PERMISSION_CATALOG = Object.freeze([
  { key: 'student_management', label: 'Student Management', description: 'Student profiles, records and enrolment.' },
  { key: 'class_management', label: 'Class Management', description: 'Classes, sections and class rosters.' },
  { key: 'attendance_management', label: 'Attendance Management', description: 'Daily attendance marking and attendance records.' },
  { key: 'attendance_alerts', label: 'Attendance Alerts', description: 'Attendance notification workflows; consent and admin authorization still apply.' },
  { key: 'monthly_reports', label: 'Monthly Reports', description: 'Monthly student and report workflows.' },
  { key: 'fortnightly_reports', label: '15-Day Reports', description: '15-day report access when its module is available.' },
  { key: 'weekly_reports', label: 'Weekly Reports', description: 'Weekly report access when its module is available.' },
  { key: 'attendance_analytics', label: 'Attendance Analytics', description: 'Attendance trends and analytics.' },
  { key: 'advanced_analytics', label: 'Advanced Analytics', description: 'Advanced analytics views when implemented.' },
  { key: 'fee_tracking', label: 'Fee Tracking', description: 'Fee records, dues, payments and student fee management.' },
  { key: 'fee_alerts', label: 'Fee Alerts', description: 'Fee-alert cards, reminder configuration and fee notification workflows.' },
  { key: 'custom_alerts', label: 'Custom Alerts', description: 'Custom alert workflows, separate from attendance and fee notifications.' },
  { key: 'quiz_management', label: 'Quiz Management', description: 'Create, edit and review class quizzes and marks.' },
  { key: 'quiz_result_notifications', label: 'Quiz Result Notifications', description: 'Send individual quiz marks through WhatsApp, subject to consent and admin controls.' },
  { key: 'notes_library', label: 'Notes & Library', description: 'Teacher notes and learning-resource library.' },
  { key: 'library_link_whatsapp', label: 'Library Link WhatsApp', description: 'Automatically share newly uploaded class-library resources with guardians who explicitly opted in; provider acceptance is not delivery confirmation.' },
  { key: 'announcements', label: 'Announcements', description: 'School announcement broadcasts.' },
]);

export const FEATURE_PERMISSION_KEYS = Object.freeze(
  FEATURE_PERMISSION_CATALOG.map(({ key }) => key),
);

export const FEATURE_PERMISSION_STATES = Object.freeze([
  'enabled',
  'disabled',
  'configurable',
]);

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isState = (value) => FEATURE_PERMISSION_STATES.includes(value);

const sharedEnabled = {
  student_management: 'enabled',
  class_management: 'enabled',
  attendance_management: 'enabled',
  attendance_alerts: 'configurable',
  monthly_reports: 'enabled',
  quiz_management: 'enabled',
  notes_library: 'enabled',
  library_link_whatsapp: 'configurable',
  announcements: 'enabled',
};

export const DEFAULT_PLAN_PERMISSION_MATRIX = Object.freeze({
  basic: Object.freeze({
    ...sharedEnabled,
    announcements: 'disabled',
    library_link_whatsapp: 'disabled',
    fee_alerts: 'disabled',
    fortnightly_reports: 'disabled',
    weekly_reports: 'disabled',
    attendance_analytics: 'disabled',
    advanced_analytics: 'disabled',
    fee_tracking: 'configurable',
    custom_alerts: 'disabled',
    quiz_result_notifications: 'disabled',
  }),
  advance: Object.freeze({
    ...sharedEnabled,
    fee_alerts: 'configurable',
    library_link_whatsapp: 'configurable',
    fortnightly_reports: 'enabled',
    weekly_reports: 'disabled',
    attendance_analytics: 'enabled',
    advanced_analytics: 'disabled',
    fee_tracking: 'enabled',
    custom_alerts: 'enabled',
    quiz_result_notifications: 'configurable',
  }),
  pro: Object.freeze({
    ...sharedEnabled,
    fee_alerts: 'enabled',
    library_link_whatsapp: 'enabled',
    fortnightly_reports: 'enabled',
    weekly_reports: 'enabled',
    attendance_analytics: 'enabled',
    advanced_analytics: 'enabled',
    fee_tracking: 'enabled',
    custom_alerts: 'enabled',
    quiz_result_notifications: 'disabled',
  }),
});

function normalizeState(value, fallback) {
  if (isState(value)) return value;
  if (value === true) return 'enabled';
  if (value === false) return 'disabled';
  return fallback;
}

// Boolean maps from existing plans and invoice snapshots remain readable. Missing keys
// now fail closed by default; callers must opt into a safe migration fallback explicitly.
export function normalizeFeaturePermissions(value, legacyDefault = false) {
  const source = isRecord(value) ? value : {};
  const fallback = legacyDefault ? 'enabled' : 'disabled';
  return Object.fromEntries(FEATURE_PERMISSION_KEYS.map((key) => [
    key,
    normalizeState(source[key], fallback),
  ]));
}

export function createDefaultFeaturePermissions(tier) {
  const normalizedTier = typeof tier === 'string' ? tier.trim().toLowerCase() : '';
  const defaults = DEFAULT_PLAN_PERMISSION_MATRIX[normalizedTier];
  if (!defaults) throw new TypeError('A Basic, Advance, or Pro plan tier is required.');
  return { ...defaults };
}

// This name lookup is used only by the explicit one-time Admin migration action. Runtime
// authorization never infers entitlements from a plan name.
export function inferPlanTierForMigration(planName) {
  const normalized = typeof planName === 'string'
    ? planName.trim().toLowerCase().replace(/\s+/g, ' ')
    : '';
  if (normalized === 'basic' || normalized === 'basic plan') return 'basic';
  if (normalized === 'advance' || normalized === 'advance plan') return 'advance';
  if (normalized === 'pro' || normalized === 'pro plan') return 'pro';
  return null;
}

export function migrateFeaturePermissionsForTier(existing, tier) {
  const defaults = createDefaultFeaturePermissions(tier);
  const source = isRecord(existing) ? existing : {};
  return Object.fromEntries(FEATURE_PERMISSION_KEYS.map((key) => [
    key,
    Object.prototype.hasOwnProperty.call(source, key)
      ? normalizeState(source[key], defaults[key])
      : defaults[key],
  ]));
}

export function isFeatureAvailable(permissions, featureKey) {
  if (!FEATURE_PERMISSION_KEYS.includes(featureKey)) return false;
  const normalized = normalizeFeaturePermissions(permissions, false);
  return normalized[featureKey] !== 'disabled';
}

export function isFeatureEnabled(permissions, featureKey, configurationEnabled = false) {
  if (!FEATURE_PERMISSION_KEYS.includes(featureKey)) return false;
  const normalized = normalizeFeaturePermissions(permissions, false);
  return normalized[featureKey] === 'enabled' ||
    (normalized[featureKey] === 'configurable' && configurationEnabled === true);
}
