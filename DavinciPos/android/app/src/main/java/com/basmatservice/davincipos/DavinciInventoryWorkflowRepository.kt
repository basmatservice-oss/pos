package com.basmatservice.davincipos

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.time.Instant
import java.util.UUID
import kotlin.math.abs
import kotlin.math.roundToLong

data class DavinciInventoryCountLine(
    val id: String,
    val productId: String,
    val name: String,
    val unitSymbol: String,
    val expectedQuantity: Double,
    val countedQuantity: Double?,
    val difference: Double?
)

data class DavinciInventoryCount(
    val id: String,
    val branchId: String?,
    val status: String,
    val openedAt: String,
    val postedAt: String?,
    val lines: List<DavinciInventoryCountLine>
)

data class DavinciInventoryCountSummary(
    val id: String,
    val status: String,
    val openedAt: String,
    val postedAt: String?,
    val products: Int,
    val countedProducts: Int
)

data class DavinciInventoryAdjustmentResult(
    val id: String,
    val duplicate: Boolean,
    val quantityDelta: Double,
    val costTotalMinor: Long
)

data class DavinciInventoryCountAdjustment(
    val productId: String,
    val quantityDelta: Double,
    val costTotalMinor: Long
)

data class DavinciInventoryCountPostResult(
    val id: String,
    val duplicate: Boolean,
    val adjustments: List<DavinciInventoryCountAdjustment>
)

/** Stock adjustments and physical inventory-count lifecycle. */
class DavinciInventoryWorkflowRepository(context: Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)
    private val inventory = DavinciInventoryRepository(context.applicationContext)
    private val accounting = DavinciAccountingRepository(context.applicationContext)

    fun adjustInventory(
        productId: String,
        quantityDelta: Double,
        unitCostMinor: Long = 0L,
        reason: String = "Inventory adjustment",
        branchId: String? = DavinciCatalogRepository.MAIN_BRANCH_ID,
        id: String = UUID.randomUUID().toString(),
        occurredAt: String = Instant.now().toString(),
        userId: String? = null
    ): DavinciInventoryAdjustmentResult {
        require(productId.isNotBlank() && quantityDelta.isFinite() && quantityDelta != 0.0) {
            "A product and non-zero quantity adjustment are required."
        }
        require(reason.isNotBlank()) { "Adjustment reason is required." }
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val existing = db.rawQuery(
                "SELECT id FROM stock_movements WHERE source_type='adjustment' AND source_id=? LIMIT 1",
                arrayOf(id)
            ).use { it.moveToFirst() }
            if (existing) {
                db.setTransactionSuccessful()
                return DavinciInventoryAdjustmentResult(id, true, quantityDelta, 0L)
            }
            val result = if (quantityDelta > 0.0) {
                inventory.receiveStock(
                    productId, branchId, "adjustment", id, quantityDelta,
                    unitCostMinor, occurredAt
                )
            } else {
                val method = setting(db, "inventory.cost_method", "weighted")
                inventory.issueStock(
                    productId, branchId, "adjustment", id, abs(quantityDelta),
                    method, occurredAt
                )
            }
            if (result.costTotalMinor > 0L) {
                val lines = if (quantityDelta > 0.0) listOf(
                    DavinciJournalLine("acc-inventory", debitMinor = result.costTotalMinor),
                    DavinciJournalLine("acc-stock-adjustment-gain", creditMinor = result.costTotalMinor)
                ) else listOf(
                    DavinciJournalLine("acc-stock-adjustment-loss", debitMinor = result.costTotalMinor),
                    DavinciJournalLine("acc-inventory", creditMinor = result.costTotalMinor)
                )
                accounting.postJournalEntry(
                    sourceType = "inventory_adjustment",
                    sourceId = id,
                    description = reason,
                    lines = lines,
                    occurredAt = occurredAt
                )
            }
            db.insertOrThrow("audit_logs", null, ContentValues().apply {
                put("id", UUID.randomUUID().toString())
                if (userId == null) putNull("user_id") else put("user_id", userId)
                put("action", "inventory.adjustment")
                put("entity_type", "product")
                put("entity_id", productId)
                put("details", org.json.JSONObject()
                    .put("quantityDelta", quantityDelta)
                    .put("reason", reason)
                    .put("costTotalMinor", result.costTotalMinor).toString())
                put("created_at", Instant.now().toString())
            })
            db.setTransactionSuccessful()
            return DavinciInventoryAdjustmentResult(id, false, quantityDelta, result.costTotalMinor)
        } finally {
            db.endTransaction()
        }
    }

    fun createInventoryCount(
        branchId: String? = DavinciCatalogRepository.MAIN_BRANCH_ID,
        userId: String? = null,
        productIds: List<String>? = null
    ): DavinciInventoryCountCreated {
        val id = UUID.randomUUID().toString()
        val now = Instant.now().toString()
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            db.insertOrThrow("inventory_counts", null, ContentValues().apply {
                put("id", id)
                if (branchId == null) putNull("branch_id") else put("branch_id", branchId)
                put("status", "draft")
                if (userId == null) putNull("opened_by") else put("opened_by", userId)
                put("opened_at", now)
            })
            val products = if (!productIds.isNullOrEmpty()) {
                val placeholders = productIds.joinToString(",") { "?" }
                db.rawQuery(
                    "SELECT id FROM products WHERE is_active=1 AND track_stock=1 AND id IN ($placeholders) ORDER BY name",
                    productIds.toTypedArray()
                ).use { cursor -> buildList { while (cursor.moveToNext()) add(cursor.getString(0)) } }
            } else {
                db.rawQuery(
                    "SELECT id FROM products WHERE is_active=1 AND track_stock=1 ORDER BY name", null
                ).use { cursor -> buildList { while (cursor.moveToNext()) add(cursor.getString(0)) } }
            }
            products.forEach { productId ->
                db.insertOrThrow("inventory_count_lines", null, ContentValues().apply {
                    put("id", UUID.randomUUID().toString())
                    put("count_id", id)
                    put("product_id", productId)
                    put("expected_quantity", inventory.getStockOnHand(productId, branchId))
                })
            }
            db.setTransactionSuccessful()
            return DavinciInventoryCountCreated(id, branchId, "draft", products.size)
        } finally {
            db.endTransaction()
        }
    }

    fun getInventoryCount(id: String): DavinciInventoryCount {
        val db = helper.readableDatabase
        val header = db.rawQuery(
            "SELECT id,branch_id,status,opened_at,posted_at FROM inventory_counts WHERE id=?",
            arrayOf(id)
        ).use { cursor ->
            if (!cursor.moveToFirst()) null else CountHeader(
                cursor.getString(0), if (cursor.isNull(1)) null else cursor.getString(1),
                cursor.getString(2), cursor.getString(3),
                if (cursor.isNull(4)) null else cursor.getString(4)
            )
        } ?: throw IllegalArgumentException("Inventory count not found.")
        val lines = db.rawQuery(
            """
            SELECT l.id,l.product_id,p.name,u.symbol,l.expected_quantity,l.counted_quantity
            FROM inventory_count_lines l
            JOIN products p ON p.id=l.product_id
            JOIN units u ON u.id=p.base_unit_id
            WHERE l.count_id=? ORDER BY p.name
            """.trimIndent(), arrayOf(id)
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    val expected = cursor.getDouble(4)
                    val counted = if (cursor.isNull(5)) null else cursor.getDouble(5)
                    add(DavinciInventoryCountLine(
                        cursor.getString(0), cursor.getString(1), cursor.getString(2),
                        cursor.getString(3), expected, counted,
                        counted?.minus(expected)
                    ))
                }
            }
        }
        return DavinciInventoryCount(
            header.id, header.branchId, header.status, header.openedAt, header.postedAt, lines
        )
    }

    fun setInventoryCountLine(
        countId: String,
        productId: String,
        countedQuantity: Double
    ): DavinciInventoryCount {
        require(countedQuantity.isFinite() && countedQuantity >= 0.0) {
            "Counted quantity must be zero or greater."
        }
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val status = db.rawQuery(
                "SELECT status FROM inventory_counts WHERE id=?", arrayOf(countId)
            ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
                ?: throw IllegalArgumentException("Inventory count not found.")
            require(status == "draft") { "A posted inventory count cannot be changed." }
            val changed = db.update(
                "inventory_count_lines",
                ContentValues().apply { put("counted_quantity", countedQuantity) },
                "count_id=? AND product_id=?", arrayOf(countId, productId)
            )
            require(changed == 1) { "Product is not part of this inventory count." }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return getInventoryCount(countId)
    }

    fun completeInventoryCount(
        countId: String,
        userId: String? = null
    ): DavinciInventoryCountPostResult {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val header = db.rawQuery(
                "SELECT branch_id,status FROM inventory_counts WHERE id=?", arrayOf(countId)
            ).use { cursor ->
                if (!cursor.moveToFirst()) null else CountHeader(
                    countId, if (cursor.isNull(0)) null else cursor.getString(0),
                    cursor.getString(1), "", null
                )
            } ?: throw IllegalArgumentException("Inventory count not found.")
            if (header.status == "posted") {
                db.setTransactionSuccessful()
                return DavinciInventoryCountPostResult(countId, true, emptyList())
            }
            val rows = db.rawQuery(
                """
                SELECT l.id,l.product_id,l.expected_quantity,l.counted_quantity,p.cost_minor
                FROM inventory_count_lines l JOIN products p ON p.id=l.product_id
                WHERE l.count_id=?
                """.trimIndent(), arrayOf(countId)
            ).use { cursor ->
                buildList {
                    while (cursor.moveToNext()) add(CountLineRow(
                        cursor.getString(0), cursor.getString(1), cursor.getDouble(2),
                        if (cursor.isNull(3)) null else cursor.getDouble(3), cursor.getLong(4)
                    ))
                }
            }
            require(rows.isNotEmpty()) { "This inventory count has no products." }
            require(rows.none { it.countedQuantity == null }) {
                "Enter the actual quantity for every product before posting."
            }
            val adjustments = mutableListOf<DavinciInventoryCountAdjustment>()
            rows.forEach { line ->
                val delta = line.countedQuantity!! - line.expectedQuantity
                if (abs(delta) < 1e-9) return@forEach
                val adjustmentId = "$countId-${line.productId}"
                val result = adjustInventory(
                    productId = line.productId,
                    quantityDelta = delta,
                    unitCostMinor = line.costMinor.coerceAtLeast(0L),
                    reason = "Inventory count $countId",
                    branchId = header.branchId,
                    id = adjustmentId,
                    userId = userId
                )
                db.update(
                    "inventory_count_lines",
                    ContentValues().apply { put("adjustment_id", adjustmentId) },
                    "id=?", arrayOf(line.id)
                )
                adjustments += DavinciInventoryCountAdjustment(
                    line.productId, delta, result.costTotalMinor
                )
            }
            val now = Instant.now().toString()
            val changed = db.update(
                "inventory_counts",
                ContentValues().apply {
                    put("status", "posted")
                    if (userId == null) putNull("posted_by") else put("posted_by", userId)
                    put("posted_at", now)
                },
                "id=? AND status='draft'", arrayOf(countId)
            )
            check(changed == 1) { "Inventory count changed while posting." }
            db.setTransactionSuccessful()
            return DavinciInventoryCountPostResult(countId, false, adjustments)
        } finally {
            db.endTransaction()
        }
    }

    fun listInventoryCounts(limit: Int = 50): List<DavinciInventoryCountSummary> {
        val safeLimit = limit.coerceIn(1, 200)
        return helper.readableDatabase.rawQuery(
            """
            SELECT c.id,c.status,c.opened_at,c.posted_at,COUNT(l.id),
              SUM(CASE WHEN l.counted_quantity IS NOT NULL THEN 1 ELSE 0 END)
            FROM inventory_counts c
            LEFT JOIN inventory_count_lines l ON l.count_id=c.id
            GROUP BY c.id ORDER BY c.opened_at DESC LIMIT ?
            """.trimIndent(), arrayOf(safeLimit.toString())
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(DavinciInventoryCountSummary(
                    cursor.getString(0), cursor.getString(1), cursor.getString(2),
                    if (cursor.isNull(3)) null else cursor.getString(3),
                    cursor.getInt(4), cursor.getInt(5)
                ))
            }
        }
    }

    private fun setting(db: SQLiteDatabase, key: String, fallback: String): String =
        db.rawQuery("SELECT value FROM app_settings WHERE key=?", arrayOf(key)).use {
            if (it.moveToFirst()) it.getString(0) else fallback
        }

    private data class CountHeader(
        val id: String,
        val branchId: String?,
        val status: String,
        val openedAt: String,
        val postedAt: String?
    )

    private data class CountLineRow(
        val id: String,
        val productId: String,
        val expectedQuantity: Double,
        val countedQuantity: Double?,
        val costMinor: Long
    )
}

data class DavinciInventoryCountCreated(
    val id: String,
    val branchId: String?,
    val status: String,
    val lineCount: Int
)
