package com.smartpos.studio

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject

@CapacitorPlugin(name = "PosLocalDatabase")
class PosLocalDatabasePlugin : Plugin() {
    private lateinit var helper: PosDatabaseHelper

    override fun load() {
        helper = PosDatabaseHelper(context)
    }

    @PluginMethod
    fun initialize(call: PluginCall) {
        try {
            val db = helper.writableDatabase
            val result = JSObject()
            result.put("ready", true)
            result.put("schemaVersion", db.version)
            result.put("database", "pos-local.db")
            call.resolve(result)
        } catch (error: Exception) {
            call.reject("تعذر تهيئة قاعدة البيانات المحلية", error)
        }
    }

    @PluginMethod
    fun putRecord(call: PluginCall) {
        val entity = call.getString("entity")?.trim().orEmpty()
        val recordId = call.getString("recordId")?.trim().orEmpty()
        val record = call.getObject("record")
        if (entity.isBlank() || recordId.isBlank() || record == null) {
            call.reject("entity و recordId و record حقول مطلوبة")
            return
        }
        try {
            val values = ContentValues().apply {
                put("entity", entity)
                put("record_id", recordId)
                put("json", record.toString())
                put("updated_at", System.currentTimeMillis())
                put("sync_state", call.getString("syncState") ?: "local")
            }
            helper.writableDatabase.insertWithOnConflict(
                "pos_records", null, values, SQLiteDatabase.CONFLICT_REPLACE
            )
            call.resolve(JSObject().put("saved", true).put("recordId", recordId))
        } catch (error: Exception) {
            call.reject("تعذر حفظ السجل المحلي", error)
        }
    }

    /**
     * Atomically persists a local record and its synchronization operation.
     * This prevents a committed local write from being lost between separate
     * record and outbox calls when the process is interrupted.
     */
    @PluginMethod
    fun saveRecordAndEnqueueOperation(call: PluginCall) {
        val entity = call.getString("entity")?.trim().orEmpty()
        val recordId = call.getString("recordId")?.trim().orEmpty()
        val record = call.getObject("record")
        val operationId = call.getString("operationId")?.trim().orEmpty()
        val type = call.getString("type")?.trim().orEmpty()
        val payload = call.getObject("payload")
        if (entity.isBlank() || recordId.isBlank() || record == null ||
            operationId.isBlank() || type.isBlank() || payload == null) {
            call.reject("بيانات السجل والعملية مطلوبة للحفظ الذري")
            return
        }

        val db = helper.writableDatabase
        try {
            var response: JSObject
            db.beginTransaction()
            try {
                val existing = db.query(
                    "pos_outbox", arrayOf("operation_id"), "operation_id = ?",
                    arrayOf(operationId), null, null, null
                ).use { it.moveToFirst() }

                if (existing) {
                    response = JSObject().put("saved", false).put("queued", true)
                        .put("duplicate", true).put("operationId", operationId)
                } else {
                    val recordValues = ContentValues().apply {
                        put("entity", entity)
                        put("record_id", recordId)
                        put("json", record.toString())
                        put("updated_at", System.currentTimeMillis())
                        put("sync_state", "pending")
                    }
                    val recordResult = db.insertWithOnConflict(
                        "pos_records", null, recordValues, SQLiteDatabase.CONFLICT_REPLACE
                    )
                    if (recordResult == -1L) throw IllegalStateException("Local record could not be saved")

                    val operationValues = ContentValues().apply {
                        put("operation_id", operationId)
                        put("type", type)
                        put("payload", payload.toString())
                        put("device_id", call.getString("deviceId") ?: "")
                        put("tenant_id", call.getString("tenantId") ?: "")
                        put("branch_id", call.getString("branchId") ?: "")
                        put("actor", call.getString("actor") ?: "")
                        put("schema_version", call.getInt("schemaVersion") ?: 1)
                        put("created_at", System.currentTimeMillis())
                        put("status", "pending")
                    }
                    val inserted = db.insertWithOnConflict(
                        "pos_outbox", null, operationValues, SQLiteDatabase.CONFLICT_IGNORE
                    )
                    if (inserted == -1L) throw IllegalStateException("Operation could not be queued")

                    response = JSObject().put("saved", true).put("queued", true)
                        .put("duplicate", false).put("operationId", operationId)
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            // Resolve only after SQLite has committed the transaction.
            call.resolve(response)
        } catch (error: Exception) {
            call.reject("تعذر حفظ السجل وعملية المزامنة بصورة ذرية", error)
        }
    }

    @PluginMethod
    fun getRecords(call: PluginCall) {
        val entity = call.getString("entity")?.trim().orEmpty()
        if (entity.isBlank()) {
            call.reject("entity حقل مطلوب")
            return
        }
        try {
            val rows = JSArray()
            helper.readableDatabase.query(
                "pos_records", arrayOf("record_id", "json", "sync_state", "updated_at"),
                "entity = ?", arrayOf(entity), null, null, "updated_at ASC, record_id ASC"
            ).use { cursor ->
                while (cursor.moveToNext()) {
                    val item = JSObject()
                    item.put("recordId", cursor.getString(0))
                    item.put("record", JSONObject(cursor.getString(1)))
                    item.put("syncState", cursor.getString(2))
                    item.put("updatedAt", cursor.getLong(3))
                    rows.put(item)
                }
            }
            call.resolve(JSObject().put("records", rows))
        } catch (error: Exception) {
            call.reject("تعذر قراءة السجلات المحلية", error)
        }
    }

    @PluginMethod
    fun enqueueOperation(call: PluginCall) {
        val operationId = call.getString("operationId")?.trim().orEmpty()
        val type = call.getString("type")?.trim().orEmpty()
        val payload = call.getObject("payload")
        if (operationId.isBlank() || type.isBlank() || payload == null) {
            call.reject("operationId و type و payload حقول مطلوبة")
            return
        }
        try {
            val values = ContentValues().apply {
                put("operation_id", operationId)
                put("type", type)
                put("payload", payload.toString())
                put("device_id", call.getString("deviceId") ?: "")
                put("tenant_id", call.getString("tenantId") ?: "")
                put("branch_id", call.getString("branchId") ?: "")
                put("actor", call.getString("actor") ?: "")
                put("schema_version", call.getInt("schemaVersion") ?: 1)
                put("created_at", System.currentTimeMillis())
                put("status", "pending")
            }
            val result = helper.writableDatabase.insertWithOnConflict(
                "pos_outbox", null, values, SQLiteDatabase.CONFLICT_IGNORE
            )
            val duplicate = result == -1L && helper.readableDatabase.query(
                "pos_outbox", arrayOf("operation_id"), "operation_id = ?", arrayOf(operationId), null, null, null
            ).use { it.moveToFirst() }
            call.resolve(JSObject().put("queued", result != -1L || duplicate).put("duplicate", duplicate).put("operationId", operationId))
        } catch (error: Exception) {
            call.reject("تعذر إضافة العملية إلى قائمة المزامنة", error)
        }
    }

    @PluginMethod
    fun listPendingOperations(call: PluginCall) {
        try {
            val rows = JSArray()
            helper.readableDatabase.query(
                "pos_outbox", null, "status IN ('pending','error')",
                null, null, null, "created_at ASC"
            ).use { cursor ->
                while (cursor.moveToNext()) {
                    val item = JSObject()
                    item.put("operationId", cursor.getString(cursor.getColumnIndexOrThrow("operation_id")))
                    item.put("type", cursor.getString(cursor.getColumnIndexOrThrow("type")))
                    item.put("payload", JSONObject(cursor.getString(cursor.getColumnIndexOrThrow("payload"))))
                    item.put("deviceId", cursor.getString(cursor.getColumnIndexOrThrow("device_id")))
                    item.put("tenantId", cursor.getString(cursor.getColumnIndexOrThrow("tenant_id")))
                    item.put("branchId", cursor.getString(cursor.getColumnIndexOrThrow("branch_id")))
                    item.put("actor", cursor.getString(cursor.getColumnIndexOrThrow("actor")))
                    item.put("schemaVersion", cursor.getInt(cursor.getColumnIndexOrThrow("schema_version")))
                    item.put("createdAt", cursor.getLong(cursor.getColumnIndexOrThrow("created_at")))
                    item.put("retryCount", cursor.getInt(cursor.getColumnIndexOrThrow("retry_count")))
                    rows.put(item)
                }
            }
            call.resolve(JSObject().put("operations", rows))
        } catch (error: Exception) {
            call.reject("تعذر قراءة قائمة العمليات المعلقة", error)
        }
    }

    @PluginMethod
    fun acknowledgeOperation(call: PluginCall) {
        updateOperationStatus(call, "synced", null)
    }

    @PluginMethod
    fun markOperationError(call: PluginCall) {
        updateOperationStatus(call, "error", call.getString("message") ?: "Sync failed")
    }

    private fun updateOperationStatus(call: PluginCall, status: String, message: String?) {
        val operationId = call.getString("operationId")?.trim().orEmpty()
        if (operationId.isBlank()) {
            call.reject("operationId حقل مطلوب")
            return
        }
        try {
            val values = ContentValues().apply {
                put("status", status)
                if (message != null) put("last_error", message)
            }
            val db = helper.writableDatabase
            db.beginTransaction()
            try {
                db.update("pos_outbox", values, "operation_id = ?", arrayOf(operationId))
                if (status == "error") {
                    db.execSQL("UPDATE pos_outbox SET retry_count = retry_count + 1 WHERE operation_id = ?", arrayOf(operationId))
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            call.resolve(JSObject().put("updated", true).put("operationId", operationId))
        } catch (error: Exception) {
            call.reject("تعذر تحديث حالة العملية", error)
        }
    }

    @PluginMethod
    fun setMeta(call: PluginCall) {
        val key = call.getString("key")?.trim().orEmpty()
        val value = call.getString("value")
        if (key.isBlank() || value == null) {
            call.reject("key و value حقول مطلوبة")
            return
        }
        val values = ContentValues().apply { put("key", key); put("value", value) }
        helper.writableDatabase.insertWithOnConflict("pos_meta", null, values, SQLiteDatabase.CONFLICT_REPLACE)
        call.resolve(JSObject().put("saved", true))
    }

    @PluginMethod
    fun getMeta(call: PluginCall) {
        val key = call.getString("key")?.trim().orEmpty()
        if (key.isBlank()) { call.reject("key حقل مطلوب"); return }
        helper.readableDatabase.query("pos_meta", arrayOf("value"), "key = ?", arrayOf(key), null, null, null).use { cursor ->
            val result = JSObject()
            if (cursor.moveToFirst()) result.put("value", cursor.getString(0))
            call.resolve(result)
        }
    }
}

private class PosDatabaseHelper(context: android.content.Context) :
    SQLiteOpenHelper(context, "pos-local.db", null, 2) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE pos_records (entity TEXT NOT NULL, record_id TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL, sync_state TEXT NOT NULL DEFAULT 'local', PRIMARY KEY(entity, record_id))")
        db.execSQL("CREATE INDEX idx_pos_records_entity_updated ON pos_records(entity, updated_at)")
        db.execSQL("CREATE TABLE pos_outbox (operation_id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT '', tenant_id TEXT NOT NULL DEFAULT '', branch_id TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT '', schema_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT)")
        db.execSQL("CREATE INDEX idx_pos_outbox_status_created ON pos_outbox(status, created_at)")
        db.execSQL("CREATE TABLE pos_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE pos_outbox ADD COLUMN tenant_id TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE pos_outbox ADD COLUMN actor TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE pos_outbox ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1")
        }
    }
}
