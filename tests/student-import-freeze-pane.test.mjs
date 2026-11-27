import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeWorksheetHeaderXml } from '../src/lib/xlsxWorksheetXml.mjs';

test('frozen-header XML is inserted after worksheet dimension in the schema position', () => {
  const xml = '<worksheet xmlns="urn:test"><dimension ref="A1:B3"/><sheetFormatPr defaultRowHeight="15"/><sheetData/></worksheet>';
  const frozen = freezeWorksheetHeaderXml(xml);
  assert.ok(frozen.indexOf('<dimension') < frozen.indexOf('<sheetViews>'));
  assert.ok(frozen.includes('state="frozen"'));
});
