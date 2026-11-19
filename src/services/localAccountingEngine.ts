import { db } from '../db/db';
import { generateUUID } from '../utils/uuid';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { nativePosRepository } from '../native/nativePosRepository';

const SYSTEM_ACCOUNTS = [
  { code: '1010', name: 'الصندوق', type: 'asset' },
  { code: '1020', name: 'البنك / الشبكة', type: 'asset' },
  { code: '1100', name: 'ذمم العملاء', type: 'asset' },
  { code: '1200', name: 'المخزون', type: 'asset' },
  { code: '2100', name: 'ذمم الموردين', type: 'liability' },
  { code: '2200', name: 'ضريبة القيمة المضافة المستحقة', type: 'liability' },
  { code: '3100', name: 'رأس المال والأرصدة الافتتاحية', type: 'equity' },
  { code: '3200', name: 'الأرباح المحتجزة', type: 'equity' },
  { code: '4100', name: 'المبيعات', type: 'revenue' },
  { code: '4200', name: 'مرتجعات المبيعات', type: 'revenue' },
  { code: '4300', name: 'خصومات مسموحة', type: 'revenue' },
  { code: '5100', name: 'تكلفة البضاعة المباعة', type: 'expense' },
  { code: '5200', name: 'المصروفات التشغيلية', type: 'expense' },
  { code: '5300', name: 'الرواتب والأجور', type: 'expense' },
  { code: '5400', name: 'تسويات الجرد', type: 'expense' },
] as const;

export interface LocalJournalLine {
  accountCode: string;
  debit: number;
  credit: number;
  description?: string;
  orderId?: string;
  purchaseId?: string;
  returnId?: string;
}

export interface LocalJournalInput {
  referenceId: string;
  referenceType: 'order' | 'purchase' | 'purchase_return' | 'expense' | 'payment' | 'return' | 'payroll' | 'stocktake' | 'shift_movement' | 'opening';
  entryKey: string;
  date: string;
  description: string;
  lines: LocalJournalLine[];
  createdBy?: string;
  branchId?: number;
}

function money(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

let standaloneAccountingMode = false;

export function setLocalAccountingStandaloneMode(enabled: boolean): void {
  standaloneAccountingMode = enabled;
}

export async function postLocalJournalEntry(input: LocalJournalInput): Promise<string | null> {
  if (isNativeAndroid()) {
    const journalSyncStatus = standaloneAccountingMode ? 'synced' : 'pending';
    const lines = input.lines
      .map((line) => ({ ...line, debit: money(line.debit), credit: money(line.credit) }))
      .filter((line) => line.debit > 0 || line.credit > 0);
    if (!lines.length) return null;
    let totalDebit = money(lines.reduce((sum, line) => sum + line.debit, 0));
    let totalCredit = money(lines.reduce((sum, line) => sum + line.credit, 0));
    const difference = money(totalDebit - totalCredit);
    if (Math.abs(difference) > 0.02) {
      throw new Error('قيد محاسبي غير متوازن: ' + input.description + ' (مدين ' + totalDebit + ' / دائن ' + totalCredit + ')');
    }
    if (difference !== 0) {
      const last = lines[lines.length - 1];
      if (last.credit > 0) last.credit = money(last.credit + difference);
      else last.debit = money(last.debit - difference);
      totalDebit = money(lines.reduce((sum, line) => sum + line.debit, 0));
      totalCredit = money(lines.reduce((sum, line) => sum + line.credit, 0));
    }
    const entryId = 'local-je:' + input.referenceType + ':' + input.referenceId + ':' + input.entryKey;
    if (await nativePosRepository.get<any>('journalEntries', entryId)) return entryId;
    const now = input.date || new Date().toISOString();
    const changes: any[] = [];
    const accounts = new Map<string, any>();
    const accountSyncStates = new Map<string, any>();
    const accountRows = await nativePosRepository.getAllWithSyncState('accounts');
    for (const row of accountRows) {
      accounts.set(String(row.record.code), row.record);
      accountSyncStates.set(String(row.record.code), row.syncState);
    }
    const accountChanges = new Map<string, any>();
    for (const definition of SYSTEM_ACCOUNTS) {
      const existing = accounts.get(definition.code);
      const account = existing || {
        ...definition, balance: 0, isSystem: 1, createdAt: now, updatedAt: now,
      };
      accounts.set(definition.code, account);
      if (!existing) {
        accountChanges.set(definition.code, account);
        accountSyncStates.set(definition.code, 'local');
      }
    }
    const journal = {
      id: entryId,
      entryNumber: 'LOCAL-' + input.entryKey + '-' + input.referenceId.slice(0, 8),
      date: now,
      referenceId: input.referenceId,
      referenceType: input.referenceType,
      description: input.description,
      totalDebit,
      totalCredit,
      status: 'posted',
      createdBy: input.createdBy || 'System',
      branchId: input.branchId,
      syncStatus: journalSyncStatus,
      createdAt: now,
    };
    changes.push({ action: 'put', entity: 'journalEntries', record: journal, syncState: journalSyncStatus });
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      let account = accounts.get(line.accountCode);
      if (!account) {
        account = await nativePosRepository.get<any>('accounts', line.accountCode);
        if (!account) throw new Error('الحساب غير موجود: ' + line.accountCode);
        accounts.set(line.accountCode, account);
      }
      const accountName = account?.name || line.accountCode;
      changes.push({
        action: 'put',
        entity: 'transactions',
        record: {
          id: entryId + ':' + index,
          journalEntryId: entryId,
          accountId: line.accountCode,
          accountName,
          type: line.debit > 0 ? 'debit' : 'credit',
          amount: line.debit > 0 ? line.debit : line.credit,
          debit: line.debit,
          credit: line.credit,
          description: line.description || input.description,
          orderId: line.orderId,
          purchaseId: line.purchaseId,
          returnId: line.returnId,
          syncStatus: journalSyncStatus,
          createdAt: now,
        },
        syncState: journalSyncStatus,
      });
      const normalDebit = account.type === 'asset' || account.type === 'expense';
      const delta = normalDebit ? line.debit - line.credit : line.credit - line.debit;
      const updated = { ...account, balance: money(Number(account.balance || 0) + delta), updatedAt: now };
      accounts.set(line.accountCode, updated);
      accountChanges.set(line.accountCode, updated);
    }
    for (const [accountCode, account] of accountChanges) {
      changes.push({
        action: 'put', entity: 'accounts', record: account,
        syncState: accountSyncStates.get(accountCode) || journalSyncStatus,
      });
    }
    const applied = await nativePosRepository.applyChanges(changes);
    if (applied !== changes.length) throw new Error('SQLite لم تؤكد حفظ جميع أجزاء القيد المحاسبي');
    await db.transaction('rw', db.accounts, db.journalEntries, db.transactions, async () => {
      for (const change of changes) {
        if (change.entity === 'accounts') await db.accounts.put(change.record);
        else if (change.entity === 'journalEntries') await db.journalEntries.put(change.record);
        else if (change.entity === 'transactions') await db.transactions.put(change.record);
      }
    });
    return entryId;
  }
  return db.transaction('rw', db.accounts, db.journalEntries, db.transactions, async () => {
  const journalSyncStatus = standaloneAccountingMode ? 'synced' : 'pending';
  const lines = input.lines
    .map((line) => ({ ...line, debit: money(line.debit), credit: money(line.credit) }))
    .filter((line) => line.debit > 0 || line.credit > 0);
  if (lines.length === 0) return null;

  let totalDebit = money(lines.reduce((sum, line) => sum + line.debit, 0));
  let totalCredit = money(lines.reduce((sum, line) => sum + line.credit, 0));
  const difference = money(totalDebit - totalCredit);
  if (Math.abs(difference) > 0.02) {
    throw new Error(`قيد محاسبي غير متوازن: ${input.description} (مدين ${totalDebit} / دائن ${totalCredit})`);
  }
  if (difference !== 0) {
    const last = lines[lines.length - 1];
    if (last.credit > 0) last.credit = money(last.credit + difference);
    else last.debit = money(last.debit - difference);
    totalDebit = money(lines.reduce((sum, line) => sum + line.debit, 0));
    totalCredit = money(lines.reduce((sum, line) => sum + line.credit, 0));
  }

  const entryId = `local-je:${input.referenceType}:${input.referenceId}:${input.entryKey}`;
  if (await db.journalEntries.get(entryId)) return entryId;

  const now = input.date || new Date().toISOString();
  for (const account of SYSTEM_ACCOUNTS) {
    if (!(await db.accounts.get(account.code))) {
      await db.accounts.put({
        ...account,
        balance: 0,
        isSystem: 1,
        createdAt: now,
        updatedAt: now,
      } as any);
    }
  }

  await db.journalEntries.put({
    id: entryId,
    entryNumber: `LOCAL-${input.entryKey}-${input.referenceId.slice(0, 8)}`,
    date: now,
    referenceId: input.referenceId,
    referenceType: input.referenceType,
    description: input.description,
    totalDebit,
    totalCredit,
    status: 'posted',
    createdBy: input.createdBy || 'System',
    branchId: input.branchId,
    syncStatus: journalSyncStatus,
    createdAt: now,
  });

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const account = await db.accounts.get(line.accountCode);
    const accountName = account?.name || SYSTEM_ACCOUNTS.find((item) => item.code === line.accountCode)?.name || line.accountCode;
    await db.transactions.put({
      id: `${entryId}:${index}`,
      journalEntryId: entryId,
      accountId: line.accountCode,
      accountName,
      type: line.debit > 0 ? 'debit' : 'credit',
      amount: line.debit > 0 ? line.debit : line.credit,
      debit: line.debit,
      credit: line.credit,
      description: line.description || input.description,
      orderId: line.orderId,
      purchaseId: line.purchaseId,
      returnId: line.returnId,
      syncStatus: journalSyncStatus,
      createdAt: now,
    });

    if (account) {
      const normalDebit = account.type === 'asset' || account.type === 'expense';
      const delta = normalDebit ? line.debit - line.credit : line.credit - line.debit;
      await db.accounts.update(account.code, {
        balance: money(Number(account.balance || 0) + delta),
        updatedAt: now,
      });
    }
  }
  return entryId;
  });
}

export async function removeLocalJournalEntriesForReference(referenceId: string): Promise<void> {
  if (isNativeAndroid()) {
    const entries = (await nativePosRepository.whereEquals<any>('journalEntries', 'referenceId', referenceId))
      .filter((entry: any) => String(entry.id).startsWith('local-je:'));
    const accountRows = await nativePosRepository.getAllWithSyncState('accounts');
    const accountMap = new Map(accountRows.map((row) => [String(row.record.code), row]));
    const accountChanges = new Map<string, any>();
    const changes: any[] = [];
    for (const entry of entries) {
      const lines = await nativePosRepository.whereEquals<any>('transactions', 'journalEntryId', String(entry.id));
      for (const line of lines) {
        const accountCode = String(line.accountId);
        const accountRow = accountMap.get(accountCode);
        const account = accountChanges.get(accountCode) || accountRow?.record;
        if (!account) continue;
        const debit = Number(line.debit || 0);
        const credit = Number(line.credit || 0);
        const normalDebit = account.type === 'asset' || account.type === 'expense';
        const delta = normalDebit ? debit - credit : credit - debit;
        accountChanges.set(accountCode, {
          ...account, balance: money(Number(account.balance || 0) - delta), updatedAt: new Date().toISOString(),
        });
        changes.push({ action: 'delete', entity: 'transactions', key: line.id });
      }
      changes.push({ action: 'delete', entity: 'journalEntries', key: entry.id });
    }
    for (const [accountCode, account] of accountChanges) changes.push({ action: 'put', entity: 'accounts', record: account, syncState: accountMap.get(accountCode)?.syncState || 'local' });
    if (changes.length) await nativePosRepository.applyChanges(changes);
    return;
  }
  return db.transaction('rw', db.accounts, db.journalEntries, db.transactions, async () => {
  const entries = await db.journalEntries.where('referenceId').equals(referenceId).toArray();
  const localEntries = entries.filter((entry: any) => String(entry.id).startsWith('local-je:'));
  for (const entry of localEntries) {
    const lines = await db.transactions.where('journalEntryId').equals(String(entry.id)).toArray();
    for (const line of lines) {
      const account = await db.accounts.get(String(line.accountId));
      if (account) {
        const debit = Number(line.debit || 0);
        const credit = Number(line.credit || 0);
        const normalDebit = account.type === 'asset' || account.type === 'expense';
        const delta = normalDebit ? debit - credit : credit - debit;
        await db.accounts.update(account.code, {
          balance: money(Number(account.balance || 0) - delta),
          updatedAt: new Date().toISOString(),
        });
      }
    }
    await db.transactions.where('journalEntryId').equals(String(entry.id)).delete();
    await db.journalEntries.delete(entry.id as any);
  }
  });
}

export async function reverseLocalJournalEntriesByReference(referenceId: string, reason: string, createdBy?: string): Promise<void> {
  return db.transaction('rw', db.accounts, db.journalEntries, db.transactions, async () => {
  const entries = await db.journalEntries.where('referenceId').equals(referenceId).toArray();
  const reversalEntryIds = new Set(entries.map((entry: any) => entry.reversedEntryId).filter(Boolean).map(String));
  for (const entry of entries) {
    if (entry.status !== 'posted' || reversalEntryIds.has(String(entry.id))) continue;
    const lines = await db.transactions.where('journalEntryId').equals(String(entry.id)).toArray();
    if (!lines.length) continue;
    const reversalLines = lines.map((line: any) => ({
      accountCode: String(line.accountId),
      debit: Number(line.credit || 0),
      credit: Number(line.debit || 0),
      description: 'عكس: ' + String(line.description || entry.description) + ' (' + reason + ')',
      orderId: line.orderId, purchaseId: line.purchaseId, returnId: line.returnId,
    }));
    const reversalId = await postLocalJournalEntry({
      referenceId,
      referenceType: (entry.referenceType || 'order') as LocalJournalInput['referenceType'],
      entryKey: 'reversal-' + String(entry.id),
      date: new Date().toISOString(),
      description: 'قيد عكسي - ' + String(entry.description) + ' (' + reason + ')',
      lines: reversalLines,
      createdBy: createdBy || 'System',
      branchId: entry.branchId,
    });
    await db.journalEntries.update(entry.id as any, { status: 'reversed', reversedEntryId: reversalId || undefined });
  }
  });
}
