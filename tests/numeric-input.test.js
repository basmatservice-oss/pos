import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNumericInput } from '../src/utils/normalizeNumericInput.ts';

test('normalizes Arabic-Indic and Persian digits to Western digits', () => {
  assert.equal(normalizeNumericInput('١٢٣٤٥٦٧٨٩٠'), '1234567890');
  assert.equal(normalizeNumericInput('۱۲۳۴۵۶۷۸۹۰'), '1234567890');
});

test('normalizes localized decimal and grouping separators', () => {
  assert.equal(normalizeNumericInput('١٢٣٬٤٥٦٫٧٥'), '123,456.75');
});

test('leaves already-Western numeric input unchanged', () => {
  assert.equal(normalizeNumericInput('-12,345.67'), '-12,345.67');
});
