import { randomUUID } from 'node:crypto';
import { db, inTransaction } from './database.js';

export function validateJournalLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) throw new Error('A journal entry needs at least two lines.');
  let debit = 0, credit = 0;
  for (const line of lines) {
    const d = Number(line.debitMinor || 0), c = Number(line.creditMinor || 0);
    if (!line.accountId || !Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0 || (d > 0) === (c > 0)) {
      throw new Error('Each journal line must contain either a positive debit or a positive credit.');
    }
    debit += d; credit += c;
  }
  if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || debit <= 0 || debit !== credit) {
    throw new Error('Journal entry is not balanced or contains invalid minor-unit amounts.');
  }
  return { debitMinor: debit, creditMinor: credit };
}

export function postJournalEntry({ sourceType, sourceId, description, occurredAt = new Date().toISOString(), lines }) {
  validateJournalLines(lines);
  return inTransaction(() => {
    const existing = db.prepare('SELECT id FROM journal_entries WHERE source_type=? AND source_id=?').get(sourceType, sourceId);
    if (existing) return existing.id;
    const id = randomUUID();
    const number = `JE-${Date.now()}-${id.slice(0,8).toUpperCase()}`;
    db.prepare(`INSERT INTO journal_entries (id,entry_number,source_type,source_id,description,status,occurred_at)
      VALUES (?,?,?,?,?,'draft',?)`).run(id, number, sourceType, sourceId, description, occurredAt);
    const insertLine = db.prepare('INSERT INTO journal_lines (id,journal_entry_id,account_id,debit_minor,credit_minor,memo) VALUES (?,?,?,?,?,?)');
    for (const line of lines) insertLine.run(randomUUID(), id, line.accountId, Number(line.debitMinor || 0), Number(line.creditMinor || 0), line.memo || null);
    db.prepare("UPDATE journal_entries SET status='posted', posted_at=? WHERE id=?").run(new Date().toISOString(), id);
    return id;
  });
}

export function getTrialBalance({from=null,to=null}={}) {
  const filters=["je.status='posted'"],params=[];
  if(from){filters.push('je.occurred_at>=?');params.push(from);}
  if(to){filters.push('je.occurred_at<=?');params.push(to);}
  return db.prepare(`SELECT a.id AS accountId,a.code,a.name,a.account_type AS accountType,
    COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit_minor ELSE 0 END),0) AS debitMinor,COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit_minor ELSE 0 END),0) AS creditMinor,
    COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit_minor-jl.credit_minor ELSE 0 END),0) AS netDebitMinor
    FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id=a.id
    LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id AND ${filters.join(' AND ')}
    WHERE a.is_active=1 GROUP BY a.id ORDER BY a.code`).all(...params);
}
export function getAccountLedger(accountId,{from=null,to=null}={}) {
  const filters=["je.status IN ('posted','reversed')","jl.account_id=?"],params=[accountId];
  if(from){filters.push('je.occurred_at>=?');params.push(from);}
  if(to){filters.push('je.occurred_at<=?');params.push(to);}
  return db.prepare(`SELECT je.id AS journalEntryId,je.entry_number AS entryNumber,je.occurred_at AS occurredAt,
    je.description,jl.debit_minor AS debitMinor,jl.credit_minor AS creditMinor,jl.memo
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id
    WHERE ${filters.join(' AND ')} ORDER BY je.occurred_at,je.entry_number`).all(...params);
}

export function reverseJournalEntry(entryId,reason='Correction') {
  return inTransaction(()=>{
    const original=db.prepare('SELECT * FROM journal_entries WHERE id=?').get(entryId);
    if(!original) throw new Error('Journal entry not found.');
    if(original.reversed_entry_id) return original.reversed_entry_id;
    if(original.status!=='posted') throw new Error('Only posted journal entries can be reversed.');
    const lines=db.prepare('SELECT account_id,debit_minor,credit_minor,memo FROM journal_lines WHERE journal_entry_id=?').all(entryId)
      .map(line=>({accountId:line.account_id,debitMinor:line.credit_minor,creditMinor:line.debit_minor,memo:line.memo}));
    const reversalId=postJournalEntry({sourceType:'reversal',sourceId:entryId,description:`Reversal of ${original.entry_number}: ${reason}`,lines});
    db.prepare("UPDATE journal_entries SET status='reversed',reversed_entry_id=? WHERE id=?").run(reversalId,entryId);
    return reversalId;
  });
}
