package com.basmatservice.davincipos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DavinciJournalValidatorTest {
    @Test
    fun acceptsBalancedMultiLineJournal() {
        val result = DavinciJournalValidator.validate(
            listOf(
                DavinciJournalLine("acc-cash", debitMinor = 1250),
                DavinciJournalLine("acc-sales", creditMinor = 1000),
                DavinciJournalLine("acc-tax", creditMinor = 250)
            )
        )
        assertEquals(DavinciJournalTotals(1250, 1250), result)
    }

    @Test
    fun rejectsUnbalancedJournal() {
        assertThrows(IllegalArgumentException::class.java) {
            DavinciJournalValidator.validate(
                listOf(
                    DavinciJournalLine("acc-cash", debitMinor = 100),
                    DavinciJournalLine("acc-sales", creditMinor = 99)
                )
            )
        }
    }

    @Test
    fun rejectsLineWithBothDebitAndCreditAndZeroLine() {
        assertThrows(IllegalArgumentException::class.java) {
            DavinciJournalValidator.validate(
                listOf(
                    DavinciJournalLine("acc-cash", debitMinor = 100, creditMinor = 100),
                    DavinciJournalLine("acc-sales", creditMinor = 100)
                )
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            DavinciJournalValidator.validate(
                listOf(
                    DavinciJournalLine("acc-cash"),
                    DavinciJournalLine("acc-sales", creditMinor = 100)
                )
            )
        }
    }

    @Test
    fun rejectsUnsafeAmountsAndOverflowingTotals() {
        assertThrows(IllegalArgumentException::class.java) {
            DavinciJournalValidator.validate(
                listOf(
                    DavinciJournalLine(
                        "acc-cash",
                        debitMinor = DavinciJournalValidator.MAX_SAFE_INTEGER + 1
                    ),
                    DavinciJournalLine("acc-sales", creditMinor = 1)
                )
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            DavinciJournalValidator.validate(
                listOf(
                    DavinciJournalLine("acc-cash", debitMinor = DavinciJournalValidator.MAX_SAFE_INTEGER),
                    DavinciJournalLine("acc-bank", debitMinor = 1),
                    DavinciJournalLine("acc-sales", creditMinor = DavinciJournalValidator.MAX_SAFE_INTEGER)
                )
            )
        }
    }

    @Test
    fun rejectsMissingAccountsAndSingleLineEntries() {
        assertThrows(IllegalArgumentException::class.java) {
            DavinciJournalValidator.validate(
                listOf(
                    DavinciJournalLine(" ", debitMinor = 50),
                    DavinciJournalLine("acc-sales", creditMinor = 50)
                )
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            DavinciJournalValidator.validate(
                listOf(DavinciJournalLine("acc-cash", debitMinor = 50))
            )
        }
    }
}
