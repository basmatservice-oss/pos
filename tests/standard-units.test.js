import test from 'node:test';
import assert from 'node:assert/strict';
import { getBaseUnitDimension, getStandardBaseUnits } from '../src/utils/standardUnits.js';

test('classifies standard base units into stable dimensions', () => {
  assert.equal(getBaseUnitDimension('piece'), 'count');
  assert.equal(getBaseUnitDimension('كجم'), 'weight');
  assert.equal(getBaseUnitDimension('لتر'), 'volume');
  assert.equal(getBaseUnitDimension('متر مربع'), 'area');
  assert.equal(getBaseUnitDimension('ساعة'), 'time');
  assert.equal(getBaseUnitDimension('وحدة مخصصة'), 'legacy');
});

test('standard unit catalog has no duplicate names', () => {
  const units = getStandardBaseUnits();
  assert.ok(units.length >= 20);
  assert.equal(new Set(units.map((unit) => unit.name)).size, units.length);
});
