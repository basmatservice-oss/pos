package com.basmatservice.davincipos

import kotlin.math.floor

data class DavinciWeightedLayer(
    val id: String,
    val remainingQuantity: Double
)

data class DavinciWeightedResult(
    val allocations: Map<String, Double>,
    val remainingByLayer: Map<String, Double>,
    val quantity: Double,
    val unitCostMinor: Long,
    val costTotalMinor: Long
)

/** Mirrors inventory.js weighted issue: round average unit cost, then round issue total. */
object DavinciWeightedAllocator {
    fun allocate(
        layers: List<DavinciWeightedLayer>,
        availableQuantity: Double,
        inventoryValueMinor: Long,
        quantity: Double
    ): DavinciWeightedResult {
        require(quantity.isFinite() && quantity > 0.0) { "Invalid quantity." }
        require(availableQuantity.isFinite() && availableQuantity >= 0.0 &&
            availableQuantity + EPSILON >= quantity) { "Insufficient stock. Available: $availableQuantity" }
        require(inventoryValueMinor in -MAX_SAFE_INTEGER..MAX_SAFE_INTEGER) {
            "Inventory value exceeds supported safe integer limits."
        }
        require(layers.map { it.id }.toSet().size == layers.size) { "Duplicate inventory layer." }
        layers.forEach {
            require(it.id.isNotBlank() && it.remainingQuantity.isFinite() &&
                it.remainingQuantity >= 0.0) { "Invalid inventory layer." }
        }

        val averageRaw = if (availableQuantity <= 0.0) 0.0
            else inventoryValueMinor.toDouble() / availableQuantity
        require(averageRaw.isFinite() && averageRaw <= MAX_SAFE_INTEGER.toDouble()) {
            "Weighted average cost exceeds supported safe integer limits."
        }
        val unitCost = floor(averageRaw + 0.5).toLong().coerceAtLeast(0L)
        val totalRaw = quantity * unitCost.toDouble()
        require(totalRaw.isFinite() && totalRaw <= MAX_SAFE_INTEGER.toDouble()) {
            "Weighted issue cost exceeds supported safe integer limits."
        }
        val totalCost = floor(totalRaw + 0.5).toLong()

        var left = quantity
        val allocations = linkedMapOf<String, Double>()
        val remaining = layers.associate { it.id to it.remainingQuantity }.toMutableMap()
        for (layer in layers) {
            if (left <= EPSILON) break
            if (layer.remainingQuantity <= 0.0) continue
            val take = minOf(left, layer.remainingQuantity)
            allocations[layer.id] = take
            remaining[layer.id] = (layer.remainingQuantity - take).coerceAtLeast(0.0)
            left -= take
        }
        require(left <= 1e-7) {
            "Inventory cost layers do not reconcile with on-hand quantity."
        }
        return DavinciWeightedResult(allocations, remaining, quantity, unitCost, totalCost)
    }

    private const val EPSILON = 1e-9
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
}
