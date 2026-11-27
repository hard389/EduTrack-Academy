import * as XLSX from 'xlsx';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  STUDENT_CONSENT_COLUMNS,
  STUDENT_IMPORT_CORE_COLUMNS,
  STUDENT_IMPORT_PHOTO_COLUMN,
  getStudentTemplateColumns,
} from './studentImportSchema.mjs';
import { freezeWorksheetHeaderXml } from './xlsxWorksheetXml.mjs';

export { freezeWorksheetHeaderXml } from './xlsxWorksheetXml.mjs';
export { STUDENT_CONSENT_COLUMNS, getStudentTemplateColumns } from './studentImportSchema.mjs';

export function buildStudentImportWorkbook(canAccessFeature) {
  const columns = getStudentTemplateColumns(canAccessFeature);
  const headers = columns.map((column) => column.label);
  // Keep student rows blank: sample Yes values in data rows could be mistaken for
  // genuine guardian consent when a teacher uploads the untouched template. The
  // Instructions sheet provides explicit Yes/No examples without pre-granting consent.
  const rows = [0, 1].map(() => Object.fromEntries(columns.map((column) => [
    column.label,
    column.key === 'rollNo' ? ' ' : '',
  ])));

  const studentsSheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  studentsSheet['!cols'] = columns.map((column) => ({ wch: column.width ?? 20 }));
  studentsSheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(headers.length - 1)}${rows.length + 1}` };

  const rollIndex = headers.indexOf('Roll Number');
  if (rollIndex >= 0) {
    const rollColumn = XLSX.utils.encode_col(rollIndex);
    for (let row = 2; row <= rows.length + 1; row += 1) {
      const cell = studentsSheet[`${rollColumn}${row}`];
      if (cell) {
        cell.t = 's';
        cell.v = String(cell.v ?? '');
        cell.z = '@';
      }
    }
  }

  const instructions = [
    { Field: 'Student Name', Requirement: 'Required', Notes: 'Full student name. Leading and trailing spaces are trimmed.' },
    { Field: "Father's Name", Requirement: 'Required', Notes: 'Enter the father or guardian name.' },
    { Field: 'Parent/Guardian WhatsApp', Requirement: 'Required', Notes: 'Pakistani mobile number: 03XXXXXXXXX or +923XXXXXXXXX. The number is normalized before saving.' },
    { Field: 'Roll Number', Requirement: 'Required', Notes: 'Stored as text. Format this column as Text before entering values such as 001 to preserve leading zeros.' },
    { Field: 'Gender', Requirement: 'Required', Notes: 'Accepted values: Male, Female, M, or F (case-insensitive). Other values are rejected.' },
    { Field: 'Monthly Fee (PKR)', Requirement: 'Required', Notes: 'Enter a non-negative number, such as 5000. Blank, text, or negative values are rejected.' },
    ...STUDENT_CONSENT_COLUMNS
      .filter((column) => headers.includes(column.label))
      .map((column) => ({
        Field: column.label,
        Requirement: 'Optional',
        Notes: `Accepted values: Yes or No (examples: Yes / No). Blank, No, or invalid values default to No. Enter Yes only after explicit guardian permission. This applies only to ${column.label.replace(' WhatsApp Consent', '')}.`,
      })),
    { Field: 'Photo URL', Requirement: 'Optional', Notes: 'Provide a direct HTTP(S) image URL. Leave blank to use the default avatar for the selected gender.' },
    { Field: 'Import validation', Requirement: '', Notes: 'Rows with missing required fields, invalid WhatsApp numbers, invalid fees, or duplicate roll numbers are skipped and reported. Valid rows continue independently.' },
    { Field: 'Academy permissions', Requirement: '', Notes: 'This template reflects the WhatsApp permissions currently granted by your Academy Admin. Available options are checked again when importing.' },
  ];
  const instructionsSheet = XLSX.utils.json_to_sheet(instructions);
  instructionsSheet['!cols'] = [{ wch: 36 }, { wch: 14 }, { wch: 96 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, studentsSheet, 'Students Template');
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, 'Instructions');
  return workbook;
}


/**
 * SheetJS Community Edition does not reliably serialize frozen panes from worksheet
 * metadata. Patch the generated OOXML so both sheets really freeze their first row in Excel.
 */
export function serializeStudentImportWorkbook(workbook) {
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true, cellStyles: true });
  const archive = unzipSync(new Uint8Array(bytes));
  const worksheetPaths = Object.keys(archive).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path));
  if (worksheetPaths.length < 2) throw new Error('The Excel template must contain both required worksheets.');
  worksheetPaths.forEach((path) => {
    archive[path] = strToU8(freezeWorksheetHeaderXml(strFromU8(archive[path])));
  });
  return zipSync(archive, { level: 6 });
}

export function downloadStudentImportWorkbook(canAccessFeature, fileName = 'EduTrack_Students_Import_Template.xlsx') {
  const workbook = buildStudentImportWorkbook(canAccessFeature);
  const bytes = serializeStudentImportWorkbook(workbook);
  const blob = new Blob([bytes.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
