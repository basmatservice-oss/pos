package com.basmatservice.davincipos

data class DavinciFifoLayer(
    val id: String,
    val remainingQuantity: Double,
    val unitCostMinor: Long
)

data class DavinciFifoAllocation(
    val layerId: String,
    val quantity: Double,
    val unitCostMinor: Long,
    val costTotalMinor: Long
)

data class DavinciFifoResult(
    val allocations: List<DavinciFifoAllocation>,
    val remainingByLayer: Map<String, Double>,
    val quantity: Double,
    val costTotalMinor: Long,
    val unitCostMinor: Long
)

/**
 * Pure FIFO allocator matching inventory.js issueStock's per-layer rounding.
 * Input layers must already be ordered by received_at, rowid (oldest first).
 */
object DavinciFifoAllocator {
    fun allocate(layers: List<DavinciFifoLayer>, quantity: Double): DavinciFifoResult {
        require(quantity.isFinite() && quantity > 0.0) { "Invalid quantity." }
        require(layers.map { it.id }.toSet().size == layers.size) { "Duplicate inventory layer." }
        layers.forEach {
            require(it.id.isNotBlank() && it.remainingQuantity.isFinite() &&
                it.remainingQuantity >= 0.0 && it.unitCostMinor in 0..MAX_SAFE_INTEGER) {
                "Invalid inventory layer."
            }
        }
        val available = layers.sumOf { it.remainingQuantity }
        require(available + EPSILON >= quantity) {
            "Insufficient stock. Available: $available"
        }

        var left = quantity
        var totalCost = 0L
        val allocations = mutableListOf<DavinciFifoAllocation>()
        val remaining = layers.associate { it.id to it.remainingQuantity }.toMutableMap()

        for (layer in layers) {
            if (left <= EPSILON) break
            if (layer.remainingQuantity <= 0.0) continue
            val take = minOf(left, layer.remainingQuantity)
            val rawCost = take * layer.unitCostMinor.toDouble()
            require(rawCost.isFinite() && rawCost <= MAX_SAFE_INTEGER.toDouble()) {
                "FIFO layer cost exceeds supported safe integer limits."
            }
            val layerCost = kotlin.math.floor(rawCost + 0.5).toLong()
            require(totalCost <= MAX_SAFE_INTEGER - layerCost) {
                "FIFO total cost exceeds supported safe integer limits."
            }
            allocations += DavinciFifoAllocation(layer.id, take, layer.unitCostMinor, layerCost)
            totalCost += layerCost
            remaining[layer.id] = (layer.remainingQuantity - take).coerceAtLeast(0.0)
            left -= take
        }
        require(left <= 1e-7) { "Inventory cost layers do not reconcile with on-hand quantity." }
        return DavinciFifoResult(
            allocations = allocations,
            remainingByLayer = remaining,
            quantity = quantity,
            costTotalMinor = totalCost,
            unitCostMinor = kotlin.math.floor(totalCost.toDouble() / quantity + 0.5).toLong()
        )
    }

    private const val EPSILON = 1e-9
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
}
