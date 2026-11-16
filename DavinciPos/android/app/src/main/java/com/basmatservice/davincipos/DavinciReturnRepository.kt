package com.basmatservice.davincipos

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import kotlin.math.abs
import kotlin.math.roundToLong

data class DavinciReturnLineOption(
    val sourceLineId: String,
    val productId: String,
    val description: String,
    val quantity: Double,
    val baseQuantity: Double,
    val amountMinor: Long,
    val taxMinor: Long,
    val costMinor: Long,
    val returnedQuantity: Double,
    val remainingQuantity: Double,
    val unitCostMinor: Long = 0L,
    val trackStock: Boolean = true
)

data class DavinciReturnOptions(
    val sourceId: String,
    val reference: String,
    val branchId: String?,
    val partnerId: String?,
    val totalMinor: Long,
    val taxMinor: Long,
    val status: String,
    val occurredAt: String,
    val lines: List<DavinciReturnLineOption>
)

data class DavinciReturnResult(
    val id: String,
    val returnNumber: String,
    val sourceId: String,
    val totalMinor: Long,
    val taxMinor: Long,
    val refundMinor: Long,
    val balanceReductionMinor: Long,
    val inventoryCostMinor: Long,
    val duplicate: Boolean
)

/**
 * Returns are linked credit documents, not standalone stock edits.
 * Quantities, payment refunds, inventory valuation and ledger effects are
 * posted together in one SQLite transaction.
 */
class DavinciReturnRepository(context: Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)
    private val inventory = DavinciInventoryRepository(context.applicationContext)
    private val accounting = DavinciAccountingRepository(context.applicationContext)

    fun getSalesReturnOptions(saleId: String): DavinciReturnOptions {
        val db = helper.readableDatabase
        val sale = db.rawQuery(
            "SELECT id,receipt_number,branch_id,customer_id,total_minor,tax_minor,status,occurred_at FROM sales WHERE id=?",
            arrayOf(saleId)
        ).use { cursor ->
            if (!cursor.moveToFirst()) null else SourceHeader(
                cursor.getString(0), cursor.getString(1),
                if (cursor.isNull(2)) null else cursor.getString(2),
                if (cursor.isNull(3)) null else cursor.getString(3),
                cursor.getLong(4), cursor.getString(6), cursor.getString(7), cursor.getLong(5)
            )
        } ?: throw IllegalArgumentException("Sales invoice not found or not eligible for return.")
        require(sale.status == "posted" || sale.status == "partially_returned") {
            "Sales invoice not found or not eligible for return."
        }
        val lines = db.rawQuery(
            """
            SELECT sl.id,sl.item_id,sl.description,sl.quantity,sl.base_quantity,
                   sl.line_total_minor,sl.tax_minor,sl.cost_total_minor,sl.unit_cost_minor,
                   COALESCE(p.track_stock,0)
            FROM sale_lines sl LEFT JOIN products p ON p.id=sl.item_id
            WHERE sl.sale_id=? AND sl.line_type='product' ORDER BY sl.description
            """.trimIndent(), arrayOf(saleId)
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    val lineId = cursor.getString(0)
                    val returned = returnedQuantity(db, "sales_return_lines", "sale_line_id", lineId)
                    val quantity = cursor.getDouble(3)
                    val remaining = (quantity - returned).coerceAtLeast(0.0)
                    if (remaining > 1e-9) add(
                        DavinciReturnLineOption(
                            lineId, cursor.getString(1), cursor.getString(2), quantity,
                            cursor.getDouble(4), cursor.getLong(5), cursor.getLong(6),
                            cursor.getLong(7), returned, remaining, cursor.getLong(8),
                            cursor.getInt(9) == 1
                        )
                    )
                }
            }
        }
        require(lines.isNotEmpty()) { "This invoice has no remaining returnable product quantities." }
        return DavinciReturnOptions(
            sale.id, sale.reference, sale.branchId, sale.partnerId, sale.totalMinor,
            0L, sale.status, sale.occurredAt, lines
        )
    }

    fun getPurchaseReturnOptions(purchaseId: String): DavinciReturnOptions {
        val db = helper.readableDatabase
        val purchase = db.rawQuery(
            """
            SELECT id,invoice_number,branch_id,supplier_id,total_minor,tax_minor,status,occurred_at
            FROM purchases WHERE id=?
            """.trimIndent(), arrayOf(purchaseId)
        ).use { cursor ->
            if (!cursor.moveToFirst()) null else SourceHeader(
                cursor.getString(0), cursor.getString(1),
                if (cursor.isNull(2)) null else cursor.getString(2),
                if (cursor.isNull(3)) null else cursor.getString(3),
                cursor.getLong(4), cursor.getString(6), cursor.getString(7), cursor.getLong(5)
            )
        } ?: throw IllegalArgumentException("Purchase invoice not found or it has no supplier.")
        require(purchase.status == "posted" && purchase.partnerId != null) {
            "Purchase invoice not found or it has no supplier."
        }
        val lines = db.rawQuery(
            """
            SELECT pl.id,pl.product_id,p.name,pl.quantity,pl.base_quantity,
                   pl.line_total_minor,pl.tax_minor,pl.unit_cost_minor
            FROM purchase_lines pl JOIN products p ON p.id=pl.product_id
            WHERE pl.purchase_id=? ORDER BY p.name
            """.trimIndent(), arrayOf(purchaseId)
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    val lineId = cursor.getString(0)
                    val returned = returnedQuantity(db, "purchase_return_lines", "purchase_line_id", lineId)
                    val quantity = cursor.getDouble(3)
                    val remaining = (quantity - returned).coerceAtLeast(0.0)
                    if (remaining > 1e-9) add(
                        DavinciReturnLineOption(
                            lineId, cursor.getString(1), cursor.getString(2), quantity,
                            cursor.getDouble(4), cursor.getLong(5), cursor.getLong(6),
                            0L, returned, remaining, cursor.getLong(7)
                        )
                    )
                }
            }
        }
        require(lines.isNotEmpty()) { "This invoice has no remaining returnable quantities." }
        return DavinciReturnOptions(
            purchase.id, purchase.reference, purchase.branchId, purchase.partnerId,
            purchase.totalMinor, purchase.taxMinor, purchase.status, purchase.occurredAt, lines
        )
    }

    fun createSalesReturn(
        saleId: String,
        input: JSONObject,
        userId: String?
    ): DavinciReturnResult {
        val id = input.optString("id").takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()
        val now = input.optString("occurredAt").takeIf { it.isNotBlank() } ?: Instant.now().toString()
        val refundMethod = validateRefund(input.optString("refundMethod", "cash"), input.optString("provider").takeIf { it.isNotBlank() })
        val entries = input.optJSONArray("lines") ?: throw IllegalArgumentException("Select at least one item to return.")
        require(entries.length() > 0) { "Select at least one item to return." }
        val reason = input.optString("reason", "Customer return")
        require(reason.length <= 300) { "Return reason must be 300 characters or fewer." }
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val existing = db.rawQuery(
                "SELECT return_number,total_minor,refund_minor FROM sales_returns WHERE id=?", arrayOf(id)
            ).use { cursor -> if (cursor.moveToFirst()) Triple(cursor.getString(0), cursor.getLong(1), cursor.getLong(2)) else null }
            if (existing != null) {
                db.setTransactionSuccessful()
                return DavinciReturnResult(id, existing.first, saleId, existing.second, 0L, existing.third, 0L, 0L, true)
            }
            val sale = sourceHeader(db, "sales", saleId, true)
            val selected = mutableSetOf<String>()
            val details = mutableListOf<ReturnDetail>()
            for (index in 0 until entries.length()) {
                val entry = entries.optJSONObject(index) ?: throw IllegalArgumentException("Invalid sales return line.")
                val lineId = entry.optString("saleLineId")
                require(lineId.isNotBlank() && selected.add(lineId)) { "Invalid or duplicate sales return line." }
                val line = db.rawQuery(
                    """
                    SELECT sl.id,sl.item_id,sl.description,sl.quantity,sl.base_quantity,
                           sl.line_total_minor,sl.tax_minor,sl.cost_total_minor,sl.unit_cost_minor,
                           COALESCE(p.track_stock,0)
                    FROM sale_lines sl LEFT JOIN products p ON p.id=sl.item_id
                    WHERE sl.id=? AND sl.sale_id=? AND sl.line_type='product'
                    """.trimIndent(), arrayOf(lineId, saleId)
                ).use { cursor ->
                    if (!cursor.moveToFirst()) null else ReturnSourceLine(
                        cursor.getString(0), cursor.getString(1), cursor.getString(2),
                        cursor.getDouble(3), cursor.getDouble(4), cursor.getLong(5),
                        cursor.getLong(6), cursor.getLong(7), cursor.getLong(8),
                        cursor.getInt(9) == 1
                    )
                } ?: throw IllegalArgumentException("A selected item does not belong to this invoice or is not returnable.")
                val quantity = entry.optDouble("quantity", Double.NaN)
                require(quantity.isFinite() && quantity > 0.0) { "Return quantity must be greater than zero." }
                val prior = returnedQuantity(db, "sales_return_lines", "sale_line_id", line.id)
                val remaining = line.quantity - prior
                require(quantity <= remaining + 1e-9) {
                    "Return quantity exceeds the unreturned quantity for ${line.description}."
                }
                val priorAmounts = db.rawQuery(
                    "SELECT COALESCE(SUM(amount_minor),0),COALESCE(SUM(tax_minor),0) FROM sales_return_lines WHERE sale_line_id=?",
                    arrayOf(line.id)
                ).use { cursor -> cursor.moveToFirst(); cursor.getLong(0) to cursor.getLong(1) }
                val ratio = quantity / line.quantity
                val finalReturn = quantity >= remaining - 1e-9
                val amount = if (finalReturn) line.amountMinor - priorAmounts.first
                    else (line.amountMinor * ratio).roundToLong()
                val tax = if (finalReturn) line.taxMinor - priorAmounts.second
                    else minOf(amount, (line.taxMinor * ratio).roundToLong())
                details += ReturnDetail(line, quantity, line.baseQuantity * ratio, amount, tax)
            }
            val total = sumSafe(details.map { it.amountMinor }, "Return value")
            val tax = sumSafe(details.map { it.taxMinor }, "Return tax")
            require(total > 0L) { "Return value must be greater than zero." }
            val received = db.rawQuery(
                "SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount_minor ELSE -amount_minor END),0) FROM payments WHERE sale_id=?",
                arrayOf(saleId)
            ).use { cursor -> cursor.moveToFirst(); cursor.getLong(0) }
            val refundAmount = minOf(total, received.coerceAtLeast(0L))
            val returnNumber = input.optString("returnNumber").takeIf { it.isNotBlank() }
                ?: "SR-${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(8).uppercase()}"
            db.insertOrThrow("sales_returns", null, ContentValues().apply {
                put("id", id); put("sale_id", saleId); put("return_number", returnNumber)
                putNullable("branch_id", sale.branchId)
                put("total_minor", total); put("tax_minor", tax); put("refund_minor", refundAmount)
                putNullable("refund_method", if (refundAmount > 0L) refundMethod.first else null)
                putNullable("reference", input.optString("reference").takeIf { it.isNotBlank() })
                put("reason", reason); putNullable("created_by", userId)
                put("occurred_at", now); put("created_at", Instant.now().toString())
            })
            var restoredCost = 0L
            details.forEach { detail ->
                var cost = 0L
                if (detail.line.trackStock && detail.baseQuantity > 0.0) {
                    cost = restoreSaleLineLayers(
                        db, detail.line, detail.baseQuantity, sale.branchId,
                        id + "-" + detail.line.id, now
                    )
                }
                restoredCost = safeAdd(restoredCost, cost, "Restored inventory cost")
                db.insertOrThrow("sales_return_lines", null, ContentValues().apply {
                    put("id", UUID.randomUUID().toString()); put("return_id", id)
                    put("sale_line_id", detail.line.id); put("quantity", detail.quantity)
                    put("base_quantity", detail.baseQuantity); put("amount_minor", detail.amountMinor)
                    put("tax_minor", detail.taxMinor); put("cost_minor", cost)
                })
            }
            if (refundAmount > 0L) db.insertOrThrow("payments", null, ContentValues().apply {
                put("id", UUID.randomUUID().toString()); put("sale_id", saleId)
                put("direction", "out"); put("method", refundMethod.first)
                put("amount_minor", refundAmount); putNullable("reference", input.optString("reference").takeIf { it.isNotBlank() })
                putNullable("provider", refundMethod.second); put("occurred_at", now)
            })
            val receivableReduction = total - refundAmount
            val journal = mutableListOf<DavinciJournalLine>()
            val net = total - tax
            if (net > 0L) journal += DavinciJournalLine("acc-sales-returns", debitMinor = net)
            if (tax > 0L) journal += DavinciJournalLine("acc-tax", debitMinor = tax)
            if (refundAmount > 0L) journal += DavinciJournalLine(paymentAccounts.getValue(refundMethod.first), creditMinor = refundAmount)
            if (receivableReduction > 0L) journal += DavinciJournalLine("acc-ar", creditMinor = receivableReduction)
            if (restoredCost > 0L) {
                journal += DavinciJournalLine("acc-inventory", debitMinor = restoredCost)
                journal += DavinciJournalLine("acc-cogs", creditMinor = restoredCost)
            }
            accounting.postJournalEntry(
                sourceType = "sales_return", sourceId = id,
                description = "Sales return $returnNumber", occurredAt = now, lines = journal
            )
            val remainingLines = db.rawQuery(
                """
                SELECT COUNT(*) FROM sale_lines sl
                WHERE sl.sale_id=? AND sl.line_type='product' AND sl.quantity>(
                  SELECT COALESCE(SUM(srl.quantity),0) FROM sales_return_lines srl WHERE srl.sale_line_id=sl.id
                )+0.000000001
                """.trimIndent(), arrayOf(saleId)
            ).use { cursor -> cursor.moveToFirst(); cursor.getInt(0) }
            db.update("sales", ContentValues().apply {
                put("status", if (remainingLines == 0) "returned" else "partially_returned")
            }, "id=?", arrayOf(saleId))
            audit(db, userId, "sales.return", id, JSONObject()
                .put("saleId", saleId).put("totalMinor", total).put("refundMinor", refundAmount)
                .put("restoredCost", restoredCost).toString())
            db.setTransactionSuccessful()
            return DavinciReturnResult(id, returnNumber, saleId, total, tax, refundAmount, receivableReduction, restoredCost, false)
        } finally {
            db.endTransaction()
        }
    }

    fun createPurchaseReturn(
        purchaseId: String,
        input: JSONObject,
        userId: String?
    ): DavinciReturnResult {
        val id = input.optString("id").takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()
        val now = input.optString("occurredAt").takeIf { it.isNotBlank() } ?: Instant.now().toString()
        val refundMethod = validateRefund(input.optString("refundMethod", "cash"), input.optString("provider").takeIf { it.isNotBlank() })
        val entries = input.optJSONArray("lines") ?: throw IllegalArgumentException("Select at least one item to return.")
        require(entries.length() > 0) { "Select at least one item to return." }
        val reason = input.optString("reason", "Supplier return")
        require(reason.length <= 300) { "Return reason must be 300 characters or fewer." }
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val existing = db.rawQuery(
                "SELECT return_number,total_minor,refund_minor FROM purchase_returns WHERE id=?", arrayOf(id)
            ).use { cursor -> if (cursor.moveToFirst()) Triple(cursor.getString(0), cursor.getLong(1), cursor.getLong(2)) else null }
            if (existing != null) {
                db.setTransactionSuccessful()
                return DavinciReturnResult(id, existing.first, purchaseId, existing.second, 0L, existing.third, 0L, 0L, true)
            }
            val purchase = sourceHeader(db, "purchases", purchaseId, false)
            require(purchase.status == "posted" && purchase.partnerId != null) {
                "Purchase invoice not found or it has no supplier."
            }
            val selected = mutableSetOf<String>()
            val details = mutableListOf<ReturnDetail>()
            for (index in 0 until entries.length()) {
                val entry = entries.optJSONObject(index) ?: throw IllegalArgumentException("Invalid purchase return line.")
                val lineId = entry.optString("purchaseLineId")
                require(lineId.isNotBlank() && selected.add(lineId)) { "Invalid or duplicate purchase return line." }
                val line = db.rawQuery(
                    """
                    SELECT pl.id,pl.product_id,p.name,pl.quantity,pl.base_quantity,
                           pl.line_total_minor,pl.tax_minor,pl.unit_cost_minor
                    FROM purchase_lines pl JOIN products p ON p.id=pl.product_id
                    WHERE pl.id=? AND pl.purchase_id=?
                    """.trimIndent(), arrayOf(lineId, purchaseId)
                ).use { cursor ->
                    if (!cursor.moveToFirst()) null else ReturnSourceLine(
                        cursor.getString(0), cursor.getString(1), cursor.getString(2),
                        cursor.getDouble(3), cursor.getDouble(4), cursor.getLong(5),
                        cursor.getLong(6), 0L, cursor.getLong(7), true
                    )
                } ?: throw IllegalArgumentException("A selected item does not belong to this purchase invoice.")
                val quantity = entry.optDouble("quantity", Double.NaN)
                require(quantity.isFinite() && quantity > 0.0) { "Return quantity must be greater than zero." }
                val prior = returnedQuantity(db, "purchase_return_lines", "purchase_line_id", line.id)
                val remaining = line.quantity - prior
                require(quantity <= remaining + 1e-9) { "Return quantity exceeds the unreturned quantity." }
                val priorAmounts = db.rawQuery(
                    "SELECT COALESCE(SUM(amount_minor-tax_minor),0),COALESCE(SUM(tax_minor),0) FROM purchase_return_lines WHERE purchase_line_id=?",
                    arrayOf(line.id)
                ).use { cursor -> cursor.moveToFirst(); cursor.getLong(0) to cursor.getLong(1) }
                val ratio = quantity / line.quantity
                val finalReturn = quantity >= remaining - 1e-9
                val net = if (finalReturn) line.amountMinor - priorAmounts.first
                    else (line.amountMinor * ratio).roundToLong()
                val tax = if (finalReturn) line.taxMinor - priorAmounts.second
                    else (line.taxMinor * ratio).roundToLong()
                details += ReturnDetail(line, quantity, line.baseQuantity * ratio, safeAdd(net, tax, "Return line total"), tax)
            }
            val total = sumSafe(details.map { it.amountMinor }, "Return value")
            val tax = sumSafe(details.map { it.taxMinor }, "Return tax")
            require(total > 0L) { "Return value must be greater than zero." }
            val paid = db.rawQuery(
                "SELECT COALESCE(SUM(CASE WHEN direction='out' THEN amount_minor ELSE -amount_minor END),0) FROM purchase_payments WHERE purchase_id=?",
                arrayOf(purchaseId)
            ).use { cursor -> cursor.moveToFirst(); cursor.getLong(0) }
            val refundAmount = minOf(total, paid.coerceAtLeast(0L))
            val returnNumber = input.optString("returnNumber").takeIf { it.isNotBlank() }
                ?: "PR-${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(8).uppercase()}"
            db.insertOrThrow("purchase_returns", null, ContentValues().apply {
                put("id", id); put("purchase_id", purchaseId); put("return_number", returnNumber)
                putNullable("branch_id", purchase.branchId); put("total_minor", total)
                put("tax_minor", tax); put("refund_minor", refundAmount)
                putNullable("refund_method", if (refundAmount > 0L) refundMethod.first else null)
                putNullable("reference", input.optString("reference").takeIf { it.isNotBlank() })
                put("reason", reason); putNullable("created_by", userId)
                put("occurred_at", now); put("created_at", Instant.now().toString())
            })
            val costMethod = setting(db, "inventory.cost_method", "weighted")
            var removedCost = 0L
            details.forEach { detail ->
                val issue = inventory.issueStock(
                    productId = detail.line.productId, branchId = purchase.branchId,
                    sourceType = "purchase_return", sourceId = id + "-" + detail.line.id,
                    quantity = detail.baseQuantity, costMethod = costMethod, occurredAt = now
                )
                removedCost = safeAdd(removedCost, issue.costTotalMinor, "Removed inventory cost")
                db.insertOrThrow("purchase_return_lines", null, ContentValues().apply {
                    put("id", UUID.randomUUID().toString()); put("return_id", id)
                    put("purchase_line_id", detail.line.id); put("quantity", detail.quantity)
                    put("base_quantity", detail.baseQuantity); put("amount_minor", detail.amountMinor)
                    put("tax_minor", detail.taxMinor); put("cost_minor", issue.costTotalMinor)
                })
            }
            if (refundAmount > 0L) db.insertOrThrow("purchase_payments", null, ContentValues().apply {
                put("id", UUID.randomUUID().toString()); put("purchase_id", purchaseId)
                put("method", refundMethod.first); put("amount_minor", refundAmount)
                putNullable("reference", input.optString("reference").takeIf { it.isNotBlank() })
                putNullable("provider", refundMethod.second); put("occurred_at", now); put("direction", "in")
            })
            val payableReduction = total - refundAmount
            val journal = mutableListOf<DavinciJournalLine>()
            if (payableReduction > 0L) journal += DavinciJournalLine("acc-ap", debitMinor = payableReduction)
            if (refundAmount > 0L) journal += DavinciJournalLine(paymentAccounts.getValue(refundMethod.first), debitMinor = refundAmount)
            if (removedCost > 0L) journal += DavinciJournalLine("acc-inventory", creditMinor = removedCost)
            if (purchase.taxTreatment == "recoverable" && tax > 0L) {
                journal += DavinciJournalLine("acc-tax-input", creditMinor = tax)
            }
            val debits = safeAdd(payableReduction, refundAmount, "Purchase return debits")
            val credits = safeAdd(removedCost, if (purchase.taxTreatment == "recoverable") tax else 0L, "Purchase return credits")
            if (debits > credits) journal += DavinciJournalLine("acc-purchase-variance", creditMinor = debits - credits)
            if (credits > debits) journal += DavinciJournalLine("acc-purchase-variance", debitMinor = credits - debits)
            accounting.postJournalEntry(
                sourceType = "purchase_return", sourceId = id,
                description = "Purchase return $returnNumber", occurredAt = now, lines = journal
            )
            audit(db, userId, "purchase.return", id, JSONObject()
                .put("purchaseId", purchaseId).put("totalMinor", total)
                .put("refundMinor", refundAmount).put("removedCost", removedCost).toString())
            db.setTransactionSuccessful()
            return DavinciReturnResult(
                id, returnNumber, purchaseId, total, tax, refundAmount,
                payableReduction, removedCost, false
            )
        } finally {
            db.endTransaction()
        }
    }

    private fun restoreSaleLineLayers(
        db: SQLiteDatabase,
        line: ReturnSourceLine,
        quantity: Double,
        branchId: String?,
        sourceId: String,
        occurredAt: String
    ): Long {
        val layers = db.rawQuery(
            """
            SELECT id,inventory_layer_id,quantity,returned_quantity,unit_cost_minor,
                   cost_total_minor,returned_cost_minor
            FROM sale_line_cost_layers WHERE sale_line_id=? AND returned_quantity<quantity
            ORDER BY rowid
            """.trimIndent(), arrayOf(line.id)
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(ReturnLayer(
                    cursor.getString(0), cursor.getString(1), cursor.getDouble(2),
                    cursor.getDouble(3), cursor.getLong(4), cursor.getLong(5), cursor.getLong(6)
                ))
            }
        }
        if (layers.isEmpty()) {
            return inventory.receiveStock(
                line.productId, branchId, "sale_return", sourceId,
                quantity, line.unitCostMinor, occurredAt
            ).costTotalMinor
        }
        var remaining = quantity
        val allocations = mutableListOf<DavinciFifoAllocation>()
        layers.forEach { layer ->
            if (remaining <= 1e-9) return@forEach
            val available = layer.quantity - layer.returnedQuantity
            val take = minOf(remaining, available)
            if (take <= 1e-9) return@forEach
            val remainingCost = layer.costTotalMinor - layer.returnedCostMinor
            val allocationCost = if (take >= available - 1e-9) remainingCost
                else (layer.costTotalMinor * take / layer.quantity).roundToLong()
            val changed = db.update(
                "sale_line_cost_layers",
                ContentValues().apply {
                    put("returned_quantity", layer.returnedQuantity + take)
                    put("returned_cost_minor", layer.returnedCostMinor + allocationCost)
                },
                "id=? AND returned_quantity=?",
                arrayOf(layer.id, layer.returnedQuantity.toString())
            )
            check(changed == 1) { "Sale return FIFO allocation changed concurrently." }
            allocations += DavinciFifoAllocation(
                layer.layerId, take, layer.unitCostMinor, allocationCost
            )
            remaining -= take
        }
        require(remaining <= 1e-7) {
            "FIFO return quantity does not reconcile with the original sale cost layers."
        }
        return inventory.restoreFifoAllocation(
            line.productId, branchId, "sale_return", sourceId, allocations, occurredAt
        ).costTotalMinor
    }

    private fun sourceHeader(
        db: SQLiteDatabase,
        table: String,
        id: String,
        sale: Boolean
    ): SourceHeader {
        val sql = if (sale) {
            "SELECT id,receipt_number,branch_id,customer_id,total_minor,tax_minor,status,occurred_at FROM sales WHERE id=?"
        } else {
            "SELECT id,invoice_number,branch_id,supplier_id,total_minor,status,occurred_at FROM purchases WHERE id=?"
        }
        return db.rawQuery(sql, arrayOf(id)).use { cursor ->
            if (!cursor.moveToFirst()) throw IllegalArgumentException(
                if (sale) "Sales invoice not found or not eligible for return."
                else "Purchase invoice not found or it has no supplier."
            )
            SourceHeader(
                cursor.getString(0), cursor.getString(1),
                if (cursor.isNull(2)) null else cursor.getString(2),
                if (cursor.isNull(3)) null else cursor.getString(3),
                cursor.getLong(4), cursor.getString(5), cursor.getString(6), 0L
            )
        }.also {
            require(if (sale) it.status in setOf("posted", "partially_returned") else it.status == "posted") {
                if (sale) "Sales invoice not found or not eligible for return."
                else "Purchase invoice not found or it has no supplier."
            }
        }
    }

    private fun returnedQuantity(db: SQLiteDatabase, table: String, column: String, lineId: String): Double {
        require(table in setOf("sales_return_lines", "purchase_return_lines") &&
            column in setOf("sale_line_id", "purchase_line_id"))
        return db.rawQuery(
            "SELECT COALESCE(SUM(quantity),0) FROM $table WHERE $column=?",
            arrayOf(lineId)
        ).use { cursor -> cursor.moveToFirst(); cursor.getDouble(0) }
    }

    private fun validateRefund(methodValue: String, providerValue: String?): Pair<String, String?> {
        val method = methodValue.ifBlank { "cash" }
        require(method in paymentAccounts) { "Unsupported refund method." }
        require(providerValue == null || providerValue in walletProviders) { "Unsupported wallet provider." }
        require(method == "wallet" || providerValue == null) {
            "A wallet provider is only valid for wallet refunds."
        }
        require(method != "wallet" || providerValue in walletProviders) {
            "Select a supported wallet provider."
        }
        return method to providerValue
    }

    private fun setting(db: SQLiteDatabase, key: String, fallback: String): String =
        db.rawQuery("SELECT value FROM app_settings WHERE key=?", arrayOf(key)).use {
            if (it.moveToFirst()) it.getString(0) else fallback
        }

    private fun sumSafe(values: List<Long>, label: String): Long =
        values.fold(0L) { total, value -> safeAdd(total, value, label) }

    private fun safeAdd(left: Long, right: Long, label: String): Long {
        require(left >= 0L && right >= 0L && left <= MAX_SAFE_INTEGER - right) {
            "$label exceeds supported safe integer limits."
        }
        return left + right
    }

    private fun audit(db: SQLiteDatabase, userId: String?, action: String, id: String, details: String) {
        db.insertOrThrow("audit_logs", null, ContentValues().apply {
            put("id", UUID.randomUUID().toString()); putNullable("user_id", userId)
            put("action", action); put("entity_type", "return"); put("entity_id", id)
            put("details", details); put("created_at", Instant.now().toString())
        })
    }

    private fun ContentValues.putNullable(key: String, value: String?) {
        if (value == null) putNull(key) else put(key, value)
    }

    private data class SourceHeader(
        val id: String, val reference: String, val branchId: String?, val partnerId: String?,
        val totalMinor: Long, val status: String, val occurredAt: String, val taxMinor: Long
    )
    private data class ReturnSourceLine(
        val id: String, val productId: String, val description: String, val quantity: Double,
        val baseQuantity: Double, val amountMinor: Long, val taxMinor: Long,
        val costMinor: Long, val unitCostMinor: Long, val trackStock: Boolean
    )
    private data class ReturnDetail(
        val line: ReturnSourceLine, val quantity: Double, val baseQuantity: Double,
        val amountMinor: Long, val taxMinor: Long
    )
    private data class ReturnLayer(
        val id: String, val layerId: String, val quantity: Double, val returnedQuantity: Double,
        val unitCostMinor: Long, val costTotalMinor: Long, val returnedCostMinor: Long
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
