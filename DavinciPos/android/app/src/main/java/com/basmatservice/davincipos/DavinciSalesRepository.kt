package com.basmatservice.davincipos

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.time.Instant
import java.util.UUID
import kotlin.math.roundToLong

data class DavinciSaleLineInput(
    val itemId: String,
    val quantity: Double,
    val lineType: String = "product",
    val productUnitId: String? = null,
    val unitName: String? = null
)

data class DavinciSalePayment(
    val method: String,
    val amountMinor: Long,
    val reference: String? = null,
    val provider: String? = null
)

data class DavinciSaleInput(
    val lines: List<DavinciSaleLineInput>,
    val id: String? = null,
    val receiptNumber: String? = null,
    val branchId: String = DavinciCatalogRepository.MAIN_BRANCH_ID,
    val deviceId: String? = null,
    val customerId: String? = null,
    val cashierId: String? = null,
    val currencyCode: String? = null,
    val occurredAt: String? = null,
    val payments: List<DavinciSalePayment> = emptyList(),
    val allowCredit: Boolean = false
)

data class DavinciSaleQuoteLine(
    val itemId: String,
    val quantity: Double,
    val netMinor: Long,
    val taxMinor: Long,
    val totalMinor: Long,
    val taxRateBps: Int,
    val taxPriceMode: String
)

data class DavinciSaleQuote(
    val subtotalMinor: Long,
    val taxMinor: Long,
    val totalMinor: Long,
    val currencyCode: String,
    val lines: List<DavinciSaleQuoteLine>
)

data class DavinciCheckoutResult(
    val id: String,
    val receiptNumber: String,
    val subtotalMinor: Long,
    val taxMinor: Long,
    val totalMinor: Long,
    val costMinor: Long,
    val duplicate: Boolean
)

/**
 * Atomic local sale quote and checkout. The outer SQLite transaction encloses
 * stock-layer consumption, sale lines, payment records and journal posting.
 * It mirrors sales.js and deliberately leaves HTTP/API response routing separate.
 */
class DavinciSalesRepository(context: Context) {
    private val appContext = context.applicationContext
    private val helper = DavinciDatabase.get(appContext)
    private val inventory = DavinciInventoryRepository(appContext)
    private val accounting = DavinciAccountingRepository(appContext)

    fun quoteSale(input: DavinciSaleInput): DavinciSaleQuote {
        val prepared = prepareSale(helper.readableDatabase, input)
        return DavinciSaleQuote(
            subtotalMinor = prepared.subtotal,
            taxMinor = prepared.taxTotal,
            totalMinor = prepared.total,
            currencyCode = prepared.currencyCode,
            lines = prepared.lines.map {
                DavinciSaleQuoteLine(
                    it.itemId, it.quantity, it.netMinor, it.taxMinor, it.totalMinor,
                    it.taxRateBps, it.taxPriceMode
                )
            }
        )
    }

    fun checkoutSale(input: DavinciSaleInput): DavinciCheckoutResult {
        val saleId = input.id?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val existing = db.rawQuery(
                """
                SELECT id,receipt_number,subtotal_minor,tax_minor,total_minor
                FROM sales WHERE id=?
                """.trimIndent(),
                arrayOf(saleId)
            ).use { cursor ->
                if (!cursor.moveToFirst()) null else DavinciCheckoutResult(
                    id = cursor.getString(0),
                    receiptNumber = cursor.getString(1),
                    subtotalMinor = cursor.getLong(2),
                    taxMinor = cursor.getLong(3),
                    totalMinor = cursor.getLong(4),
                    costMinor = db.rawQuery(
                        "SELECT COALESCE(SUM(cost_total_minor),0) FROM sale_lines WHERE sale_id=?",
                        arrayOf(saleId)
                    ).use { cost -> if (cost.moveToFirst()) cost.getLong(0) else 0L },
                    duplicate = true
                )
            }
            if (existing != null) {
                db.setTransactionSuccessful()
                return existing
            }

            val prepared = prepareSale(db, input)
            val now = prepared.occurredAt
            val receipt = input.receiptNumber?.takeIf { it.isNotBlank() }
                ?: "S-${System.currentTimeMillis()}-${saleId.take(6).uppercase()}"
            db.insertOrThrow("sales", null, ContentValues().apply {
                put("id", saleId)
                put("receipt_number", receipt)
                put("branch_id", prepared.branchId)
                putNullable("device_id", input.deviceId)
                putNullable("customer_id", input.customerId)
                putNullable("cashier_id", input.cashierId)
                put("status", "posted")
                put("subtotal_minor", prepared.subtotal)
                put("discount_minor", 0L)
                put("tax_minor", prepared.taxTotal)
                put("total_minor", prepared.total)
                put("currency_code", prepared.currencyCode)
                put("occurred_at", now)
                put("created_at", Instant.now().toString())
                put("tax_enabled", if (prepared.taxEnabled) 1 else 0)
                put("tax_price_mode", prepared.priceMode)
            })

            val journalLines = mutableListOf<DavinciJournalLine>()
            val paidByMethod = linkedMapOf<String, Long>()
            var costTotal = 0L
            prepared.lines.forEach { line ->
                var lineCost = 0L
                var allocations: List<DavinciFifoAllocation> = emptyList()
                if (line.lineType == "service") {
                    line.components.forEach { component ->
                        val issue = inventory.issueStock(
                            productId = component.productId,
                            branchId = prepared.branchId,
                            sourceType = "service_sale",
                            sourceId = saleId,
                            quantity = component.quantity * line.quantity,
                            costMethod = prepared.costMethod,
                            occurredAt = now
                        )
                        lineCost = safeAdd(lineCost, issue.costTotalMinor, "Sale cost")
                    }
                } else if (line.trackStock) {
                    val issue = inventory.issueStock(
                        productId = line.itemId,
                        branchId = prepared.branchId,
                        sourceType = "sale",
                        sourceId = saleId,
                        quantity = line.baseQuantity,
                        costMethod = prepared.costMethod,
                        occurredAt = now
                    )
                    lineCost = issue.costTotalMinor
                    allocations = issue.allocations
                }
                costTotal = safeAdd(costTotal, lineCost, "Sale cost")
                val costQuantity = if (line.baseQuantity > 0.0) line.baseQuantity else line.quantity
                val unitCost = if (costQuantity > 0.0) (lineCost.toDouble() / costQuantity).roundToLong() else 0L
                val saleLineId = UUID.randomUUID().toString()
                db.insertOrThrow("sale_lines", null, ContentValues().apply {
                    put("id", saleLineId)
                    put("sale_id", saleId)
                    put("line_type", line.lineType)
                    put("item_id", line.itemId)
                    put("description", line.description)
                    put("quantity", line.quantity)
                    put("unit_name", line.unitName)
                    put("base_quantity", line.baseQuantity)
                    put("unit_price_minor", line.unitPriceMinor)
                    put("unit_cost_minor", unitCost)
                    put("cost_total_minor", lineCost)
                    put("discount_minor", 0L)
                    put("tax_minor", line.taxMinor)
                    put("line_total_minor", line.totalMinor)
                    put("tax_rate_bps", line.taxRateBps)
                    putNullable("tax_profile_id", line.taxProfileId)
                    put("tax_price_mode", line.taxPriceMode)
                })
                allocations.forEach { allocation ->
                    db.insertOrThrow("sale_line_cost_layers", null, ContentValues().apply {
                        put("id", UUID.randomUUID().toString())
                        put("sale_line_id", saleLineId)
                        put("inventory_layer_id", allocation.layerId)
                        put("quantity", allocation.quantity)
                        put("unit_cost_minor", allocation.unitCostMinor)
                        put("cost_total_minor", allocation.costTotalMinor)
                    })
                }
            }

            prepared.payments.forEach { payment ->
                db.insertOrThrow("payments", null, ContentValues().apply {
                    put("id", UUID.randomUUID().toString())
                    put("sale_id", saleId)
                    put("direction", "in")
                    put("method", payment.method)
                    put("amount_minor", payment.amountMinor)
                    putNullable("reference", payment.reference)
                    putNullable("provider", payment.provider)
                    put("occurred_at", now)
                })
                paidByMethod[payment.method] = safeAdd(
                    paidByMethod[payment.method] ?: 0L, payment.amountMinor, "Payment total"
                )
            }

            paidByMethod.forEach { (method, amount) ->
                journalLines += DavinciJournalLine(paymentAccounts.getValue(method), debitMinor = amount)
            }
            val credit = prepared.total - prepared.paid
            if (credit > 0L) {
                require(input.allowCredit) { "Your role does not permit credit sales." }
                require(!input.customerId.isNullOrBlank()) {
                    "A customer is required for an unpaid or credit sale."
                }
                journalLines += DavinciJournalLine("acc-ar", debitMinor = credit)
            }
            if (prepared.subtotal > 0L) {
                journalLines += DavinciJournalLine("acc-sales", creditMinor = prepared.subtotal)
            }
            if (prepared.taxTotal > 0L) {
                journalLines += DavinciJournalLine("acc-tax", creditMinor = prepared.taxTotal)
            }
            if (costTotal > 0L) {
                journalLines += DavinciJournalLine("acc-cogs", debitMinor = costTotal)
                journalLines += DavinciJournalLine("acc-inventory", creditMinor = costTotal)
            }
            if (journalLines.isNotEmpty()) {
                accounting.postJournalEntry(
                    sourceType = "sale",
                    sourceId = saleId,
                    description = "Sale $receipt",
                    lines = journalLines,
                    occurredAt = now
                )
            }
            db.setTransactionSuccessful()
            return DavinciCheckoutResult(
                saleId, receipt, prepared.subtotal, prepared.taxTotal,
                prepared.total, costTotal, duplicate = false
            )
        } finally {
            db.endTransaction()
        }
    }

    private fun prepareSale(db: SQLiteDatabase, input: DavinciSaleInput): PreparedSale {
        require(input.lines.isNotEmpty()) { "Sale must contain at least one line." }
        val saleId = input.id?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()
        val now = input.occurredAt ?: Instant.now().toString()
        val branchId = input.branchId.ifBlank { DavinciCatalogRepository.MAIN_BRANCH_ID }
        val currencyCode = setting(db, "currency.code", "SDG")
        val priceMode = setting(db, "tax.price_mode", "exclusive")
        val taxEnabled = setting(db, "tax.enabled", "true") in setOf("true", "1")
        val costMethod = setting(db, "inventory.cost_method", "weighted")
        require(input.currencyCode == null || input.currencyCode == currencyCode) {
            "Sale currency does not match the configured base currency."
        }
        require(costMethod in setOf("weighted", "fifo")) { "Invalid inventory cost method." }

        val lines = input.lines.map { line ->
            require(line.lineType in setOf("product", "service")) { "Invalid sale line type." }
            require(line.itemId.isNotBlank() && line.quantity.isFinite() && line.quantity > 0.0) {
                "Line quantity must be greater than zero."
            }
            val item = if (line.lineType == "service") {
                db.rawQuery(
                    """
                    SELECT name,price_minor,tax_rate_bps,tax_exempt,0,'service',1
                    FROM services WHERE id=? AND is_active=1
                    """.trimIndent(), arrayOf(line.itemId)
                ).use { cursor ->
                    if (!cursor.moveToFirst()) null else SaleItem(
                        cursor.getString(0), cursor.getLong(1), cursor.getInt(2),
                        cursor.getInt(3) == 1, false, cursor.getString(5), cursor.getDouble(6)
                    )
                }
            } else {
                db.rawQuery(
                    """
                    SELECT p.name,
                           CASE WHEN pu.id IS NULL THEN p.sale_price_minor
                                ELSE COALESCE(pu.sale_price_minor,ROUND(p.sale_price_minor*pu.base_quantity)) END,
                           p.tax_rate_bps,p.tax_exempt,p.track_stock,
                           u.symbol,COALESCE(pu.base_quantity,1)
                    FROM products p
                    LEFT JOIN product_units pu ON pu.id=? AND pu.product_id=p.id
                    LEFT JOIN units u ON u.id=COALESCE(pu.unit_id,p.base_unit_id)
                    WHERE p.id=? AND p.is_active=1
                    """.trimIndent(), arrayOf(line.productUnitId ?: "", line.itemId)
                ).use { cursor ->
                    if (!cursor.moveToFirst()) null else SaleItem(
                        cursor.getString(0), cursor.getLong(1), cursor.getInt(2),
                        cursor.getInt(3) == 1, cursor.getInt(4) == 1,
                        if (cursor.isNull(5)) null else cursor.getString(5), cursor.getDouble(6)
                    )
                }
            } ?: throw IllegalArgumentException(
                if (line.lineType == "service") "Service not found or inactive."
                else "Product not found or inactive."
            )

            val components = if (line.lineType == "service") {
                db.rawQuery(
                    """
                    SELECT sc.product_id,sc.quantity,p.sale_price_minor
                    FROM service_components sc
                    JOIN products p ON p.id=sc.product_id
                    WHERE sc.service_id=?
                    """.trimIndent(), arrayOf(line.itemId)
                ).use { cursor ->
                    buildList {
                        while (cursor.moveToNext()) add(
                            ServiceComponent(cursor.getString(0), cursor.getDouble(1), cursor.getLong(2))
                        )
                    }
                }
            } else emptyList()
            var componentPrice = 0L
            components.forEach { component ->
                val part = (component.quantity * component.salePriceMinor.toDouble()).roundToLong()
                componentPrice = safeAdd(componentPrice, part, "Service price")
            }
            val unitPrice = safeAdd(item.salePriceMinor, componentPrice, "Product or service price")
            val profile = when {
                item.taxExempt -> TaxProfile(null, 0, priceMode)
                item.taxRateBps > 0 -> TaxProfile(null, item.taxRateBps, priceMode)
                else -> defaultTaxProfile(db, priceMode)
            }
            val tax = DavinciTaxCalculator.calculateLineTax(
                unitPriceMinor = unitPrice,
                quantity = line.quantity,
                rateBps = profile.rateBps,
                priceMode = profile.priceMode,
                enabled = taxEnabled
            )
            val baseQuantity = line.quantity * item.unitMultiplier
            require(baseQuantity.isFinite() && baseQuantity > 0.0) {
                "Invalid converted unit quantity."
            }
            PreparedSaleLine(
                lineType = line.lineType,
                itemId = line.itemId,
                description = item.name,
                quantity = line.quantity,
                baseQuantity = if (line.lineType == "service") 0.0 else baseQuantity,
                unitName = line.unitName?.takeIf { it.isNotBlank() } ?: item.unitSymbol ?: "pc",
                unitPriceMinor = unitPrice,
                trackStock = line.lineType == "product" && item.trackStock,
                taxRateBps = profile.rateBps,
                taxProfileId = profile.id,
                taxPriceMode = profile.priceMode,
                netMinor = tax.netMinor,
                taxMinor = tax.taxMinor,
                totalMinor = tax.totalMinor,
                components = components
            )
        }
        val subtotal = lines.fold(0L) { sum, line -> safeAdd(sum, line.netMinor, "Sale subtotal") }
        val taxTotal = lines.fold(0L) { sum, line -> safeAdd(sum, line.taxMinor, "Sale tax") }
        val total = lines.fold(0L) { sum, line -> safeAdd(sum, line.totalMinor, "Sale total") }
        val paid = input.payments.fold(0L) { sum, payment ->
            require(payment.method in paymentAccounts) { "Invalid payment method or amount." }
            require(payment.amountMinor in 1..MAX_SAFE_INTEGER) { "Invalid payment method or amount." }
            if (payment.provider != null) require(payment.provider in walletProviders) {
                "Unsupported payment provider."
            }
            if (payment.method == "wallet") require(payment.provider in walletProviders) {
                "Select a supported wallet provider."
            }
            safeAdd(sum, payment.amountMinor, "Payment total")
        }
        require(paid <= total) { "Payment amount exceeds sale total or is invalid." }
        return PreparedSale(
            saleId, now, branchId, currencyCode, priceMode, taxEnabled, costMethod,
            lines, subtotal, taxTotal, total, input.payments, paid
        )
    }

    private fun defaultTaxProfile(db: SQLiteDatabase, priceMode: String): TaxProfile {
        val selected = setting(db, "tax.default_profile_id", "").takeIf { it.isNotBlank() }
        val query = if (selected != null) {
            "SELECT id,rate_bps,price_mode FROM tax_profiles WHERE id=? AND is_active=1"
        } else {
            "SELECT id,rate_bps,price_mode FROM tax_profiles WHERE is_default=1 AND is_active=1 ORDER BY name LIMIT 1"
        }
        val args = if (selected != null) arrayOf(selected) else null
        val result = db.rawQuery(query, args).use { cursor ->
            if (!cursor.moveToFirst()) null else TaxProfile(
                cursor.getString(0), cursor.getInt(1), cursor.getString(2)
            )
        }
        if (selected != null && result == null) {
            throw IllegalArgumentException("Default tax profile not found or inactive.")
        }
        return result ?: TaxProfile(null, 0, priceMode)
    }

    private fun setting(db: SQLiteDatabase, key: String, fallback: String): String =
        db.rawQuery("SELECT value FROM app_settings WHERE key=?", arrayOf(key)).use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else fallback
        }

    private fun safeAdd(left: Long, right: Long, label: String): Long {
        require(left >= 0 && right >= 0 && left <= MAX_SAFE_INTEGER - right) {
            "$label exceeds supported safe integer limits."
        }
        return left + right
    }

    private fun ContentValues.putNullable(key: String, value: String?) {
        if (value == null) putNull(key) else put(key, value)
    }

    private data class SaleItem(
        val name: String,
        val salePriceMinor: Long,
        val taxRateBps: Int,
        val taxExempt: Boolean,
        val trackStock: Boolean,
        val unitSymbol: String?,
        val unitMultiplier: Double
    )

    private data class ServiceComponent(
        val productId: String,
        val quantity: Double,
        val salePriceMinor: Long
    )

    private data class TaxProfile(val id: String?, val rateBps: Int, val priceMode: String)

    private data class PreparedSaleLine(
        val lineType: String,
        val itemId: String,
        val description: String,
        val quantity: Double,
        val baseQuantity: Double,
        val unitName: String,
        val unitPriceMinor: Long,
        val trackStock: Boolean,
        val taxRateBps: Int,
        val taxProfileId: String?,
        val taxPriceMode: String,
        val netMinor: Long,
        val taxMinor: Long,
        val totalMinor: Long,
        val components: List<ServiceComponent>
    )

    private data class PreparedSale(
        val saleId: String,
        val occurredAt: String,
        val branchId: String,
        val currencyCode: String,
        val priceMode: String,
        val taxEnabled: Boolean,
        val costMethod: String,
        val lines: List<PreparedSaleLine>,
        val subtotal: Long,
        val taxTotal: Long,
        val total: Long,
        val payments: List<DavinciSalePayment>,
        val paid: Long
    )

    companion object {
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        private val paymentAccounts = mapOf(
            "cash" to "acc-cash",
            "card" to "acc-card",
            "bank" to "acc-bank",
            "wallet" to "acc-wallet",
            "other" to "acc-other-clearing"
        )
        private val walletProviders = setOf("bankak", "ocash", "fawry", "mycashy")
    }
}
