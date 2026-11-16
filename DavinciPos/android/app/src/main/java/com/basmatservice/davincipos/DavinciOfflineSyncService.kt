package com.basmatservice.davincipos

import org.json.JSONObject

data class DavinciSyncBatchResult(
    val accepted: Int,
    val conflicts: Int,
    val rejected: Int,
    val failed: Int
)

/**
 * Authenticated adapter between the durable SQLite outbox and the existing
 * Express offline-sales API. It deliberately reuses the server's idempotent
 * operationId contract and never deletes a queued sale after a network error.
 */
class DavinciOfflineSyncService(
    private val client: DavinciLanClient,
    private val outbox: DavinciSyncOutboxRepository
) {
    fun registerDevice(
        bearerToken: String,
        name: String,
        platform: String = "android"
    ): String {
        require(name.isNotBlank()) { "Device name is required." }
        require(platform in setOf("android", "desktop", "web")) { "Unsupported device platform." }
        val deviceId = outbox.getOrCreateDeviceId()
        val response = client.request(
            method = "POST",
            apiPath = "/api/devices/register",
            body = JSONObject()
                .put("id", deviceId)
                .put("name", name.trim().take(160))
                .put("platform", platform),
            bearerToken = bearerToken
        )
        val payload = parseData(response)
        val registeredId = payload.optString("id", "")
        require(registeredId == deviceId) { "Server returned a different device identity." }
        outbox.setDeviceRegistration(deviceId)
        return deviceId
    }

    fun synchronizePendingSales(
        bearerToken: String,
        deviceId: String = outbox.getOrCreateDeviceId(),
        limit: Int = 100
    ): DavinciSyncBatchResult {
        require(bearerToken.isNotBlank()) { "Authentication is required before synchronization." }
        val pending = outbox.listPending(deviceId, limit)
        var accepted = 0
        var conflicts = 0
        var rejected = 0
        var failed = 0

        for (operation in pending) {
            try {
                require(operation.entityType == "sale" && operation.operation == "upsert") {
                    "Unsupported queued operation type: ${operation.entityType}/${operation.operation}"
                }
                val response = client.request(
                    method = "POST",
                    apiPath = "/api/sync/offline-sales",
                    body = JSONObject()
                        .put("operationId", operation.operationId)
                        .put("deviceId", operation.deviceId)
                        .put("sale", operation.payload),
                    bearerToken = bearerToken
                )
                if (!response.isSuccessful) {
                    val message = errorMessage(response.body, response.statusCode)
                    if (response.statusCode in 400..499 &&
                        response.statusCode !in setOf(401, 403, 408, 429)
                    ) {
                        outbox.rejectOperation(operation.operationId, message)
                        rejected++
                        continue
                    }
                    outbox.recordFailure(operation.operationId, message)
                    failed++
                    break
                }

                val result = parseData(response)
                when (result.optString("status")) {
                    "accepted" -> {
                        check(outbox.acknowledge(operation.operationId)) {
                            "Could not acknowledge synchronized sale."
                        }
                        accepted++
                    }
                    "conflict" -> {
                        outbox.holdConflict(
                            operation.operationId,
                            result.optString("reason", "Server requires conflict review.")
                        )
                        conflicts++
                    }
                    "rejected" -> {
                        outbox.rejectOperation(
                            operation.operationId,
                            result.optString("reason", "Server rejected the offline sale.")
                        )
                        rejected++
                    }
                    else -> {
                        outbox.recordFailure(operation.operationId, "Unrecognized server sync response.")
                        failed++
                        break
                    }
                }
            } catch (error: Exception) {
                outbox.recordFailure(operation.operationId, error.message ?: "Synchronization failed.")
                failed++
                break
            }
        }
        return DavinciSyncBatchResult(accepted, conflicts, rejected, failed)
    }

    private fun parseData(response: DavinciLanResponse): JSONObject {
        if (!response.isSuccessful) {
            throw DavinciLanException(errorMessage(response.body, response.statusCode), response.statusCode)
        }
        val root = try { JSONObject(response.body) }
        catch (_: Exception) { throw DavinciLanException("Server returned invalid JSON.", response.statusCode) }
        return root.optJSONObject("data")
            ?: throw DavinciLanException("Server response is missing its data object.", response.statusCode)
    }

    private fun errorMessage(body: String, status: Int): String {
        val message = try { JSONObject(body).optString("error").takeIf { it.isNotBlank() } }
        catch (_: Exception) { null }
        return message ?: "Server synchronization failed (HTTP $status)."
    }
}
