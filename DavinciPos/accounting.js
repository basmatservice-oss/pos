import { randomUUID } from 'node:crypto';
import { db, inTransaction } from './database.js';

export function postJournalEntry({ sourceType, sourceId, description, occurredAt = new Date().toISOString(), lines }) {
  if (!Array.isArray(lines) || lines.length < 2) throw new Error('A journal entry needs at least two lines.');
  const debit = lines.reduce((sum, line) => sum + Number(line.debitMinor || 0), 0);
  const credit = lines.reduce((sum, line) => sum + Number(line.creditMinor || 0), 0);
  if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || debit <= 0 || debit !== credit) {
    throw new Error('Journal entry is not balanced or contains invalid minor-unit amounts.');
  }
  for (const line of lines) {
    const d = Number(line.debitMinor || 0), c = Number(line.creditMinor || 0);
    if (!line.accountId || !Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0 || (d > 0) === (c > 0)) {
      throw new Error('Each journal line must contain either a positive debit or a positive credit.');
    }
  }

  return inTransaction(() => {
    const existing = db.prepare('SELECT id FROM journal_entries WHERE source_type=? AND source_id=?').get(sourceType, sourceId);
    if (existing) return existing.id;
    const id = randomUUID();
    const number = `JE-${Date.now()}-${id.slice(0,8).toUpperCase()}`;
    db.prepare(`INSERT INTO journal_entries (id,entry_number,source_type,source_id,description,status,occurred_at,posted_at)
      VALUES (?,?,?,?,?,'posted',?,?)`).run(id, number, sourceType, sourceId, description, occurredAt, new Date().toISOString());
    const insertLine = db.prepare('INSERT INTO journal_lines (id,journal_entry_id,account_id,debit_minor,credit_minor,memo) VALUES (?,?,?,?,?,?)');
    for (const line of lines) insertLine.run(randomUUID(), id, line.accountId, Number(line.debitMinor || 0), Number(line.creditMinor || 0), line.memo || null);
    return id;
  });
}
