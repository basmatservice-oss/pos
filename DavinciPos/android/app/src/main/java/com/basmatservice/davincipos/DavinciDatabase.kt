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
        ensureCompatibilityColumns(db)
        seedDefaults(db)
        seedRoles(db)
        db.execSQL(
            "INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES(?, ?)",
            arrayOf(DATABASE_VERSION, Instant.now().toString())
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Version 2 mirrors the additive compatibility migrations used by the
        // Node.js server. Never drop or recreate existing POS tables.
        if (newVersion > 2) {
            throw IllegalStateException("Missing DavinciPos database migration: $oldVersion -> $newVersion")
        }
        if (oldVersion < 2) ensureCompatibilityColumns(db)
        db.execSQL(
            "INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES(?, ?)",
            arrayOf(newVersion, Instant.now().toString())
        )
    }

    private fun ensureCompatibilityColumns(db: SQLiteDatabase) {
        val additions = listOf(
            Triple("sale_line_cost_layers", "cost_total_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(cost_total_minor>=0)"),
            Triple("sale_line_cost_layers", "returned_cost_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(returned_cost_minor>=0 AND returned_cost_minor<=cost_total_minor)"),
            Triple("sync_receipts", "payload_hash", "TEXT"),
            Triple("sync_conflicts", "payload_hash", "TEXT"),
            Triple("products", "tax_exempt", "INTEGER NOT NULL DEFAULT 0 CHECK(tax_exempt IN (0,1))"),
            Triple("services", "tax_exempt", "INTEGER NOT NULL DEFAULT 0 CHECK(tax_exempt IN (0,1))"),
            Triple("sales", "tax_enabled", "INTEGER NOT NULL DEFAULT 1 CHECK(tax_enabled IN (0,1))"),
            Triple("sales", "tax_price_mode", "TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_price_mode IN ('inclusive','exclusive'))"),
            Triple("sale_lines", "tax_rate_bps", "INTEGER NOT NULL DEFAULT 0 CHECK(tax_rate_bps BETWEEN 0 AND 10000)"),
            Triple("sale_lines", "tax_profile_id", "TEXT"),
            Triple("sale_lines", "tax_price_mode", "TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_price_mode IN ('inclusive','exclusive'))"),
            Triple("purchases", "tax_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(tax_minor>=0)"),
            Triple("purchases", "tax_treatment", "TEXT NOT NULL DEFAULT 'disabled' CHECK(tax_treatment IN ('recoverable','non_recoverable','disabled'))"),
            Triple("purchases", "tax_price_mode", "TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_price_mode IN ('inclusive','exclusive'))"),
            Triple("devices", "owner_user_id", "TEXT"),
            Triple("devices", "is_active", "INTEGER NOT NULL DEFAULT 1"),
            Triple("payments", "provider", "TEXT"),
            Triple("purchase_payments", "provider", "TEXT"),
            Triple("purchase_payments", "direction", "TEXT NOT NULL DEFAULT 'out' CHECK(direction IN ('out','in'))"),
            Triple("purchase_lines", "tax_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(tax_minor>=0)"),
            Triple("purchase_lines", "tax_rate_bps", "INTEGER NOT NULL DEFAULT 0 CHECK(tax_rate_bps BETWEEN 0 AND 10000)"),
            Triple("purchase_lines", "tax_profile_id", "TEXT"),
            Triple("purchase_lines", "tax_price_mode", "TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_price_mode IN ('inclusive','exclusive'))"),
            Triple("products", "price_currency", "TEXT NOT NULL DEFAULT 'SDG' CHECK(price_currency IN ('SDG','USD'))"),
            Triple("products", "foreign_cost_minor", "INTEGER"),
            Triple("products", "foreign_sale_price_minor", "INTEGER"),
            Triple("products", "auto_rate_update", "INTEGER NOT NULL DEFAULT 0 CHECK(auto_rate_update IN (0,1))")
        )
        additions.forEach { (table, column, definition) ->
            if (!hasColumn(db, table, column)) {
                db.execSQL("ALTER TABLE $table ADD COLUMN $column $definition")
            }
        }
        db.execSQL(
            """UPDATE sale_line_cost_layers
               SET cost_total_minor=CAST(ROUND(quantity*unit_cost_minor) AS INTEGER)
               WHERE cost_total_minor=0"""
        )
    }

    private fun hasColumn(db: SQLiteDatabase, table: String, column: String): Boolean =
        db.rawQuery("PRAGMA table_info($table)", null).use { cursor ->
            val nameIndex = cursor.getColumnIndex("name")
            while (cursor.moveToNext()) {
                if (cursor.getString(nameIndex) == column) return@use true
            }
            false
        }

    private fun seedRoles(db: SQLiteDatabase) {
        val rolePermissions = linkedMapOf(
            "owner" to listOf("*"),
            "admin" to listOf("*"),
            "manager" to listOf(
                "dashboard.read", "products.read", "products.write", "inventory.read", "inventory.write",
                "sales.read", "sales.create", "sales.credit", "sales.collect", "sales.return", "sales.void",
                "purchases.read", "purchases.create", "purchases.pay", "purchases.return",
                "customers.read", "customers.write", "customers.balance.read",
                "suppliers.read", "suppliers.write", "suppliers.balance.read", "reports.read",
                "expenses.read", "expenses.create", "accounting.read", "settings.read", "users.read",
                "sync.conflicts.read", "sync.conflicts.resolve"
            ),
            "cashier" to listOf(
                "dashboard.read", "products.read", "inventory.read", "sales.create",
                "sales.collect", "customers.read", "customers.balance.read"
            ),
            "accountant" to listOf(
                "dashboard.read", "sales.read", "sales.collect", "purchases.read", "purchases.pay",
                "customers.balance.read", "suppliers.balance.read", "reports.read", "expenses.read",
                "accounting.read", "accounting.reverse", "settings.read"
            ),
            "sales" to listOf(
                "dashboard.read", "products.read", "inventory.read", "sales.read", "sales.create",
                "sales.collect", "customers.read", "customers.write", "customers.balance.read"
            )
        )
        val insertRole = db.compileStatement(
            "INSERT OR IGNORE INTO roles(name,description,is_system) VALUES(?,?,1)"
        )
        val insertPermission = db.compileStatement(
            "INSERT OR IGNORE INTO role_permissions(role_name,permission) VALUES(?,?)"
        )
        val now = Instant.now().toString()
        rolePermissions.forEach { (role, permissions) ->
            insertRole.clearBindings()
            insertRole.bindString(1, role)
            insertRole.bindString(2, "$role role")
            insertRole.executeInsert()
            permissions.forEach { permission ->
                insertPermission.clearBindings()
                insertPermission.bindString(1, role)
                insertPermission.bindString(2, permission)
                insertPermission.executeInsert()
            }
        }
        db.execSQL(
            "INSERT OR REPLACE INTO app_settings(key,value,updated_at) VALUES(?,?,?)",
            arrayOf("security.permissions.version", "5", now)
        )
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
        private const val DATABASE_VERSION = 2

        @Volatile private var instance: DavinciDatabase? = null

        fun get(context: Context): DavinciDatabase =
            instance ?: synchronized(this) {
                instance ?: DavinciDatabase(context).also { instance = it }
            }

        /** Test-only isolation for Robolectric SQLite integration tests. */
        internal fun resetForTests(context: Context) {
            synchronized(this) {
                instance?.close()
                instance = null
                context.applicationContext.deleteDatabase(DATABASE_NAME)
            }
        }

        /**
         * Split SQL while preserving quoted strings, comments and trigger bodies.
         * SQLiteOpenHelper.execSQL accepts one statement at a time.
         */
        internal fun splitSqlStatements(source: String): List<String> = DavinciSqlScriptSplitter.split(source)

    }
}
