import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexes = JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8'));

test('canonical teacher customer registry UID lookup has a collection-group index', () => {
  const override = indexes.fieldOverrides.find((entry) =>
    entry.collectionGroup === 'customers' && entry.fieldPath === 'uid'
  );

  assert.ok(override, 'missing customers.uid field override');
  assert.ok(
    override.indexes.some((index) =>
      index.queryScope === 'COLLECTION_GROUP' && index.order === 'ASCENDING'
    ),
    'customers.uid must support ascending collection-group queries'
  );
});

test('customers.uid collection-scope indexes are retained', () => {
  const override = indexes.fieldOverrides.find((entry) =>
    entry.collectionGroup === 'customers' && entry.fieldPath === 'uid'
  );
  assert.ok(override);
  for (const order of ['ASCENDING', 'DESCENDING']) {
    assert.ok(override.indexes.some((index) =>
      index.queryScope === 'COLLECTION' && index.order === order
    ), `missing ${order} collection-scope index`);
  }
});
