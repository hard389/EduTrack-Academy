export type SubscriptionFeatureKey =
  | 'student_management'
  | 'class_management'
  | 'attendance_management'
  | 'attendance_alerts'
  | 'monthly_reports'
  | 'fortnightly_reports'
  | 'weekly_reports'
  | 'attendance_analytics'
  | 'advanced_analytics'
  | 'fee_tracking'
  | 'fee_alerts'
  | 'custom_alerts'
  | 'quiz_management'
  | 'quiz_result_notifications'
  | 'notes_library'
  | 'library_link_whatsapp'
  | 'announcements';

export type FeaturePermissionState = 'enabled' | 'disabled' | 'configurable';
export type SubscriptionFeaturePermissions = Record<SubscriptionFeatureKey, FeaturePermissionState>;
export type SubscriptionPlanTier = 'basic' | 'advance' | 'pro';

export declare const FEATURE_PERMISSION_CATALOG: readonly { readonly key: SubscriptionFeatureKey; readonly label: string; readonly description: string }[];
export declare const FEATURE_PERMISSION_KEYS: readonly SubscriptionFeatureKey[];
export declare const FEATURE_PERMISSION_STATES: readonly FeaturePermissionState[];
export declare const DEFAULT_PLAN_PERMISSION_MATRIX: Readonly<Record<SubscriptionPlanTier, Readonly<SubscriptionFeaturePermissions>>>;
export declare function normalizeFeaturePermissions(value: unknown, legacyDefault?: boolean): SubscriptionFeaturePermissions;
export declare function createDefaultFeaturePermissions(tier: SubscriptionPlanTier): SubscriptionFeaturePermissions;
export declare function inferPlanTierForMigration(planName: unknown): SubscriptionPlanTier | null;
export declare function migrateFeaturePermissionsForTier(existing: unknown, tier: SubscriptionPlanTier): SubscriptionFeaturePermissions;
export declare function isFeatureAvailable(permissions: unknown, featureKey: SubscriptionFeatureKey): boolean;
export declare function isFeatureEnabled(permissions: unknown, featureKey: SubscriptionFeatureKey, configurationEnabled?: boolean): boolean;
