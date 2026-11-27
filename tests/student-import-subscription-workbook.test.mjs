import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { strFromU8, unzipSync } from 'fflate';
import { buildStudentImportWorkbook, serializeStudentImportWorkbook } from '../src/lib/studentImportWorkbook.mjs';
import { createDefaultFeaturePermissions } from '../server/subscriptionFeaturePermissions.mjs';

const readable = (permissions) => (key) => permissions[key] === 'enabled' || permissions[key] === 'configurable';
const readBack = (permissions) => {
  const workbook = buildStudentImportWorkbook(readable(permissions));
  const bytes = serializeStudentImportWorkbook(workbook);
  const reopened = XLSX.read(bytes, { type: 'array', cellText: false, cellNF: true });
  const sheet = reopened.Sheets['Students Template'];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  const instructions = XLSX.utils.sheet_to_json(reopened.Sheets.Instructions, { header: 1, raw: true });
  const archive = unzipSync(new Uint8Array(bytes));
  const frozenSheets = ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].every((path) =>
    strFromU8(archive[path]).includes('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>')
  );
  return { reopened, sheet, rows, instructions, frozenSheets };
};

test('actual XLSX has two dynamic sheets, Yes/No instructions, text roll numbers and frozen headers', () => {
  const { reopened, sheet, rows, instructions, frozenSheets } = readBack(createDefaultFeaturePermissions('basic'));
  assert.deepEqual(reopened.SheetNames, ['Students Template', 'Instructions']);
  assert.deepEqual(rows[0], [
    'Student Name', "Father's Name", 'Parent/Guardian WhatsApp', 'Roll Number', 'Gender', 'Monthly Fee (PKR)',
    'Attendance Alert WhatsApp Consent', 'Monthly Report WhatsApp Consent', 'Photo URL',
  ]);
  assert.equal(rows[1][0] ?? '', '');
  assert.equal(rows[2][0] ?? '', '');
  assert.equal(rows[1][3], ' ');
  assert.equal(rows[2][3], ' ');
  assert.equal(sheet.D2.t, 's');
  assert.equal(sheet.D2.z, '@');
  assert.equal(rows[1][6] ?? '', '');
  assert.equal(rows[2][6] ?? '', '');
  assert.equal(rows[1][7] ?? '', '');
  assert.equal(rows[2][7] ?? '', '');
  const instructionLabels = instructions.map((row) => row[0]);
  assert.ok(instructionLabels.includes('Attendance Alert WhatsApp Consent'));
  assert.ok(instructionLabels.includes('Monthly Report WhatsApp Consent'));
  assert.ok(!instructionLabels.includes('Quiz Results WhatsApp Consent'));
  assert.ok(instructions.some((row) => String(row[2] ?? '').includes('Permissions are checked again when importing.')));
  assert.ok(instructions.some((row) => String(row[2] ?? '').includes('examples: Yes / No')));
  assert.ok(instructions.some((row) => String(row[2] ?? '').includes('Enter Yes only after explicit guardian permission.')));
  assert.equal(frozenSheets, true);
});

test('Pro XLSX serialization omits disabled Quiz Results and keeps enabled Fee and Library columns', () => {
  const { rows } = readBack(createDefaultFeaturePermissions('pro'));
  assert.ok(!rows[0].includes('Quiz Results WhatsApp Consent'));
  assert.ok(rows[0].includes('Fee Alerts WhatsApp Consent'));
  assert.ok(rows[0].includes('Library Links WhatsApp Consent'));
});
