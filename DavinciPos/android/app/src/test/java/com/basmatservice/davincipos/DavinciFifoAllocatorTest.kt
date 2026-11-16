package com.basmatservice.davincipos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DavinciFifoAllocatorTest {
    @Test
    fun consumesOldestLayerFirstAndPreservesExactAllocations() {
        val result = DavinciFifoAllocator.allocate(
            listOf(
                DavinciFifoLayer("old", 2.0, 100),
                DavinciFifoLayer("new", 5.0, 250)
            ),
            3.0
        )
        assertEquals(2, result.allocations.size)
        assertEquals(DavinciFifoAllocation("old", 2.0, 100, 200), result.allocations[0])
        assertEquals(DavinciFifoAllocation("new", 1.0, 250, 250), result.allocations[1])
        assertEquals(450L, result.costTotalMinor)
        assertEquals(150L, result.unitCostMinor)
        assertEquals(0.0, result.remainingByLayer["old"]!!, 0.0000001)
        assertEquals(4.0, result.remainingByLayer["new"]!!, 0.0000001)
    }

    @Test
    fun skipsEmptyLayersAndRoundsEachLayerCostLikeServer() {
        val result = DavinciFifoAllocator.allocate(
            listOf(
                DavinciFifoLayer("empty", 0.0, 999),
                DavinciFifoLayer("fractional", 0.5, 101),
                DavinciFifoLayer("next", 1.0, 203)
            ),
            1.25
        )
        assertEquals(2, result.allocations.size)
        assertEquals(51L, result.allocations[0].costTotalMinor)
        assertEquals(152L, result.allocations[1].costTotalMinor)
        assertEquals(203L, result.costTotalMinor)
    }

    @Test
    fun rejectsInsufficientStockAndInvalidQuantities() {
        assertThrows(IllegalArgumentException::class.java) {
            DavinciFifoAllocator.allocate(listOf(DavinciFifoLayer("a", 1.0, 10)), 1.1)
        }
        assertThrows(IllegalArgumentException::class.java) {
            DavinciFifoAllocator.allocate(listOf(DavinciFifoLayer("a", 1.0, 10)), 0.0)
        }
    }
}
