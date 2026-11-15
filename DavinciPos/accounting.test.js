import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJournalLines,getTrialBalance } from './accounting.js';

test('accepts balanced journal lines in minor currency units',()=>{
  assert.deepEqual(validateJournalLines([{accountId:'cash',debitMinor:1250},{accountId:'sales',creditMinor:1250}]),{debitMinor:1250,creditMinor:1250});
});
test('rejects unbalanced journal entries',()=>{
  assert.throws(()=>validateJournalLines([{accountId:'cash',debitMinor:100},{accountId:'sales',creditMinor:99}]),/not balanced/);
});
test('rejects a line with debit and credit at the same time',()=>{
  assert.throws(()=>validateJournalLines([{accountId:'cash',debitMinor:10,creditMinor:10},{accountId:'sales',creditMinor:10}]),/either a positive debit or a positive credit/);
});
test('rejects floating point monetary values',()=>{
  assert.throws(()=>validateJournalLines([{accountId:'cash',debitMinor:1.5},{accountId:'sales',creditMinor:1.5}]),/positive debit or a positive credit/);
});

test('rejects impossible calendar dates in trial balance filters',()=>{
  assert.throws(()=>getTrialBalance({from:'2026-02-31'}),/Invalid trial balance date/);
});
