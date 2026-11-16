package com.basmatservice.davincipos

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import kotlin.math.roundToLong

data class DavinciExchangeRate(
    val id: String,
    val fromCurrency: String,
    val toCurrency: String,
    val rate: Double,
    val effectiveAt: String,
    val createdBy: String?
)

data class DavinciProductCurrency(
    val productId: String,
    val currency: String,
    val foreignCostMinor: Long?,
    val foreignSalePriceMinor: Long?,
    val autoUpdate: Boolean,
    val localCostMinor: Long,
    val localSalePriceMinor: Long
)

/**
 * Local SQLite implementation of the exchange-rate and product-currency rules.
 * All monetary values remain integer minor units; only the exchange rate is decimal.
 */
class DavinciCurrencyRepository(context: android.content.Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)

    fun getCurrentExchangeRate(
        fromCurrency: String = "USD",
        toCurrency: String = "SDG"
    ): DavinciExchangeRate? = helper.readableDatabase.rawQuery(
        """
        SELECT id,from_currency,to_currency,rate,effective_at,created_by
        FROM exchange_rates
        WHERE from_currency=? AND to_currency=?
        ORDER BY effective_at DESC,created_at DESC,rowid DESC LIMIT 1
        """.trimIndent(),
        arrayOf(fromCurrency, toCurrency)
    ).use { cursor ->
        if (!cursor.moveToFirst()) null else cursor.toExchangeRate()
    }

    fun listExchangeRates(limit: Int = 50): List<DavinciExchangeRate> {
        val safeLimit = limit.coerceIn(1, 200)
        return helper.readableDatabase.rawQuery(
            """
            SELECT er.id,er.from_currency,er.to_currency,er.rate,er.effective_at,u.display_name
            FROM exchange_rates er LEFT JOIN users u ON u.id=er.created_by
            ORDER BY er.effective_at DESC,er.created_at DESC LIMIT ?
            """.trimIndent(),
            arrayOf(safeLimit.toString())
        ).use { cursor ->
            buildList { while (cursor.moveToNext()) add(cursor.toExchangeRate()) }
        }
    }

    fun recordExchangeRate(
        rate: Double,
        effectiveAt: String = Instant.now().toString(),
        fromCurrency: String = "USD",
        toCurrency: String = "SDG",
        actorUserId: String? = null,
        applyAutomatically: Boolean = false
    ): Pair<DavinciExchangeRate, Int> {
        require(fromCurrency.matches(Regex("[A-Z]{3}")) &&
            toCurrency.matches(Regex("[A-Z]{3}")) && fromCurrency != toCurrency) {
            "Invalid currency pair."
        }
        require(rate.isFinite() && rate > 0.0 && rate <= 1_000_000.0) {
            "Exchange rate must be a positive number."
        }
        val normalizedDate = try { Instant.parse(effectiveAt).toString() }
        catch (_: Exception) { throw IllegalArgumentException("Invalid effective date.") }
        require(!applyAutomatically || (fromCurrency == "USD" && toCurrency == "SDG")) {
            "Automatic price updates are currently supported only for USD to SDG."
        }

        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val id = UUID.randomUUID().toString()
            val now = Instant.now().toString()
            db.insertOrThrow("exchange_rates", null, ContentValues().apply {
                put("id", id)
                put("from_currency", fromCurrency)
                put("to_currency", toCurrency)
                put("rate", rate)
                put("effective_at", normalizedDate)
                if (actorUserId == null) putNull("created_by") else put("created_by", actorUserId)
                put("created_at", now)
            })

            var updatedProducts = 0
            if (applyAutomatically) {
                val currentRate = getCurrentRateValue(db, fromCurrency, toCurrency) ?: rate
                db.rawQuery(
                    """
                    SELECT id,foreign_cost_minor,foreign_sale_price_minor
                    FROM products
                    WHERE price_currency='USD' AND auto_rate_update=1
                      AND foreign_sale_price_minor IS NOT NULL
                    """.trimIndent(), null
                ).use { cursor ->
                    while (cursor.moveToNext()) {
                        val values = ContentValues().apply {
                            if (!cursor.isNull(1)) {
                                put("cost_minor", toLocalMinor(cursor.getLong(1), currentRate))
                            }
                            put("sale_price_minor", toLocalMinor(cursor.getLong(2), currentRate))
                            put("updated_at", now)
                        }
                        db.update("products", values, "id=?", arrayOf(cursor.getString(0)))
                        updatedProducts++
                    }
                }
            }

            val details = JSONObject()
                .put("fromCurrency", fromCurrency)
                .put("toCurrency", toCurrency)
                .put("rate", rate)
                .put("applyAutomatically", applyAutomatically)
                .put("updatedProducts", updatedProducts)
            db.insertOrThrow("audit_logs", null, ContentValues().apply {
                put("id", UUID.randomUUID().toString())
                if (actorUserId == null) putNull("user_id") else put("user_id", actorUserId)
                put("action", "currency.exchange_rate")
                put("entity_type", "exchange_rate")
                put("entity_id", id)
                put("details", details.toString())
                put("created_at", now)
            })
            db.setTransactionSuccessful()
            return DavinciExchangeRate(id, fromCurrency, toCurrency, rate, normalizedDate, actorUserId) to updatedProducts
        } finally {
            db.endTransaction()
        }
    }

    fun configureProductCurrency(
        productId: String,
        currency: String = "SDG",
        foreignCostMinor: Long? = null,
        foreignSalePriceMinor: Long? = null,
        localCostMinor: Long? = null,
        localSalePriceMinor: Long? = null,
        autoUpdate: Boolean = false
    ): DavinciProductCurrency {
        require(currency == "SDG" || currency == "USD") {
            "Product currency must be SDG or USD."
        }
        listOfNotNull(foreignCostMinor, foreignSalePriceMinor, localCostMinor, localSalePriceMinor)
            .forEach {
                require(it in 0..MAX_SAFE_INTEGER) { "Product prices must be safe non-negative integers." }
            }

        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            db.rawQuery("SELECT 1 FROM products WHERE id=? LIMIT 1", arrayOf(productId)).use { cursor ->
                require(cursor.moveToFirst()) { "Product not found." }
            }
            val now = Instant.now().toString()
            val values = ContentValues().apply {
                put("updated_at", now)
                if (currency == "USD") {
                    val exchangeRate = getCurrentRateValue(db, "USD", "SDG")
                        ?: throw IllegalArgumentException("Set the USD to SDG exchange rate before linking a product to USD prices.")
                    require(foreignSalePriceMinor != null) { "Enter valid USD source prices." }
                    put("price_currency", "USD")
                    if (foreignCostMinor == null) putNull("foreign_cost_minor")
                    else put("foreign_cost_minor", foreignCostMinor)
                    put("foreign_sale_price_minor", foreignSalePriceMinor)
                    put("auto_rate_update", if (autoUpdate) 1 else 0)
                    if (foreignCostMinor != null) put("cost_minor", toLocalMinor(foreignCostMinor, exchangeRate))
                    put("sale_price_minor", toLocalMinor(foreignSalePriceMinor, exchangeRate))
                } else {
                    put("price_currency", "SDG")
                    putNull("foreign_cost_minor")
                    putNull("foreign_sale_price_minor")
                    put("auto_rate_update", 0)
                    if (localCostMinor != null) put("cost_minor", localCostMinor)
                    if (localSalePriceMinor != null) put("sale_price_minor", localSalePriceMinor)
                }
            }
            require(db.update("products", values, "id=?", arrayOf(productId)) == 1) {
                "Product not found."
            }
            val result = db.rawQuery(
                """
                SELECT price_currency,foreign_cost_minor,foreign_sale_price_minor,
                       auto_rate_update,cost_minor,sale_price_minor
                FROM products WHERE id=?
                """.trimIndent(), arrayOf(productId)
            ).use { cursor ->
                check(cursor.moveToFirst())
                DavinciProductCurrency(
                    productId = productId,
                    currency = cursor.getString(0),
                    foreignCostMinor = if (cursor.isNull(1)) null else cursor.getLong(1),
                    foreignSalePriceMinor = if (cursor.isNull(2)) null else cursor.getLong(2),
                    autoUpdate = cursor.getInt(3) == 1,
                    localCostMinor = cursor.getLong(4),
                    localSalePriceMinor = cursor.getLong(5)
                )
            }
            db.setTransactionSuccessful()
            return result
        } finally {
            db.endTransaction()
        }
    }

    private fun toLocalMinor(foreignMinor: Long, rate: Double): Long {
        val converted = foreignMinor.toDouble() * rate
        require(converted.isFinite() && converted <= MAX_SAFE_INTEGER.toDouble()) {
            "Converted product price exceeds the supported safe integer range."
        }
        return converted.roundToLong()
    }

    private fun getCurrentRateValue(db: SQLiteDatabase, from: String, to: String): Double? =
        db.rawQuery(
            """
            SELECT rate FROM exchange_rates
            WHERE from_currency=? AND to_currency=?
            ORDER BY effective_at DESC,created_at DESC,rowid DESC LIMIT 1
            """.trimIndent(), arrayOf(from, to)
        ).use { cursor -> if (cursor.moveToFirst()) cursor.getDouble(0) else null }

    private fun android.database.Cursor.toExchangeRate() = DavinciExchangeRate(
        id = getString(0),
        fromCurrency = getString(1),
        toCurrency = getString(2),
        rate = getDouble(3),
        effectiveAt = getString(4),
        createdBy = if (isNull(5)) null else getString(5)
    )

    companion object {
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    }
}
