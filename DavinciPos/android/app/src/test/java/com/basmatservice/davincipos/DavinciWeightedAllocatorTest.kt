package com.basmatservice.davincipos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DavinciWeightedAllocatorTest {
    @Test
    fun roundsAverageUnitCostBeforeCalculatingIssueTotal() {
        val result = DavinciWeightedAllocator.allocate(
            listOf(DavinciWeightedLayer("a", 2.0), DavinciWeightedLayer("b", 3.0)),
            availableQuantity = 5.0,
            inventoryValueMinor = 1_005,
            quantity = 2.0
        )
        assertEquals(201L, result.unitCostMinor)
        assertEquals(402L, result.costTotalMinor)
        assertEquals(mapOf("a" to 2.0), result.allocations)
        assertEquals(0.0, result.remainingByLayer["a"]!!, 0.0000001)
        assertEquals(3.0, result.remainingByLayer["b"]!!, 0.0000001)
    }

    @Test
    fun followsOldestLayerOrderAndAcceptsTinyFloatingTolerance() {
        val result = DavinciWeightedAllocator.allocate(
            listOf(DavinciWeightedLayer("first", 0.4), DavinciWeightedLayer("second", 1.0)),
            availableQuantity = 1.4,
            inventoryValueMinor = 140,
            quantity = 0.4000000005
        )
        assertEquals(1, result.allocations.size)
        assertEquals(0.4, result.allocations["first"]!!, 0.0000001)
        assertEquals(1.0, result.remainingByLayer["second"]!!, 0.0000001)
    }

    @Test
    fun rejectsInsufficientOrUnreconciledLayers() {
        assertThrows(IllegalArgumentException::class.java) {
            DavinciWeightedAllocator.allocate(
                listOf(DavinciWeightedLayer("a", 1.0)), 1.0, 100, 1.1
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            DavinciWeightedAllocator.allocate(
                listOf(DavinciWeightedLayer("a", 0.5)), 1.0, 100, 1.0
            )
        }
    }
}
