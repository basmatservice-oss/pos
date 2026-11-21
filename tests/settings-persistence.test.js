import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8');

test('new settings receive the SQLite primary key before entity_upsert', () => {
  assert.match(source, /const settingId = existing\?\.id \?\? \(Date\.now\(\) \* 1000 \+ Object\.keys\(settings\)\.indexOf\(key\) \+ 1\)/);
  assert.match(source, /id: settingId,[\s\S]*?key,[\s\S]*?value: stringVal/);
});

test('current USD exchange rate is persisted instead of only changing React state', () => {
  assert.match(source, /await putPosSetting\('exchangeRate', rateNum, 'synced'\)/);
  assert.match(source, /setSettings\(\(prev: any\) => \(\{ \.\.\.prev, exchangeRate: rateNum \}\)\)/);
});

test('standalone Android can save exchange-rate history locally', () => {
  assert.match(source, /const standalone = await isStandaloneAndroid\(\)/);
  assert.match(source, /id: `local-fx-\$\{Date\.now\(\)\}`/);
  assert.doesNotMatch(source, /if \(await isStandaloneAndroid\(\)\) \{ toast\.error\('تسجيل سعر الصرف عبر الخادم غير متاح/);
});

test('exchange rate is edited in one place, not duplicated in general settings', () => {
  assert.doesNotMatch(source, /سعر الصرف \(للدولار\)/);
  assert.match(source, /سجل وتحديث أسعار الصرف/);
});
