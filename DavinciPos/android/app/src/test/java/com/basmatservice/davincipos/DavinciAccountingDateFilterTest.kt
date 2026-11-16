package com.basmatservice.davincipos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DavinciAccountingDateFilterTest {
    @Test
    fun createsInclusiveStartAndExclusiveEndBoundaries() {
        assertEquals(
            "2026-11-01T00:00:00",
            DavinciAccountingDateFilter.boundary("2026-11-01")
        )
        assertEquals(
            "2026-12-01T00:00:00",
            DavinciAccountingDateFilter.boundary("2026-11-30", endExclusive = true)
        )
    }

    @Test
    fun rejectsMalformedAndImpossibleDates() {
        listOf("", "2026-2-01", "2026-02-30", "2026-13-01", "2026-01-01T00:00:00")
            .forEach { value ->
                assertThrows(IllegalArgumentException::class.java) {
                    DavinciAccountingDateFilter.boundary(value)
                }
            }
    }
}
