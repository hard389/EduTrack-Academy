export type StudentConsentColumnKey =
  | 'attendanceConsent'
  | 'monthlyReportConsent'
  | 'quizResultsConsent'
  | 'feeAlertsConsent'
  | 'announcementConsent'
  | 'libraryLinkConsent';

export type StudentColumnMapKey =
  | 'name' | 'fatherName' | 'phone' | 'rollNo' | 'gender' | 'fee' | 'photo'
  | StudentConsentColumnKey;

export type StudentColumnMap = Record<StudentColumnMapKey, string>;

export interface StudentImportColumn {
  key: StudentColumnMapKey;
  label: string;
  width?: number;
  required?: boolean;
  example?: string[];
  permissionKey?: string;
  inputProperty?: string;
  studentProperty?: string;
  persistenceProperty?: string;
  timestampProperty?: string;
  phoneProperty?: string;
  aliases?: string[];
}

export const STUDENT_IMPORT_CORE_COLUMNS: ReadonlyArray<StudentImportColumn>;
export const STUDENT_CONSENT_COLUMNS: ReadonlyArray<StudentImportColumn & {
  key: StudentConsentColumnKey;
  permissionKey: string;
  inputProperty: string;
  studentProperty: string;
  timestampProperty: string;
  phoneProperty: string;
}>;
export const STUDENT_IMPORT_PHOTO_COLUMN: StudentImportColumn;
export const STUDENT_IMPORT_REQUIRED_KEYS: ReadonlyArray<string>;
export const STUDENT_IMPORT_FIELD_LABELS: Readonly<Record<string, string>>;
export function createEmptyStudentColumnMap(): StudentColumnMap;
export function isFeatureAccessible(canAccessFeature: (permissionKey: string) => boolean, permissionKey: string): boolean;
export function getStudentTemplateColumns(canAccessFeature: (permissionKey: string) => boolean): StudentImportColumn[];
export function isPermissionStateAccessible(state: unknown): boolean;
export function getIgnoredStudentConsentColumnLabels(columnMap: Partial<StudentColumnMap>, featurePermissions: object): string[];
export interface StudentConsentFormValues {
  attendanceWhatsAppOptIn: boolean;
  monthlyReportWhatsAppOptIn: boolean;
  quizResultsWhatsAppOptIn: boolean;
  feeAlertsWhatsAppOptIn: boolean;
  announcementWhatsAppOptIn: boolean;
  libraryLinkWhatsAppOptIn: boolean;
}
export function getStudentConsentFormValues(consents: Partial<Record<StudentConsentColumnKey, boolean>>, featurePermissions: object): StudentConsentFormValues;
export function getStudentColumnAliases(): Record<string, string[]>;
export function autoDetectStudentColumnMap(headers: string[]): StudentColumnMap;
export function parseStudentConsent(value: unknown): boolean;
