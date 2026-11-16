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
    private val people = DavinciPeopleRepository(context)
    private val catalog = DavinciCatalogRepository(context)
    private val currency = DavinciCurrencyRepository(context)
    private val inventoryWorkflows = DavinciInventoryWorkflowRepository(context)
    private val expenses = DavinciExpenseRepository(context)

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


                method == "GET" && path == "/api/expenses" ->
                    success(JSONArray().apply { expenses.listExpenses().forEach { put(it.toJson()) } })

                method == "POST" && path == "/api/expenses" -> {
                    val result = expenses.createExpense(
                        category = body.optString("category"),
                        amountMinor = body.optLong("amountMinor", -1),
                        paymentMethod = body.optString("paymentMethod", "cash"),
                        provider = body.optString("provider").takeIf { it.isNotEmpty() },
                        reference = body.optString("reference").takeIf { it.isNotEmpty() },
                        note = body.optString("note").takeIf { it.isNotEmpty() },
                        occurredAt = body.optString("occurredAt").takeIf { it.isNotEmpty() },
                        userId = actorUserId
                    )
                    DavinciLocalApiResult(201, data(result.toJson()))
                }

                method == "GET" && path == "/api/inventory/counts" ->
                    success(JSONArray().apply { inventoryWorkflows.listInventoryCounts().forEach { put(it.toJson()) } })

                method == "POST" && path == "/api/inventory/counts" -> {
                    val ids = body.optJSONArray("productIds")?.let { array -> (0 until array.length()).map { array.getString(it) } }
                    val result = inventoryWorkflows.createInventoryCount(userId = actorUserId, productIds = ids)
                    DavinciLocalApiResult(201, data(result.toJson()))
                }

                method == "GET" && path.matches(Regex("^/api/inventory/counts/[^/]+$")) ->
                    success(inventoryWorkflows.getInventoryCount(path.split("/")[4]).toJson())

                method == "PUT" && path.matches(Regex("^/api/inventory/counts/[^/]+/lines/[^/]+$")) -> {
                    val parts = path.split("/")
                    success(inventoryWorkflows.setInventoryCountLine(parts[4], parts[6], body.optDouble("countedQuantity", Double.NaN)).toJson())
                }

                method == "POST" && path.matches(Regex("^/api/inventory/counts/[^/]+/post$")) ->
                    success(inventoryWorkflows.completeInventoryCount(path.split("/")[4], actorUserId).toJson())

                method == "POST" && path == "/api/inventory/adjustments" -> {
                    val result = inventoryWorkflows.adjustInventory(
                        productId = body.optString("productId"),
                        quantityDelta = body.optDouble("quantityDelta", Double.NaN),
                        unitCostMinor = body.optLong("unitCostMinor", 0),
                        reason = body.optString("reason", "Inventory adjustment"),
                        id = body.optString("id").takeIf { it.isNotEmpty() } ?: java.util.UUID.randomUUID().toString(),
                        userId = actorUserId
                    )
                    success(result.toJson())
                }

                method == "GET" && path == "/api/currency/rates" -> {
                    val current = currency.getCurrentExchangeRate()
                    success(JSONObject().put("current", current?.toJson() ?: JSONObject.NULL)
                        .put("history", JSONArray().apply { currency.listExchangeRates().forEach { put(it.toJson()) } }))
                }

                method == "POST" && path == "/api/currency/rates" -> {
                    val result = currency.recordExchangeRate(
                        rate = body.optDouble("rate", Double.NaN),
                        effectiveAt = body.optString("effectiveAt").takeIf { it.isNotEmpty() } ?: java.time.Instant.now().toString(),
                        fromCurrency = body.optString("fromCurrency", "USD"),
                        toCurrency = body.optString("toCurrency", "SDG"),
                        actorUserId = actorUserId,
                        applyAutomatically = body.optBoolean("applyAutomatically", false)
                    )
                    DavinciLocalApiResult(201, data(result.first.toJson().put("updatedProducts", result.second)))
                }

                method == "PUT" && path.matches(Regex("^/api/products/[^/]+/currency$")) -> {
                    val id = path.split("/")[3]
                    val result = currency.configureProductCurrency(
                        productId = id,
                        currency = body.optString("currency", "SDG"),
                        foreignCostMinor = body.longOrNull("foreignCostMinor"),
                        foreignSalePriceMinor = body.longOrNull("foreignSalePriceMinor"),
                        localCostMinor = body.longOrNull("localCostMinor"),
                        localSalePriceMinor = body.longOrNull("localSalePriceMinor"),
                        autoUpdate = body.optBoolean("autoUpdate", false)
                    )
                    success(result.toJson())
                }

                method == "GET" && path == "/api/products" ->
                    success(JSONArray().apply { catalog.listProducts().forEach { put(it.toJson()) } })

                method == "PATCH" && path.matches(Regex("^/api/products/[^/]+$")) -> {
                    val id = path.substringAfterLast("/")
                    catalog.updateProduct(id, body.toPrimitiveMap())
                    success(JSONObject().put("updated", true))
                }

                method == "POST" && path == "/api/products" -> {
                    val id = catalog.createProduct(body.toNewProduct())
                    DavinciLocalApiResult(201, data(JSONObject().put("id", id)))
                }

                method == "GET" && path == "/api/categories" ->
                    success(JSONArray().apply { catalog.listCategories().forEach { put(it.toJson()) } })

                method == "POST" && path == "/api/categories" -> {
                    val id = catalog.createCategory(body.optString("name"), body.optString("color", "#64748b"), body.optString("id").takeIf { it.isNotEmpty() } ?: java.util.UUID.randomUUID().toString())
                    DavinciLocalApiResult(201, data(JSONObject().put("id", id)))
                }

                method == "GET" && path == "/api/units" ->
                    success(JSONArray().apply { catalog.listUnits().forEach { put(it.toJson()) } })

                method == "POST" && path == "/api/units" -> {
                    val id = catalog.createUnit(body.optString("name"), body.optString("symbol"), body.optInt("precision", 0), body.optString("id").takeIf { it.isNotEmpty() } ?: java.util.UUID.randomUUID().toString())
                    DavinciLocalApiResult(201, data(JSONObject().put("id", id)))
                }

                method == "GET" && path.matches(Regex("^/api/products/[^/]+/units$")) -> {
                    val id = path.split("/")[3]
                    success(JSONArray().apply { catalog.listProductUnits(id).forEach { put(it.toJson()) } })
                }

                method == "POST" && path.matches(Regex("^/api/products/[^/]+/units$")) -> {
                    val id = path.split("/")[3]
                    val saved = catalog.saveProductUnit(id, body.optString("unitId"), body.optDouble("baseQuantity", Double.NaN), body.optString("barcode").takeIf { it.isNotEmpty() }, if (body.has("salePriceMinor") && !body.isNull("salePriceMinor")) body.optLong("salePriceMinor") else null, body.optBoolean("isDefaultSale", false), body.optString("id").takeIf { it.isNotEmpty() } ?: java.util.UUID.randomUUID().toString())
                    DavinciLocalApiResult(201, data(JSONObject().put("id", saved)))
                }

                method == "GET" && path.startsWith("/api/barcode/") -> {
                    val code = path.substringAfter("/api/barcode/")
                    success(catalog.lookupBarcode(code).toJson())
                }

                method == "GET" && path == "/api/customers" ->
                    success(JSONArray().apply { people.listCustomers().forEach { put(it.toJson()) } })

                method == "POST" && path == "/api/customers" -> {
                    val id = people.createCustomer(body.optString("name"), body.optString("phone").takeIf { it.isNotEmpty() }, body.optString("email").takeIf { it.isNotEmpty() }, body.optString("id").takeIf { it.isNotEmpty() } ?: java.util.UUID.randomUUID().toString())
                    DavinciLocalApiResult(201, data(JSONObject().put("id", id)))
                }

                method == "GET" && path == "/api/suppliers" ->
                    success(JSONArray().apply { people.listSuppliers().forEach { put(it.toJson()) } })

                method == "POST" && path == "/api/suppliers" -> {
                    val id = people.createSupplier(body.optString("name"), body.optString("phone").takeIf { it.isNotEmpty() }, body.optString("email").takeIf { it.isNotEmpty() }, body.optString("address").takeIf { it.isNotEmpty() }, body.optString("id").takeIf { it.isNotEmpty() } ?: java.util.UUID.randomUUID().toString())
                    DavinciLocalApiResult(201, data(JSONObject().put("id", id)))
                }

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


    private fun DavinciExpense.toJson() = JSONObject()
        .put("id", id).put("category", category).put("amountMinor", amountMinor)
        .put("paymentMethod", paymentMethod).put("provider", provider ?: JSONObject.NULL)
        .put("reference", reference ?: JSONObject.NULL).put("note", note ?: JSONObject.NULL)
        .put("occurredAt", occurredAt).put("createdBy", createdBy ?: JSONObject.NULL)

    private fun DavinciInventoryCountCreated.toJson() = JSONObject()
        .put("id", id).put("branchId", branchId ?: JSONObject.NULL).put("status", status).put("lineCount", lineCount)
    private fun DavinciInventoryCount.toJson() = JSONObject()
        .put("id", id).put("branchId", branchId ?: JSONObject.NULL).put("status", status)
        .put("openedAt", openedAt).put("postedAt", postedAt ?: JSONObject.NULL)
        .put("lines", JSONArray().apply { lines.forEach { put(it.toJson()) } })
    private fun DavinciInventoryCountLine.toJson() = JSONObject()
        .put("id", id).put("productId", productId).put("name", name).put("unitSymbol", unitSymbol)
        .put("expectedQuantity", expectedQuantity)
        .put("countedQuantity", countedQuantity ?: JSONObject.NULL)
        .put("difference", difference ?: JSONObject.NULL)
    private fun DavinciInventoryCountSummary.toJson() = JSONObject()
        .put("id", id).put("status", status).put("openedAt", openedAt)
        .put("postedAt", postedAt ?: JSONObject.NULL).put("products", products)
        .put("countedProducts", countedProducts)
    private fun DavinciInventoryAdjustmentResult.toJson() = JSONObject()
        .put("id", id).put("duplicate", duplicate).put("quantityDelta", quantityDelta)
        .put("costTotalMinor", costTotalMinor)
    private fun DavinciInventoryCountPostResult.toJson() = JSONObject()
        .put("id", id).put("duplicate", duplicate)
        .put("adjustments", JSONArray().apply { adjustments.forEach { put(JSONObject().put("productId", it.productId).put("quantityDelta", it.quantityDelta).put("costTotalMinor", it.costTotalMinor)) } })

    private fun DavinciExchangeRate.toJson() = JSONObject()
        .put("id", id).put("fromCurrency", fromCurrency).put("toCurrency", toCurrency)
        .put("rate", rate).put("effectiveAt", effectiveAt)
        .put("createdBy", createdBy ?: JSONObject.NULL)
    private fun DavinciProductCurrency.toJson() = JSONObject()
        .put("id", productId).put("priceCurrency", currency)
        .put("foreignCostMinor", foreignCostMinor ?: JSONObject.NULL)
        .put("foreignSalePriceMinor", foreignSalePriceMinor ?: JSONObject.NULL)
        .put("autoRateUpdate", autoUpdate).put("costMinor", localCostMinor)
        .put("salePriceMinor", localSalePriceMinor)

    private fun DavinciUnit.toJson() = JSONObject().put("id", id).put("name", name).put("symbol", symbol).put("precision", precision)
    private fun DavinciCategory.toJson() = JSONObject().put("id", id).put("name", name).put("color", color)
    private fun DavinciProduct.toJson() = JSONObject()
        .put("id", id).put("sku", sku ?: JSONObject.NULL).put("barcode", barcode ?: JSONObject.NULL)
        .put("name", name).put("categoryId", categoryId ?: JSONObject.NULL).put("categoryName", categoryName ?: JSONObject.NULL)
        .put("baseUnitId", baseUnitId).put("baseUnitSymbol", baseUnitSymbol ?: JSONObject.NULL)
        .put("costMinor", costMinor).put("salePriceMinor", salePriceMinor).put("taxRateBps", taxRateBps)
        .put("taxExempt", taxExempt).put("trackStock", trackStock).put("minStock", minStock)
        .put("stockOnHand", stockOnHand).put("inventoryValueMinor", inventoryValueMinor)
        .put("priceCurrency", priceCurrency).put("foreignCostMinor", foreignCostMinor ?: JSONObject.NULL)
        .put("foreignSalePriceMinor", foreignSalePriceMinor ?: JSONObject.NULL).put("autoRateUpdate", autoRateUpdate).put("isActive", isActive)
    private fun DavinciProductUnit.toJson() = JSONObject()
        .put("id", id).put("productId", productId).put("unitId", unitId).put("name", unitName).put("symbol", unitSymbol)
        .put("baseQuantity", baseQuantity).put("barcode", barcode ?: JSONObject.NULL)
        .put("salePriceMinor", salePriceMinor ?: JSONObject.NULL).put("isDefaultSale", isDefaultSale)
    private fun DavinciBarcodeLookup.toJson() = JSONObject()
        .put("productId", productId).put("name", name).put("barcode", barcode ?: JSONObject.NULL)
        .put("salePriceMinor", salePriceMinor).put("unitId", unitId ?: JSONObject.NULL)
        .put("unitName", unitName ?: JSONObject.NULL).put("unitSymbol", unitSymbol ?: JSONObject.NULL)
        .put("baseQuantity", baseQuantity).put("productUnitId", productUnitId ?: JSONObject.NULL).put("lineType", lineType)

    private fun DavinciCustomer.toJson() = JSONObject()
        .put("id", id).put("name", name).put("phone", phone ?: JSONObject.NULL)
        .put("email", email ?: JSONObject.NULL)

    private fun DavinciSupplier.toJson() = JSONObject()
        .put("id", id).put("name", name).put("phone", phone ?: JSONObject.NULL)
        .put("email", email ?: JSONObject.NULL).put("address", address ?: JSONObject.NULL)

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

    private fun JSONObject.longOrNull(key: String): Long? =
        if (!has(key) || isNull(key) || optString(key).isEmpty()) null else optLong(key)

    private fun JSONObject.toPrimitiveMap(): Map<String, Any?> {
        val result = linkedMapOf<String, Any?>()
        val iterator = keys()
        while (iterator.hasNext()) {
            val key = iterator.next()
            val value = get(key)
            result[key] = if (value === JSONObject.NULL) null else value
        }
        return result
    }

    private fun JSONObject.toNewProduct() = DavinciCatalogRepository.NewProduct(
        id = optString("id").takeIf { it.isNotEmpty() }, name = optString("name"),
        baseUnitId = optString("baseUnitId"), sku = optString("sku").takeIf { it.isNotEmpty() },
        barcode = optString("barcode").takeIf { it.isNotEmpty() }, categoryId = optString("categoryId").takeIf { it.isNotEmpty() },
        costMinor = optLong("costMinor", 0), salePriceMinor = optLong("salePriceMinor", 0),
        taxRateBps = optInt("taxRateBps", 0), taxExempt = optBoolean("taxExempt", false),
        trackStock = optBoolean("trackStock", true), minStock = optDouble("minStock", 0.0)
    )

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
