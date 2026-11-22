import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/pages/Inventory.tsx', import.meta.url), 'utf8');

test('new products default to fixed SDG cost and selling prices', () => {
  assert.match(source, /const \[costFxLinked, setCostFxLinked\] = useState\(false\)/);
  assert.match(source, /const \[sellingFxLinked, setSellingFxLinked\] = useState\(false\)/);
  assert.match(source, /setCostFxLinked\(false\);\s*setSellingFxLinked\(false\);/);
});
