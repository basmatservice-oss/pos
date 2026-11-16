package com.basmatservice.davincipos

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.time.Instant
import java.util.UUID
import kotlin.math.roundToLong

data class DavinciPurchaseLineInput(
    val productId: String,
    val quantity: Double,
    val unitCostMinor: Long,
    val discountMinor: Long = 0L,
    val productUnitId: String? = null,
    val unitName: String? = null
)

data class DavinciPurchasePaymentInput(
    val method: String,
    val amountMinor: Long,
    val reference: String? = null,
    val provider: String? = null
)

data class DavinciPurchaseInput(
    val id: String? = null,
    val invoiceNumber: String? = null,
    val supplierId: String? = null,
    val branchId: String = DavinciCatalogRepository.MAIN_BRANCH_ID,
    val currencyCode: String? = null,
    val occurredAt: String? = null,
    val lines: List<DavinciPurchaseLineInput>,
    val payments: List<DavinciPurchasePaymentInput> = emptyList()
)

data class DavinciPurchaseQuoteLine(
    val productId: String,
    val quantity: Double,
    val netMinor: Long,
    val taxMinor: Long,
    val totalMinor: Long,
    val taxRateBps: Int,
    val taxPriceMode: String
)

data class DavinciPurchaseQuote(
    val subtotalMinor: Long,
    val taxMinor: Long,
    val totalMinor: Long,
    val currencyCode: String,
    val taxTreatment: String,
    val lines: List<DavinciPurchaseQuoteLine>
)

data class DavinciPurchaseReceiveResult(
    val id: String,
    val invoiceNumber: String? = null,
    val subtotalMinor: Long? = null,
    val taxMinor: Long? = null,
    val totalMinor: Long? = null,
    val taxTreatment: String? = null,
    val paidMinor: Long? = null,
    val duplicate: Boolean
)

/** Purchase quoting and atomic receipt, inventory valuation and accounting. */
class DavinciPurchaseRepository(context: Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)
    private val inventory = DavinciInventoryRepository(context.applicationContext)
    private val accounting = DavinciAccountingRepository(context.applicationContext)
    private val settings = DavinciSettingsRepository(context.applicationContext)

    fun quotePurchase(input: DavinciPurchaseInput): DavinciPurchaseQuote {
        val prepared = preparePurchase(helper.readableDatabase, input)
        return DavinciPurchaseQuote(
            prepared.subtotal, prepared.taxTotal, prepared.total, prepared.currency,
            prepared.taxTreatment,
            prepared.lines.map {
                DavinciPurchaseQuoteLine(
                    it.productId, it.quantity, it.netMinor, it.taxMinor, it.totalMinor,
                    it.taxRateBps, it.taxPriceMode
                )
            }
        )
    }

    fun receivePurchase(input: DavinciPurchaseInput): DavinciPurchaseReceiveResult {
        val prepared = preparePurchase(helper.readableDatabase, input)
        val id = prepared.id
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val existing = db.rawQuery(
                "SELECT id FROM purchases WHERE id=?", arrayOf(id)
            ).use { it.moveToFirst() }
            if (existing) {
                db.setTransactionSuccessful()
                return DavinciPurchaseReceiveResult(id, duplicate = true)
            }
            val invoice = input.invoiceNumber?.takeIf { it.isNotBlank() }
                ?: "P-${System.currentTimeMillis()}-${id.take(6).uppercase()}"
            val now = prepared.occurredAt
            db.insertOrThrow("purchases", null, ContentValues().apply {
                put("id", id)
                put("invoice_number", invoice)
                putNullable("supplier_id", input.supplierId)
                put("branch_id", prepared.branchId)
                put("status", "posted")
                put("subtotal_minor", prepared.subtotal)
                put("discount_minor", 0L)
                put("total_minor", prepared.total)
                put("currency_code", prepared.currency)
                put("occurred_at", now)
                put("created_at", Instant.now().toString())
                put("tax_minor", prepared.taxTotal)
                put("tax_treatment", prepared.taxTreatment)
                put("tax_price_mode", prepared.defaultMode)
            })

            var inventoryValue = 0L
            prepared.lines.forEach { line ->
                db.insertOrThrow("purchase_lines", null, ContentValues().apply {
                    put("id", UUID.randomUUID().toString())
                    put("purchase_id", id)
                    put("product_id", line.productId)
                    put("quantity", line.quantity)
                    put("unit_name", line.unitName)
                    put("base_quantity", line.baseQuantity)
                    put("unit_cost_minor", line.inventoryUnitCostMinor)
                    put("discount_minor", line.discountMinor)
                    put("line_total_minor", line.netMinor)
                    put("tax_minor", line.taxMinor)
                    put("tax_rate_bps", line.taxRateBps)
                    putNullable("tax_profile_id", line.taxProfileId)
                    put("tax_price_mode", line.taxPriceMode)
                })
                val received = inventory.receiveStock(
                    productId = line.productId,
                    branchId = prepared.branchId,
                    sourceType = "purchase",
                    sourceId = id,
                    quantity = line.baseQuantity,
                    unitCostMinor = line.inventoryUnitCostMinor,
                    occurredAt = now
                )
                inventoryValue = safeAdd(inventoryValue, received.costTotalMinor, "Inventory value")
            }

            prepared.payments.forEach { payment ->
                db.insertOrThrow("purchase_payments", null, ContentValues().apply {
                    put("id", UUID.randomUUID().toString())
                    put("purchase_id", id)
                    put("method", payment.method)
                    put("amount_minor", payment.amountMinor)
                    putNullable("reference", payment.reference)
                    putNullable("provider", payment.provider)
                    put("occurred_at", now)
                    put("direction", "out")
                })
            }

            val journal = mutableListOf<DavinciJournalLine>()
            if (inventoryValue > 0L) journal += DavinciJournalLine(
                "acc-inventory", debitMinor = inventoryValue
            )
            val bookedValue = if (prepared.taxTreatment == "recoverable") {
                prepared.subtotal
            } else prepared.total
            if (inventoryValue > bookedValue) journal += DavinciJournalLine(
                "acc-purchase-variance", creditMinor = inventoryValue - bookedValue
            )
            if (inventoryValue < bookedValue) journal += DavinciJournalLine(
                "acc-purchase-variance", debitMinor = bookedValue - inventoryValue
            )
            val payable = prepared.total - prepared.paid
            if (payable > 0L) journal += DavinciJournalLine("acc-ap", creditMinor = payable)
            val paidByMethod = prepared.payments.groupBy { it.method }
            paidByMethod.forEach { (method, rows) ->
                val amount = rows.fold(0L) { total, row -> safeAdd(total, row.amountMinor, "Payment total") }
                if (amount > 0L) journal += DavinciJournalLine(
                    paymentAccounts.getValue(method), creditMinor = amount
                )
            }
            if (prepared.taxTotal > 0L && prepared.taxTreatment == "recoverable") {
                journal += DavinciJournalLine("acc-tax-input", debitMinor = prepared.taxTotal)
            }
            accounting.postJournalEntry(
                sourceType = "purchase",
                sourceId = id,
                description = "Purchase $invoice",
                occurredAt = now,
                lines = journal
            )
            db.setTransactionSuccessful()
            return DavinciPurchaseReceiveResult(
                id, invoice, prepared.subtotal, prepared.taxTotal, prepared.total,
                prepared.taxTreatment, prepared.paid, duplicate = false
            )
        } finally {
            db.endTransaction()
        }
    }

    private fun preparePurchase(db: SQLiteDatabase, input: DavinciPurchaseInput): PreparedPurchase {
        require(input.lines.isNotEmpty()) { "Purchase must contain at least one line." }
        val id = input.id?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()
        val occurredAt = input.occurredAt?.takeIf { it.isNotBlank() } ?: Instant.now().toString()
        val branchId = input.branchId.ifBlank { DavinciCatalogRepository.MAIN_BRANCH_ID }
        val currency = setting(db, "currency.code", "SDG")
        require(input.currencyCode == null || input.currencyCode == currency) {
            "Purchase currency does not match configured base currency."
        }
        val taxEnabled = setting(db, "tax.enabled", "true") in setOf("true", "1")
        val taxTreatment = if (taxEnabled) setting(db, "tax.purchase_mode", "recoverable") else "disabled"
        require(taxTreatment in setOf("recoverable", "non_recoverable", "disabled")) {
            "Invalid purchase tax treatment."
        }
        val defaultMode = setting(db, "tax.price_mode", "exclusive")
        val defaultProfile = settings.resolveTaxProfile()

        val lines = input.lines.map { line ->
            require(line.quantity.isFinite() && line.quantity > 0.0 &&
                line.unitCostMinor in 0..MAX_SAFE_INTEGER &&
                line.discountMinor in 0..MAX_SAFE_INTEGER) {
                "Invalid purchase line."
            }
            val product = db.rawQuery(
                """
                SELECT p.name,p.tax_rate_bps,p.tax_exempt,p.track_stock,
                       COALESCE(u.symbol,'pc'),COALESCE(pu.base_quantity,1)
                FROM products p
                LEFT JOIN product_units pu ON pu.id=? AND pu.product_id=p.id
                LEFT JOIN units u ON u.id=COALESCE(pu.unit_id,p.base_unit_id)
                WHERE p.id=? AND p.is_active=1
                """.trimIndent(), arrayOf(line.productUnitId ?: "", line.productId)
            ).use { cursor ->
                if (!cursor.moveToFirst()) null else PurchaseProduct(
                    cursor.getString(0), cursor.getInt(1), cursor.getInt(2) == 1,
                    cursor.getInt(3) == 1, cursor.getString(4), cursor.getDouble(5)
                )
            } ?: throw IllegalArgumentException(
                "Purchase line must reference an existing active stock-tracked product."
            )
            require(product.trackStock) {
                "Purchase line must reference an existing active stock-tracked product."
            }
            val baseQuantity = line.quantity * product.unitMultiplier
            require(baseQuantity.isFinite() && baseQuantity > 0.0) { "Invalid converted purchase quantity." }
            val profile = when {
                product.taxExempt -> DavinciResolvedTaxProfile(null, null, 0, defaultMode)
                product.taxRateBps > 0 -> DavinciResolvedTaxProfile(null, null, product.taxRateBps, defaultMode)
                else -> defaultProfile
            }
            val tax = DavinciTaxCalculator.calculateLineTax(
                unitPriceMinor = line.unitCostMinor,
                quantity = line.quantity,
                discountMinor = line.discountMinor,
                rateBps = if (taxTreatment == "disabled") 0 else profile.rateBps,
                priceMode = profile.priceMode,
                enabled = taxEnabled && taxTreatment != "disabled"
            )
            val inventoryCost = if (taxTreatment == "non_recoverable") tax.totalMinor else tax.netMinor
            val inventoryUnitCost = if (baseQuantity > 0.0) {
                (inventoryCost.toDouble() / baseQuantity).roundToLong()
            } else 0L
            require(inventoryUnitCost in 0..MAX_SAFE_INTEGER) {
                "Inventory unit cost exceeds supported safe integer limits."
            }
            PreparedPurchaseLine(
                line.productId, line.quantity, baseQuantity,
                line.unitName?.takeIf { it.isNotBlank() } ?: product.unitSymbol,
                line.unitCostMinor, line.discountMinor, profile.rateBps,
                profile.id, profile.priceMode, tax.netMinor, tax.taxMinor, tax.totalMinor,
                inventoryUnitCost
            )
        }
        val subtotal = lines.fold(0L) { sum, line -> safeAdd(sum, line.netMinor, "Purchase subtotal") }
        val taxTotal = lines.fold(0L) { sum, line -> safeAdd(sum, line.taxMinor, "Purchase tax") }
        val total = lines.fold(0L) { sum, line -> safeAdd(sum, line.totalMinor, "Purchase total") }
        require(total > 0L) { "Purchase total must be greater than zero." }
        val payments = input.payments
        val paid = payments.fold(0L) { sum, payment ->
            require(payment.method in paymentAccounts && payment.amountMinor in 1..MAX_SAFE_INTEGER) {
                "Invalid purchase payment."
            }
            if (payment.provider != null) require(payment.provider in walletProviders) {
                "Unsupported payment provider."
            }
            if (payment.method == "wallet") require(payment.provider in walletProviders) {
                "Select a supported wallet provider."
            }
            safeAdd(sum, payment.amountMinor, "Purchase payment total")
        }
        require(paid <= total) { "Invalid purchase payment total." }
        return PreparedPurchase(
            id, occurredAt, branchId, currency, taxTreatment, defaultMode,
            lines, subtotal, taxTotal, total, payments, paid
        )
    }

    private fun setting(db: SQLiteDatabase, key: String, fallback: String): String =
        db.rawQuery("SELECT value FROM app_settings WHERE key=?", arrayOf(key)).use {
            if (it.moveToFirst()) it.getString(0) else fallback
        }

    private fun safeAdd(left: Long, right: Long, label: String): Long {
        require(left >= 0L && right >= 0L && left <= MAX_SAFE_INTEGER - right) {
            "$label exceeds supported safe integer limits."
        }
        return left + right
    }

    private fun ContentValues.putNullable(key: String, value: String?) {
        if (value == null) putNull(key) else put(key, value)
    }

    private data class PurchaseProduct(
        val name: String,
        val taxRateBps: Int,
        val taxExempt: Boolean,
        val trackStock: Boolean,
        val unitSymbol: String,
        val unitMultiplier: Double
    )

    private data class PreparedPurchaseLine(
        val productId: String,
        val quantity: Double,
        val baseQuantity: Double,
        val unitName: String,
        val unitCostMinor: Long,
        val discountMinor: Long,
        val taxRateBps: Int,
        val taxProfileId: String?,
        val taxPriceMode: String,
        val netMinor: Long,
        val taxMinor: Long,
        val totalMinor: Long,
        val inventoryUnitCostMinor: Long
    )

    private data class PreparedPurchase(
        val id: String,
        val occurredAt: String,
        val branchId: String,
        val currency: String,
        val taxTreatment: String,
        val defaultMode: String,
        val lines: List<PreparedPurchaseLine>,
        val subtotal: Long,
        val taxTotal: Long,
        val total: Long,
        val payments: List<DavinciPurchasePaymentInput>,
        val paid: Long
    )

    companion object {
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        private val paymentAccounts = mapOf(
            "cash" to "acc-cash", "card" to "acc-card", "bank" to "acc-bank",
            "wallet" to "acc-wallet", "other" to "acc-other-clearing"
        )
        private val walletProviders = setOf("bankak", "ocash", "fawry", "mycashy")
    }
}
