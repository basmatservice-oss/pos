import test from 'node:test';
import assert from 'node:assert/strict';
import { getLineagePalette } from '../src/utils/themeManager';

test('LineageOS 24 theme exposes a complete light Material palette', () => {
  const palette = getLineagePalette('light');
  assert.equal(palette.primary, '#6750A4');
  assert.equal(palette.surface, '#F7F2FA');
  assert.equal(palette.onSurface, '#1D1B20');
  assert.ok(palette.outlineVariant);
});

test('LineageOS 24 theme exposes a readable dark Material palette', () => {
  const palette = getLineagePalette('dark');
  assert.equal(palette.primary, '#D0BCFF');
  assert.equal(palette.surface, '#141218');
  assert.equal(palette.onSurface, '#E6E0E9');
  assert.ok(palette.outlineVariant);
});
