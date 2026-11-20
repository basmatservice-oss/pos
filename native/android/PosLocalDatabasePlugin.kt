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
import org.json.JSONTokener

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
        val syncState = call.getString("syncState") ?: "local"
        if (entity.isBlank() || recordId.isBlank() || record == null ||
            syncState !in setOf("local", "pending", "synced", "error")) {
            call.reject("entity و recordId و record وحالة مزامنة صحيحة مطلوبة")
            return
        }
        try {
            val values = ContentValues().apply {
                put("entity", entity)
                put("record_id", recordId)
                put("json", record.toString())
                put("updated_at", System.currentTimeMillis())
                put("sync_state", syncState)
            }
            val inserted = helper.writableDatabase.insertWithOnConflict(
                "pos_records", null, values, SQLiteDatabase.CONFLICT_REPLACE
            )
            if (inserted == -1L) throw IllegalStateException("Local record could not be saved")
            call.resolve(JSObject().put("saved", true).put("recordId", recordId))
        } catch (error: Exception) {
            call.reject("تعذر حفظ السجل المحلي", error)
        }
    }

    /**
     * Atomically writes a batch of records for repository-level mutations.
     * All input is validated before the transaction starts, so invalid input
     * cannot leave a partially-applied batch in the local database.
     */
    @PluginMethod
    fun putRecords(call: PluginCall) {
        val records = call.getArray("records")
        if (records == null) {
            call.reject("records حقل مطلوب")
            return
        }

        try {
            val validated = ArrayList<Pair<String, ContentValues>>(records.length())
            val identities = HashSet<String>()
            for (index in 0 until records.length()) {
                val item = records.getJSONObject(index)
                val entity = item.optString("entity").trim()
                val recordId = item.optString("recordId").trim()
                val record = item.optJSONObject("record")
                val syncState = item.optString("syncState", "local")
                if (entity.isBlank() || recordId.isBlank() || record == null ||
                    syncState !in setOf("local", "pending", "synced", "error")) {
                    throw IllegalArgumentException("سجل غير صالح ضمن دفعة SQLite")
                }
                val identity = JSONArray().put(entity).put(recordId).toString()
                if (!identities.add(identity)) {
                    throw IllegalArgumentException("مفتاح سجل مكرر ضمن دفعة SQLite")
                }
                val values = ContentValues().apply {
                    put("entity", entity)
                    put("record_id", recordId)
                    put("json", record.toString())
                    put("updated_at", System.currentTimeMillis())
                    put("sync_state", syncState)
                }
                validated.add(Pair(entity, values))
            }

            val db = helper.writableDatabase
            var savedCount = 0
            db.beginTransaction()
            try {
                for ((_, values) in validated) {
                    val inserted = db.insertWithOnConflict(
                        "pos_records", null, values, SQLiteDatabase.CONFLICT_REPLACE
                    )
                    if (inserted == -1L) {
                        throw IllegalStateException("تعذر حفظ دفعة السجلات المحلية")
                    }
                    savedCount += 1
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            call.resolve(JSObject().put("saved", true).put("count", savedCount))
        } catch (error: Exception) {
            call.reject("تعذر حفظ دفعة السجلات المحلية بصورة ذرية", error)
        }
    }

    /**
     * Applies mixed record inserts/updates/deletes in one SQLite transaction.
     * Duplicate entity/key mutations are rejected before any database write.
     */
    @PluginMethod
    fun applyRecordChanges(call: PluginCall) {
        val changes = call.getArray("changes")
        if (changes == null) {
            call.reject("changes حقل مطلوب")
            return
        }
        val ifAbsentEntity = call.getString("ifAbsentEntity")?.trim()
        val ifAbsentRecordId = call.getString("ifAbsentRecordId")?.trim()
        val ifAbsentField = call.getString("ifAbsentField")?.trim()
        val ifAbsentValue = call.getString("ifAbsentValue")
        val ifMatchEntity = call.getString("ifMatchEntity")?.trim()
        val ifMatchRecordId = call.getString("ifMatchRecordId")?.trim()
        val ifMatchField = call.getString("ifMatchField")?.trim()
        val ifMatchValue = call.getString("ifMatchValue")
        val ifMatchGuardsArray = call.getArray("ifMatchGuards")
        class MatchGuard(val entity: String, val recordId: String, val field: String, val expectedValue: String)
        val matchGuards = ArrayList<MatchGuard>()
        if (ifMatchGuardsArray != null) {
            for (index in 0 until ifMatchGuardsArray.length()) {
                val item = ifMatchGuardsArray.optJSONObject(index)
                if (item == null) {
                    call.reject("شرط مقارنة SQLite متعدد غير صالح")
                    return
                }
                val entity = item.optString("entity").trim()
                val recordId = item.optString("recordId").trim()
                val field = item.optString("field").trim()
                val expectedValue = item.optString("expectedValue")
                if (entity.isBlank() || recordId.isBlank() || field.isBlank() || expectedValue.isBlank()) {
                    call.reject("شرط مقارنة SQLite متعدد غير مكتمل")
                    return
                }
                matchGuards.add(MatchGuard(entity, recordId, field, expectedValue))
            }
            if (matchGuards.isEmpty()) {
                call.reject("قائمة شروط مقارنة SQLite لا يمكن أن تكون فارغة")
                return
            }
        }
        val hasRecordGuard = !ifAbsentEntity.isNullOrBlank() && !ifAbsentRecordId.isNullOrBlank()
        val hasFieldGuard = !ifAbsentEntity.isNullOrBlank() && !ifAbsentField.isNullOrBlank() && ifAbsentValue != null
        val hasMatchGuard = !ifMatchEntity.isNullOrBlank() && !ifMatchRecordId.isNullOrBlank() &&
            !ifMatchField.isNullOrBlank() && ifMatchValue != null
        val hasAnySingleMatchInput = ifMatchEntity != null || ifMatchRecordId != null || ifMatchField != null || ifMatchValue != null
        val hasAnyMatchInput = hasAnySingleMatchInput || ifMatchGuardsArray != null
        if ((ifMatchGuardsArray != null && hasAnySingleMatchInput) ||
            (ifAbsentRecordId != null && (ifAbsentEntity.isNullOrBlank() || ifAbsentRecordId.isBlank())) ||
            ((ifAbsentField == null) != (ifAbsentValue == null)) ||
            (ifAbsentField != null && (ifAbsentField.isBlank() || ifAbsentEntity.isNullOrBlank())) ||
            (hasRecordGuard && ifAbsentField != null) ||
            (ifAbsentEntity != null && ifAbsentEntity.isBlank()) ||
            (ifAbsentEntity != null && !hasRecordGuard && !hasFieldGuard) ||
            (ifAbsentEntity == null && (ifAbsentRecordId != null || ifAbsentField != null || ifAbsentValue != null)) ||
            (hasAnySingleMatchInput && !hasMatchGuard) ||
            (ifMatchGuardsArray != null && matchGuards.isEmpty())) {
            call.reject("شرط منع التكرار أو المقارنة الذرية غير مكتمل")
            return
        }

        try {
            class ValidatedChange(val action: String, val entity: String, val recordId: String, val values: ContentValues?)
            val validated = ArrayList<ValidatedChange>()
            val identities = HashSet<String>()
            for (index in 0 until changes.length()) {
                val item = changes.getJSONObject(index)
                val action = item.optString("action").trim()
                val entity = item.optString("entity").trim()
                val recordId = item.optString("recordId").trim()
                if (action !in setOf("put", "delete") || entity.isBlank() || recordId.isBlank()) {
                    throw IllegalArgumentException("تغيير سجل SQLite غير صالح")
                }
                val identity = JSONArray().put(entity).put(recordId).toString()
                if (!identities.add(identity)) {
                    throw IllegalArgumentException("تغيير مكرر لنفس السجل ضمن دفعة SQLite")
                }
                val values = if (action == "put") {
                    val record = item.optJSONObject("record")
                        ?: throw IllegalArgumentException("بيانات السجل مطلوبة لعملية put")
                    val syncState = item.optString("syncState", "local")
                    if (syncState !in setOf("local", "pending", "synced", "error")) {
                        throw IllegalArgumentException("حالة مزامنة غير صالحة")
                    }
                    ContentValues().apply {
                        put("entity", entity)
                        put("record_id", recordId)
                        put("json", record.toString())
                        put("updated_at", System.currentTimeMillis())
                        put("sync_state", syncState)
                    }
                } else null
                validated.add(ValidatedChange(action, entity, recordId, values))
            }

            val db = helper.writableDatabase
            var applied = 0
            var skipped = false
            db.beginTransaction()
            try {
                if (hasRecordGuard) {
                    db.query(
                        "pos_records", arrayOf("record_id"),
                        "entity = ? AND record_id = ?", arrayOf(ifAbsentEntity, ifAbsentRecordId),
                        null, null, null, "1"
                    ).use { cursor ->
                        if (cursor.moveToFirst()) skipped = true
                    }
                }
                if (!skipped && hasFieldGuard) {
                    db.query("pos_records", arrayOf("json"), "entity = ?", arrayOf(ifAbsentEntity), null, null, null).use { cursor ->
                        while (!skipped && cursor.moveToNext()) {
                            val json = cursor.getString(0)
                            val record = try { JSONObject(json) } catch (_: Exception) { null }
                            if (record != null && record.opt(ifAbsentField!!) != null &&
                                record.opt(ifAbsentField!!).toString() == ifAbsentValue) {
                                skipped = true
                            }
                        }
                    }
                }
                if (!skipped && hasAnyMatchInput) {
                    val guardsToCheck = if (hasMatchGuard) {
                        listOf(MatchGuard(ifMatchEntity!!, ifMatchRecordId!!, ifMatchField!!, ifMatchValue!!))
                    } else matchGuards
                    for (guard in guardsToCheck) {
                        if (skipped) break
                        db.query(
                            "pos_records", arrayOf("json"),
                            "entity = ? AND record_id = ?", arrayOf(guard.entity, guard.recordId),
                            null, null, null, "1"
                        ).use { cursor ->
                            if (!cursor.moveToFirst()) {
                                skipped = true
                            } else {
                                val record = try { JSONObject(cursor.getString(0)) } catch (_: Exception) { null }
                                if (record == null || record.opt(guard.field) == null ||
                                    record.opt(guard.field).toString() != guard.expectedValue) skipped = true
                            }
                        }
                    }
                }
                if (!skipped) for (change in validated) {
                    val action = change.action
                    val entity = change.entity
                    val recordId = change.recordId
                    val values = change.values
                    if (action == "put") {
                        val inserted = db.insertWithOnConflict(
                            "pos_records", null, values, SQLiteDatabase.CONFLICT_REPLACE
                        )
                        if (inserted == -1L) throw IllegalStateException("تعذر حفظ سجل ضمن الدفعة")
                        applied += 1
                    } else {
                        applied += db.delete(
                            "pos_records", "entity = ? AND record_id = ?", arrayOf(entity, recordId)
                        )
                    }
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            call.resolve(JSObject().put("applied", applied).put("count", validated.size).put("skipped", skipped))
        } catch (error: Exception) {
            call.reject("تعذر تطبيق تغييرات السجلات بصورة ذرية", error)
        }
    }

    @PluginMethod
    fun replaceRecords(call: PluginCall) {
        val entity = call.getString("entity")?.trim().orEmpty()
        val records = call.getArray("records")
        if (entity.isBlank() || records == null) {
            call.reject("entity و records مطلوبان لاستبدال سجلات الكيان")
            return
        }
        try {
            // Validate the complete snapshot before deleting any existing rows.
            // Duplicate IDs must not silently overwrite one another during replace.
            class ValidatedRecord(val recordId: String, val values: ContentValues)
            val validated = ArrayList<ValidatedRecord>(records.length())
            val identities = HashSet<String>()
            for (index in 0 until records.length()) {
                val item = records.getJSONObject(index)
                val recordId = item.optString("recordId").trim()
                val record = item.optJSONObject("record")
                val syncState = item.optString("syncState", "local")
                if (recordId.isBlank() || record == null ||
                    syncState !in setOf("local", "pending", "synced", "error")) {
                    throw IllegalArgumentException("سجل محلي غير صالح ضمن الكيان $entity")
                }
                if (!identities.add(recordId)) {
                    throw IllegalArgumentException("معرف سجل مكرر ضمن لقطة الكيان $entity: $recordId")
                }
                val values = ContentValues().apply {
                    put("entity", entity)
                    put("record_id", recordId)
                    put("json", record.toString())
                    put("updated_at", System.currentTimeMillis())
                    put("sync_state", syncState)
                }
                validated.add(ValidatedRecord(recordId, values))
            }

            val db = helper.writableDatabase
            var savedCount = 0
            db.beginTransaction()
            try {
                // This method receives a complete Dexie snapshot for one entity.
                // Replace the entity atomically so deleted Dexie rows cannot be
                // resurrected from stale SQLite records after a restart.
                db.delete("pos_records", "entity = ?", arrayOf(entity))
                for (item in validated) {
                    val rowId = db.insertWithOnConflict(
                        "pos_records", null, item.values, SQLiteDatabase.CONFLICT_REPLACE
                    )
                    if (rowId == -1L) {
                        throw IllegalStateException("تعذر حفظ سجل ضمن الكيان $entity")
                    }
                    savedCount += 1
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            call.resolve(JSObject().put("replaced", true).put("count", savedCount))
        } catch (error: Exception) {
            call.reject("تعذر استبدال سجلات الكيان في SQLite", error)
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
                    "pos_outbox", arrayOf("type", "payload"), "operation_id = ?",
                    arrayOf(operationId), null, null, null
                ).use { cursor ->
                    if (cursor.moveToFirst()) Pair(cursor.getString(0), cursor.getString(1)) else null
                }

                if (existing != null) {
                    if (existing.first != type || existing.second != payload.toString()) {
                        throw IllegalStateException("Operation ID was reused with a different type or payload")
                    }
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
                        put("schema_version", (call.getInt("schemaVersion") ?: 1).coerceAtLeast(1))
                        put("created_at", (call.getLong("createdAt") ?: System.currentTimeMillis()).coerceAtLeast(0L))
                        put("retry_count", (call.getInt("retryCount") ?: 0).coerceAtLeast(0))
                        val nextRetryAt = call.getLong("nextRetryAt")
                        if (nextRetryAt != null && nextRetryAt > 0L) put("next_retry_at", nextRetryAt)
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
    fun getRecord(call: PluginCall) {
        val entity = call.getString("entity")?.trim().orEmpty()
        val recordId = call.getString("recordId")?.trim().orEmpty()
        if (entity.isBlank() || recordId.isBlank()) {
            call.reject("entity و recordId مطلوبان لقراءة سجل محدد")
            return
        }
        try {
            val result = helper.readableDatabase.query(
                "pos_records", arrayOf("record_id", "json", "sync_state", "updated_at"),
                "entity = ? AND record_id = ?", arrayOf(entity, recordId),
                null, null, null, "1"
            ).use { cursor ->
                if (!cursor.moveToFirst()) null else JSObject()
                    .put("recordId", cursor.getString(0))
                    .put("record", JSONObject(cursor.getString(1)))
                    .put("syncState", cursor.getString(2))
                    .put("updatedAt", cursor.getLong(3))
            }
            call.resolve(JSObject().put("found", result != null).put("item", result))
        } catch (error: Exception) {
            call.reject("تعذر قراءة السجل المحلي المحدد", error)
        }
    }

    @PluginMethod
    fun getRecordsByIds(call: PluginCall) {
        val entity = call.getString("entity")?.trim().orEmpty()
        val requestedIds = call.getArray("recordIds")
        if (entity.isBlank() || requestedIds == null) {
            call.reject("entity و recordIds مطلوبان")
            return
        }
        try {
            val ids = LinkedHashSet<String>()
            for (index in 0 until requestedIds.length()) {
                val id = requestedIds.optString(index).trim()
                if (id.isBlank()) throw IllegalArgumentException("recordIds يحتوي على معرف فارغ")
                ids.add(id)
            }

            val rows = JSArray()
            val db = helper.readableDatabase
            // Keep each IN query below SQLite's bind-parameter limit.
            ids.toList().chunked(900).forEach { chunk ->
                val placeholders = List(chunk.size) { "?" }.joinToString(",")
                val args = arrayOf(entity) + chunk.toTypedArray()
                db.query(
                    "pos_records", arrayOf("record_id", "json", "sync_state", "updated_at"),
                    "entity = ? AND record_id IN ($placeholders)", args,
                    null, null, "updated_at ASC, record_id ASC"
                ).use { cursor ->
                    while (cursor.moveToNext()) {
                        rows.put(
                            JSObject()
                                .put("recordId", cursor.getString(0))
                                .put("record", JSONObject(cursor.getString(1)))
                                .put("syncState", cursor.getString(2))
                                .put("updatedAt", cursor.getLong(3))
                        )
                    }
                }
            }
            call.resolve(JSObject().put("records", rows))
        } catch (error: Exception) {
            call.reject("تعذر قراءة مجموعة السجلات المحلية المحددة", error)
        }
    }

    @PluginMethod
    fun getRecordsByField(call: PluginCall) {
        val entity = call.getString("entity")?.trim().orEmpty()
        val field = call.getString("field")?.trim().orEmpty()
        val valueJson = call.getString("valueJson")
        val requestedLimit = call.getInt("limit", 0)
        if (entity.isBlank() || field.isBlank() || valueJson.isNullOrBlank() ||
            !field.matches(Regex("[A-Za-z_][A-Za-z0-9_]*")) || requestedLimit < 0) {
            call.reject("entity و field و valueJson صالحون مطلوبة")
            return
        }
        try {
            // Prefer SQLite JSON1; Android builds without JSON1 use a native-side
            // cursor fallback so Android 8 remains functional without WebView scans.
            val path = "\$." + field
            val rows = JSArray()
            val database = helper.readableDatabase
            try {
                database.rawQuery(
                    "SELECT record_id, json, sync_state, updated_at FROM pos_records " +
                        "WHERE entity = ? AND json_valid(json) AND json_extract(json, ?) = json_extract(?, '\$') " +
                        "ORDER BY updated_at ASC, record_id ASC" + if (requestedLimit > 0) " LIMIT ?" else "",
                    if (requestedLimit > 0) arrayOf(entity, path, valueJson, requestedLimit.toString()) else arrayOf(entity, path, valueJson)
                ).use { cursor ->
                    while (cursor.moveToNext()) {
                        rows.put(
                            JSObject()
                                .put("recordId", cursor.getString(0))
                                .put("record", JSONObject(cursor.getString(1)))
                                .put("syncState", cursor.getString(2))
                                .put("updatedAt", cursor.getLong(3))
                        )
                    }
                }
            } catch (_: Exception) {
                val expected = JSONTokener(valueJson).nextValue()
                database.query(
                    "pos_records", arrayOf("record_id", "json", "sync_state", "updated_at"),
                    "entity = ?", arrayOf(entity), null, null, "updated_at ASC, record_id ASC"
                ).use { cursor ->
                    while (cursor.moveToNext()) {
                        val record = JSONObject(cursor.getString(1))
                        val actual = record.opt(field)
                        val matches = when {
                            actual is Number && expected is Number -> actual.toDouble() == expected.toDouble()
                            else -> actual == expected
                        }
                        if (matches) {
                            rows.put(
                                JSObject()
                                    .put("recordId", cursor.getString(0))
                                    .put("record", record)
                                    .put("syncState", cursor.getString(2))
                                    .put("updatedAt", cursor.getLong(3))
                            )
                            if (requestedLimit > 0 && rows.length() >= requestedLimit) break
                        }
                    }
                }
            }
            call.resolve(JSObject().put("records", rows))
        } catch (error: Exception) {
            call.reject("تعذر تنفيذ البحث المحلي بالحقل المحدد", error)
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
    fun updateRecordSyncState(call: PluginCall) {
        val entity = call.getString("entity")?.trim().orEmpty()
        val recordId = call.getString("recordId")?.trim().orEmpty()
        val state = call.getString("syncState")?.trim().orEmpty()
        if (entity.isBlank() || recordId.isBlank() ||
            state !in setOf("local", "pending", "synced", "error")) {
            call.reject("entity و recordId وحالة مزامنة صحيحة مطلوبة")
            return
        }
        try {
            val db = helper.writableDatabase
            var changed = 0
            db.beginTransaction()
            try {
                val currentJson = db.query(
                    "pos_records", arrayOf("json"), "entity = ? AND record_id = ?",
                    arrayOf(entity, recordId), null, null, null, "1"
                ).use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0) else null
                }
                if (currentJson != null) {
                    // Keep the JSON record and indexed sync_state column consistent so
                    // startup restoration never revives a stale syncStatus value.
                    val updatedJson = JSONObject(currentJson).put("syncStatus", state).toString()
                    val values = ContentValues().apply {
                        put("json", updatedJson)
                        put("sync_state", state)
                        put("updated_at", System.currentTimeMillis())
                    }
                    changed = db.update(
                        "pos_records", values, "entity = ? AND record_id = ?",
                        arrayOf(entity, recordId)
                    )
                    if (changed != 1) throw IllegalStateException("Local record sync state was not updated")
                    db.setTransactionSuccessful()
                }
            } finally {
                db.endTransaction()
            }
            call.resolve(JSObject().put("updated", changed == 1).put("rows", changed))
        } catch (error: Exception) {
            call.reject("تعذر تحديث حالة مزامنة السجل المحلي", error)
        }
    }

    @PluginMethod
    fun deleteRecord(call: PluginCall) {
        val entity = call.getString("entity")?.trim().orEmpty()
        val recordId = call.getString("recordId")?.trim().orEmpty()
        if (entity.isBlank() || recordId.isBlank()) {
            call.reject("entity و recordId مطلوبان")
            return
        }
        try {
            val rows = helper.writableDatabase.delete(
                "pos_records", "entity = ? AND record_id = ?", arrayOf(entity, recordId)
            )
            call.resolve(JSObject().put("deleted", rows > 0).put("rows", rows))
        } catch (error: Exception) {
            call.reject("تعذر حذف السجل المحلي", error)
        }
    }

    @PluginMethod
    fun deleteRecords(call: PluginCall) {
        val entity = call.getString("entity")?.trim().orEmpty()
        val requestedIds = call.getArray("recordIds")
        if (entity.isBlank() || requestedIds == null) {
            call.reject("entity و recordIds مطلوبان للحذف الجماعي")
            return
        }
        try {
            val ids = LinkedHashSet<String>()
            for (index in 0 until requestedIds.length()) {
                val id = requestedIds.optString(index).trim()
                if (id.isBlank()) throw IllegalArgumentException("recordIds يحتوي على معرف فارغ")
                ids.add(id)
            }
            if (ids.isEmpty()) {
                call.resolve(JSObject().put("deleted", 0))
                return
            }

            val db = helper.writableDatabase
            var deleted = 0
            db.beginTransaction()
            try {
                ids.toList().chunked(900).forEach { chunk ->
                    val placeholders = List(chunk.size) { "?" }.joinToString(",")
                    val args = arrayOf(entity) + chunk.toTypedArray()
                    deleted += db.delete(
                        "pos_records", "entity = ? AND record_id IN ($placeholders)", args
                    )
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            call.resolve(JSObject().put("deleted", deleted))
        } catch (error: Exception) {
            call.reject("تعذر حذف مجموعة السجلات المحلية بصورة ذرية", error)
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
            val existing = if (result == -1L) helper.readableDatabase.query(
                "pos_outbox", arrayOf("type", "payload"), "operation_id = ?", arrayOf(operationId), null, null, null
            ).use { cursor ->
                if (cursor.moveToFirst()) Pair(cursor.getString(0), cursor.getString(1)) else null
            } else null
            if (result == -1L && (existing == null || existing.first != type || existing.second != payload.toString())) {
                throw IllegalStateException("Operation ID was reused with a different type or payload")
            }
            val duplicate = result == -1L
            call.resolve(JSObject().put("queued", result != -1L || duplicate).put("duplicate", duplicate).put("operationId", operationId))
        } catch (error: Exception) {
            call.reject("تعذر إضافة العملية إلى قائمة المزامنة", error)
        }
    }

    @PluginMethod
    fun applySnapshotAndReplaceOutbox(call: PluginCall) {
        val changes = call.getArray("changes") ?: JSArray()
        val operations = call.getArray("operations") ?: JSArray()
        val parsedOperations = mutableListOf<JSONObject>()
        val operationIds = mutableSetOf<String>()
        try {
            for (index in 0 until operations.length()) {
                val operation = operations.getJSONObject(index)
                val id = operation.optString("operationId").trim()
                if (id.isBlank() || operation.optString("type").isBlank() ||
                    operation.optJSONObject("payload") == null || !operationIds.add(id)) {
                    throw IllegalArgumentException("Invalid or duplicate outbox operation at index $index")
                }
                parsedOperations.add(operation)
            }
            val db = helper.writableDatabase
            var applied = 0
            db.beginTransaction()
            try {
                for (index in 0 until changes.length()) {
                    val change = changes.getJSONObject(index)
                    val entity = change.optString("entity").trim()
                    val action = change.optString("action")
                    val recordId = change.optString("recordId")
                    if (entity.isBlank() || recordId.isBlank()) throw IllegalArgumentException("Invalid snapshot change at index $index")
                    if (action == "delete") {
                        db.delete("pos_records", "entity = ? AND record_id = ?", arrayOf(entity, recordId))
                        // Count successfully processed changes, not affected rows:
                        // deleting an already-absent key is still an applied snapshot instruction.
                        applied++
                    } else if (action == "put") {
                        val record = change.optJSONObject("record") ?: throw IllegalArgumentException("Missing snapshot record at index $index")
                        val state = change.optString("syncState", "local")
                        if (state !in setOf("local", "pending", "synced", "error")) throw IllegalArgumentException("Invalid sync state")
                        val values = ContentValues().apply {
                            put("entity", entity); put("record_id", recordId); put("json", record.toString())
                            put("sync_state", state); put("updated_at", System.currentTimeMillis())
                        }
                        if (db.insertWithOnConflict("pos_records", null, values, SQLiteDatabase.CONFLICT_REPLACE) == -1L) {
                            throw IllegalStateException("Could not restore snapshot record")
                        }
                        applied++
                    } else throw IllegalArgumentException("Unknown snapshot change action")
                }
                db.delete("pos_outbox", null, null)
                db.delete("pos_records", "entity = ?", arrayOf("operations"))
                val now = System.currentTimeMillis()
                for (operation in parsedOperations) {
                    val id = operation.getString("operationId").trim()
                    val payload = operation.getJSONObject("payload")
                    val values = ContentValues().apply {
                        put("operation_id", id); put("type", operation.getString("type").trim())
                        put("payload", payload.toString()); put("device_id", operation.optString("deviceId", ""))
                        put("tenant_id", operation.optString("tenantId", "")); put("branch_id", operation.optString("branchId", ""))
                        put("actor", operation.optString("actor", "")); put("schema_version", operation.optInt("schemaVersion", 1).coerceAtLeast(1))
                        put("created_at", operation.optLong("createdAt", now).coerceAtLeast(0L))
                        put("retry_count", operation.optInt("retryCount", 0).coerceAtLeast(0))
                        val nextRetryAt = operation.optLong("nextRetryAt", 0L)
                        if (nextRetryAt > 0L) put("next_retry_at", nextRetryAt)
                        put("status", "pending")
                    }
                    db.insertOrThrow("pos_outbox", null, values)
                    val recordValues = ContentValues().apply {
                        put("entity", "operations"); put("record_id", id); put("json", payload.toString())
                        put("sync_state", "pending"); put("updated_at", now)
                    }
                    db.insertOrThrow("pos_records", null, recordValues)
                }
                db.setTransactionSuccessful()
            } finally { db.endTransaction() }
            call.resolve(JSObject().put("applied", applied).put("operationCount", parsedOperations.size).put("committed", true))
        } catch (error: Exception) {
            call.reject("تعذر تطبيق النسخة الاحتياطية وطابور المزامنة في معاملة واحدة", error)
        }
    }

    @PluginMethod
    fun replacePendingOperations(call: PluginCall) {
        val operations = call.getArray("operations") ?: JSArray()
        val parsed = mutableListOf<JSONObject>()
        val ids = mutableSetOf<String>()
        try {
            for (index in 0 until operations.length()) {
                val operation = operations.getJSONObject(index)
                val operationId = operation.optString("operationId").trim()
                val type = operation.optString("type").trim()
                val payload = operation.optJSONObject("payload")
                if (operationId.isBlank() || type.isBlank() || payload == null || !ids.add(operationId)) {
                    throw IllegalArgumentException("Invalid or duplicate pending operation at index $index")
                }
                parsed.add(operation)
            }

            val db = helper.writableDatabase
            db.beginTransaction()
            try {
                db.delete("pos_outbox", null, null)
                db.delete("pos_records", "entity = ?", arrayOf("operations"))
                val now = System.currentTimeMillis()
                for (operation in parsed) {
                    val operationId = operation.getString("operationId").trim()
                    val type = operation.getString("type").trim()
                    val payload = operation.getJSONObject("payload")
                    val values = ContentValues().apply {
                        put("operation_id", operationId)
                        put("type", type)
                        put("payload", payload.toString())
                        put("device_id", operation.optString("deviceId", ""))
                        put("tenant_id", operation.optString("tenantId", ""))
                        put("branch_id", operation.optString("branchId", ""))
                        put("actor", operation.optString("actor", ""))
                        put("schema_version", operation.optInt("schemaVersion", 1).coerceAtLeast(1))
                        put("created_at", operation.optLong("createdAt", now).coerceAtLeast(0L))
                        put("retry_count", operation.optInt("retryCount", 0).coerceAtLeast(0))
                        val nextRetryAt = operation.optLong("nextRetryAt", 0L)
                        if (nextRetryAt > 0L) put("next_retry_at", nextRetryAt)
                        put("status", "pending")
                    }
                    val inserted = db.insertOrThrow("pos_outbox", null, values)
                    if (inserted == -1L) throw IllegalStateException("Could not restore outbox operation $operationId")
                    val recordValues = ContentValues().apply {
                        put("entity", "operations")
                        put("record_id", operationId)
                        put("json", payload.toString())
                        put("sync_state", "pending")
                        put("updated_at", now)
                    }
                    db.insertOrThrow("pos_records", null, recordValues)
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            call.resolve(JSObject().put("replaced", true).put("count", parsed.size))
        } catch (error: Exception) {
            call.reject("تعذر استبدال قائمة العمليات المعلقة بصورة ذرية", error)
        }
    }

    @PluginMethod
    fun listPendingOperations(call: PluginCall) {
        try {
            val rows = JSArray()
            helper.readableDatabase.query(
                "pos_outbox", null,
                "status = 'pending' OR (status = 'error' AND (next_retry_at IS NULL OR next_retry_at <= ?))",
                arrayOf(System.currentTimeMillis().toString()), null, null, "created_at ASC"
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
                    val nextRetryAt = cursor.getLong(cursor.getColumnIndexOrThrow("next_retry_at"))
                    if (nextRetryAt > 0) item.put("nextRetryAt", nextRetryAt)
                    rows.put(item)
                }
            }
            call.resolve(JSObject().put("operations", rows))
        } catch (error: Exception) {
            call.reject("تعذر قراءة قائمة العمليات المعلقة", error)
        }
    }

    @PluginMethod
    fun listAllOperations(call: PluginCall) {
        try {
            val rows = JSArray()
            helper.readableDatabase.query(
                "pos_outbox", null, null, null, null, null, "created_at ASC"
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
                    item.put("status", cursor.getString(cursor.getColumnIndexOrThrow("status")))
                    val lastError = cursor.getString(cursor.getColumnIndexOrThrow("last_error"))
                    if (!lastError.isNullOrBlank()) item.put("lastError", lastError)
                    val nextRetryAt = cursor.getLong(cursor.getColumnIndexOrThrow("next_retry_at"))
                    if (nextRetryAt > 0) item.put("nextRetryAt", nextRetryAt)
                    rows.put(item)
                }
            }
            call.resolve(JSObject().put("operations", rows))
        } catch (error: Exception) {
            call.reject("تعذر قراءة سجل عمليات SQLite", error)
        }
    }

    @PluginMethod
    fun retryOperation(call: PluginCall) {
        val operationId = call.getString("operationId")?.trim().orEmpty()
        if (operationId.isBlank()) {
            call.reject("operationId حقل مطلوب")
            return
        }
        try {
            val db = helper.writableDatabase
            var updated = 0
            db.beginTransaction()
            try {
                updated = db.update(
                    "pos_outbox",
                    ContentValues().apply {
                        put("status", "pending")
                        put("retry_count", 0)
                        putNull("next_retry_at")
                        putNull("last_error")
                    },
                    "operation_id = ? AND status IN ('error', 'conflict')",
                    arrayOf(operationId)
                )
                if (updated != 1) throw IllegalStateException("Retryable SQLite operation was not found: $operationId")
                val payload = db.query(
                    "pos_outbox", arrayOf("payload"), "operation_id = ?",
                    arrayOf(operationId), null, null, null
                ).use { cursor ->
                    if (!cursor.moveToFirst()) throw IllegalStateException("SQLite outbox operation disappeared: $operationId")
                    JSONObject(cursor.getString(0))
                }
                val recordValues = ContentValues().apply {
                    put("entity", "operations")
                    put("record_id", operationId)
                    put("json", payload.toString())
                    put("sync_state", "pending")
                    put("updated_at", System.currentTimeMillis())
                }
                db.insertWithOnConflict("pos_records", null, recordValues, SQLiteDatabase.CONFLICT_REPLACE)
                db.setTransactionSuccessful()
            } finally { db.endTransaction() }
            call.resolve(JSObject().put("updated", true).put("operationId", operationId))
        } catch (error: Exception) {
            call.reject("تعذر إعادة جدولة عملية SQLite", error)
        }
    }

    @PluginMethod
    fun updatePendingOperationPayload(call: PluginCall) {
        val operationId = call.getString("operationId")?.trim().orEmpty()
        val payload = call.getObject("payload")
        if (operationId.isBlank() || payload == null) {
            call.reject("operationId و payload مطلوبان")
            return
        }
        try {
            val db = helper.writableDatabase
            var outboxRows = 0
            var recordRows = 0
            db.beginTransaction()
            try {
                val values = ContentValues().apply { put("payload", payload.toString()) }
                outboxRows = db.update(
                    "pos_outbox", values, "operation_id = ? AND status IN ('pending', 'error')",
                    arrayOf(operationId)
                )
                if (outboxRows != 1) {
                    throw IllegalStateException("Pending outbox operation was not found: $operationId")
                }
                // The operation record mirrors the durable outbox payload. Keep
                // both copies aligned when server IDs are remapped after an ack.
                recordRows = db.update(
                    "pos_records",
                    ContentValues().apply {
                        put("json", payload.toString())
                        put("updated_at", System.currentTimeMillis())
                    },
                    "entity = ? AND record_id = ?",
                    arrayOf("operations", operationId)
                )
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            call.resolve(JSObject().put("updated", true).put("rows", outboxRows).put("recordUpdated", recordRows > 0))
        } catch (error: Exception) {
            call.reject("تعذر تحديث مراجع العملية المعلقة", error)
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

    @PluginMethod
    fun markOperationConflict(call: PluginCall) {
        updateOperationStatus(call, "conflict", call.getString("message") ?: "Operation conflict")
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
            var outboxRows = 0
            var recordRows = 0
            db.beginTransaction()
            try {
                outboxRows = if (status == "error") {
                    val currentRetry = db.query(
                        "pos_outbox", arrayOf("retry_count"), "operation_id = ?",
                        arrayOf(operationId), null, null, null
                    ).use { cursor -> if (cursor.moveToFirst()) cursor.getInt(0) else 0 }
                    val nextRetry = System.currentTimeMillis() +
                        minOf(60000L, 2000L * (1L shl (currentRetry + 1).coerceAtMost(8)))
                    values.put("next_retry_at", nextRetry)
                    values.put("retry_count", currentRetry + 1)
                    db.update("pos_outbox", values, "operation_id = ?", arrayOf(operationId))
                } else {
                    values.putNull("next_retry_at")
                    db.update("pos_outbox", values, "operation_id = ?", arrayOf(operationId))
                }
                // Never update the business operation record if its durable outbox
                // entry is missing. Throwing rolls back the transaction unchanged.
                if (outboxRows != 1) {
                    throw IllegalStateException("Durable outbox operation was not found: $operationId")
                }
                // Keep the durable operation record and its outbox state aligned
                // in the same SQLite transaction after acknowledgement or failure.
                val recordSyncState = if (status == "synced") "synced" else "error"
                recordRows = db.update(
                    "pos_records",
                    ContentValues().apply { put("sync_state", recordSyncState); put("updated_at", System.currentTimeMillis()) },
                    "entity = ? AND record_id = ?",
                    arrayOf("operations", operationId)
                )
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            call.resolve(JSObject().put("updated", outboxRows > 0).put("recordUpdated", recordRows > 0).put("operationId", operationId))
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
    SQLiteOpenHelper(context, "pos-local.db", null, 3) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE pos_records (entity TEXT NOT NULL, record_id TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL, sync_state TEXT NOT NULL DEFAULT 'local', PRIMARY KEY(entity, record_id))")
        db.execSQL("CREATE INDEX idx_pos_records_entity_updated ON pos_records(entity, updated_at)")
        db.execSQL("CREATE TABLE pos_outbox (operation_id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT '', tenant_id TEXT NOT NULL DEFAULT '', branch_id TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT '', schema_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_retry_at INTEGER)")
        db.execSQL("CREATE INDEX idx_pos_outbox_status_created ON pos_outbox(status, created_at)")
        db.execSQL("CREATE TABLE pos_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE pos_outbox ADD COLUMN tenant_id TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE pos_outbox ADD COLUMN actor TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE pos_outbox ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1")
        }
        if (oldVersion < 3) {
            db.execSQL("ALTER TABLE pos_outbox ADD COLUMN next_retry_at INTEGER")
        }
    }
}
