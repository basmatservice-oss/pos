package com.basmatservice.davincipos

import kotlin.math.roundToLong

data class DavinciLineTax(
    val netMinor: Long,
    val taxMinor: Long,
    val totalMinor: Long
)

/**
 * Integer-minor-unit tax calculation matching DavinciPos tax.js.
 * The caller remains responsible for validating aggregate sale/purchase totals.
 */
object DavinciTaxCalculator {
    fun calculateLineTax(
        unitPriceMinor: Long,
        quantity: Double = 1.0,
        discountMinor: Long = 0L,
        rateBps: Int,
        priceMode: String,
        enabled: Boolean = true
    ): DavinciLineTax {
        require(unitPriceMinor in 0..MAX_SAFE_INTEGER) { "Invalid tax calculation input." }
        require(quantity.isFinite() && quantity > 0.0) { "Invalid tax calculation input." }
        require(discountMinor in 0..MAX_SAFE_INTEGER) { "Invalid tax calculation input." }
        require(rateBps in 0..10_000) { "Invalid tax calculation input." }

        val grossProduct = unitPriceMinor.toDouble() * quantity
        require(grossProduct.isFinite() && grossProduct <= Long.MAX_VALUE.toDouble()) {
            "Tax calculation exceeds supported numeric limits."
        }
        val gross = grossProduct.roundToLong() - discountMinor

        if (!enabled) return DavinciLineTax(gross, 0L, gross)
        require(priceMode == "inclusive" || priceMode == "exclusive") {
            "Tax price mode must be inclusive or exclusive."
        }
        require(gross >= 0L) { "Discount cannot exceed the line amount." }

        val taxValue = if (priceMode == "inclusive") {
            gross.toDouble() * rateBps / (10_000.0 + rateBps)
        } else {
            gross.toDouble() * rateBps / 10_000.0
        }
        require(taxValue.isFinite() && taxValue <= Long.MAX_VALUE.toDouble()) {
            "Tax amount exceeds supported numeric limits."
        }
        val tax = taxValue.roundToLong()
        return if (priceMode == "inclusive") {
            DavinciLineTax(gross - tax, tax, gross)
        } else {
            DavinciLineTax(gross, tax, gross + tax)
        }
    }

    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
}
