package com.basmatservice.davincipos

import android.content.Context

data class DavinciSaleDocument(
    val id: String,
    val receiptNumber: String,
    val customerId: String?,
    val cashierId: String?,
    val status: String,
    val subtotalMinor: Long,
    val taxMinor: Long,
    val totalMinor: Long,
    val currencyCode: String,
    val occurredAt: String
)

data class DavinciPurchaseDocument(
    val id: String,
    val invoiceNumber: String,
    val supplierId: String?,
    val status: String,
    val subtotalMinor: Long,
    val taxMinor: Long,
    val totalMinor: Long,
    val taxTreatment: String,
    val currencyCode: String,
    val occurredAt: String
)

/** Read-only document lists used by invoice history and statements. */
class DavinciDocumentRepository(context: Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)

    fun listSales(limit: Int = 100): List<DavinciSaleDocument> =
        helper.readableDatabase.rawQuery(
            """
            SELECT id,receipt_number,customer_id,cashier_id,status,subtotal_minor,
                   tax_minor,total_minor,currency_code,occurred_at
            FROM sales ORDER BY occurred_at DESC LIMIT ?
            """.trimIndent(), arrayOf(limit.coerceIn(1, 500).toString())
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(
                    DavinciSaleDocument(
                        cursor.getString(0), cursor.getString(1),
                        if (cursor.isNull(2)) null else cursor.getString(2),
                        if (cursor.isNull(3)) null else cursor.getString(3),
                        cursor.getString(4), cursor.getLong(5), cursor.getLong(6),
                        cursor.getLong(7), cursor.getString(8), cursor.getString(9)
                    )
                )
            }
        }

    fun listPurchases(limit: Int = 100): List<DavinciPurchaseDocument> =
        helper.readableDatabase.rawQuery(
            """
            SELECT id,invoice_number,supplier_id,status,subtotal_minor,tax_minor,
                   total_minor,tax_treatment,currency_code,occurred_at
            FROM purchases ORDER BY occurred_at DESC LIMIT ?
            """.trimIndent(), arrayOf(limit.coerceIn(1, 500).toString())
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(
                    DavinciPurchaseDocument(
                        cursor.getString(0), cursor.getString(1),
                        if (cursor.isNull(2)) null else cursor.getString(2),
                        cursor.getString(3), cursor.getLong(4), cursor.getLong(5),
                        cursor.getLong(6), cursor.getString(7), cursor.getString(8),
                        cursor.getString(9)
                    )
                )
            }
        }
}
