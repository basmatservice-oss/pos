package com.basmatservice.davincipos

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class DavinciLocalApiResult(
    val statusCode: Int,
    val body: JSONObject
)

/**
 * Narrow API-compatibility facade for Kotlin-native local operations.
 * It deliberately exposes typed repository operations, never SQL or a DB handle.
 * Routes are added here as their Kotlin workflows become complete.
 */
class DavinciLocalApiFacade(context: Context) {
    private val services = DavinciServiceRepository(context)
    private val settings = DavinciSettingsRepository(context)
    private val settlements = DavinciSettlementRepository(context)

    fun dispatch(
        method: String,
        rawPath: String,
        body: JSONObject = JSONObject(),
        actorUserId: String? = null,
        idempotencyKey: String? = null
    ): DavinciLocalApiResult {
        val path = rawPath.substringBefore('?').trimEnd('/').ifEmpty { "/" }
        return try {
            when {
                method == "GET" && path == "/api/services" ->
                    success(JSONArray().apply { services.listServices().forEach { put(it.toJson()) } })

                method == "POST" && path == "/api/services" -> {
                    val id = services.saveService(body.toServiceInput(), body.componentsOrNull())
                    DavinciLocalApiResult(201, data(JSONObject().put("id", id)))
                }

                method == "PATCH" && path.matches(Regex("^/api/services/[^/]+$")) -> {
                    val id = path.substringAfterLast('/')
                    services.saveService(body.toServiceInput(id), body.componentsOrNull())
                    success(JSONObject().put("updated", true))
                }

                method == "GET" && path.matches(Regex("^/api/services/[^/]+/components$")) -> {
                    val id = path.split('/').let { it[it.size - 2] }
                    success(JSONArray().apply {
                        services.listComponents(id).forEach { put(it.toJson()) }
                    })
                }

                method == "PUT" && path.matches(Regex("^/api/services/[^/]+/components$")) -> {
                    val id = path.split('/').let { it[it.size - 2] }
                    val components = body.optJSONArray("components") ?: JSONArray()
                    success(JSONArray().apply {
                        services.setComponents(id, components.toComponentInputs()).forEach { put(it.toJson()) }
                    })
                }

                method == "GET" && path == "/api/settings" ->
                    success(settings.getSettings().toJson())

                method == "PUT" && path == "/api/settings" -> {
                    val changes = body.optJSONObject("settings")
                        ?: throw IllegalArgumentException("Settings object is required.")
                    success(settings.updateSettings(changes.toSettingMap(), actorUserId).toJson())
                }

                method == "GET" && path == "/api/tax-profiles" ->
                    success(JSONArray().apply { settings.listTaxProfiles().forEach { put(it.toJson()) } })


                method == "GET" && path == "/api/settlements/customers" ->
                    success(JSONArray().apply { settlements.listCustomerBalances().forEach { put(it.toJson()) } })

                method == "GET" && path == "/api/settlements/suppliers" ->
                    success(JSONArray().apply { settlements.listSupplierBalances().forEach { put(it.toJson()) } })

                method == "GET" && path.matches(Regex("^/api/customers/[^/]+/statement$")) -> {
                    val id = path.split('/')[3]
                    success(settlements.getCustomerStatement(id).toJson())
                }

                method == "GET" && path.matches(Regex("^/api/suppliers/[^/]+/statement$")) -> {
                    val id = path.split('/')[3]
                    success(settlements.getSupplierStatement(id).toJson())
                }

                method == "POST" && path.matches(Regex("^/api/sales/[^/]+/payments$")) -> {
                    val id = path.split('/')[3]
                    val payment = settlements.recordCustomerPayment(id, body.toPaymentInput(idempotencyKey), actorUserId)
                    DavinciLocalApiResult(201, data(payment.toJson("saleId")))
                }

                method == "POST" && path.matches(Regex("^/api/purchases/[^/]+/payments$")) -> {
                    val id = path.split('/')[3]
                    val payment = settlements.recordSupplierPayment(id, body.toPaymentInput(idempotencyKey), actorUserId)
                    DavinciLocalApiResult(201, data(payment.toJson("purchaseId")))
                }

                method == "POST" && path == "/api/tax-profiles" -> {
                    val id = settings.saveTaxProfile(
                        DavinciSettingsRepository.SaveTaxProfileInput(
                            name = body.optString("name"),
                            rateBps = body.optInt("rateBps", -1),
                            priceMode = body.optString("priceMode"),
                            isDefault = body.optBoolean("isDefault", false),
                            id = body.optString("id").takeIf { it.isNotBlank() }
                        ), actorUserId
                    )
                    DavinciLocalApiResult(201, data(JSONObject().put("id", id)))
                }

                else -> DavinciLocalApiResult(
                    501, JSONObject().put("error", "This operation is not yet available in the Kotlin local runtime.")
                )
            }
        } catch (error: IllegalArgumentException) {
            DavinciLocalApiResult(400, JSONObject().put("error", error.message ?: "Invalid request."))
        } catch (error: Exception) {
            DavinciLocalApiResult(400, JSONObject().put("error", error.message ?: "Request failed."))
        }
    }

    private fun success(value: Any) = DavinciLocalApiResult(200, data(value))
    private fun data(value: Any) = JSONObject().put("data", value)


    private fun DavinciPartyBalance.toJson() = JSONObject()
        .put("id", id).put("name", name).put("phone", phone ?: JSONObject.NULL)
        .put("balanceMinor", balanceMinor)

    private fun DavinciPartyStatement.toJson() = JSONObject()
        .put("party", JSONObject().put("id", party.id).put("name", party.name)
            .put("phone", party.phone ?: JSONObject.NULL))
        .put("balanceMinor", balanceMinor)
        .put("invoices", JSONArray().apply { invoices.forEach { put(it.toJson()) } })

    private fun DavinciStatementInvoice.toJson() = JSONObject()
        .put("id", id).put("reference", reference).put("occurredAt", occurredAt)
        .put("totalMinor", totalMinor).put("paidMinor", paidMinor)
        .put("returnedMinor", returnedMinor).put("dueMinor", dueMinor)

    private fun DavinciRecordedPayment.toJson(entityKey: String) = JSONObject()
        .put("id", id).put(entityKey, entityId)
        .put("amountMinor", amountMinor).put("remainingMinor", remainingMinor)

    private fun JSONObject.toPaymentInput(headerKey: String?) = DavinciPaymentInput(
        amountMinor = optLong("amountMinor", -1),
        method = optString("method", "cash"),
        provider = optString("provider").takeIf { it.isNotBlank() },
        reference = optString("reference").takeIf { it.isNotBlank() },
        occurredAt = optString("occurredAt").takeIf { it.isNotBlank() },
        idempotencyKey = headerKey?.takeIf { it.isNotBlank() }
            ?: optString("idempotencyKey").takeIf { it.isNotBlank() }
    )

    private fun DavinciService.toJson() = JSONObject()
        .put("id", id).put("code", code ?: JSONObject.NULL).put("name", name)
        .put("priceMinor", priceMinor).put("taxRateBps", taxRateBps)
        .put("taxExempt", taxExempt).put("isActive", isActive)
        .put("componentCostMinor", componentCostMinor)
        .put("componentSaleMinor", componentSaleMinor)
        .put("componentSummary", componentSummary)

    private fun DavinciServiceComponent.toJson() = JSONObject()
        .put("productId", productId).put("name", name).put("quantity", quantity)
        .put("unitSymbol", unitSymbol).put("unitCostMinor", unitCostMinor)
        .put("componentCostMinor", componentCostMinor)

    private fun DavinciTaxProfile.toJson() = JSONObject()
        .put("id", id).put("name", name).put("rateBps", rateBps)
        .put("priceMode", priceMode).put("isDefault", isDefault).put("isActive", isActive)

    private fun Map<String, Any?>.toJson() = JSONObject().apply {
        forEach { (key, value) -> put(key, value ?: JSONObject.NULL) }
    }

    private fun JSONObject.toServiceInput(id: String? = null) =
        DavinciServiceRepository.SaveServiceInput(
            id = id ?: optString("id").takeIf { it.isNotBlank() },
            code = optString("code").takeIf { it.isNotBlank() },
            name = optString("name"),
            priceMinor = optLong("priceMinor", -1),
            taxRateBps = optInt("taxRateBps", 0),
            taxExempt = optBoolean("taxExempt", false),
            isActive = optBoolean("isActive", true)
        )

    private fun JSONObject.componentsOrNull(): List<DavinciServiceComponentInput>? {
        if (!has("components") || isNull("components")) return null
        return optJSONArray("components")?.toComponentInputs()
            ?: throw IllegalArgumentException("Service components must be a list.")
    }

    private fun JSONArray.toComponentInputs(): List<DavinciServiceComponentInput> =
        (0 until length()).map { index ->
            val item = optJSONObject(index)
                ?: throw IllegalArgumentException("Invalid service component.")
            DavinciServiceComponentInput(
                productId = item.optString("productId"),
                quantity = item.optDouble("quantity", Double.NaN)
            )
        }

    private fun JSONObject.toSettingMap(): Map<String, Any?> {
        val result = linkedMapOf<String, Any?>()
        val iterator = keys()
        while (iterator.hasNext()) {
            val key = iterator.next()
            val value = get(key)
            result[key] = if (value === JSONObject.NULL) null else value
        }
        return result
    }
}
