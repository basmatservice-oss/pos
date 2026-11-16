package com.basmatservice.davincipos

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

data class DavinciTaxProfile(
    val id: String,
    val name: String,
    val rateBps: Int,
    val priceMode: String,
    val isDefault: Boolean,
    val isActive: Boolean
)

data class DavinciResolvedTaxProfile(
    val id: String?,
    val name: String?,
    val rateBps: Int,
    val priceMode: String
)

/**
 * Typed settings and tax-profile storage for the Android-native application.
 * Validation and costing locks mirror settings.js and tax.js.
 */
class DavinciSettingsRepository(context: Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)

    fun getSettings(): Map<String, Any?> {
        val stored = linkedMapOf<String, String>()
        helper.readableDatabase.rawQuery(
            "SELECT key,value FROM app_settings", null
        ).use { cursor ->
            while (cursor.moveToNext()) stored[cursor.getString(0)] = cursor.getString(1)
        }
        return SETTING_DEFAULTS.mapValues { (key, fallback) ->
            val raw = stored[key] ?: fallback
            when (key) {
                "tax.enabled", "sync.offline_sales" -> raw == "true" || raw == "1"
                "tax.default_profile_id" -> raw.takeIf { it.isNotEmpty() }
                else -> raw
            }
        }
    }

    fun updateSettings(
        changes: Map<String, Any?>,
        actorUserId: String? = null
    ): Map<String, Any?> {
        require(changes.isNotEmpty()) { "At least one setting is required." }
        val normalized = changes.map { (key, value) -> key to normalizeSetting(key, value) }
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            normalized.forEach { (key, value) ->
                val previous = db.rawQuery(
                    "SELECT value FROM app_settings WHERE key=?", arrayOf(key)
                ).use { if (it.moveToFirst()) it.getString(0) else null }
                if (key == "inventory.cost_method" && previous != null && previous != value) {
                    val movements = db.rawQuery(
                        "SELECT COUNT(*) FROM stock_movements", null
                    ).use { it.moveToFirst(); it.getLong(0) }
                    require(movements == 0L) {
                        "Inventory costing is locked after stock activity. A controlled revaluation workflow is required."
                    }
                }
                db.insertWithOnConflict(
                    "app_settings", null,
                    ContentValues().apply {
                        put("key", key)
                        put("value", value ?: "")
                        put("updated_at", Instant.now().toString())
                    },
                    SQLiteDatabase.CONFLICT_REPLACE
                )
                writeAudit(
                    db, actorUserId, "settings.update", "setting", key,
                    JSONObject().put("previous", previous ?: JSONObject.NULL)
                        .put("value", value ?: JSONObject.NULL).toString()
                )
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return getSettings()
    }

    fun listTaxProfiles(): List<DavinciTaxProfile> =
        helper.readableDatabase.rawQuery(
            """
            SELECT id,name,rate_bps,price_mode,is_default,is_active
            FROM tax_profiles ORDER BY name
            """.trimIndent(), null
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(
                    DavinciTaxProfile(
                        cursor.getString(0), cursor.getString(1), cursor.getInt(2),
                        cursor.getString(3), cursor.getInt(4) == 1, cursor.getInt(5) == 1
                    )
                )
            }
        }

    fun resolveTaxProfile(profileId: String? = null): DavinciResolvedTaxProfile {
        val settings = getSettings()
        val selectedId = profileId?.takeIf { it.isNotBlank() }
            ?: settings["tax.default_profile_id"] as? String
        val row = helper.readableDatabase.rawQuery(
            if (selectedId != null) {
                "SELECT id,name,rate_bps,price_mode FROM tax_profiles WHERE id=? AND is_active=1"
            } else {
                "SELECT id,name,rate_bps,price_mode FROM tax_profiles WHERE is_default=1 AND is_active=1 ORDER BY name LIMIT 1"
            },
            if (selectedId != null) arrayOf(selectedId) else null
        ).use { cursor ->
            if (!cursor.moveToFirst()) null else DavinciResolvedTaxProfile(
                cursor.getString(0), cursor.getString(1), cursor.getInt(2), cursor.getString(3)
            )
        }
        if (selectedId != null && row == null) {
            throw IllegalArgumentException("Default tax profile not found or inactive.")
        }
        return row ?: DavinciResolvedTaxProfile(
            null, null, 0, settings["tax.price_mode"] as String
        )
    }

    fun saveTaxProfile(
        input: SaveTaxProfileInput,
        actorUserId: String? = null
    ): String {
        val name = input.name.trim()
        require(name.isNotEmpty() && name.length <= 160) { "Tax profile name is required." }
        require(input.rateBps in 0..10_000) { "Tax rate must be between 0 and 100 percent." }
        require(input.priceMode in setOf("inclusive", "exclusive")) {
            "Tax price mode must be inclusive or exclusive."
        }
        val id = input.id?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val previous = db.rawQuery(
                "SELECT name,rate_bps,price_mode,is_default,is_active FROM tax_profiles WHERE id=?",
                arrayOf(id)
            ).use { cursor ->
                if (!cursor.moveToFirst()) JSONObject.NULL else JSONObject()
                    .put("name", cursor.getString(0))
                    .put("rateBps", cursor.getInt(1))
                    .put("priceMode", cursor.getString(2))
                    .put("isDefault", cursor.getInt(3) == 1)
                    .put("isActive", cursor.getInt(4) == 1)
            }
            if (input.isDefault) {
                db.execSQL("UPDATE tax_profiles SET is_default=0")
                db.insertWithOnConflict(
                    "app_settings", null,
                    ContentValues().apply {
                        put("key", "tax.default_profile_id")
                        put("value", id)
                        put("updated_at", Instant.now().toString())
                    },
                    SQLiteDatabase.CONFLICT_REPLACE
                )
            }
            val values = ContentValues().apply {
                put("id", id)
                put("name", name)
                put("rate_bps", input.rateBps)
                put("price_mode", input.priceMode)
                put("is_default", if (input.isDefault) 1 else 0)
                put("is_active", 1)
            }
            db.insertWithOnConflict(
                "tax_profiles", null, values, SQLiteDatabase.CONFLICT_REPLACE
            )
            writeAudit(
                db, actorUserId, "tax_profile.save", "tax_profile", id,
                JSONObject().put("previous", previous)
                    .put("next", JSONObject().put("name", name)
                        .put("rateBps", input.rateBps)
                        .put("priceMode", input.priceMode)
                        .put("isDefault", input.isDefault)).toString()
            )
            db.setTransactionSuccessful()
            return id
        } finally {
            db.endTransaction()
        }
    }

    private fun normalizeSetting(key: String, value: Any?): String? = when (key) {
        "tax.enabled", "sync.offline_sales" -> {
            require(value is Boolean) { "Setting $key must be boolean." }
            value.toString()
        }
        "tax.purchase_mode" -> enumSetting(key, value, setOf("recoverable", "non_recoverable", "disabled"))
        "tax.price_mode" -> enumSetting(key, value, setOf("inclusive", "exclusive"))
        "inventory.cost_method" -> enumSetting(key, value, setOf("weighted", "fifo"))
        "sync.stock_conflict_policy" -> enumSetting(key, value, setOf("hold_for_review", "reject_sale"))
        "tax.default_profile_id" -> {
            if (value == null || value == "") null
            else (value as? String)?.also {
                require(it.length <= 128) { "Invalid value for setting $key." }
            } ?: throw IllegalArgumentException("Invalid value for setting $key.")
        }
        "currency.code", "company.name" -> {
            val text = value as? String
                ?: throw IllegalArgumentException("Invalid value for setting $key.")
            val normalized = text.trim()
            require(normalized.isNotEmpty() && normalized.length <= 120) {
                "Invalid value for setting $key."
            }
            if (key == "currency.code") require(normalized.matches(Regex("^[A-Z]{3}$"))) {
                "Currency code must be a three-letter uppercase ISO code."
            }
            normalized
        }
        else -> throw IllegalArgumentException("Setting is not configurable: $key")
    }

    private fun enumSetting(key: String, value: Any?, allowed: Set<String>): String {
        val text = value as? String
            ?: throw IllegalArgumentException("Invalid value for setting $key.")
        require(text in allowed) { "Invalid value for setting $key." }
        return text
    }

    private fun writeAudit(
        db: SQLiteDatabase,
        actorUserId: String?,
        action: String,
        entityType: String,
        entityId: String,
        details: String
    ) {
        db.insertOrThrow("audit_logs", null, ContentValues().apply {
            put("id", UUID.randomUUID().toString())
            if (actorUserId == null) putNull("user_id") else put("user_id", actorUserId)
            put("action", action)
            put("entity_type", entityType)
            put("entity_id", entityId)
            put("details", details)
            put("created_at", Instant.now().toString())
        })
    }

    data class SaveTaxProfileInput(
        val name: String,
        val rateBps: Int,
        val priceMode: String,
        val isDefault: Boolean = false,
        val id: String? = null
    )

    companion object {
        private val SETTING_DEFAULTS = linkedMapOf<String, String>(
            "tax.enabled" to "true",
            "tax.purchase_mode" to "recoverable",
            "tax.price_mode" to "exclusive",
            "tax.default_profile_id" to "",
            "inventory.cost_method" to "weighted",
            "sync.offline_sales" to "true",
            "sync.stock_conflict_policy" to "hold_for_review",
            "currency.code" to "SDG",
            "company.name" to "DavinciPos"
        )
    }
}
