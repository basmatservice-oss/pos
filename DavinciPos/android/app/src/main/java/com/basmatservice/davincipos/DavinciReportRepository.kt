package com.basmatservice.davincipos

import android.content.Context
import android.database.Cursor
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

/** Detailed operational, sales, purchasing, tax, cash and stock reporting. */
class DavinciReportRepository(context: Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)

    fun availableReports(): JSONArray = JSONArray(REPORT_TYPES)

    fun simpleReport(fromValue: String?, toValue: String?): JSONObject {
        val from = validDate(fromValue)
        val to = validDate(toValue)
        require(from == null || to == null || from <= to) { "Start date must be before end date." }
        val date = dateFilter("occurred_at", from, to)
        val salesDate = dateFilter("occurred_at", from, to)
        val returnDate = dateFilter("occurred_at", from, to)
        val sales = one(
            "SELECT COUNT(*) count,COALESCE(SUM(total_minor),0) totalMinor,COALESCE(SUM(tax_minor),0) taxMinor FROM sales WHERE status IN ('posted','partially_returned','returned') AND ${salesDate.sql}",
            salesDate.args
        )
        val salesReturns = one(
            "SELECT COALESCE(SUM(total_minor),0) totalMinor,COALESCE(SUM(tax_minor),0) taxMinor FROM sales_returns WHERE ${returnDate.sql}",
            returnDate.args
        )
        val purchases = one(
            "SELECT COUNT(*) count,COALESCE(SUM(total_minor),0) totalMinor FROM purchases WHERE status='posted' AND ${date.sql}",
            date.args
        )
        val purchaseReturns = one(
            "SELECT COALESCE(SUM(total_minor),0) totalMinor FROM purchase_returns WHERE ${returnDate.sql}",
            returnDate.args
        )
        val journal = one(
            """
            SELECT
              COALESCE(SUM(CASE WHEN a.id IN ('acc-sales','acc-sales-returns') THEN jl.credit_minor-jl.debit_minor ELSE 0 END),0) ledgerSalesMinor,
              COALESCE(SUM(CASE WHEN a.id='acc-cogs' THEN jl.debit_minor-jl.credit_minor ELSE 0 END),0) cogsMinor,
              COALESCE(SUM(CASE WHEN a.account_type='expense' AND a.id!='acc-cogs' THEN jl.debit_minor-jl.credit_minor ELSE 0 END),0) expensesTotalMinor,
              COALESCE(SUM(CASE WHEN a.account_type='revenue' AND a.id NOT IN ('acc-sales','acc-sales-returns') THEN jl.credit_minor-jl.debit_minor ELSE 0 END),0) otherIncomeMinor,
              COALESCE(SUM(CASE WHEN a.account_type='revenue' THEN jl.credit_minor-jl.debit_minor
                WHEN a.account_type='expense' THEN jl.credit_minor-jl.debit_minor ELSE 0 END),0) netProfitMinor
            FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id=je.id
            JOIN accounts a ON a.id=jl.account_id
            WHERE je.status IN ('posted','reversed') AND ${dateFilter("je.occurred_at", from, to).sql}
            """.trimIndent(), dateFilter("je.occurred_at", from, to).args
        )
        val salesAlias = dateFilter("s.occurred_at", from, to)
        val returnsAlias = dateFilter("sr.occurred_at", from, to)
        val topProducts = query(
            """
            SELECT itemId,name,SUM(quantity)-SUM(returnQuantity) quantity,
              SUM(netMinor)-SUM(returnNetMinor) totalMinor FROM (
              SELECT sl.item_id itemId,sl.description name,sl.quantity quantity,0 returnQuantity,
                sl.line_total_minor-sl.tax_minor netMinor,0 returnNetMinor
              FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id
              WHERE s.status IN ('posted','partially_returned','returned') AND ${salesAlias.sql}
              UNION ALL
              SELECT sl.item_id itemId,sl.description name,0 quantity,srl.quantity returnQuantity,
                0 netMinor,srl.amount_minor-srl.tax_minor returnNetMinor
              FROM sales_return_lines srl JOIN sales_returns sr ON sr.id=srl.return_id
              JOIN sale_lines sl ON sl.id=srl.sale_line_id WHERE ${returnsAlias.sql}
            ) activity GROUP BY itemId,name ORDER BY totalMinor DESC LIMIT 5
            """.trimIndent(), salesAlias.args + returnsAlias.args
        )
        val lowStock = query(
            """
            SELECT p.id,p.name,COALESCE(SUM(sm.quantity_delta),0) quantity,p.min_stock minStock
            FROM products p LEFT JOIN stock_movements sm ON sm.product_id=p.id
            WHERE p.is_active=1 AND p.track_stock=1 GROUP BY p.id
            HAVING quantity<=p.min_stock ORDER BY quantity ASC,p.name LIMIT 20
            """.trimIndent(), emptyList()
        )
        return JSONObject()
            .put("from", from ?: JSONObject.NULL).put("to", to ?: JSONObject.NULL)
            .put("salesCount", sales.optLong("count"))
            .put("salesTotalMinor", sales.optLong("totalMinor") - salesReturns.optLong("totalMinor"))
            .put("salesTaxMinor", sales.optLong("taxMinor") - salesReturns.optLong("taxMinor"))
            .put("purchasesCount", purchases.optLong("count"))
            .put("purchasesTotalMinor", purchases.optLong("totalMinor") - purchaseReturns.optLong("totalMinor"))
            .put("ledgerSalesMinor", journal.optLong("ledgerSalesMinor"))
            .put("cogsMinor", journal.optLong("cogsMinor"))
            .put("grossProfitMinor", journal.optLong("ledgerSalesMinor") - journal.optLong("cogsMinor"))
            .put("otherIncomeMinor", journal.optLong("otherIncomeMinor"))
            .put("expensesTotalMinor", journal.optLong("expensesTotalMinor"))
            .put("netProfitMinor", journal.optLong("netProfitMinor"))
            .put("topProducts", topProducts).put("lowStock", lowStock)
    }

    fun detailedReport(type: String, fromValue: String?, toValue: String?, branchId: String?): JSONObject {
        val from = validDate(fromValue)
        val to = validDate(toValue)
        require(from == null || to == null || from <= to) { "Start date must be before end date." }
        require(type in REPORT_TYPES) { "Unknown report type." }
        val rows = when (type) {
            "sales-returns" -> singleDateQuery(
                """
                SELECT sr.return_number returnNumber,s.receipt_number sourceReference,sr.occurred_at occurredAt,
                  COALESCE(c.name,'عميل نقدي') party,sr.total_minor totalMinor,sr.tax_minor taxMinor,
                  sr.refund_minor refundMinor,sr.reason
                FROM sales_returns sr JOIN sales s ON s.id=sr.sale_id LEFT JOIN customers c ON c.id=s.customer_id
                WHERE {{where}} ORDER BY sr.occurred_at DESC
                """.trimIndent(), "sr.occurred_at", from, to
            )
            "purchase-returns" -> singleDateQuery(
                """
                SELECT pr.return_number returnNumber,p.invoice_number sourceReference,pr.occurred_at occurredAt,
                  COALESCE(s.name,'بدون مورد') party,pr.total_minor totalMinor,pr.tax_minor taxMinor,
                  pr.refund_minor refundMinor,pr.reason
                FROM purchase_returns pr JOIN purchases p ON p.id=pr.purchase_id
                LEFT JOIN suppliers s ON s.id=p.supplier_id
                WHERE {{where}} ORDER BY pr.occurred_at DESC
                """.trimIndent(), "pr.occurred_at", from, to
            )
            "expenses" -> singleDateQuery(
                """
                SELECT e.category,e.occurred_at occurredAt,e.amount_minor amountMinor,
                  e.payment_method paymentMethod,e.provider,e.reference,e.note,u.display_name createdBy
                FROM expenses e LEFT JOIN users u ON u.id=e.created_by
                WHERE {{where}} ORDER BY e.occurred_at DESC
                """.trimIndent(), "e.occurred_at", from, to
            )
            "sales-daily" -> {
                val a = dateFilter("s.occurred_at", from, to)
                val b = dateFilter("sr.occurred_at", from, to)
                query(
                    """
                    SELECT day,SUM(invoices) invoices,SUM(returns) returns,SUM(totalMinor) totalMinor,SUM(taxMinor) taxMinor
                    FROM (
                      SELECT date(s.occurred_at) day,COUNT(*) invoices,0 returns,SUM(s.total_minor) totalMinor,SUM(s.tax_minor) taxMinor
                      FROM sales s WHERE s.status IN ('posted','partially_returned','returned') AND ${a.sql} GROUP BY date(s.occurred_at)
                      UNION ALL
                      SELECT date(sr.occurred_at) day,0 invoices,COUNT(*) returns,-SUM(sr.total_minor) totalMinor,-SUM(sr.tax_minor) taxMinor
                      FROM sales_returns sr WHERE ${b.sql} GROUP BY date(sr.occurred_at)
                    ) daily GROUP BY day ORDER BY day DESC
                    """.trimIndent(), a.args + b.args
                )
            }
            "sales-invoices" -> singleDateQuery(
                """
                SELECT s.receipt_number reference,s.occurred_at occurredAt,COALESCE(c.name,'عميل نقدي') party,
                  s.status,s.subtotal_minor subtotalMinor,s.tax_minor taxMinor,s.total_minor totalMinor,
                  COALESCE((SELECT SUM(CASE WHEN p.direction='in' THEN p.amount_minor ELSE -p.amount_minor END) FROM payments p WHERE p.sale_id=s.id),0) paidMinor,
                  COALESCE((SELECT SUM(sr.total_minor) FROM sales_returns sr WHERE sr.sale_id=s.id),0) returnedMinor,
                  s.total_minor-COALESCE((SELECT SUM(sr.total_minor) FROM sales_returns sr WHERE sr.sale_id=s.id),0)
                  -COALESCE((SELECT SUM(CASE WHEN p.direction='in' THEN p.amount_minor ELSE -p.amount_minor END) FROM payments p WHERE p.sale_id=s.id),0) dueMinor
                FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.status!='void' AND {{where}} ORDER BY s.occurred_at DESC
                """.trimIndent(), "s.occurred_at", from, to
            )
            "sales-products" -> query(
                """
                SELECT itemId,name,SUM(quantity) quantity,SUM(netSalesMinor) netSalesMinor,SUM(taxMinor) taxMinor,
                  SUM(costMinor) costMinor,SUM(profitMinor) profitMinor FROM (
                  SELECT sl.item_id itemId,sl.description name,sl.quantity quantity,sl.line_total_minor-sl.tax_minor netSalesMinor,
                    sl.tax_minor taxMinor,sl.cost_total_minor costMinor,sl.line_total_minor-sl.tax_minor-sl.cost_total_minor profitMinor
                  FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id WHERE s.status!='void' AND {{sales}}
                  UNION ALL
                  SELECT sl.item_id itemId,sl.description name,-srl.quantity quantity,-(srl.amount_minor-srl.tax_minor) netSalesMinor,
                    -srl.tax_minor taxMinor,-srl.cost_minor costMinor,-(srl.amount_minor-srl.tax_minor-srl.cost_minor) profitMinor
                  FROM sales_return_lines srl JOIN sales_returns sr ON sr.id=srl.return_id
                  JOIN sale_lines sl ON sl.id=srl.sale_line_id WHERE {{returns}}
                ) activity GROUP BY itemId,name ORDER BY netSalesMinor DESC
                """.trimIndent(), from, to, "s.occurred_at", "sr.occurred_at"
            )
            "sales-categories" -> query(
                """
                SELECT category,SUM(quantity) quantity,SUM(netSalesMinor) netSalesMinor,SUM(taxMinor) taxMinor FROM (
                  SELECT COALESCE(c.name,'بدون تصنيف') category,sl.quantity quantity,sl.line_total_minor-sl.tax_minor netSalesMinor,sl.tax_minor taxMinor
                  FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id
                  LEFT JOIN products p ON sl.line_type='product' AND p.id=sl.item_id LEFT JOIN categories c ON c.id=p.category_id
                  WHERE s.status!='void' AND {{sales}}
                  UNION ALL
                  SELECT COALESCE(c.name,'بدون تصنيف') category,-srl.quantity quantity,-(srl.amount_minor-srl.tax_minor) netSalesMinor,-srl.tax_minor taxMinor
                  FROM sales_return_lines srl JOIN sales_returns sr ON sr.id=srl.return_id JOIN sale_lines sl ON sl.id=srl.sale_line_id
                  LEFT JOIN products p ON sl.line_type='product' AND p.id=sl.item_id LEFT JOIN categories c ON c.id=p.category_id
                  WHERE {{returns}}
                ) activity GROUP BY category ORDER BY netSalesMinor DESC
                """.trimIndent(), from, to, "s.occurred_at", "sr.occurred_at"
            )
            "sales-customers" -> singleDateQuery(
                """
                SELECT COALESCE(c.name,'عميل نقدي') customer,COUNT(DISTINCT s.id) invoices,
                  SUM(s.total_minor-COALESCE((SELECT SUM(sr.total_minor) FROM sales_returns sr WHERE sr.sale_id=s.id),0)) totalMinor,
                  SUM(s.total_minor-COALESCE((SELECT SUM(sr.total_minor) FROM sales_returns sr WHERE sr.sale_id=s.id),0)
                  -COALESCE((SELECT SUM(CASE WHEN p.direction='in' THEN p.amount_minor ELSE -p.amount_minor END) FROM payments p WHERE p.sale_id=s.id),0)) dueMinor
                FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.status!='void' AND {{where}}
                GROUP BY c.id,c.name ORDER BY totalMinor DESC
                """.trimIndent(), "s.occurred_at", from, to
            )
            "sales-payments" -> singleDateQuery(
                """
                SELECT p.method,p.provider,p.direction,COUNT(*) operations,SUM(p.amount_minor) totalMinor
                FROM payments p JOIN sales s ON s.id=p.sale_id WHERE s.status!='void' AND {{where}}
                GROUP BY p.method,p.provider,p.direction ORDER BY totalMinor DESC
                """.trimIndent(), "p.occurred_at", from, to
            )
            "purchase-invoices" -> singleDateQuery(
                """
                SELECT p.invoice_number reference,p.occurred_at occurredAt,COALESCE(s.name,'بدون مورد') party,
                  p.status,p.subtotal_minor subtotalMinor,p.tax_minor taxMinor,p.total_minor totalMinor,
                  COALESCE((SELECT SUM(CASE WHEN pp.direction='out' THEN pp.amount_minor ELSE -pp.amount_minor END) FROM purchase_payments pp WHERE pp.purchase_id=p.id),0) paidMinor,
                  COALESCE((SELECT SUM(pr.total_minor) FROM purchase_returns pr WHERE pr.purchase_id=p.id),0) returnedMinor,
                  p.total_minor-COALESCE((SELECT SUM(pr.total_minor) FROM purchase_returns pr WHERE pr.purchase_id=p.id),0)
                  -COALESCE((SELECT SUM(CASE WHEN pp.direction='out' THEN pp.amount_minor ELSE -pp.amount_minor END) FROM purchase_payments pp WHERE pp.purchase_id=p.id),0) dueMinor
                FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.status!='void' AND {{where}} ORDER BY p.occurred_at DESC
                """.trimIndent(), "p.occurred_at", from, to
            )
            "purchase-products" -> query(
                """
                SELECT productId,name,SUM(quantity) quantity,SUM(netCostMinor) netCostMinor,SUM(taxMinor) taxMinor FROM (
                  SELECT pr.id productId,pr.name,pl.quantity quantity,pl.line_total_minor netCostMinor,pl.tax_minor taxMinor
                  FROM purchase_lines pl JOIN purchases pu ON pu.id=pl.purchase_id JOIN products pr ON pr.id=pl.product_id
                  WHERE pu.status!='void' AND {{sales}}
                  UNION ALL
                  SELECT pr.id productId,pr.name,-prl.quantity quantity,-(prl.amount_minor-prl.tax_minor) netCostMinor,-prl.tax_minor taxMinor
                  FROM purchase_return_lines prl JOIN purchase_returns rr ON rr.id=prl.return_id
                  JOIN purchase_lines pl ON pl.id=prl.purchase_line_id JOIN products pr ON pr.id=pl.product_id
                  WHERE {{returns}}
                ) activity GROUP BY productId,name ORDER BY netCostMinor DESC
                """.trimIndent(), from, to, "pu.occurred_at", "rr.occurred_at"
            )
            "purchase-categories" -> query(
                """
                SELECT category,SUM(quantity) quantity,SUM(netCostMinor) netCostMinor,SUM(taxMinor) taxMinor FROM (
                  SELECT COALESCE(c.name,'بدون تصنيف') category,pl.quantity quantity,pl.line_total_minor netCostMinor,pl.tax_minor taxMinor
                  FROM purchase_lines pl JOIN purchases pu ON pu.id=pl.purchase_id JOIN products pr ON pr.id=pl.product_id
                  LEFT JOIN categories c ON c.id=pr.category_id WHERE pu.status!='void' AND {{sales}}
                  UNION ALL
                  SELECT COALESCE(c.name,'بدون تصنيف') category,-prl.quantity quantity,-(prl.amount_minor-prl.tax_minor) netCostMinor,-prl.tax_minor taxMinor
                  FROM purchase_return_lines prl JOIN purchase_returns rr ON rr.id=prl.return_id
                  JOIN purchase_lines pl ON pl.id=prl.purchase_line_id JOIN products pr ON pr.id=pl.product_id
                  LEFT JOIN categories c ON c.id=pr.category_id WHERE {{returns}}
                ) activity GROUP BY category ORDER BY netCostMinor DESC
                """.trimIndent(), from, to, "pu.occurred_at", "rr.occurred_at"
            )
            "purchase-payments" -> singleDateQuery(
                """
                SELECT pp.method,pp.provider,pp.direction,COUNT(*) operations,SUM(pp.amount_minor) totalMinor
                FROM purchase_payments pp JOIN purchases pu ON pu.id=pp.purchase_id
                WHERE pu.status!='void' AND {{where}} GROUP BY pp.method,pp.provider,pp.direction ORDER BY totalMinor DESC
                """.trimIndent(), "pp.occurred_at", from, to
            )
            "stock-on-hand" -> query(
                """
                SELECT p.id productId,p.name,p.sku,p.barcode,u.symbol unit,
                  COALESCE(SUM(sm.quantity_delta),0) quantity,p.min_stock minStock,
                  COALESCE(SUM(CASE WHEN sm.quantity_delta>0 THEN sm.cost_total_minor ELSE -sm.cost_total_minor END),0) stockValueMinor
                FROM products p LEFT JOIN stock_movements sm ON sm.product_id=p.id AND sm.branch_id IS ?
                LEFT JOIN units u ON u.id=p.base_unit_id WHERE p.is_active=1 AND p.track_stock=1
                GROUP BY p.id ORDER BY p.name
                """.trimIndent(), listOf(branchId)
            )
            "stock-movements" -> singleDateQuery(
                """
                SELECT sm.occurred_at occurredAt,p.name product,sm.source_type source,sm.source_id reference,
                  sm.quantity_delta quantityDelta,sm.unit_cost_minor unitCostMinor,sm.cost_total_minor costTotalMinor
                FROM stock_movements sm JOIN products p ON p.id=sm.product_id WHERE {{where}} ORDER BY sm.occurred_at DESC
                """.trimIndent(), "sm.occurred_at", from, to
            )
            "tax-summary" -> taxSummary(from, to)
            "cash-movements" -> cashMovements(from, to)
            else -> throw IllegalArgumentException("Unknown report type.")
        }
        var total = 0L
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            val value = when {
                row.has("totalMinor") -> row.optLong("totalMinor")
                row.has("netSalesMinor") -> row.optLong("netSalesMinor")
                row.has("netCostMinor") -> row.optLong("netCostMinor")
                row.has("amountMinor") -> row.optLong("amountMinor")
                row.has("netTaxMinor") -> row.optLong("netTaxMinor")
                row.has("collectedTaxMinor") -> row.optLong("collectedTaxMinor")
                else -> 0L
            }
            if (value > 0 && total <= MAX_SAFE - value) total += value
            else if (value < 0 && total >= -MAX_SAFE - value) total += value
        }
        return JSONObject().put("type", type).put("from", from ?: JSONObject.NULL)
            .put("to", to ?: JSONObject.NULL).put("count", rows.length())
            .put("totalMinor", total).put("rows", rows)
    }

    private fun taxSummary(from: String?, to: String?): JSONArray {
        val sales = dateFilter("s.occurred_at", from, to)
        val salesReturns = dateFilter("sr.occurred_at", from, to)
        val purchases = dateFilter("p.occurred_at", from, to)
        val purchaseReturns = dateFilter("pr.occurred_at", from, to)
        return query(
            """
            SELECT currency,SUM(outputTaxMinor) collectedTaxMinor,SUM(inputTaxMinor) inputTaxMinor,
              SUM(outputTaxMinor)-SUM(inputTaxMinor) netTaxMinor,SUM(invoices) invoices,SUM(returns) returns,
              SUM(purchaseInvoices) purchaseInvoices,SUM(purchaseReturns) purchaseReturns FROM (
              SELECT s.currency_code currency,SUM(s.tax_minor) outputTaxMinor,0 inputTaxMinor,COUNT(*) invoices,0 returns,0 purchaseInvoices,0 purchaseReturns
              FROM sales s WHERE s.status!='void' AND ${sales.sql} GROUP BY s.currency_code
              UNION ALL
              SELECT s.currency_code currency,-SUM(sr.tax_minor) outputTaxMinor,0 inputTaxMinor,0 invoices,COUNT(*) returns,0 purchaseInvoices,0 purchaseReturns
              FROM sales_returns sr JOIN sales s ON s.id=sr.sale_id WHERE ${salesReturns.sql} GROUP BY s.currency_code
              UNION ALL
              SELECT p.currency_code currency,0 outputTaxMinor,SUM(CASE WHEN p.tax_treatment='recoverable' THEN p.tax_minor ELSE 0 END) inputTaxMinor,
                0 invoices,0 returns,COUNT(*) purchaseInvoices,0 purchaseReturns
              FROM purchases p WHERE p.status!='void' AND ${purchases.sql} GROUP BY p.currency_code
              UNION ALL
              SELECT p.currency_code currency,0 outputTaxMinor,-SUM(CASE WHEN p.tax_treatment='recoverable' THEN pr.tax_minor ELSE 0 END) inputTaxMinor,
                0 invoices,0 returns,0 purchaseInvoices,COUNT(*) purchaseReturns
              FROM purchase_returns pr JOIN purchases p ON p.id=pr.purchase_id WHERE ${purchaseReturns.sql} GROUP BY p.currency_code
            ) taxActivity GROUP BY currency
            """.trimIndent(), sales.args + salesReturns.args + purchases.args + purchaseReturns.args
        )
    }

    private fun cashMovements(from: String?, to: String?): JSONArray {
        val clauses = mutableListOf<String>()
        val args = mutableListOf<Any?>()
        if (from != null) { clauses += "x.occurredAt>=?"; args += boundary(from) }
        if (to != null) { clauses += "x.occurredAt<?"; args += boundary(LocalDate.parse(to).plusDays(1).toString()) }
        return query(
            """
            SELECT occurredAt,source,reference,method,provider,direction,amountMinor FROM (
              SELECT p.occurred_at occurredAt,CASE WHEN p.direction='out' THEN 'مرتجع بيع' ELSE 'بيع' END source,
                s.receipt_number reference,p.method,p.provider,p.direction,p.amount_minor amountMinor
              FROM payments p JOIN sales s ON s.id=p.sale_id WHERE s.status!='void'
              UNION ALL
              SELECT pp.occurred_at occurredAt,CASE WHEN pp.direction='in' THEN 'مرتجع شراء' ELSE 'شراء' END source,
                pu.invoice_number reference,pp.method,pp.provider,CASE WHEN pp.direction='in' THEN 'in' ELSE 'out' END direction,
                pp.amount_minor amountMinor FROM purchase_payments pp JOIN purchases pu ON pu.id=pp.purchase_id WHERE pu.status!='void'
              UNION ALL
              SELECT e.occurred_at occurredAt,'مصروف' source,e.category reference,e.payment_method method,e.provider,
                'out' direction,e.amount_minor amountMinor FROM expenses e
            ) x ${if (clauses.isEmpty()) "" else "WHERE " + clauses.joinToString(" AND ")}
            ORDER BY occurredAt DESC
            """.trimIndent(), args
        )
    }

    private fun query(sql: String, args: List<Any?>): JSONArray {
        val values = args.map { it?.toString() }.toTypedArray()
        return helper.readableDatabase.rawQuery(sql, values).use { cursor -> cursorToJson(cursor) }
    }

    private fun one(sql: String, args: List<String>): JSONObject {
        val rows = query(sql, args)
        return rows.optJSONObject(0) ?: JSONObject()
    }

    private fun singleDateQuery(template: String, column: String, from: String?, to: String?): JSONArray {
        val filter = dateFilter(column, from, to)
        return query(template.replace("{{where}}", filter.sql), filter.args)
    }

    private fun query(
        template: String,
        from: String?,
        to: String?,
        firstAlias: String,
        secondAlias: String
    ): JSONArray {
        val first = dateFilter(firstAlias, from, to)
        val second = dateFilter(secondAlias, from, to)
        return query(
            template.replace("{{sales}}", first.sql).replace("{{returns}}", second.sql),
            first.args + second.args
        )
    }

    private fun cursorToJson(cursor: Cursor): JSONArray {
        val rows = JSONArray()
        while (cursor.moveToNext()) {
            val row = JSONObject()
            for (index in 0 until cursor.columnCount) {
                val name = cursor.getColumnName(index)
                when (cursor.getType(index)) {
                    Cursor.FIELD_TYPE_NULL -> row.put(name, JSONObject.NULL)
                    Cursor.FIELD_TYPE_INTEGER -> row.put(name, cursor.getLong(index))
                    Cursor.FIELD_TYPE_FLOAT -> row.put(name, cursor.getDouble(index))
                    Cursor.FIELD_TYPE_STRING -> row.put(name, cursor.getString(index))
                    else -> row.put(name, JSONObject.NULL)
                }
            }
            rows.put(row)
        }
        return rows
    }

    private fun dateFilter(column: String, from: String?, to: String?): DateFilter {
        val clauses = mutableListOf<String>()
        val args = mutableListOf<String>()
        if (from != null) { clauses += "$column>=?"; args += boundary(from) }
        if (to != null) { clauses += "$column<?"; args += boundary(LocalDate.parse(to).plusDays(1).toString()) }
        return DateFilter(if (clauses.isEmpty()) "1=1" else clauses.joinToString(" AND "), args)
    }

    private fun boundary(value: String): String = value + "T00:00:00"
    private fun validDate(value: String?): String? {
        if (value.isNullOrBlank()) return null
        require(Regex("\\d{4}-\\d{2}-\\d{2}").matches(value)) { "Invalid report date." }
        val parsed = try { LocalDate.parse(value) } catch (_: Exception) {
            throw IllegalArgumentException("Invalid report date.")
        }
        require(parsed.toString() == value) { "Invalid report date." }
        return value
    }

    private data class DateFilter(val sql: String, val args: List<String>)

    companion object {
        private const val MAX_SAFE = 9_007_199_254_740_991L
        private val REPORT_TYPES = listOf(
            "sales-returns", "purchase-returns", "expenses", "sales-daily", "sales-invoices",
            "sales-products", "sales-categories", "sales-customers", "sales-payments",
            "purchase-invoices", "purchase-products", "purchase-categories", "purchase-payments",
            "stock-on-hand", "stock-movements", "tax-summary", "cash-movements"
        )
    }
}
