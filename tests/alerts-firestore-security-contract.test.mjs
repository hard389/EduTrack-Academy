import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const alerts = readFileSync(new URL('../src/pages/alerts.tsx', import.meta.url), 'utf8');
const context = readFileSync(new URL('../src/contexts/AppContext.tsx', import.meta.url), 'utf8');
const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');

test('teacher alert list queries are constrained by the category rules', () => {
  assert.match(alerts, /where\('category',\s*'==',\s*category\)/);
  assert.match(alerts, /permittedCategories/);
  assert.match(alerts, /hasAnnouncements/);
  assert.match(alerts, /hasCustomAlerts/);
  assert.match(alerts, /\}, \[hasAnnouncements, hasCustomAlerts, tenant\]\)/);
  assert.doesNotMatch(alerts, /const alertsQuery = hasCustomAlerts\s*\?\s*collection\(db, path\)/);
});

test('new teacher alerts are created without a pre-read of a category-protected notification document', () => {
  assert.match(alerts, /await setDoc\(alertRef,/);
  assert.doesNotMatch(alerts, /runTransaction\(db, async \(transaction\) => \{[\s\S]{0,250}transaction\.get\(alertRef\)/);
});

test('AppContext no longer reads legacy global departments or timeConfig collections', () => {
  assert.doesNotMatch(context, /departmentService\.getAll\(\)/);
  assert.doesNotMatch(context, /timeConfigService\.getByInstitutionType/);
  assert.doesNotMatch(context, /Error fetching (data|departments|timeConfig)/);
  assert.match(context, /const refreshData = useCallback\(async \(\) => \{\}, \[\]\)/);
});

test('repository Firestore rules use safe defaults for optional disabled/deleted profile flags', () => {
  assert.match(rules, /profile\.get\('disabled', false\) != true/);
  assert.match(rules, /profile\.get\('deleted', false\) != true/);
});
