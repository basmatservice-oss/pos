package com.basmatservice.davincipos

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import java.time.Instant
import java.util.UUID
import kotlin.math.floor

data class DavinciStockMovementResult(
    val movementId: String,
    val quantity: Double,
    val costTotalMinor: Long,
    val unitCostMinor: Long,
    val allocations: List<DavinciFifoAllocation> = emptyList()
)

/**
 * Native SQLite inventory operations. FIFO ordering and per-layer cost rounding
 * mirror inventory.js; callers must wrap related sale/return/accounting writes
 * in the same higher-level transaction when adding those workflows.
 */
class DavinciInventoryRepository(context: android.content.Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)

    fun getStockOnHand(productId: String, branchId: String? = null): Double =
        helper.readableDatabase.rawQuery(
            "SELECT COALESCE(SUM(quantity_delta),0) FROM stock_movements WHERE product_id=? AND branch_id IS ?",
            arrayOf(productId, branchId)
        ).use { cursor -> if (cursor.moveToFirst()) cursor.getDouble(0) else 0.0 }

    fun getInventoryValueMinor(productId: String, branchId: String? = null): Long =
        helper.readableDatabase.rawQuery(
            """
            SELECT COALESCE(SUM(CASE WHEN quantity_delta>0
                THEN cost_total_minor ELSE -cost_total_minor END),0)
            FROM stock_movements WHERE product_id=? AND branch_id IS ?
            """.trimIndent(),
            arrayOf(productId, branchId)
        ).use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else 0L }

    fun getWeightedAverageCostMinor(productId: String, branchId: String? = null): Long {
        val quantity = getStockOnHand(productId, branchId)
        if (quantity <= 0.0) return 0L
        val value = getInventoryValueMinor(productId, branchId).toDouble() / quantity
        require(value.isFinite() && value <= MAX_SAFE_INTEGER.toDouble()) {
            "Weighted average cost exceeds supported safe integer limits."
        }
        return floor(value + 0.5).toLong().coerceAtLeast(0L)
    }

    fun receiveStock(
        productId: String,
        branchId: String? = null,
        sourceType: String,
        sourceId: String,
        quantity: Double,
        unitCostMinor: Long,
        occurredAt: String = Instant.now().toString()
    ): DavinciStockMovementResult {
        requireSource(productId, sourceType, sourceId)
        require(quantity.isFinite() && quantity > 0.0) { "Invalid quantity." }
        require(unitCostMinor in 0..MAX_SAFE_INTEGER) { "Invalid unit cost." }
        val total = roundedCost(quantity, unitCostMinor)
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val trackStock = db.rawQuery(
                "SELECT track_stock FROM products WHERE id=?",
                arrayOf(productId)
            ).use { cursor ->
                require(cursor.moveToFirst()) { "Product not found." }
                cursor.getInt(0) == 1
            }
            require(trackStock) { "Cannot receive stock for a non-stock product." }
            val movementId = UUID.randomUUID().toString()
            db.insertOrThrow("stock_movements", null, ContentValues().apply {
                put("id", movementId)
                put("product_id", productId)
                putNullable("branch_id", branchId)
                put("source_type", sourceType)
                put("source_id", sourceId)
                put("quantity_delta", quantity)
                put("unit_cost_minor", unitCostMinor)
                put("cost_total_minor", total)
                put("cost_method", "opening")
                put("occurred_at", occurredAt)
            })
            db.insertOrThrow("inventory_layers", null, ContentValues().apply {
                put("id", UUID.randomUUID().toString())
                put("product_id", productId)
                putNullable("branch_id", branchId)
                put("source_type", sourceType)
                put("source_id", sourceId)
                put("received_quantity", quantity)
                put("remaining_quantity", quantity)
                put("unit_cost_minor", unitCostMinor)
                put("received_at", occurredAt)
            })
            db.setTransactionSuccessful()
            return DavinciStockMovementResult(movementId, quantity, total, unitCostMinor)
        } finally {
            db.endTransaction()
        }
    }

    fun issueStock(
        productId: String,
        branchId: String? = null,
        sourceType: String,
        sourceId: String,
        quantity: Double,
        costMethod: String,
        occurredAt: String = Instant.now().toString()
    ): DavinciStockMovementResult = when (costMethod) {
        "fifo" -> issueFifoStock(productId, branchId, sourceType, sourceId, quantity, occurredAt)
        "weighted" -> issueWeightedStock(productId, branchId, sourceType, sourceId, quantity, occurredAt)
        else -> throw IllegalArgumentException("Cost method must be weighted or fifo.")
    }

    fun issueWeightedStock(
        productId: String,
        branchId: String? = null,
        sourceType: String,
        sourceId: String,
        quantity: Double,
        occurredAt: String = Instant.now().toString()
    ): DavinciStockMovementResult {
        requireSource(productId, sourceType, sourceId)
        require(quantity.isFinite() && quantity > 0.0) { "Invalid quantity." }
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val available = stockOnHand(db, productId, branchId)
            require(available + 1e-9 >= quantity) { "Insufficient stock. Available: $available" }
            val inventoryValue = db.rawQuery(
                """
                SELECT COALESCE(SUM(CASE WHEN quantity_delta>0
                    THEN cost_total_minor ELSE -cost_total_minor END),0)
                FROM stock_movements WHERE product_id=? AND branch_id IS ?
                """.trimIndent(),
                arrayOf(productId, branchId)
            ).use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else 0L }
            val layers = db.rawQuery(
                """
                SELECT id,remaining_quantity FROM inventory_layers
                WHERE product_id=? AND branch_id IS ? AND remaining_quantity>0
                ORDER BY received_at,rowid
                """.trimIndent(),
                arrayOf(productId, branchId)
            ).use { cursor ->
                buildList {
                    while (cursor.moveToNext()) add(
                        DavinciWeightedLayer(cursor.getString(0), cursor.getDouble(1))
                    )
                }
            }
            val allocation = DavinciWeightedAllocator.allocate(
                layers, available, inventoryValue, quantity
            )
            allocation.remainingByLayer.forEach { (layerId, remaining) ->
                val original = layers.first { it.id == layerId }.remainingQuantity
                val take = original - remaining
                if (take > 0.0) {
                    val changed = db.update(
                        "inventory_layers",
                        ContentValues().apply { put("remaining_quantity", remaining) },
                        "id=? AND product_id=? AND branch_id IS ? AND remaining_quantity>=?",
                        arrayOf(layerId, productId, branchId, take.toString())
                    )
                    check(changed == 1) { "Inventory layer changed while issuing weighted stock." }
                }
            }
            val movementId = UUID.randomUUID().toString()
            db.insertOrThrow("stock_movements", null, ContentValues().apply {
                put("id", movementId)
                put("product_id", productId)
                putNullable("branch_id", branchId)
                put("source_type", sourceType)
                put("source_id", sourceId)
                put("quantity_delta", -quantity)
                put("unit_cost_minor", allocation.unitCostMinor)
                put("cost_total_minor", allocation.costTotalMinor)
                put("cost_method", "weighted")
                put("occurred_at", occurredAt)
            })
            db.setTransactionSuccessful()
            return DavinciStockMovementResult(
                movementId, quantity, allocation.costTotalMinor, allocation.unitCostMinor
            )
        } finally {
            db.endTransaction()
        }
    }

    fun issueFifoStock(
        productId: String,
        branchId: String? = null,
        sourceType: String,
        sourceId: String,
        quantity: Double,
        occurredAt: String = Instant.now().toString()
    ): DavinciStockMovementResult {
        requireSource(productId, sourceType, sourceId)
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val available = stockOnHand(db, productId, branchId)
            require(available + 1e-9 >= quantity) { "Insufficient stock. Available: $available" }
            val layers = db.rawQuery(
                """
                SELECT id,remaining_quantity,unit_cost_minor
                FROM inventory_layers
                WHERE product_id=? AND branch_id IS ? AND remaining_quantity>0
                ORDER BY received_at,rowid
                """.trimIndent(),
                arrayOf(productId, branchId)
            ).use { cursor ->
                buildList {
                    while (cursor.moveToNext()) add(
                        DavinciFifoLayer(cursor.getString(0), cursor.getDouble(1), cursor.getLong(2))
                    )
                }
            }
            val allocation = DavinciFifoAllocator.allocate(layers, quantity)
            allocation.allocations.forEach { part ->
                val changed = db.update(
                    "inventory_layers",
                    ContentValues().apply {
                        put("remaining_quantity", allocation.remainingByLayer.getValue(part.layerId))
                    },
                    "id=? AND product_id=? AND branch_id IS ? AND remaining_quantity>=?",
                    arrayOf(part.layerId, productId, branchId, part.quantity.toString())
                )
                check(changed == 1) { "Inventory layer changed while issuing stock." }
            }
            val movementId = UUID.randomUUID().toString()
            db.insertOrThrow("stock_movements", null, ContentValues().apply {
                put("id", movementId)
                put("product_id", productId)
                putNullable("branch_id", branchId)
                put("source_type", sourceType)
                put("source_id", sourceId)
                put("quantity_delta", -quantity)
                put("unit_cost_minor", allocation.unitCostMinor)
                put("cost_total_minor", allocation.costTotalMinor)
                put("cost_method", "fifo")
                put("occurred_at", occurredAt)
            })
            db.setTransactionSuccessful()
            return DavinciStockMovementResult(
                movementId, quantity, allocation.costTotalMinor,
                allocation.unitCostMinor, allocation.allocations
            )
        } finally {
            db.endTransaction()
        }
    }

    fun restoreFifoAllocation(
        productId: String,
        branchId: String? = null,
        sourceType: String,
        sourceId: String,
        allocations: List<DavinciFifoAllocation>,
        occurredAt: String = Instant.now().toString()
    ): DavinciStockMovementResult {
        requireSource(productId, sourceType, sourceId)
        require(allocations.isNotEmpty()) { "FIFO restoration requires layer allocations." }
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            var quantity = 0.0
            var totalCost = 0L
            allocations.forEach { part ->
                require(part.quantity.isFinite() && part.quantity > 0.0 &&
                    part.unitCostMinor in 0..MAX_SAFE_INTEGER &&
                    part.costTotalMinor in 0..MAX_SAFE_INTEGER) { "Invalid FIFO layer allocation." }
                val layer = db.rawQuery(
                    """
                    SELECT product_id,branch_id,received_quantity,remaining_quantity,unit_cost_minor
                    FROM inventory_layers WHERE id=?
                    """.trimIndent(),
                    arrayOf(part.layerId)
                ).use { cursor ->
                    if (!cursor.moveToFirst()) null else LayerState(
                        cursor.getString(0),
                        if (cursor.isNull(1)) null else cursor.getString(1),
                        cursor.getDouble(2), cursor.getDouble(3), cursor.getLong(4)
                    )
                } ?: throw IllegalArgumentException("FIFO return layer does not exist.")
                require(layer.productId == productId && layer.branchId == branchId) {
                    "FIFO return layer does not match the product branch."
                }
                require(layer.unitCostMinor == part.unitCostMinor) {
                    "FIFO layer cost changed since the original sale."
                }
                require(layer.remainingQuantity + part.quantity <= layer.receivedQuantity + 1e-8) {
                    "FIFO return exceeds the quantity originally issued from this layer."
                }
                db.execSQL(
                    "UPDATE inventory_layers SET remaining_quantity=remaining_quantity+? WHERE id=?",
                    arrayOf(part.quantity, part.layerId)
                )
                quantity += part.quantity
                require(totalCost <= MAX_SAFE_INTEGER - part.costTotalMinor) {
                    "FIFO return cost exceeds supported safe integer limits."
                }
                totalCost += part.costTotalMinor
            }
            val unitCost = if (quantity > 0.0) totalCost.toDouble() / quantity else 0.0
            val roundedUnitCost = floor(unitCost + 0.5).toLong()
            val movementId = UUID.randomUUID().toString()
            db.insertOrThrow("stock_movements", null, ContentValues().apply {
                put("id", movementId)
                put("product_id", productId)
                putNullable("branch_id", branchId)
                put("source_type", sourceType)
                put("source_id", sourceId)
                put("quantity_delta", quantity)
                put("unit_cost_minor", roundedUnitCost)
                put("cost_total_minor", totalCost)
                put("cost_method", "fifo")
                put("occurred_at", occurredAt)
            })
            db.setTransactionSuccessful()
            return DavinciStockMovementResult(movementId, quantity, totalCost, roundedUnitCost)
        } finally {
            db.endTransaction()
        }
    }

    private fun stockOnHand(db: SQLiteDatabase, productId: String, branchId: String?): Double =
        db.rawQuery(
            "SELECT COALESCE(SUM(quantity_delta),0) FROM stock_movements WHERE product_id=? AND branch_id IS ?",
            arrayOf(productId, branchId)
        ).use { cursor -> if (cursor.moveToFirst()) cursor.getDouble(0) else 0.0 }

    private fun requireSource(productId: String, sourceType: String, sourceId: String) {
        require(productId.isNotBlank() && sourceType.isNotBlank() && sourceId.isNotBlank()) {
            "Stock movement requires product and source references."
        }
    }

    private fun roundedCost(quantity: Double, unitCostMinor: Long): Long {
        val value = quantity * unitCostMinor.toDouble()
        require(value.isFinite() && value <= MAX_SAFE_INTEGER.toDouble()) {
            "Stock cost exceeds supported safe integer limits."
        }
        return floor(value + 0.5).toLong()
    }

    private data class LayerState(
        val productId: String,
        val branchId: String?,
        val receivedQuantity: Double,
        val remainingQuantity: Double,
        val unitCostMinor: Long
    )

    private fun ContentValues.putNullable(key: String, value: String?) {
        if (value == null) putNull(key) else put(key, value)
    }

    private companion object {
        const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    }
}
