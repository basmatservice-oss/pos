import { generateUUID } from '../utils/uuid';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { nativePosRepository } from '../native/nativePosRepository';
// Dexie is loaded on demand for desktop accounting; Android accounting commits to SQLite only.
let db = {} as typeof import('../db/db').db;
let desktopDatabaseLoaded = false;

async function ensureDesktopDatabase(): Promise<void> {
  if (isNativeAndroid() || desktopDatabaseLoaded) return;
  db = (await import('../db/db')).db;
  desktopDatabaseLoaded = true;
}


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
    if (!input.referenceId.trim() || !input.entryKey.trim() || !input.lines.length ||
        input.lines.some((line) => {
          const debit = Number(line.debit), credit = Number(line.credit);
          return !String(line.accountCode || '').trim() || !Number.isFinite(debit) || !Number.isFinite(credit) ||
            debit < 0 || credit < 0 || (debit > 0 && credit > 0);
        })) {
      throw new Error('بيانات القيد المحاسبي تحتوي حسابًا أو مبلغًا غير صالح');
    }
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
        if (account) accounts.set(line.accountCode, account);
      }
      if (!account) {
        throw new Error('الحساب المحاسبي ' + line.accountCode + ' غير موجود؛ أُوقف ترحيل القيد لمنع إنشاء حركة بلا حساب أستاذ');
      }
      const accountName = account.name || line.accountCode;
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
      if (account) {
        const normalDebit = account.type === 'asset' || account.type === 'expense';
        const delta = normalDebit ? line.debit - line.credit : line.credit - line.debit;
        const updated = { ...account, balance: money(Number(account.balance || 0) + delta), updatedAt: now };
        accounts.set(line.accountCode, updated);
        accountChanges.set(line.accountCode, updated);
      }
    }
    for (const [accountCode, account] of accountChanges) {
      changes.push({
        action: 'put', entity: 'accounts', record: account,
        syncState: accountSyncStates.get(accountCode) || journalSyncStatus,
      });
    }
    const applied = await nativePosRepository.applyChanges(changes);
    if (applied !== changes.length) throw new Error('SQLite لم تؤكد حفظ جميع أجزاء القيد المحاسبي');
    return entryId;
  }
  await ensureDesktopDatabase();
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
    if (!account) {
      throw new Error('الحساب المحاسبي ' + line.accountCode + ' غير موجود؛ أُوقف ترحيل القيد لمنع إنشاء حركة بلا حساب أستاذ');
    }
    const accountName = account.name || line.accountCode;
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
    if (changes.length) {
      const applied = await nativePosRepository.applyChanges(changes);
      if (applied !== changes.length) throw new Error('SQLite لم تؤكد حذف جميع القيود المحلية وتحديث الأرصدة');
    }
    return;
  }
  await ensureDesktopDatabase();
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
  if (isNativeAndroid()) {
    const [entries, transactions, accountRows] = await Promise.all([
      nativePosRepository.whereEquals<any>('journalEntries', 'referenceId', referenceId),
      nativePosRepository.getAll<any>('transactions'),
      nativePosRepository.getAllWithSyncState('accounts'),
    ]);
    const reversalEntryIds = new Set(entries.map((entry: any) => entry.reversedEntryId).filter(Boolean).map(String));
    const accountRowsByCode = new Map(accountRows.map((row) => [String(row.record.code), row]));
    const accountChanges = new Map<string, any>();
    const changes: any[] = [];
    const now = new Date().toISOString();
    const journalSyncStatus = standaloneAccountingMode ? 'synced' : 'pending';
    for (const entry of entries) {
      if (entry.status !== 'posted' || reversalEntryIds.has(String(entry.id))) continue;
      const lines = transactions.filter((line: any) => String(line.journalEntryId) === String(entry.id));
      if (!lines.length) continue;
      const reversalId = 'local-je:' + String(entry.referenceType || 'order') + ':' + referenceId + ':reversal-' + String(entry.id);
      if (await nativePosRepository.get<any>('journalEntries', reversalId)) continue;
      const reversalLines = lines.map((line: any) => ({
        accountCode: String(line.accountId),
        debit: money(Number(line.credit || 0)),
        credit: money(Number(line.debit || 0)),
        description: 'عكس: ' + String(line.description || entry.description) + ' (' + reason + ')',
        orderId: line.orderId, purchaseId: line.purchaseId, returnId: line.returnId,
      })).filter((line: any) => line.debit > 0 || line.credit > 0);
      const totalDebit = money(reversalLines.reduce((sum: number, line: any) => sum + line.debit, 0));
      const totalCredit = money(reversalLines.reduce((sum: number, line: any) => sum + line.credit, 0));
      if (Math.abs(totalDebit - totalCredit) > 0.02) throw new Error('القيد العكسي غير متوازن: ' + String(entry.id));
      const reversalEntry = {
        id: reversalId,
        entryNumber: 'LOCAL-reversal-' + String(entry.id) + '-' + referenceId.slice(0, 8),
        date: now,
        referenceId,
        referenceType: entry.referenceType || 'order',
        description: 'قيد عكسي - ' + String(entry.description) + ' (' + reason + ')',
        totalDebit, totalCredit, status: 'posted',
        createdBy: createdBy || 'System',
        branchId: entry.branchId,
        syncStatus: journalSyncStatus,
        createdAt: now,
      };
      changes.push({ action: 'put', entity: 'journalEntries', record: reversalEntry, syncState: journalSyncStatus });
      reversalLines.forEach((line: any, index: number) => {
        const lineId = reversalId + ':' + index;
        changes.push({
          action: 'put', entity: 'transactions',
          record: {
            id: lineId, journalEntryId: reversalId, accountId: line.accountCode,
            accountName: accountRowsByCode.get(line.accountCode)?.record.name || line.accountCode,
            type: line.debit > 0 ? 'debit' : 'credit',
            amount: line.debit > 0 ? line.debit : line.credit,
            debit: line.debit, credit: line.credit, description: line.description,
            orderId: line.orderId, purchaseId: line.purchaseId, returnId: line.returnId,
            syncStatus: journalSyncStatus, createdAt: now,
          },
          syncState: journalSyncStatus,
        });
        const accountRow = accountRowsByCode.get(line.accountCode);
        const account = accountChanges.get(line.accountCode) || accountRow?.record;
        if (account) {
          const normalDebit = account.type === 'asset' || account.type === 'expense';
          const delta = normalDebit ? line.debit - line.credit : line.credit - line.debit;
          accountChanges.set(line.accountCode, {
            ...account, balance: money(Number(account.balance || 0) + delta), updatedAt: now,
          });
        }
      });
      changes.push({
        action: 'put', entity: 'journalEntries',
        record: { ...entry, status: 'reversed', reversedEntryId: reversalId, updatedAt: now },
        syncState: entry.syncStatus || 'local',
      });
    }
    for (const [code, account] of accountChanges) {
      changes.push({
        action: 'put', entity: 'accounts', record: account,
        syncState: accountRowsByCode.get(code)?.syncState || 'local',
      });
    }
    if (changes.length) {
      const applied = await nativePosRepository.applyChanges(changes);
      if (applied !== changes.length) throw new Error('SQLite لم تؤكد حفظ جميع القيود العكسية');
    }
    return;
  }
  await ensureDesktopDatabase();
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
