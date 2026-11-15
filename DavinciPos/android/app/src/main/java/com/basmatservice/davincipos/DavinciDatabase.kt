package com.basmatservice.davincipos

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.BufferedReader
import java.io.InputStreamReader
import java.time.Instant

/**
 * Platform SQLite foundation for the Android port.
 *
 * The helper deliberately imports the canonical schema.sql. It does not yet
 * expose business operations; those are added as typed repositories/services
 * before the app launcher is switched away from the legacy Node runtime.
 */
class DavinciDatabase private constructor(context: Context) :
    SQLiteOpenHelper(context, DATABASE_NAME, null, DATABASE_VERSION) {

    private val appContext = context.applicationContext

    override fun onConfigure(db: SQLiteDatabase) {
        super.onConfigure(db)
        db.setForeignKeyConstraintsEnabled(true)
        db.enableWriteAheadLogging()
    }

    override fun onCreate(db: SQLiteDatabase) {
        val sql = appContext.assets.open("schema.sql").use { input ->
            BufferedReader(InputStreamReader(input, Charsets.UTF_8)).readText()
        }
        splitSqlStatements(sql).forEach { statement ->
            if (statement.isNotBlank()) db.execSQL(statement)
        }
        seedDefaults(db)
        db.execSQL(
            "INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES(?, ?)",
            arrayOf(DATABASE_VERSION, Instant.now().toString())
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Never silently drop POS data. Each future schema version must add an
        // explicit, tested migration before DATABASE_VERSION is increased.
        throw IllegalStateException("Missing DavinciPos database migration: $oldVersion -> $newVersion")
    }

    private fun seedDefaults(db: SQLiteDatabase) {
        val now = Instant.now().toString()
        db.execSQL(
            "INSERT OR IGNORE INTO branches(id,name,code,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            arrayOf("branch-main", "Main Branch", "MAIN", 1, now, now)
        )
        val units = arrayOf(
            arrayOf<Any>("unit-piece", "Piece", "pc", 0),
            arrayOf<Any>("unit-box", "Box", "box", 0),
            arrayOf<Any>("unit-kg", "Kilogram", "kg", 3),
            arrayOf<Any>("unit-liter", "Liter", "L", 3)
        )
        units.forEach {
            db.execSQL("INSERT OR IGNORE INTO units(id,name,symbol,precision) VALUES(?,?,?,?)", it)
        }
        val accounts = arrayOf(
            arrayOf<Any>("acc-cash", "1000", "Cash", "asset", "debit"),
            arrayOf<Any>("acc-card", "1020", "Card Clearing", "asset", "debit"),
            arrayOf<Any>("acc-bank", "1010", "Bank", "asset", "debit"),
            arrayOf<Any>("acc-wallet", "1030", "Wallet Clearing", "asset", "debit"),
            arrayOf<Any>("acc-other-clearing", "1040", "Other Payment Clearing", "asset", "debit"),
            arrayOf<Any>("acc-ar", "1100", "Accounts Receivable", "asset", "debit"),
            arrayOf<Any>("acc-inventory", "1200", "Inventory", "asset", "debit"),
            arrayOf<Any>("acc-ap", "2000", "Accounts Payable", "liability", "credit"),
            arrayOf<Any>("acc-tax", "2100", "Tax Payable", "liability", "credit"),
            arrayOf<Any>("acc-capital", "3000", "Owner Equity", "equity", "credit"),
            arrayOf<Any>("acc-tax-input", "2110", "Recoverable Input Tax", "asset", "debit"),
            arrayOf<Any>("acc-sales", "4000", "Sales Revenue", "revenue", "credit"),
            arrayOf<Any>("acc-sales-returns", "4010", "Sales Returns", "revenue", "debit"),
            arrayOf<Any>("acc-cogs", "5000", "Cost of Goods Sold", "expense", "debit"),
            arrayOf<Any>("acc-expenses", "6000", "Operating Expenses", "expense", "debit"),
            arrayOf<Any>("acc-purchase-variance", "5010", "Purchase Cost Rounding Variance", "expense", "debit"),
            arrayOf<Any>("acc-stock-adjustment-gain", "4090", "Inventory Adjustment Gain", "revenue", "credit"),
            arrayOf<Any>("acc-stock-adjustment-loss", "6010", "Inventory Adjustment Loss", "expense", "debit")
        )
        accounts.forEach {
            db.execSQL(
                "INSERT OR IGNORE INTO accounts(id,code,name,account_type,normal_side) VALUES(?,?,?,?,?)",
                it
            )
        }
        val settings = arrayOf(
            arrayOf<Any>("inventory.cost_method", "weighted"),
            arrayOf<Any>("tax.enabled", "true"),
            arrayOf<Any>("tax.purchase_mode", "recoverable"),
            arrayOf<Any>("sync.offline_sales", "true"),
            arrayOf<Any>("sync.stock_conflict_policy", "hold_for_review"),
            arrayOf<Any>("tax.price_mode", "exclusive"),
            arrayOf<Any>("currency.code", "SDG")
        )
        settings.forEach {
            db.execSQL(
                "INSERT OR IGNORE INTO app_settings(key,value,updated_at) VALUES(?,?,?)",
                arrayOf(it[0], it[1], now)
            )
        }
    }

    companion object {
        private const val DATABASE_NAME = "DavinciPos.sqlite"
        private const val DATABASE_VERSION = 1

        @Volatile private var instance: DavinciDatabase? = null

        fun get(context: Context): DavinciDatabase =
            instance ?: synchronized(this) {
                instance ?: DavinciDatabase(context).also { instance = it }
            }

        /**
         * Split SQL while preserving quoted strings, comments and trigger bodies.
         * SQLiteOpenHelper.execSQL accepts one statement at a time.
         */
        internal fun splitSqlStatements(source: String): List<String> {
            val statements = mutableListOf<String>()
            val current = StringBuilder()
            var quote: Char? = null
            var lineComment = false
            var blockComment = false
            var trigger = false
            var triggerDepth = 0
            var caseDepth = 0
            var i = 0
            while (i < source.length) {
                val c = source[i]
                val next = if (i + 1 < source.length) source[i + 1] else '\u0000'
                if (lineComment) {
                    current.append(c)
                    if (c == '\n') lineComment = false
                    i++
                    continue
                }
                if (blockComment) {
                    current.append(c)
                    if (c == '*' && next == '/') {
                        current.append(next); i += 2; blockComment = false
                    } else i++
                    continue
                }
                if (quote != null) {
                    current.append(c)
                    if (c == quote) {
                        if (next == quote) { current.append(next); i += 2; continue }
                        quote = null
                    } else if (c == '\\' && next != '\u0000') {
                        current.append(next); i += 2; continue
                    }
                    i++
                    continue
                }
                if (c == '-' && next == '-') { current.append(c).append(next); i += 2; lineComment = true; continue }
                if (c == '/' && next == '*') { current.append(c).append(next); i += 2; blockComment = true; continue }
                if (c == '\'' || c == '"' || c == '`') { quote = c; current.append(c); i++; continue }
                if (c.isLetter()) {
                    val start = i
                    while (i < source.length && (source[i].isLetterOrDigit() || source[i] == '_')) i++
                    val word = source.substring(start, i)
                    val upper = word.uppercase()
                    if (current.toString().trimStart().uppercase().startsWith("CREATE TRIGGER")) {
                        trigger = true
                        if (upper == "BEGIN") triggerDepth++
                        if (upper == "CASE") caseDepth++
                        if (upper == "END") {
                            if (caseDepth > 0) caseDepth-- else if (triggerDepth > 0) triggerDepth--
                        }
                    }
                    current.append(word)
                    continue
                }
                if (c == ';' && (!trigger || (triggerDepth == 0 && caseDepth == 0))) {
                    if (current.isNotBlank()) statements.add(current.toString().trim())
                    current.setLength(0)
                    trigger = false
                    triggerDepth = 0
                    caseDepth = 0
                } else current.append(c)
                i++
            }
            if (current.isNotBlank()) statements.add(current.toString().trim())
            return statements
        }
    }
}
