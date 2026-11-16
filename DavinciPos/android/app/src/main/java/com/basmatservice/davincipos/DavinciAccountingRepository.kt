package com.basmatservice.davincipos

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

data class DavinciJournalLine(
    val accountId: String,
    val debitMinor: Long = 0L,
    val creditMinor: Long = 0L,
    val memo: String? = null
)

data class DavinciJournalTotals(val debitMinor: Long, val creditMinor: Long)

data class DavinciTrialBalanceRow(
    val accountId: String,
    val code: String,
    val name: String,
    val accountType: String,
    val debitMinor: Long,
    val creditMinor: Long,
    val netDebitMinor: Long
)

data class DavinciAccountLedgerRow(
    val journalEntryId: String,
    val entryNumber: String,
    val occurredAt: String,
    val description: String,
    val debitMinor: Long,
    val creditMinor: Long,
    val memo: String?
)

internal object DavinciAccountingDateFilter {
    fun boundary(value: String, endExclusive: Boolean = false): String {
        require(Regex("\\\\d{4}-\\\\d{2}-\\\\d{2}").matches(value)) {
            "Invalid trial balance date."
        }
        val date = try { LocalDate.parse(value) } catch (_: Exception) {
            throw IllegalArgumentException("Invalid trial balance date.")
        }
        require(date.toString() == value) { "Invalid trial balance date." }
        return (if (endExclusive) date.plusDays(1) else date).toString() + "T00:00:00"
    }
}

/** Exact integer-minor-unit journal validation shared by post and reversal workflows. */
object DavinciJournalValidator {
    const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    fun validate(lines: List<DavinciJournalLine>): DavinciJournalTotals {
        require(lines.size >= 2) { "A journal entry needs at least two lines." }
        var debit = 0L
        var credit = 0L
        lines.forEach { line ->
            require(line.accountId.isNotBlank() &&
                line.debitMinor in 0..MAX_SAFE_INTEGER &&
                line.creditMinor in 0..MAX_SAFE_INTEGER &&
                ((line.debitMinor > 0L) xor (line.creditMinor > 0L))) {
                "Each journal line must contain either a positive debit or a positive credit."
            }
            require(debit <= MAX_SAFE_INTEGER - line.debitMinor &&
                credit <= MAX_SAFE_INTEGER - line.creditMinor) {
                "Journal total exceeds supported safe integer limits."
            }
            debit += line.debitMinor
            credit += line.creditMinor
        }
        require(debit > 0L && debit == credit) {
            "Journal entry is not balanced or contains invalid minor-unit amounts."
        }
        return DavinciJournalTotals(debit, credit)
    }
}

/**
 * Native accounting operations matching accounting.js.
 *
 * Journal lines are inserted while the entry is draft, then the entry is posted
 * in the same SQLite transaction so schema triggers enforce balanced immutable
 * posted entries. This repository deliberately does not expose arbitrary SQL.
 */
class DavinciAccountingRepository(context: Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)

    fun postJournalEntry(
        sourceType: String,
        sourceId: String,
        description: String,
        lines: List<DavinciJournalLine>,
        occurredAt: String = Instant.now().toString()
    ): String {
        require(sourceType.isNotBlank() && sourceId.isNotBlank()) {
            "Journal source references are required."
        }
        require(description.isNotBlank()) { "Journal description is required." }
        DavinciJournalValidator.validate(lines)
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val existing = findEntryId(db, sourceType, sourceId)
            val id = existing ?: insertDraftAndPost(
                db, sourceType, sourceId, description, lines, occurredAt
            )
            db.setTransactionSuccessful()
            return id
        } finally {
            db.endTransaction()
        }
    }

    fun reverseJournalEntry(
        entryId: String,
        reason: String = "Correction",
        occurredAt: String = Instant.now().toString()
    ): String {
        require(entryId.isNotBlank()) { "Journal entry ID is required." }
        val cleanReason = reason.trim().ifEmpty { "Correction" }
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val original = db.rawQuery(
                "SELECT entry_number,status,reversed_entry_id FROM journal_entries WHERE id=?",
                arrayOf(entryId)
            ).use { cursor ->
                if (!cursor.moveToFirst()) null else Triple(
                    cursor.getString(0), cursor.getString(1),
                    if (cursor.isNull(2)) null else cursor.getString(2)
                )
            } ?: throw IllegalArgumentException("Journal entry not found.")

            if (original.third != null) {
                db.setTransactionSuccessful()
                return original.third!!
            }
            require(original.second == "posted") {
                "Only posted journal entries can be reversed."
            }

            val lines = db.rawQuery(
                """
                SELECT account_id,credit_minor,debit_minor,memo
                FROM journal_lines WHERE journal_entry_id=? ORDER BY rowid
                """.trimIndent(), arrayOf(entryId)
            ).use { cursor ->
                buildList {
                    while (cursor.moveToNext()) add(
                        DavinciJournalLine(
                            accountId = cursor.getString(0),
                            debitMinor = cursor.getLong(1),
                            creditMinor = cursor.getLong(2),
                            memo = if (cursor.isNull(3)) null else cursor.getString(3)
                        )
                    )
                }
            }
            val reversalId = findEntryId(db, "reversal", entryId) ?: insertDraftAndPost(
                db, "reversal", entryId,
                "Reversal of ${original.first}: $cleanReason",
                lines, occurredAt
            )
            val changed = db.update(
                "journal_entries",
                ContentValues().apply {
                    put("status", "reversed")
                    put("reversed_entry_id", reversalId)
                },
                "id=? AND status='posted' AND reversed_entry_id IS NULL",
                arrayOf(entryId)
            )
            check(changed == 1) { "Journal entry changed while it was being reversed." }
            db.setTransactionSuccessful()
            return reversalId
        } finally {
            db.endTransaction()
        }
    }

    fun getTrialBalance(from: String? = null, to: String? = null): List<DavinciTrialBalanceRow> {
        val filters = mutableListOf("je.status IN ('posted','reversed')")
        val params = mutableListOf<String>()
        if (from != null) {
            filters += "je.occurred_at>=?"
            params += DavinciAccountingDateFilter.boundary(from)
        }
        if (to != null) {
            filters += "je.occurred_at<?"
            params += DavinciAccountingDateFilter.boundary(to, endExclusive = true)
        }
        val db = helper.readableDatabase
        return db.rawQuery(
            """
            SELECT a.id,a.code,a.name,a.account_type,
                   COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit_minor ELSE 0 END),0),
                   COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit_minor ELSE 0 END),0),
                   COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit_minor-jl.credit_minor ELSE 0 END),0)
            FROM accounts a
            LEFT JOIN journal_lines jl ON jl.account_id=a.id
            LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id
                 AND ${filters.joinToString(" AND ")}
            WHERE a.is_active=1
            GROUP BY a.id ORDER BY a.code
            """.trimIndent(), params.toTypedArray()
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(
                    DavinciTrialBalanceRow(
                        cursor.getString(0), cursor.getString(1), cursor.getString(2),
                        cursor.getString(3), cursor.getLong(4), cursor.getLong(5),
                        cursor.getLong(6)
                    )
                )
            }
        }
    }

    fun getAccountLedger(
        accountId: String,
        from: String? = null,
        to: String? = null
    ): List<DavinciAccountLedgerRow> {
        require(accountId.isNotBlank()) { "Account ID is required." }
        val filters = mutableListOf("je.status IN ('posted','reversed')", "jl.account_id=?")
        val params = mutableListOf(accountId)
        if (from != null) {
            filters += "je.occurred_at>=?"
            params += from
        }
        if (to != null) {
            filters += "je.occurred_at<=?"
            params += to
        }
        val db = helper.readableDatabase
        return db.rawQuery(
            """
            SELECT je.id,je.entry_number,je.occurred_at,je.description,
                   jl.debit_minor,jl.credit_minor,jl.memo
            FROM journal_lines jl
            JOIN journal_entries je ON je.id=jl.journal_entry_id
            WHERE ${filters.joinToString(" AND ")}
            ORDER BY je.occurred_at,je.entry_number
            """.trimIndent(), params.toTypedArray()
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(
                    DavinciAccountLedgerRow(
                        cursor.getString(0), cursor.getString(1), cursor.getString(2),
                        cursor.getString(3), cursor.getLong(4), cursor.getLong(5),
                        if (cursor.isNull(6)) null else cursor.getString(6)
                    )
                )
            }
        }
    }

    private fun findEntryId(db: SQLiteDatabase, sourceType: String, sourceId: String): String? =
        db.rawQuery(
            "SELECT id FROM journal_entries WHERE source_type=? AND source_id=?",
            arrayOf(sourceType, sourceId)
        ).use { if (it.moveToFirst()) it.getString(0) else null }

    private fun insertDraftAndPost(
        db: SQLiteDatabase,
        sourceType: String,
        sourceId: String,
        description: String,
        lines: List<DavinciJournalLine>,
        occurredAt: String
    ): String {
        DavinciJournalValidator.validate(lines)
        lines.forEach { line ->
            val active = db.rawQuery(
                "SELECT is_active FROM accounts WHERE id=?",
                arrayOf(line.accountId)
            ).use { cursor -> cursor.moveToFirst() && cursor.getInt(0) == 1 }
            require(active) { "Account not found or inactive: ${line.accountId}" }
        }

        val id = UUID.randomUUID().toString()
        val entryNumber = "JE-${System.currentTimeMillis()}-${id.replace("-", "").take(8).uppercase()}"
        db.insertOrThrow("journal_entries", null, ContentValues().apply {
            put("id", id)
            put("entry_number", entryNumber)
            put("source_type", sourceType)
            put("source_id", sourceId)
            put("description", description)
            put("status", "draft")
            put("occurred_at", occurredAt)
        })
        lines.forEach { line ->
            db.insertOrThrow("journal_lines", null, ContentValues().apply {
                put("id", UUID.randomUUID().toString())
                put("journal_entry_id", id)
                put("account_id", line.accountId)
                put("debit_minor", line.debitMinor)
                put("credit_minor", line.creditMinor)
                if (line.memo == null) putNull("memo") else put("memo", line.memo)
            })
        }
        val posted = db.update(
            "journal_entries",
            ContentValues().apply {
                put("status", "posted")
                put("posted_at", Instant.now().toString())
            },
            "id=? AND status='draft'",
            arrayOf(id)
        )
        check(posted == 1) { "Could not post journal entry." }
        return id
    }
}
