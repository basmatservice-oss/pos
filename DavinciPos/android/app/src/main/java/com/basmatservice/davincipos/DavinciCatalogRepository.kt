package com.basmatservice.davincipos

import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import java.util.UUID

data class DavinciUnit(
    val id: String,
    val name: String,
    val symbol: String,
    val precision: Int
)

data class DavinciCategory(
    val id: String,
    val name: String,
    val color: String
)

data class DavinciProduct(
    val id: String,
    val sku: String?,
    val barcode: String?,
    val name: String,
    val categoryId: String?,
    val categoryName: String?,
    val baseUnitId: String,
    val baseUnitSymbol: String?,
    val costMinor: Long,
    val salePriceMinor: Long,
    val taxRateBps: Int,
    val taxExempt: Boolean,
    val trackStock: Boolean,
    val minStock: Double,
    val stockOnHand: Double,
    val inventoryValueMinor: Long,
    val priceCurrency: String,
    val isActive: Boolean
)

/**
 * First typed Android repository slice. SQL is private to this class; the WebView
 * must never receive a raw database handle or arbitrary SQL execution capability.
 */
class DavinciCatalogRepository(context: android.content.Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)

    fun listUnits(): List<DavinciUnit> = helper.readableDatabase.rawQuery(
        "SELECT id,name,symbol,precision FROM units ORDER BY name", null
    ).use { cursor ->
        buildList {
            while (cursor.moveToNext()) add(
                DavinciUnit(
                    cursor.getString(0), cursor.getString(1),
                    cursor.getString(2), cursor.getInt(3)
                )
            )
        }
    }

    fun listCategories(): List<DavinciCategory> = helper.readableDatabase.rawQuery(
        "SELECT id,name,color FROM categories ORDER BY name", null
    ).use { cursor ->
        buildList {
            while (cursor.moveToNext()) add(
                DavinciCategory(cursor.getString(0), cursor.getString(1), cursor.getString(2))
            )
        }
    }

    fun listProducts(branchId: String = MAIN_BRANCH_ID): List<DavinciProduct> =
        helper.readableDatabase.rawQuery(
            """
            SELECT p.id,p.sku,p.barcode,p.name,p.category_id,c.name,p.base_unit_id,u.symbol,
                   p.cost_minor,p.sale_price_minor,p.tax_rate_bps,p.tax_exempt,p.track_stock,
                   p.min_stock,p.price_currency,p.is_active,
                   COALESCE((SELECT SUM(sm.quantity_delta) FROM stock_movements sm
                             WHERE sm.product_id=p.id AND sm.branch_id=?),0),
                   COALESCE((SELECT SUM(CASE WHEN sm.quantity_delta>0
                             THEN sm.cost_total_minor ELSE -sm.cost_total_minor END)
                             FROM stock_movements sm
                             WHERE sm.product_id=p.id AND sm.branch_id=?),0)
            FROM products p
            LEFT JOIN categories c ON c.id=p.category_id
            LEFT JOIN units u ON u.id=p.base_unit_id
            WHERE p.is_active=1
            ORDER BY p.name
            """.trimIndent(),
            arrayOf(branchId, branchId)
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(cursor.toDavinciProduct())
            }
        }

    fun createCategory(name: String, color: String = "#64748b", id: String = UUID.randomUUID().toString()): String {
        val cleanName = requiredText(name, "category name", 160)
        val cleanColor = requiredText(color, "category color", 32)
        val values = ContentValues().apply {
            put("id", id)
            put("name", cleanName)
            put("color", cleanColor)
            put("created_at", now())
            put("updated_at", now())
        }
        helper.writableDatabase.insertOrThrow("categories", null, values)
        return id
    }

    fun createProduct(input: NewProduct): String {
        val name = requiredText(input.name, "product name", 160)
        val baseUnitId = requiredText(input.baseUnitId, "base unit", 100)
        require(input.costMinor >= 0) { "Invalid cost." }
        require(input.salePriceMinor >= 0) { "Invalid sale price." }
        require(input.taxRateBps in 0..10_000) { "Invalid product tax rate." }
        require(input.minStock.isFinite() && input.minStock >= 0) { "Invalid minimum stock." }

        val database = helper.writableDatabase
        database.beginTransaction()
        try {
            requireExists(database, "units", baseUnitId, "Base unit not found.")
            input.categoryId?.let { requireExists(database, "categories", it, "Category not found.") }
            val id = input.id ?: UUID.randomUUID().toString()
            val values = ContentValues().apply {
                put("id", id)
                put("sku", input.sku?.let { requiredText(it, "SKU", 80) })
                put("barcode", input.barcode?.let { requiredText(it, "barcode", 100) })
                put("name", name)
                put("category_id", input.categoryId)
                put("base_unit_id", baseUnitId)
                put("cost_minor", input.costMinor)
                put("sale_price_minor", input.salePriceMinor)
                put("tax_rate_bps", input.taxRateBps)
                put("tax_exempt", if (input.taxExempt) 1 else 0)
                put("track_stock", if (input.trackStock) 1 else 0)
                put("min_stock", input.minStock)
                put("is_active", 1)
                put("created_at", now())
                put("updated_at", now())
            }
            database.insertOrThrow("products", null, values)
            database.setTransactionSuccessful()
            return id
        } finally {
            database.endTransaction()
        }
    }

    private fun requireExists(db: SQLiteDatabase, table: String, id: String, message: String) {
        // Table names are selected only by this class, never supplied by WebView input.
        db.rawQuery("SELECT 1 FROM $table WHERE id=? LIMIT 1", arrayOf(id)).use {
            require(it.moveToFirst()) { message }
        }
    }

    private fun Cursor.toDavinciProduct() = DavinciProduct(
        id = getString(0),
        sku = nullableString(1),
        barcode = nullableString(2),
        name = getString(3),
        categoryId = nullableString(4),
        categoryName = nullableString(5),
        baseUnitId = getString(6),
        baseUnitSymbol = nullableString(7),
        costMinor = getLong(8),
        salePriceMinor = getLong(9),
        taxRateBps = getInt(10),
        taxExempt = getInt(11) == 1,
        trackStock = getInt(12) == 1,
        minStock = getDouble(13),
        priceCurrency = getString(14),
        isActive = getInt(15) == 1,
        stockOnHand = getDouble(16),
        inventoryValueMinor = getLong(17)
    )

    private fun Cursor.nullableString(index: Int): String? =
        if (isNull(index)) null else getString(index)

    private fun requiredText(value: String, label: String, max: Int): String {
        val clean = value.trim()
        require(clean.isNotEmpty() && clean.length <= max) { "Invalid $label." }
        return clean
    }

    private fun now() = java.time.Instant.now().toString()

    data class NewProduct(
        val name: String,
        val baseUnitId: String,
        val sku: String? = null,
        val barcode: String? = null,
        val categoryId: String? = null,
        val costMinor: Long = 0,
        val salePriceMinor: Long = 0,
        val taxRateBps: Int = 0,
        val taxExempt: Boolean = false,
        val trackStock: Boolean = true,
        val minStock: Double = 0.0,
        val id: String? = null
    )

    companion object {
        const val MAIN_BRANCH_ID = "branch-main"
    }
}
