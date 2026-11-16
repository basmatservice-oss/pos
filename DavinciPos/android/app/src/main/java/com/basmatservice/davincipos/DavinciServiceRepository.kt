package com.basmatservice.davincipos

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import java.time.Instant
import java.util.UUID

data class DavinciService(
    val id: String,
    val code: String?,
    val name: String,
    val priceMinor: Long,
    val taxRateBps: Int,
    val taxExempt: Boolean,
    val isActive: Boolean,
    val componentCostMinor: Long,
    val componentSaleMinor: Long,
    val componentSummary: String
)

data class DavinciServiceComponent(
    val productId: String,
    val name: String,
    val quantity: Double,
    val unitSymbol: String,
    val unitCostMinor: Long,
    val componentCostMinor: Long
)

data class DavinciServiceComponentInput(
    val productId: String,
    val quantity: Double
)

/**
 * Service catalogue and bill-of-materials operations.
 *
 * Service components are stock-tracked products. Their quantities are expressed
 * in each product's base unit and are consumed by DavinciSalesRepository when
 * the service is sold. Service and component changes can be committed together.
 */
class DavinciServiceRepository(context: Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)

    fun listServices(): List<DavinciService> =
        helper.readableDatabase.rawQuery(
            """
            SELECT s.id,s.code,s.name,s.price_minor,s.tax_rate_bps,s.tax_exempt,s.is_active,
                   COALESCE((
                     SELECT SUM(sc.quantity * COALESCE(
                       (SELECT ROUND(
                          SUM(CASE WHEN sm.quantity_delta>0 THEN sm.cost_total_minor ELSE -sm.cost_total_minor END) /
                          NULLIF(SUM(sm.quantity_delta),0)
                       ) FROM stock_movements sm WHERE sm.product_id=p.id),
                       p.cost_minor
                     ))
                     FROM service_components sc JOIN products p ON p.id=sc.product_id
                     WHERE sc.service_id=s.id
                   ),0),
                   COALESCE((
                     SELECT SUM(sc.quantity*p.sale_price_minor)
                     FROM service_components sc JOIN products p ON p.id=sc.product_id
                     WHERE sc.service_id=s.id
                   ),0),
                   COALESCE((
                     SELECT group_concat(p.name || ' × ' || sc.quantity,'، ')
                     FROM service_components sc JOIN products p ON p.id=sc.product_id
                     WHERE sc.service_id=s.id
                   ),'بدون مواد')
            FROM services s
            ORDER BY s.name
            """.trimIndent(), null
        ).use { cursor ->
            buildList { while (cursor.moveToNext()) add(cursor.toService()) }
        }

    fun getService(serviceId: String): DavinciService? =
        listServices().firstOrNull { it.id == serviceId }

    fun listComponents(serviceId: String): List<DavinciServiceComponent> {
        requireService(helper.readableDatabase, serviceId)
        return helper.readableDatabase.rawQuery(
            """
            SELECT sc.product_id,p.name,sc.quantity,u.symbol,p.cost_minor,
                   ROUND(sc.quantity*COALESCE(
                     (SELECT ROUND(
                       SUM(CASE WHEN sm.quantity_delta>0 THEN sm.cost_total_minor ELSE -sm.cost_total_minor END) /
                       NULLIF(SUM(sm.quantity_delta),0)
                     ) FROM stock_movements sm WHERE sm.product_id=p.id),
                     p.cost_minor
                   ))
            FROM service_components sc
            JOIN products p ON p.id=sc.product_id
            JOIN units u ON u.id=p.base_unit_id
            WHERE sc.service_id=?
            ORDER BY p.name
            """.trimIndent(), arrayOf(serviceId)
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(
                    DavinciServiceComponent(
                        productId = cursor.getString(0),
                        name = cursor.getString(1),
                        quantity = cursor.getDouble(2),
                        unitSymbol = cursor.getString(3),
                        unitCostMinor = cursor.getLong(4),
                        componentCostMinor = cursor.getLong(5)
                    )
                )
            }
        }
    }

    fun saveService(
        input: SaveServiceInput,
        components: List<DavinciServiceComponentInput>? = null
    ): String {
        val name = requiredText(input.name, "service name", 160)
        val code = input.code?.trim()?.takeIf { it.isNotEmpty() }?.also {
            require(it.length <= 100) { "Invalid service code." }
        }
        require(input.priceMinor in 0..MAX_SAFE_INTEGER) { "Invalid service price." }
        require(input.taxRateBps in 0..10_000) { "Invalid service tax rate." }
        val id = input.id?.let { requiredText(it, "service id", 100) }
            ?: UUID.randomUUID().toString()
        val now = Instant.now().toString()
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val exists = exists(db, "SELECT 1 FROM services WHERE id=? LIMIT 1", arrayOf(id))
            if (input.id != null) require(exists) { "Service not found." }
            val values = ContentValues().apply {
                putNullable("code", code)
                put("name", name)
                put("price_minor", input.priceMinor)
                put("tax_rate_bps", input.taxRateBps)
                put("tax_exempt", if (input.taxExempt) 1 else 0)
                put("is_active", if (input.isActive) 1 else 0)
                put("updated_at", now)
            }
            if (exists) {
                db.update("services", values, "id=?", arrayOf(id))
            } else {
                values.put("id", id)
                values.put("created_at", now)
                db.insertOrThrow("services", null, values)
            }
            components?.let { replaceComponents(db, id, it) }
            db.setTransactionSuccessful()
            return id
        } finally {
            db.endTransaction()
        }
    }

    fun setComponents(
        serviceId: String,
        components: List<DavinciServiceComponentInput>
    ): List<DavinciServiceComponent> {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            replaceComponents(db, serviceId, components)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return listComponents(serviceId)
    }

    private fun replaceComponents(
        db: SQLiteDatabase,
        serviceId: String,
        components: List<DavinciServiceComponentInput>
    ) {
        requireService(db, serviceId)
        val normalized = components.map {
            val productId = requiredText(it.productId, "component product", 100)
            require(it.quantity.isFinite() && it.quantity > 0.0) {
                "Each service component must have a positive quantity."
            }
            require(
                exists(
                    db,
                    "SELECT 1 FROM products WHERE id=? AND track_stock=1 LIMIT 1",
                    arrayOf(productId)
                )
            ) { "Each service component must be a stock-tracked product with a positive quantity." }
            DavinciServiceComponentInput(productId, it.quantity)
        }
        db.delete("service_components", "service_id=?", arrayOf(serviceId))
        normalized.forEach { component ->
            db.insertOrThrow("service_components", null, ContentValues().apply {
                put("id", UUID.randomUUID().toString())
                put("service_id", serviceId)
                put("product_id", component.productId)
                put("quantity", component.quantity)
            })
        }
    }

    private fun requireService(db: SQLiteDatabase, id: String) {
        require(exists(db, "SELECT 1 FROM services WHERE id=? LIMIT 1", arrayOf(id))) {
            "Service not found."
        }
    }

    private fun exists(db: SQLiteDatabase, sql: String, args: Array<String>): Boolean =
        db.rawQuery(sql, args).use { it.moveToFirst() }

    private fun Cursor.toService() = DavinciService(
        id = getString(0),
        code = nullableString(1),
        name = getString(2),
        priceMinor = getLong(3),
        taxRateBps = getInt(4),
        taxExempt = getInt(5) == 1,
        isActive = getInt(6) == 1,
        componentCostMinor = getLong(7),
        componentSaleMinor = getLong(8),
        componentSummary = getString(9)
    )

    private fun Cursor.nullableString(index: Int): String? =
        if (isNull(index)) null else getString(index)

    private fun ContentValues.putNullable(key: String, value: String?) {
        if (value == null) putNull(key) else put(key, value)
    }

    private fun requiredText(value: String, label: String, maxLength: Int): String =
        value.trim().also {
            require(it.isNotEmpty() && it.length <= maxLength) { "Invalid $label." }
        }

    data class SaveServiceInput(
        val name: String,
        val priceMinor: Long,
        val code: String? = null,
        val taxRateBps: Int = 0,
        val taxExempt: Boolean = false,
        val isActive: Boolean = true,
        val id: String? = null
    )

    companion object {
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    }
}
