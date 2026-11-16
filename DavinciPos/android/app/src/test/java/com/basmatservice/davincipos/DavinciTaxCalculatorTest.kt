package com.basmatservice.davincipos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DavinciTaxCalculatorTest {
    @Test
    fun calculatesExclusiveTaxAndRoundsToMinorUnit() {
        val result = DavinciTaxCalculator.calculateLineTax(
            unitPriceMinor = 10_000,
            quantity = 2.0,
            rateBps = 1_500,
            priceMode = "exclusive"
        )
        assertEquals(DavinciLineTax(20_000, 3_000, 23_000), result)
    }

    @Test
    fun extractsInclusiveTaxFromGrossAmount() {
        val result = DavinciTaxCalculator.calculateLineTax(
            unitPriceMinor = 11_500,
            rateBps = 1_500,
            priceMode = "inclusive"
        )
        assertEquals(DavinciLineTax(10_000, 1_500, 11_500), result)
    }

    @Test
    fun disabledTaxKeepsGrossAsNetAndDoesNotRequirePriceMode() {
        val result = DavinciTaxCalculator.calculateLineTax(
            unitPriceMinor = 1_000,
            quantity = 1.5,
            discountMinor = 100,
            rateBps = 1_500,
            priceMode = "not-used",
            enabled = false
        )
        assertEquals(DavinciLineTax(1_400, 0, 1_400), result)
    }

    @Test
    fun rejectsDiscountAboveGrossWhenTaxIsEnabled() {
        assertThrows(IllegalArgumentException::class.java) {
            DavinciTaxCalculator.calculateLineTax(
                unitPriceMinor = 100,
                discountMinor = 101,
                rateBps = 0,
                priceMode = "exclusive"
            )
        }
    }

    @Test
    fun rejectsInvalidRateAndQuantity() {
        assertThrows(IllegalArgumentException::class.java) {
            DavinciTaxCalculator.calculateLineTax(
                unitPriceMinor = 100,
                quantity = 0.0,
                rateBps = 0,
                priceMode = "exclusive"
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            DavinciTaxCalculator.calculateLineTax(
                unitPriceMinor = 100,
                rateBps = 10_001,
                priceMode = "exclusive"
            )
        }
    }
}
