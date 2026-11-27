import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceClassRollSequence,
  nextClassRollNumber,
} from '../server/academyManagementDomain.mjs';

test('class roll numbering starts at 1 when a class has no existing numeric roll numbers', () => {
  assert.equal(nextClassRollNumber([], 1), 1);
  assert.equal(nextClassRollNumber(['A-01', 'ADM-2'], 1), 1);
});

test('class roll numbering continues after the highest existing numeric roll number', () => {
  assert.equal(nextClassRollNumber(['1', '2', '4'], 1), 5);
  assert.equal(nextClassRollNumber(['001', '002', '003'], 1), 4);
});

test('class roll numbering never moves backward from an existing atomic sequence', () => {
  assert.equal(nextClassRollNumber(['1', '2'], 8), 8);
});

test('manual numeric teacher roll numbers advance the shared class sequence', () => {
  assert.equal(advanceClassRollSequence(1, '4'), 5);
  assert.equal(advanceClassRollSequence(5, '3'), 5);
  assert.equal(advanceClassRollSequence(5, 'A-06'), 5);
});
