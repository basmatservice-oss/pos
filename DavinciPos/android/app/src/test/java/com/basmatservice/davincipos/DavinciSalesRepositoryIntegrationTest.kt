package com.basmatservice.davincipos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class DavinciSalesRepositoryIntegrationTest {
    @Test
    fun fifoServiceSalePersistsComponentLayerAllocations() {
        val context = RuntimeEnvironment.getApplication()
        DavinciDatabase.resetForTests(context)
        val db = DavinciDatabase.get(context).writableDatabase
        db.execSQL("UPDATE app_settings SET value='fifo' WHERE key='inventory.cost_method'")
        db.execSQL("UPDATE app_settings SET value='false' WHERE key='tax.enabled'")

        val catalog = DavinciCatalogRepository(context)
        val componentId = catalog.createProduct(
            DavinciCatalogRepository.NewProduct(
                id = "service-component-product",
                name = "Service Component",
                baseUnitId = "unit-piece",
                costMinor = 150,
                salePriceMinor = 100,
                trackStock = true
            )
        )
        DavinciInventoryRepository(context).receiveStock(
            productId = componentId,
            branchId = DavinciCatalogRepository.MAIN_BRANCH_ID,
            sourceType = "opening",
            sourceId = "service-component-opening",
            quantity = 3.0,
            unitCostMinor = 150,
            occurredAt = "2026-11-16T08:00:00.000Z"
        )
        val serviceId = "service-with-fifo-component"
        db.execSQL(
            """INSERT INTO services(id,code,name,price_minor,tax_rate_bps,tax_exempt,is_active,created_at,updated_at)
               VALUES(?,?,?,?,0,0,1,?,?)""".trimIndent(),
            arrayOf(serviceId, "SVC-FIFO", "Assembly Service", 500,
                "2026-11-16T08:00:00.000Z", "2026-11-16T08:00:00.000Z")
        )
        db.execSQL(
            "INSERT INTO service_components(id,service_id,product_id,quantity) VALUES(?,?,?,?)",
            arrayOf("service-component-link", serviceId, componentId, 2.0)
        )

        val result = DavinciSalesRepository(context).checkoutSale(
            DavinciSaleInput(
                id = "service-fifo-sale",
                lines = listOf(DavinciSaleLineInput(serviceId, 1.0, lineType = "service")),
                payments = listOf(DavinciSalePayment("cash", 600)),
                occurredAt = "2026-11-16T09:00:00.000Z"
            )
        )
        assertEquals(600L, result.totalMinor)
        assertEquals(300L, result.costMinor)
        assertEquals(1.0, DavinciInventoryRepository(context).getStockOnHand(
            componentId, DavinciCatalogRepository.MAIN_BRANCH_ID
        ), 0.000001)

        val allocation = db.rawQuery(
            """SELECT COUNT(*),COALESCE(SUM(scl.quantity),0),
                      COALESCE(SUM(scl.cost_total_minor),0),MAX(il.product_id)
               FROM sale_line_cost_layers scl
               JOIN sale_lines sl ON sl.id=scl.sale_line_id
               JOIN inventory_layers il ON il.id=scl.inventory_layer_id
               WHERE sl.sale_id=? AND sl.line_type='service'""".trimIndent(),
            arrayOf(result.id)
        ).use { cursor ->
            assertTrue(cursor.moveToFirst())
            listOf(cursor.getInt(0), cursor.getDouble(1), cursor.getLong(2), cursor.getString(3))
        }
        assertEquals(1, allocation[0])
        assertEquals(2.0, allocation[1] as Double, 0.000001)
        assertEquals(300L, allocation[2])
        assertEquals(componentId, allocation[3])
    }

    @Test
    fun fifoCheckoutPostsPaymentAndCogsAndRollsBackInsufficientStock() {
        val context = RuntimeEnvironment.getApplication()
        DavinciDatabase.resetForTests(context)
        val helper = DavinciDatabase.get(context)
        val db = helper.writableDatabase
        db.execSQL(
            "UPDATE app_settings SET value='fifo' WHERE key='inventory.cost_method'"
        )

        val catalog = DavinciCatalogRepository(context)
        val productId = catalog.createProduct(
            DavinciCatalogRepository.NewProduct(
                id = "integration-product",
                name = "Integration Item",
                baseUnitId = "unit-piece",
                costMinor = 200,
                salePriceMinor = 1_000,
                trackStock = true
            )
        )
        val inventory = DavinciInventoryRepository(context)
        inventory.receiveStock(
            productId = productId,
            branchId = DavinciCatalogRepository.MAIN_BRANCH_ID,
            sourceType = "opening",
            sourceId = "opening-integration",
            quantity = 5.0,
            unitCostMinor = 200,
            occurredAt = "2026-11-16T08:00:00.000Z"
        )

        val sales = DavinciSalesRepository(context)
        val input = DavinciSaleInput(
            id = "integration-sale-001",
            lines = listOf(DavinciSaleLineInput(productId, 2.0)),
            payments = listOf(DavinciSalePayment("cash", 2_000)),
            occurredAt = "2026-11-16T09:00:00.000Z"
        )
        val salesBeforeQuote = db.rawQuery("SELECT COUNT(*) FROM sales", null).use { cursor ->
            cursor.moveToFirst(); cursor.getInt(0)
        }
        val movementsBeforeQuote = db.rawQuery(
            "SELECT COUNT(*) FROM stock_movements WHERE product_id=?",
            arrayOf(productId)
        ).use { cursor -> cursor.moveToFirst(); cursor.getInt(0) }
        val quote = try {
            sales.quoteSale(input)
        } catch (error: IllegalArgumentException) {
            System.err.println("QUOTE_SALE_FAILURE: ${error.javaClass.name}: ${error.message}")
            error.printStackTrace(System.err)
            throw AssertionError("Quote failed: ${error.message}", error)
        }
        assertEquals(2_000L, quote.totalMinor)
        assertEquals(2_000L, quote.subtotalMinor)
        assertEquals(0L, quote.taxMinor)
        assertEquals(
            salesBeforeQuote,
            db.rawQuery("SELECT COUNT(*) FROM sales", null).use { cursor ->
                cursor.moveToFirst(); cursor.getInt(0)
            }
        )
        assertEquals(
            movementsBeforeQuote,
            db.rawQuery(
                "SELECT COUNT(*) FROM stock_movements WHERE product_id=?",
                arrayOf(productId)
            ).use { cursor -> cursor.moveToFirst(); cursor.getInt(0) }
        )

        val result = try {
            sales.checkoutSale(input)
        } catch (error: IllegalArgumentException) {
            System.err.println("CHECKOUT_SALE_FAILURE: ${error.javaClass.name}: ${error.message}")
            error.printStackTrace(System.err)
            throw AssertionError("Checkout failed: ${error.message}", error)
        }
        assertFalse(result.duplicate)
        assertEquals(2_000L, result.totalMinor)
        assertEquals(400L, result.costMinor)
        assertEquals(3.0, inventory.getStockOnHand(productId, DavinciCatalogRepository.MAIN_BRANCH_ID), 0.000001)

        val allocation = db.rawQuery(
            """
            SELECT COUNT(*),COALESCE(SUM(scl.quantity),0),COALESCE(SUM(scl.cost_total_minor),0)
            FROM sale_line_cost_layers scl
            JOIN sale_lines sl ON sl.id=scl.sale_line_id
            WHERE sl.sale_id=?
            """.trimIndent(),
            arrayOf(result.id)
        ).use { cursor ->
            assertTrue(cursor.moveToFirst())
            Triple(cursor.getInt(0), cursor.getDouble(1), cursor.getLong(2))
        }
        assertEquals(1, allocation.first)
        assertEquals(2.0, allocation.second, 0.000001)
        assertEquals(400L, allocation.third)

        val paymentCount = db.rawQuery(
            "SELECT COUNT(*) FROM payments WHERE sale_id=? AND direction='in' AND method='cash' AND amount_minor=2000",
            arrayOf(result.id)
        ).use { cursor -> cursor.moveToFirst(); cursor.getInt(0) }
        assertEquals(1, paymentCount)

        val journal = db.rawQuery(
            "SELECT status FROM journal_entries WHERE source_type='sale' AND source_id=?",
            arrayOf(result.id)
        ).use { cursor -> assertTrue(cursor.moveToFirst()); cursor.getString(0) }
        assertEquals("posted", journal)

        val duplicate = sales.checkoutSale(input)
        assertTrue(duplicate.duplicate)
        assertEquals(result.receiptNumber, duplicate.receiptNumber)
        assertEquals(3.0, inventory.getStockOnHand(productId, DavinciCatalogRepository.MAIN_BRANCH_ID), 0.000001)

        val insufficient = input.copy(
            id = "integration-sale-insufficient",
            lines = listOf(DavinciSaleLineInput(productId, 10.0))
        )
        assertThrows(IllegalArgumentException::class.java) { sales.checkoutSale(insufficient) }
        val failedSaleCount = db.rawQuery(
            "SELECT COUNT(*) FROM sales WHERE id='integration-sale-insufficient'",
            null
        ).use { cursor -> cursor.moveToFirst(); cursor.getInt(0) }
        assertEquals(0, failedSaleCount)
        assertEquals(3.0, inventory.getStockOnHand(productId, DavinciCatalogRepository.MAIN_BRANCH_ID), 0.000001)
    }
}
