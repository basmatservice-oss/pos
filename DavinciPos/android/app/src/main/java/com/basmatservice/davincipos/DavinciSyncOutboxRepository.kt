package com.basmatservice.davincipos

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

data class DavinciOfflineOperation(
    val operationId: String,
    val deviceId: String,
    val entityType: String,
    val entityId: String,
    val operation: String,
    val payload: JSONObject,
    val status: String,
    val attempts: Int,
    val createdAt: String,
    val lastError: String?
)

/**
 * SQLite-backed device identity, POS snapshot and offline-operation queue.
 * Network replay is deliberately kept in the LAN service layer; this class
 * provides durable, transactional storage and retry state only.
 */
class DavinciSyncOutboxRepository(context: android.content.Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)

    fun getOrCreateDeviceId(): String {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val existing = db.rawQuery(
                "SELECT value FROM app_settings WHERE key=?",
                arrayOf(KEY_DEVICE_ID)
            ).use { if (it.moveToFirst()) it.getString(0) else null }
            if (!existing.isNullOrBlank()) {
                db.setTransactionSuccessful()
                return existing
            }
            val created = UUID.randomUUID().toString()
            putSetting(db, KEY_DEVICE_ID, created)
            db.setTransactionSuccessful()
            return created
        } finally {
            db.endTransaction()
        }
    }

    fun setDeviceRegistration(deviceId: String, registeredAt: String = Instant.now().toString()) {
        require(deviceId.length in 8..100) { "Invalid device ID." }
        val value = JSONObject().put("deviceId", deviceId).put("registeredAt", registeredAt)
        putSetting(helper.writableDatabase, KEY_DEVICE_REGISTRATION, value.toString())
    }

    fun cachePosSnapshot(snapshot: JSONObject) {
        require(snapshot.optJSONArray("products") != null &&
            snapshot.optJSONArray("customers") != null &&
            snapshot.optJSONArray("services") != null) {
            "POS snapshot must contain products, customers and services."
        }
        putSetting(helper.writableDatabase, KEY_POS_SNAPSHOT, snapshot.toString())
    }

    fun loadPosSnapshot(): JSONObject? =
        getSetting(KEY_POS_SNAPSHOT)?.let { JSONObject(it) }

    fun enqueueOfflineSale(
        sale: JSONObject,
        deviceId: String = getOrCreateDeviceId(),
        operationId: String = UUID.randomUUID().toString()
    ): String {
        require(deviceId.length in 8..100) { "A valid registered device ID is required." }
        require(operationId.matches(Regex("[A-Za-z0-9._~-]{1,128}"))) { "Invalid offline operation ID." }
        val lines = sale.optJSONArray("lines")
        require(lines != null && lines.length() > 0) { "Offline sale requires at least one line." }
        for (index in 0 until lines.length()) {
            val line = lines.optJSONObject(index)
                ?: throw IllegalArgumentException("Offline sale contains an invalid line.")
            val itemId = line.optString("itemId", "")
            val quantity = line.optDouble("quantity", Double.NaN)
            require(itemId.isNotBlank() && quantity.isFinite() && quantity > 0.0) {
                "Offline sale contains an invalid line."
            }
        }
        val entityId = if (sale.has("id") && !sale.isNull("id")) sale.optString("id") else operationId
        val now = Instant.now().toString()
        helper.writableDatabase.insertOrThrow("sync_outbox", null, ContentValues().apply {
            put("id", UUID.randomUUID().toString())
            put("device_id", deviceId)
            put("operation_id", operationId)
            put("entity_type", "sale")
            put("entity_id", entityId)
            put("operation", "upsert")
            put("payload", sale.toString())
            put("status", "pending")
            put("attempts", 0)
            put("created_at", now)
        })
        return operationId
    }

    fun listPending(deviceId: String? = null, limit: Int = 100): List<DavinciOfflineOperation> {
        val safeLimit = limit.coerceIn(1, 500)
        val selection = if (deviceId.isNullOrBlank()) "" else "AND device_id=?"
        val args = if (deviceId.isNullOrBlank()) arrayOf(safeLimit.toString())
            else arrayOf(deviceId, safeLimit.toString())
        return helper.readableDatabase.rawQuery(
            """
            SELECT o.operation_id,o.device_id,o.entity_type,o.entity_id,o.operation,
                   o.payload,o.status,o.attempts,o.created_at,o.last_error
            FROM sync_outbox o
            WHERE o.status IN ('pending','failed')
              AND NOT EXISTS (
                SELECT 1 FROM sync_conflicts c
                WHERE c.operation_id=o.operation_id AND c.status IN ('pending','rejected')
              )
              $selection
            ORDER BY o.created_at,o.rowid
            LIMIT ?
            """.trimIndent(), args
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(
                    DavinciOfflineOperation(
                        operationId = cursor.getString(0),
                        deviceId = cursor.getString(1),
                        entityType = cursor.getString(2),
                        entityId = cursor.getString(3),
                        operation = cursor.getString(4),
                        payload = JSONObject(cursor.getString(5)),
                        status = cursor.getString(6),
                        attempts = cursor.getInt(7),
                        createdAt = cursor.getString(8),
                        lastError = if (cursor.isNull(9)) null else cursor.getString(9)
                    )
                )
            }
        }
    }

    fun listHeldConflicts(deviceId: String, limit: Int = 100): List<DavinciOfflineOperation> {
        return helper.readableDatabase.rawQuery(
            """
            SELECT o.operation_id,o.device_id,o.entity_type,o.entity_id,o.operation,
                   o.payload,o.status,o.attempts,o.created_at,o.last_error
            FROM sync_outbox o
            INNER JOIN sync_conflicts c ON c.operation_id=o.operation_id
            WHERE o.device_id=? AND c.status='pending'
            ORDER BY c.created_at,o.rowid
            LIMIT ?
            """.trimIndent(),
            arrayOf(deviceId, limit.coerceIn(1, 500).toString())
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(
                    DavinciOfflineOperation(
                        operationId = cursor.getString(0),
                        deviceId = cursor.getString(1),
                        entityType = cursor.getString(2),
                        entityId = cursor.getString(3),
                        operation = cursor.getString(4),
                        payload = JSONObject(cursor.getString(5)),
                        status = cursor.getString(6),
                        attempts = cursor.getInt(7),
                        createdAt = cursor.getString(8),
                        lastError = if (cursor.isNull(9)) null else cursor.getString(9)
                    )
                )
            }
        }
    }

    fun applyServerConflictDecision(operationId: String, status: String, reason: String?): Boolean {
        require(status == "pending" || status == "rejected") { "Unsupported server conflict status." }
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val operation = db.rawQuery(
                "SELECT device_id,entity_type,entity_id,payload FROM sync_outbox WHERE operation_id=?",
                arrayOf(operationId)
            ).use { cursor ->
                if (!cursor.moveToFirst()) null else arrayOf(
                    cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getString(3)
                )
            } ?: return false
            val existingId = db.rawQuery(
                "SELECT id FROM sync_conflicts WHERE operation_id=?",
                arrayOf(operationId)
            ).use { if (it.moveToFirst()) it.getString(0) else null }
            val now = Instant.now().toString()
            if (existingId != null) {
                db.update("sync_conflicts", ContentValues().apply {
                    put("reason", (reason ?: "Server requires conflict review.").take(1000))
                    put("status", status)
                }, "operation_id=?", arrayOf(operationId))
            } else {
                db.insertOrThrow("sync_conflicts", null, ContentValues().apply {
                    put("id", UUID.randomUUID().toString())
                    put("operation_id", operationId)
                    put("device_id", operation[0])
                    put("entity_type", operation[1])
                    put("entity_id", operation[2])
                    put("payload", operation[3])
                    put("reason", (reason ?: "Server requires conflict review.").take(1000))
                    put("status", status)
                    put("created_at", now)
                })
            }
            db.update("sync_outbox", ContentValues().apply {
                put("status", "failed")
                put("last_error", reason?.take(1000))
            }, "operation_id=?", arrayOf(operationId))
            db.setTransactionSuccessful()
            return true
        } finally {
            db.endTransaction()
        }
    }

    fun acknowledge(operationId: String): Boolean {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val changed = db.update("sync_outbox", ContentValues().apply {
                put("status", "acknowledged")
                put("acknowledged_at", Instant.now().toString())
                putNull("last_error")
            }, "operation_id=?", arrayOf(operationId))
            db.update("sync_conflicts", ContentValues().apply {
                put("status", "resolved")
                put("resolved_at", Instant.now().toString())
            }, "operation_id=? AND status='pending'", arrayOf(operationId))
            db.setTransactionSuccessful()
            return changed == 1
        } finally {
            db.endTransaction()
        }
    }

    fun recordFailure(operationId: String, error: String): Boolean {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val changed = db.update("sync_outbox", ContentValues().apply {
                put("status", "failed")
                put("last_error", error.take(1000))
            }, "operation_id=?", arrayOf(operationId))
            if (changed == 1) {
                db.execSQL(
                    "UPDATE sync_outbox SET attempts=attempts+1 WHERE operation_id=?",
                    arrayOf(operationId)
                )
            }
            db.setTransactionSuccessful()
            return changed == 1
        } finally {
            db.endTransaction()
        }
    }

    fun holdConflict(operationId: String, reason: String): Boolean =
        recordServerDecision(operationId, reason, "pending")

    fun rejectOperation(operationId: String, reason: String): Boolean =
        recordServerDecision(operationId, reason, "rejected")

    private fun recordServerDecision(operationId: String, reason: String, conflictStatus: String): Boolean {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val operation = db.rawQuery(
                "SELECT device_id,entity_type,entity_id,payload FROM sync_outbox WHERE operation_id=?",
                arrayOf(operationId)
            ).use { cursor ->
                if (!cursor.moveToFirst()) null else arrayOf(
                    cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getString(3)
                )
            } ?: return false
            db.insertWithOnConflict("sync_conflicts", null, ContentValues().apply {
                put("id", UUID.randomUUID().toString())
                put("operation_id", operationId)
                put("device_id", operation[0])
                put("entity_type", operation[1])
                put("entity_id", operation[2])
                put("payload", operation[3])
                put("reason", reason.take(1000))
                put("status", conflictStatus)
                put("created_at", Instant.now().toString())
            }, SQLiteDatabase.CONFLICT_IGNORE)
            db.update("sync_outbox", ContentValues().apply {
                put("status", "failed")
                put("last_error", reason.take(1000))
            }, "operation_id=?", arrayOf(operationId))
            db.setTransactionSuccessful()
            return true
        } finally {
            db.endTransaction()
        }
    }

    private fun getSetting(key: String): String? =
        helper.readableDatabase.rawQuery(
            "SELECT value FROM app_settings WHERE key=?", arrayOf(key)
        ).use { if (it.moveToFirst()) it.getString(0) else null }

    private fun putSetting(db: SQLiteDatabase, key: String, value: String) {
        db.insertWithOnConflict("app_settings", null, ContentValues().apply {
            put("key", key)
            put("value", value)
            put("updated_at", Instant.now().toString())
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    companion object {
        private const val KEY_DEVICE_ID = "sync.device_id"
        private const val KEY_DEVICE_REGISTRATION = "sync.device_registration"
        private const val KEY_POS_SNAPSHOT = "sync.pos_snapshot"
    }
}
