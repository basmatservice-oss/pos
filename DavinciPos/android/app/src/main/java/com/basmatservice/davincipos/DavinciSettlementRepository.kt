package com.basmatservice.davincipos

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

data class DavinciPartyBalance(
    val id: String,
    val name: String,
    val phone: String?,
    val balanceMinor: Long
)

data class DavinciStatementInvoice(
    val id: String,
    val reference: String,
    val occurredAt: String,
    val totalMinor: Long,
    val paidMinor: Long,
    val returnedMinor: Long,
    val dueMinor: Long
)

data class DavinciPartyStatement(
    val party: DavinciStatementParty,
    val balanceMinor: Long,
    val invoices: List<DavinciStatementInvoice>
)

data class DavinciStatementParty(
    val id: String,
    val name: String,
    val phone: String?
)

data class DavinciRecordedPayment(
    val id: String,
    val entityId: String,
    val amountMinor: Long,
    val remainingMinor: Long
)

data class DavinciPaymentInput(
    val amountMinor: Long,
    val method: String = "cash",
    val provider: String? = null,
    val reference: String? = null,
    val occurredAt: String? = null,
    val idempotencyKey: String? = null
)

/**
 * Customer collections and supplier payments, including balance statements,
 * accounting entries, audit history and idempotent request replay.
 */
class DavinciSettlementRepository(context: Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)
    private val accounting = DavinciAccountingRepository(context.applicationContext)

    fun recordCustomerPayment(
        saleId: String,
        input: DavinciPaymentInput,
        actorUserId: String? = null
    ): DavinciRecordedPayment {
        val payment = normalizePayment(input)
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            replay(db, "customer_collection", saleId, payment)?.let {
                db.setTransactionSuccessful()
                return it
            }
            val sale = db.rawQuery(
                "SELECT receipt_number,customer_id,total_minor,status FROM sales WHERE id=?",
                arrayOf(saleId)
            ).use { cursor ->
                if (!cursor.moveToFirst()) null else SaleBalance(
                    cursor.getString(0), cursor.nullableString(1), cursor.getLong(2), cursor.getString(3)
                )
            } ?: throw IllegalArgumentException("Customer invoice not found or not eligible for collection.")
            require(!sale.customerId.isNullOrBlank() && sale.status in setOf("posted", "partially_returned")) {
                "Customer invoice not found or not eligible for collection."
            }
            val paid = scalarLong(
                db,
                "SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount_minor ELSE -amount_minor END),0) FROM payments WHERE sale_id=?",
                arrayOf(saleId)
            )
            val returned = scalarLong(
                db, "SELECT COALESCE(SUM(total_minor),0) FROM sales_returns WHERE sale_id=?",
                arrayOf(saleId)
            )
            val due = sale.totalMinor - returned - paid
            require(payment.amountMinor <= due) { "Payment exceeds the remaining invoice balance." }
            val id = UUID.randomUUID().toString()
            db.insertOrThrow("payments", null, ContentValues().apply {
                put("id", id)
                put("sale_id", saleId)
                put("direction", "in")
                put("method", payment.method)
                put("amount_minor", payment.amountMinor)
                putNullable("reference", payment.reference)
                putNullable("provider", payment.provider)
                put("occurred_at", payment.occurredAt)
            })
            accounting.postJournalEntry(
                sourceType = "sale_collection",
                sourceId = id,
                description = "Customer payment for ${sale.reference}",
                occurredAt = payment.occurredAt,
                lines = listOf(
                    DavinciJournalLine(paymentAccounts.getValue(payment.method), debitMinor = payment.amountMinor),
                    DavinciJournalLine("acc-ar", creditMinor = payment.amountMinor)
                )
            )
            auditPayment(db, actorUserId, "customer.payment", id, saleId, payment)
            val response = DavinciRecordedPayment(id, saleId, payment.amountMinor, due - payment.amountMinor)
            saveReplay(db, payment, "customer_collection", saleId, response)
            db.setTransactionSuccessful()
            return response
        } finally {
            db.endTransaction()
        }
    }

    fun recordSupplierPayment(
        purchaseId: String,
        input: DavinciPaymentInput,
        actorUserId: String? = null
    ): DavinciRecordedPayment {
        val payment = normalizePayment(input)
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            replay(db, "supplier_payment", purchaseId, payment)?.let {
                db.setTransactionSuccessful()
                return it
            }
            val purchase = db.rawQuery(
                "SELECT invoice_number,supplier_id,total_minor,status FROM purchases WHERE id=?",
                arrayOf(purchaseId)
            ).use { cursor ->
                if (!cursor.moveToFirst()) null else PurchaseBalance(
                    cursor.getString(0), cursor.nullableString(1), cursor.getLong(2), cursor.getString(3)
                )
            } ?: throw IllegalArgumentException("Supplier invoice not found or not eligible for payment.")
            require(!purchase.supplierId.isNullOrBlank() && purchase.status == "posted") {
                "Supplier invoice not found or not eligible for payment."
            }
            val paid = scalarLong(
                db,
                "SELECT COALESCE(SUM(CASE WHEN direction='out' THEN amount_minor ELSE -amount_minor END),0) FROM purchase_payments WHERE purchase_id=?",
                arrayOf(purchaseId)
            )
            val returned = scalarLong(
                db, "SELECT COALESCE(SUM(total_minor),0) FROM purchase_returns WHERE purchase_id=?",
                arrayOf(purchaseId)
            )
            val due = purchase.totalMinor - returned - paid
            require(payment.amountMinor <= due) { "Payment exceeds the remaining supplier balance." }
            val id = UUID.randomUUID().toString()
            db.insertOrThrow("purchase_payments", null, ContentValues().apply {
                put("id", id)
                put("purchase_id", purchaseId)
                put("method", payment.method)
                put("amount_minor", payment.amountMinor)
                putNullable("reference", payment.reference)
                putNullable("provider", payment.provider)
                put("occurred_at", payment.occurredAt)
                put("direction", "out")
            })
            accounting.postJournalEntry(
                sourceType = "supplier_payment",
                sourceId = id,
                description = "Payment to supplier for ${purchase.reference}",
                occurredAt = payment.occurredAt,
                lines = listOf(
                    DavinciJournalLine("acc-ap", debitMinor = payment.amountMinor),
                    DavinciJournalLine(paymentAccounts.getValue(payment.method), creditMinor = payment.amountMinor)
                )
            )
            auditPayment(db, actorUserId, "supplier.payment", id, purchaseId, payment)
            val response = DavinciRecordedPayment(id, purchaseId, payment.amountMinor, due - payment.amountMinor)
            saveReplay(db, payment, "supplier_payment", purchaseId, response)
            db.setTransactionSuccessful()
            return response
        } finally {
            db.endTransaction()
        }
    }

    fun listCustomerBalances(): List<DavinciPartyBalance> =
        helper.readableDatabase.rawQuery(
            """
            SELECT c.id,c.name,c.phone,
              COALESCE(SUM(s.total_minor-COALESCE(r.returned_minor,0)-COALESCE(p.paid_minor,0)),0)
            FROM customers c
            LEFT JOIN sales s ON s.customer_id=c.id AND s.status IN ('posted','partially_returned','returned')
            LEFT JOIN (
              SELECT sale_id,SUM(CASE WHEN direction='in' THEN amount_minor ELSE -amount_minor END) paid_minor
              FROM payments GROUP BY sale_id
            ) p ON p.sale_id=s.id
            LEFT JOIN (
              SELECT sale_id,SUM(total_minor) returned_minor FROM sales_returns GROUP BY sale_id
            ) r ON r.sale_id=s.id
            GROUP BY c.id ORDER BY c.name
            """.trimIndent(), null
        ).use { cursor -> cursor.toBalances() }

    fun listSupplierBalances(): List<DavinciPartyBalance> =
        helper.readableDatabase.rawQuery(
            """
            SELECT s.id,s.name,s.phone,
              COALESCE(SUM(p.total_minor-COALESCE(r.returned_minor,0)-COALESCE(pp.paid_minor,0)),0)
            FROM suppliers s
            LEFT JOIN purchases p ON p.supplier_id=s.id AND p.status='posted'
            LEFT JOIN (
              SELECT purchase_id,SUM(CASE WHEN direction='out' THEN amount_minor ELSE -amount_minor END) paid_minor
              FROM purchase_payments GROUP BY purchase_id
            ) pp ON pp.purchase_id=p.id
            LEFT JOIN (
              SELECT purchase_id,SUM(total_minor) returned_minor FROM purchase_returns GROUP BY purchase_id
            ) r ON r.purchase_id=p.id
            GROUP BY s.id ORDER BY s.name
            """.trimIndent(), null
        ).use { cursor -> cursor.toBalances() }

    fun getCustomerStatement(customerId: String): DavinciPartyStatement =
        getStatement(customerId, customer = true)

    fun getSupplierStatement(supplierId: String): DavinciPartyStatement =
        getStatement(supplierId, customer = false)

    private fun getStatement(id: String, customer: Boolean): DavinciPartyStatement {
        val db = helper.readableDatabase
        val table = if (customer) "customers" else "suppliers"
        val party = db.rawQuery(
            "SELECT id,name,phone FROM $table WHERE id=?", arrayOf(id)
        ).use { cursor ->
            if (!cursor.moveToFirst()) null else DavinciStatementParty(
                cursor.getString(0), cursor.getString(1), cursor.nullableString(2)
            )
        } ?: throw IllegalArgumentException(if (customer) "Customer not found." else "Supplier not found.")
        val invoices = if (customer) {
            """
            SELECT s.id,s.receipt_number,s.occurred_at,s.total_minor,
              COALESCE(p.paid_minor,0),COALESCE(r.returned_minor,0),
              s.total_minor-COALESCE(r.returned_minor,0)-COALESCE(p.paid_minor,0)
            FROM sales s
            LEFT JOIN (SELECT sale_id,SUM(CASE WHEN direction='in' THEN amount_minor ELSE -amount_minor END) paid_minor FROM payments GROUP BY sale_id) p ON p.sale_id=s.id
            LEFT JOIN (SELECT sale_id,SUM(total_minor) returned_minor FROM sales_returns GROUP BY sale_id) r ON r.sale_id=s.id
            WHERE s.customer_id=? AND s.status IN ('posted','partially_returned','returned')
            ORDER BY s.occurred_at DESC
            """.trimIndent()
        } else {
            """
            SELECT p.id,p.invoice_number,p.occurred_at,p.total_minor,
              COALESCE(pp.paid_minor,0),COALESCE(r.returned_minor,0),
              p.total_minor-COALESCE(r.returned_minor,0)-COALESCE(pp.paid_minor,0)
            FROM purchases p
            LEFT JOIN (SELECT purchase_id,SUM(CASE WHEN direction='out' THEN amount_minor ELSE -amount_minor END) paid_minor FROM purchase_payments GROUP BY purchase_id) pp ON pp.purchase_id=p.id
            LEFT JOIN (SELECT purchase_id,SUM(total_minor) returned_minor FROM purchase_returns GROUP BY purchase_id) r ON r.purchase_id=p.id
            WHERE p.supplier_id=? AND p.status='posted'
            ORDER BY p.occurred_at DESC
            """.trimIndent()
        }
        val rows = db.rawQuery(invoices, arrayOf(id)).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(
                    DavinciStatementInvoice(
                        cursor.getString(0), cursor.getString(1), cursor.getString(2),
                        cursor.getLong(3), cursor.getLong(4), cursor.getLong(5), cursor.getLong(6)
                    )
                )
            }
        }
        return DavinciPartyStatement(party, rows.fold(0L) { total, row -> safeAdd(total, row.dueMinor) }, rows)
    }

    private fun normalizePayment(input: DavinciPaymentInput): NormalizedPayment {
        require(input.amountMinor in 1..MAX_SAFE_INTEGER) {
            "Payment amount must be a positive integer in minor currency units."
        }
        val method = input.method.ifBlank { "cash" }
        require(method in paymentAccounts) { "Unsupported payment method." }
        val provider = input.provider?.takeIf { it.isNotBlank() }
        require(provider == null || provider in walletProviders) { "Unsupported wallet provider." }
        require(method == "wallet" || provider == null) {
            "A wallet provider is only valid for wallet payments."
        }
        require(method != "wallet" || provider != null) { "Select a supported wallet provider." }
        val key = input.idempotencyKey?.takeIf { it.isNotBlank() }
        require(key == null || (key.length <= 200 && key.trim() == key)) {
            "Invalid idempotency key."
        }
        return NormalizedPayment(
            input.amountMinor, method, provider, input.reference,
            input.occurredAt ?: Instant.now().toString(), input.occurredAt, key
        )
    }

    private fun replay(
        db: SQLiteDatabase,
        operation: String,
        entityId: String,
        payment: NormalizedPayment
    ): DavinciRecordedPayment? {
        val key = payment.idempotencyKey ?: return null
        val hash = payloadHash(payment)
        val existing = db.rawQuery(
            "SELECT operation,entity_id,payload_hash,response_json FROM payment_idempotency WHERE idempotency_key=?",
            arrayOf(key)
        ).use { cursor ->
            if (!cursor.moveToFirst()) null else arrayOf(
                cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getString(3)
            )
        } ?: return null
        require(existing[0] == operation && existing[1] == entityId && existing[2] == hash) {
            "Idempotency key was already used for a different payment request."
        }
        val json = JSONObject(existing[3])
        return DavinciRecordedPayment(
            json.getString("id"), json.getString(if (operation == "customer_collection") "saleId" else "purchaseId"),
            json.getLong("amountMinor"), json.getLong("remainingMinor")
        )
    }

    private fun saveReplay(
        db: SQLiteDatabase,
        payment: NormalizedPayment,
        operation: String,
        entityId: String,
        response: DavinciRecordedPayment
    ) {
        val key = payment.idempotencyKey ?: return
        val json = JSONObject()
            .put("id", response.id)
            .put(if (operation == "customer_collection") "saleId" else "purchaseId", entityId)
            .put("amountMinor", response.amountMinor)
            .put("remainingMinor", response.remainingMinor)
        db.insertOrThrow("payment_idempotency", null, ContentValues().apply {
            put("idempotency_key", key)
            put("operation", operation)
            put("entity_id", entityId)
            put("payload_hash", payloadHash(payment))
            put("response_json", json.toString())
            put("created_at", Instant.now().toString())
        })
    }

    private fun payloadHash(payment: NormalizedPayment): String {
        val payload = JSONObject()
            .put("amountMinor", payment.amountMinor)
            .put("method", payment.method)
            .put("provider", payment.provider ?: JSONObject.NULL)
            .put("reference", payment.reference ?: JSONObject.NULL)
            .put("occurredAt", payment.requestedOccurredAt ?: JSONObject.NULL)
            .toString()
        return MessageDigest.getInstance("SHA-256")
            .digest(payload.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    private fun auditPayment(
        db: SQLiteDatabase,
        actorUserId: String?,
        action: String,
        paymentId: String,
        entityId: String,
        payment: NormalizedPayment
    ) {
        if (actorUserId == null) return
        db.insertOrThrow("audit_logs", null, ContentValues().apply {
            put("id", UUID.randomUUID().toString())
            put("user_id", actorUserId)
            put("action", action)
            put("entity_type", "payment")
            put("entity_id", paymentId)
            put("details", JSONObject().put("entityId", entityId)
                .put("amountMinor", payment.amountMinor).put("method", payment.method).toString())
            put("created_at", Instant.now().toString())
        })
    }

    private fun scalarLong(db: SQLiteDatabase, sql: String, args: Array<String>): Long =
        db.rawQuery(sql, args).use { it.moveToFirst(); it.getLong(0) }

    private fun Cursor.toBalances(): List<DavinciPartyBalance> =
        buildList {
            while (moveToNext()) add(
                DavinciPartyBalance(
                    getString(0), getString(1), nullableString(2), getLong(3)
                )
            )
        }

    private fun Cursor.nullableString(index: Int): String? =
        if (isNull(index)) null else getString(index)

    private fun ContentValues.putNullable(key: String, value: String?) {
        if (value == null) putNull(key) else put(key, value)
    }

    private fun safeAdd(left: Long, right: Long): Long {
        require(right >= 0 && left <= MAX_SAFE_INTEGER - right) {
            "Statement balance exceeds supported safe integer limits."
        }
        return left + right
    }

    private data class SaleBalance(
        val reference: String,
        val customerId: String?,
        val totalMinor: Long,
        val status: String
    )

    private data class PurchaseBalance(
        val reference: String,
        val supplierId: String?,
        val totalMinor: Long,
        val status: String
    )

    private data class NormalizedPayment(
        val amountMinor: Long,
        val method: String,
        val provider: String?,
        val reference: String?,
        val occurredAt: String,
        val requestedOccurredAt: String?,
        val idempotencyKey: String?
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
