export type { StudentConsentColumnKey, StudentColumnMapKey, StudentColumnMap, StudentImportColumn, StudentConsentFormValues } from './studentImportSchema.mjs';
export { STUDENT_CONSENT_COLUMNS, getStudentTemplateColumns } from './studentImportSchema.mjs';
export function buildStudentImportWorkbook(canAccessFeature: (permissionKey: string) => boolean): import('xlsx').WorkBook;
export function serializeStudentImportWorkbook(workbook: import('xlsx').WorkBook): Uint8Array;
export function downloadStudentImportWorkbook(canAccessFeature: (permissionKey: string) => boolean, fileName?: string): void;
export function freezeWorksheetHeaderXml(xml: string): string;
