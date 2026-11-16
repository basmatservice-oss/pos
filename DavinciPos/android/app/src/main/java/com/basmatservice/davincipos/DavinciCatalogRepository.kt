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
    val foreignCostMinor: Long?,
    val foreignSalePriceMinor: Long?,
    val autoRateUpdate: Boolean,
    val isActive: Boolean
)

data class DavinciBarcodeLookup(
    val productId: String,
    val name: String,
    val barcode: String?,
    val salePriceMinor: Long,
    val unitId: String?,
    val unitName: String?,
    val unitSymbol: String?,
    val baseQuantity: Double,
    val productUnitId: String?,
    val lineType: String
)

data class DavinciProductUnit(
    val id: String,
    val productId: String,
    val unitId: String,
    val unitName: String,
    val unitSymbol: String,
    val baseQuantity: Double,
    val barcode: String?,
    val salePriceMinor: Long?,
    val isDefaultSale: Boolean
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
                   p.min_stock,p.price_currency,p.foreign_cost_minor,p.foreign_sale_price_minor,
                   p.auto_rate_update,p.is_active,
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

    fun lookupBarcode(code: String): DavinciBarcodeLookup {
        val value = requiredText(code, "barcode", 100)
        val product = helper.readableDatabase.rawQuery(
            """
            SELECT p.id,p.name,p.barcode,p.sale_price_minor,p.base_unit_id,
                   u.name,u.symbol,1 AS base_quantity,NULL AS product_unit_id,'product' AS line_type
            FROM products p JOIN units u ON u.id=p.base_unit_id
            WHERE p.barcode=? AND p.is_active=1
            UNION ALL
            SELECT p.id,p.name,pu.barcode,COALESCE(pu.sale_price_minor,p.sale_price_minor),
                   pu.unit_id,u.name,u.symbol,pu.base_quantity,pu.id,'product'
            FROM product_units pu JOIN products p ON p.id=pu.product_id
            JOIN units u ON u.id=pu.unit_id
            WHERE pu.barcode=? AND p.is_active=1
            LIMIT 1
            """.trimIndent(), arrayOf(value, value)
        ).use { cursor ->
            if (!cursor.moveToFirst()) null else DavinciBarcodeLookup(
                productId = cursor.getString(0),
                name = cursor.getString(1),
                barcode = cursor.nullableString(2),
                salePriceMinor = cursor.getLong(3),
                unitId = cursor.nullableString(4),
                unitName = cursor.nullableString(5),
                unitSymbol = cursor.nullableString(6),
                baseQuantity = cursor.getDouble(7),
                productUnitId = cursor.nullableString(8),
                lineType = cursor.getString(9)
            )
        }
        if (product != null) return product
        val service = helper.readableDatabase.rawQuery(
            "SELECT id,name,code,price_minor FROM services WHERE code=? AND is_active=1",
            arrayOf(value)
        ).use { cursor ->
            if (!cursor.moveToFirst()) null else DavinciBarcodeLookup(
                productId = cursor.getString(0),
                name = cursor.getString(1),
                barcode = cursor.nullableString(2),
                salePriceMinor = cursor.getLong(3),
                unitId = null,
                unitName = null,
                unitSymbol = null,
                baseQuantity = 1.0,
                productUnitId = null,
                lineType = "service"
            )
        }
        return service ?: throw IllegalArgumentException("لم يتم العثور على صنف أو خدمة بهذا الباركود.")
    }

    fun createUnit(name: String, symbol: String, precision: Int = 0, id: String = UUID.randomUUID().toString()): String {
        val cleanName = requiredText(name, "unit name", 160)
        val cleanSymbol = requiredText(symbol, "unit symbol", 16)
        require(precision in 0..6) { "Unit precision must be between 0 and 6." }
        helper.writableDatabase.insertOrThrow("units", null, ContentValues().apply {
            put("id", id)
            put("name", cleanName)
            put("symbol", cleanSymbol)
            put("precision", precision)
        })
        return id
    }

    fun listProductUnits(productId: String): List<DavinciProductUnit> =
        helper.readableDatabase.rawQuery(
            """
            SELECT pu.id,pu.product_id,pu.unit_id,u.name,u.symbol,pu.base_quantity,
                   pu.barcode,pu.sale_price_minor,pu.is_default_sale
            FROM product_units pu JOIN units u ON u.id=pu.unit_id
            WHERE pu.product_id=?
            ORDER BY pu.is_default_sale DESC,u.name
            """.trimIndent(), arrayOf(productId)
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(
                    DavinciProductUnit(
                        id = cursor.getString(0),
                        productId = cursor.getString(1),
                        unitId = cursor.getString(2),
                        unitName = cursor.getString(3),
                        unitSymbol = cursor.getString(4),
                        baseQuantity = cursor.getDouble(5),
                        barcode = cursor.nullableString(6),
                        salePriceMinor = if (cursor.isNull(7)) null else cursor.getLong(7),
                        isDefaultSale = cursor.getInt(8) == 1
                    )
                )
            }
        }

    /** Saves a conversion without relying on SQLite UPSERT (Android API 26 compatibility). */
    fun saveProductUnit(
        productId: String,
        unitId: String,
        baseQuantity: Double,
        barcode: String? = null,
        salePriceMinor: Long? = null,
        isDefaultSale: Boolean = false,
        id: String = UUID.randomUUID().toString()
    ): String {
        require(baseQuantity.isFinite() && baseQuantity > 0.0) { "Invalid unit conversion." }
        require(salePriceMinor == null || salePriceMinor >= 0) { "Invalid unit sale price." }
        val cleanBarcode = barcode?.let { requiredText(it, "barcode", 100) }
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            requireExists(db, "products", productId, "Product not found.")
            requireExists(db, "units", unitId, "Unit not found.")
            val existingId = db.rawQuery(
                "SELECT id FROM product_units WHERE product_id=? AND unit_id=? LIMIT 1",
                arrayOf(productId, unitId)
            ).use { if (it.moveToFirst()) it.getString(0) else null }
            val values = ContentValues().apply {
                put("base_quantity", baseQuantity)
                if (cleanBarcode == null) putNull("barcode") else put("barcode", cleanBarcode)
                if (salePriceMinor == null) putNull("sale_price_minor") else put("sale_price_minor", salePriceMinor)
                put("is_default_sale", if (isDefaultSale) 1 else 0)
            }
            val savedId = existingId ?: id
            if (existingId == null) {
                values.put("id", savedId)
                values.put("product_id", productId)
                values.put("unit_id", unitId)
                db.insertOrThrow("product_units", null, values)
            } else {
                db.update("product_units", values, "id=?", arrayOf(existingId))
            }
            if (isDefaultSale) {
                db.execSQL(
                    "UPDATE product_units SET is_default_sale=0 WHERE product_id=? AND id<>?",
                    arrayOf(productId, savedId)
                )
            }
            db.setTransactionSuccessful()
            return savedId
        } finally {
            db.endTransaction()
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

    /**
     * Partial product update matching catalog.js. Base units and stock tracking
     * cannot be changed in ways that would invalidate existing stock movements.
     */
    fun updateProduct(id: String, patch: Map<String, Any?>): Boolean {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val current = db.rawQuery(
                "SELECT base_unit_id FROM products WHERE id=?",
                arrayOf(id)
            ).use { cursor ->
                if (!cursor.moveToFirst()) null else cursor.getString(0)
            } ?: throw IllegalArgumentException("Product not found.")

            val values = ContentValues()
            if (patch.containsKey("sku")) values.put(
                "sku", optionalText(patch["sku"], "SKU", 80)
            )
            if (patch.containsKey("barcode")) values.put(
                "barcode", optionalText(patch["barcode"], "barcode", 100)
            )
            if (patch.containsKey("name")) values.put(
                "name", requiredText(patch["name"] as? String ?: "", "product name", 160)
            )
            if (patch.containsKey("categoryId")) {
                val categoryId = optionalText(patch["categoryId"], "category", 100)
                if (categoryId != null) requireExists(db, "categories", categoryId, "Category not found.")
                if (categoryId == null) values.putNull("category_id") else values.put("category_id", categoryId)
            }
            if (patch.containsKey("baseUnitId")) {
                val unitId = requiredText(patch["baseUnitId"] as? String ?: "", "base unit", 100)
                if (unitId != current) {
                    val hasMovements = db.rawQuery(
                        "SELECT 1 FROM stock_movements WHERE product_id=? LIMIT 1", arrayOf(id)
                    ).use { it.moveToFirst() }
                    require(!hasMovements) { "Base unit cannot be changed after stock movements exist." }
                }
                requireExists(db, "units", unitId, "Base unit not found.")
                values.put("base_unit_id", unitId)
            }
            if (patch.containsKey("costMinor")) values.put(
                "cost_minor", safeMoney(patch["costMinor"], "cost")
            )
            if (patch.containsKey("salePriceMinor")) values.put(
                "sale_price_minor", safeMoney(patch["salePriceMinor"], "sale price")
            )
            if (patch.containsKey("taxRateBps")) {
                val rate = safeInteger(patch["taxRateBps"], "tax rate")
                require(rate in 0..10_000) { "Invalid product tax rate or minimum stock." }
                values.put("tax_rate_bps", rate.toInt())
            }
            if (patch.containsKey("taxExempt")) values.put(
                "tax_exempt", if (patch["taxExempt"] == true) 1 else 0
            )
            if (patch.containsKey("trackStock")) {
                val track = patch["trackStock"] == true
                if (!track) {
                    val onHand = db.rawQuery(
                        "SELECT COALESCE(SUM(quantity_delta),0) FROM stock_movements WHERE product_id=?",
                        arrayOf(id)
                    ).use { it.moveToFirst(); it.getDouble(0) }
                    require(onHand <= 0.0) { "A product with stock on hand cannot stop tracking stock." }
                }
                values.put("track_stock", if (track) 1 else 0)
            }
            if (patch.containsKey("minStock")) {
                val minimum = (patch["minStock"] as? Number)?.toDouble()
                    ?: throw IllegalArgumentException("Invalid product tax rate or minimum stock.")
                require(minimum.isFinite() && minimum >= 0.0) {
                    "Invalid product tax rate or minimum stock."
                }
                values.put("min_stock", minimum)
            }
            if (patch.containsKey("isActive")) values.put(
                "is_active", if (patch["isActive"] == false) 0 else 1
            )
            values.put("updated_at", now())
            require(db.update("products", values, "id=?", arrayOf(id)) == 1) {
                "Product not found."
            }
            db.setTransactionSuccessful()
            return true
        } finally {
            db.endTransaction()
        }
    }

    private fun optionalText(value: Any?, label: String, max: Int): String? {
        if (value == null || value == "") return null
        return requiredText(value as? String ?: "", label, max)
    }

    private fun safeMoney(value: Any?, label: String): Long {
        val amount = safeInteger(value, label)
        require(amount >= 0L) { "Invalid $label." }
        return amount
    }

    private fun safeInteger(value: Any?, label: String): Long {
        val number = value as? Number ?: throw IllegalArgumentException("Invalid $label.")
        val doubleValue = number.toDouble()
        require(doubleValue.isFinite() && doubleValue >= 0.0 &&
            doubleValue <= 9_007_199_254_740_991.0 && doubleValue % 1.0 == 0.0) {
            "Invalid $label."
        }
        return number.toLong()
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
        foreignCostMinor = if (isNull(15)) null else getLong(15),
        foreignSalePriceMinor = if (isNull(16)) null else getLong(16),
        autoRateUpdate = getInt(17) == 1,
        isActive = getInt(18) == 1,
        stockOnHand = getDouble(19),
        inventoryValueMinor = getLong(20)
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
