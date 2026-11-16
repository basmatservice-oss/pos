package com.basmatservice.davincipos

import android.database.sqlite.SQLiteConstraintException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class DavinciAccountingRepositoryIntegrationTest {
    @Test
    fun postsReversesAndReportsJournalAtomicallyInRealSqliteSchema() {
        val context = RuntimeEnvironment.getApplication()
        DavinciDatabase.resetForTests(context)
        val repository = DavinciAccountingRepository(context)
        val helper = DavinciDatabase.get(context)
        val occurredAt = "2026-11-16T10:00:00.000Z"
        val lines = listOf(
            DavinciJournalLine(accountId = "acc-cash", debitMinor = 12_500),
            DavinciJournalLine(accountId = "acc-sales", creditMinor = 12_500)
        )

        val entryId = repository.postJournalEntry(
            sourceType = "integration-test",
            sourceId = "sale-001",
            description = "Integration sale",
            lines = lines,
            occurredAt = occurredAt
        )
        assertEquals(
            entryId,
            repository.postJournalEntry(
                sourceType = "integration-test",
                sourceId = "sale-001",
                description = "Duplicate source",
                lines = lines,
                occurredAt = occurredAt
            )
        )
        assertThrows(IllegalArgumentException::class.java) {
            repository.postJournalEntry(
                sourceType = "integration-test",
                sourceId = "sale-unbalanced",
                description = "Must roll back",
                lines = listOf(
                    DavinciJournalLine("acc-cash", debitMinor = 100),
                    DavinciJournalLine("acc-sales", creditMinor = 99)
                ),
                occurredAt = occurredAt
            )
        }

        val reversalId = repository.reverseJournalEntry(entryId, "Test reversal", occurredAt)
        assertNotEquals(entryId, reversalId)
        assertEquals(reversalId, repository.reverseJournalEntry(entryId, "Repeated reversal", occurredAt))

        val status = helper.readableDatabase.rawQuery(
            "SELECT status,reversed_entry_id FROM journal_entries WHERE id=?",
            arrayOf(entryId)
        ).use { cursor ->
            assertTrue(cursor.moveToFirst())
            cursor.getString(0) to cursor.getString(1)
        }
        assertEquals("reversed", status.first)
        assertEquals(reversalId, status.second)

        val balance = repository.getTrialBalance(from = "2026-11-16", to = "2026-11-16")
        val cash = balance.single { it.accountId == "acc-cash" }
        val sales = balance.single { it.accountId == "acc-sales" }
        assertEquals(0L, cash.netDebitMinor)
        assertEquals(0L, sales.netDebitMinor)
        assertEquals(12_500L, cash.debitMinor)
        assertEquals(12_500L, cash.creditMinor)

        val ledger = repository.getAccountLedger("acc-cash", from = occurredAt, to = occurredAt)
        assertEquals(2, ledger.size)
        assertEquals(listOf(12_500L, 0L), ledger.map { it.debitMinor }.sortedDescending())

        assertThrows(SQLiteConstraintException::class.java) {
            helper.writableDatabase.execSQL(
                """
                INSERT INTO journal_lines(id,journal_entry_id,account_id,debit_minor,credit_minor)
                VALUES('forbidden-line',?,'acc-cash',1,0)
                """.trimIndent(),
                arrayOf(entryId)
            )
        }
    }
}
