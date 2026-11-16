package com.basmatservice.davincipos

import android.content.ContentValues
import android.content.Context
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

data class DavinciExpense(
    val id: String,
    val category: String,
    val amountMinor: Long,
    val paymentMethod: String,
    val provider: String?,
    val reference: String?,
    val note: String?,
    val occurredAt: String,
    val createdBy: String?
)

/** Expense recording and reporting with balanced accounting entries. */
class DavinciExpenseRepository(context: Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)
    private val accounting = DavinciAccountingRepository(context.applicationContext)

    fun createExpense(
        category: String,
        amountMinor: Long,
        paymentMethod: String = "cash",
        provider: String? = null,
        reference: String? = null,
        note: String? = null,
        occurredAt: String? = null,
        userId: String? = null,
        branchId: String? = DavinciCatalogRepository.MAIN_BRANCH_ID
    ): DavinciExpense {
        val cleanCategory = category.trim()
        require(cleanCategory.isNotEmpty() && cleanCategory.length <= 100) {
            "Enter a valid expense category."
        }
        require(amountMinor in 1..MAX_SAFE_INTEGER) {
            "Expense amount must be a positive integer in minor currency units."
        }
        require(paymentMethod in paymentAccounts) { "Invalid expense payment method." }
        val cleanProvider = provider?.takeIf { it.isNotEmpty() }
        require(cleanProvider == null || cleanProvider in walletProviders) {
            "Unsupported payment provider."
        }
        require(paymentMethod != "wallet" || cleanProvider in walletProviders) {
            "Select Bankak, OCash, Fawry or MyCashy."
        }
        val cleanReference = reference?.trim()?.takeIf { it.isNotEmpty() }?.take(120)
        val cleanNote = note?.trim()?.takeIf { it.isNotEmpty() }?.take(500)
        val date = occurredAt?.let {
            try { Instant.parse(it).toString() }
            catch (_: Exception) { throw IllegalArgumentException("Invalid expense date.") }
        } ?: Instant.now().toString()
        val id = UUID.randomUUID().toString()
        val now = Instant.now().toString()
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            db.insertOrThrow("expenses", null, ContentValues().apply {
                put("id", id)
                if (branchId == null) putNull("branch_id") else put("branch_id", branchId)
                put("category", cleanCategory)
                put("amount_minor", amountMinor)
                put("payment_method", paymentMethod)
                if (cleanProvider == null) putNull("provider") else put("provider", cleanProvider)
                if (cleanReference == null) putNull("reference") else put("reference", cleanReference)
                if (cleanNote == null) putNull("note") else put("note", cleanNote)
                put("occurred_at", date)
                if (userId == null) putNull("created_by") else put("created_by", userId)
                put("created_at", now)
            })
            accounting.postJournalEntry(
                sourceType = "expense",
                sourceId = id,
                description = "Expense: $cleanCategory",
                occurredAt = date,
                lines = listOf(
                    DavinciJournalLine("acc-expenses", debitMinor = amountMinor),
                    DavinciJournalLine(paymentAccounts.getValue(paymentMethod), creditMinor = amountMinor)
                )
            )
            db.insertOrThrow("audit_logs", null, ContentValues().apply {
                put("id", UUID.randomUUID().toString())
                if (userId == null) putNull("user_id") else put("user_id", userId)
                put("action", "expense.create")
                put("entity_type", "expense")
                put("entity_id", id)
                put("details", org.json.JSONObject().put("category", cleanCategory)
                    .put("amountMinor", amountMinor).put("paymentMethod", paymentMethod)
                    .put("provider", cleanProvider ?: org.json.JSONObject.NULL).toString())
                put("created_at", now)
            })
            db.setTransactionSuccessful()
            return DavinciExpense(
                id, cleanCategory, amountMinor, paymentMethod, cleanProvider,
                cleanReference, cleanNote, date, userId
            )
        } finally {
            db.endTransaction()
        }
    }

    fun listExpenses(
        from: String? = null,
        to: String? = null,
        limit: Int = 200
    ): List<DavinciExpense> {
        val filters = mutableListOf<String>()
        val args = mutableListOf<String>()
        if (from != null) {
            filters += "e.occurred_at>=?"
            args += dateBoundary(from)
        }
        if (to != null) {
            filters += "e.occurred_at<?"
            args += LocalDate.parse(to).plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toString()
        }
        args += limit.coerceIn(1, 500).toString()
        return helper.readableDatabase.rawQuery(
            """
            SELECT e.id,e.category,e.amount_minor,e.payment_method,e.provider,e.reference,
                   e.note,e.occurred_at,u.display_name
            FROM expenses e LEFT JOIN users u ON u.id=e.created_by
            ${if (filters.isEmpty()) "" else "WHERE ${filters.joinToString(" AND ")}"}
            ORDER BY e.occurred_at DESC LIMIT ?
            """.trimIndent(), args.toTypedArray()
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(
                    DavinciExpense(
                        cursor.getString(0), cursor.getString(1), cursor.getLong(2),
                        cursor.getString(3), if (cursor.isNull(4)) null else cursor.getString(4),
                        if (cursor.isNull(5)) null else cursor.getString(5),
                        if (cursor.isNull(6)) null else cursor.getString(6),
                        cursor.getString(7), if (cursor.isNull(8)) null else cursor.getString(8)
                    )
                )
            }
        }
    }

    private fun dateBoundary(value: String): String {
        val date = try { LocalDate.parse(value) }
        catch (_: Exception) { throw IllegalArgumentException("Invalid expense date filter.") }
        require(date.toString() == value) { "Invalid expense date filter." }
        return date.atStartOfDay(ZoneId.systemDefault()).toInstant().toString()
    }

    companion object {
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        private val paymentAccounts = mapOf(
            "cash" to "acc-cash", "card" to "acc-card", "bank" to "acc-bank",
            "wallet" to "acc-wallet", "other" to "acc-other-clearing"
        )
        private val walletProviders = setOf("bankak", "ocash", "fawry", "mycashy")
    }
}
