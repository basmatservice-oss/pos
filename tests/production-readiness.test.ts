import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-prod-test-'));
const testDbPath = path.join(tmpDir, 'test-prod-pos.db');
process.env.POS_DB_PATH = testDbPath;

const { runMigrations } = await import('../migrate.js');
const { sqliteInstance } = await import('../drizzle/db.js');
const { createPosApp, seedDefaultUsersAndAccounts, isAllowedCorsOrigin } = await import('../server/app.js');

let baseUrl = '';
let httpServer: any;
let adminToken = '';
let cashierToken = '';
let categoryId = 0;
let supplierId = 0;

test.before(async () => {
  await runMigrations();
  await seedDefaultUsersAndAccounts();

  const created = createPosApp();
  httpServer = created.httpServer;
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  const loginRes = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  assert.equal(loginRes.status, 200);
  adminToken = loginRes.data.token;

  const catRes = await api(
    '/api/categories',
    { method: 'POST', body: JSON.stringify({ name: 'تصنيف عام', color: '#0f766e' }) },
    adminToken
  );
  assert.equal(catRes.status, 201);
  categoryId = catRes.data.id;

  const supRes = await api(
    '/api/suppliers',
    { method: 'POST', body: JSON.stringify({ name: 'مورد الجملة', phone: '0551112233', balance: 0 }) },
    adminToken
  );
  assert.equal(supRes.status, 201);
  supplierId = supRes.data.id;
});

test.after(async () => {
  await new Promise<void>((resolve) => {
    if (httpServer) {
      httpServer.close(() => resolve());
    } else {
      resolve();
    }
  });
  try {
    sqliteInstance.close();
  } catch {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

async function api(route: string, init: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${baseUrl}${route}`, { ...init, headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, data: json };
}

test('1. Decimal & Multi-Unit Purchase + Sale Flow', async () => {
  // Bulk fractional product (kg + 5kg sack)
  const kgProdRes = await api(
    '/api/products',
    {
      method: 'POST',
      body: JSON.stringify({
        barcode: 'KG-100',
        name: 'أرز بسمتي',
        categoryId,
        costPrice: 0,
        sellingPrice: 20,
        stockQuantity: 0,
        unit: 'كجم',
        conversionFactor: 1,
        allowFractions: 1,
        itemType: 'stock',
        unitsJson: JSON.stringify([
          { name: 'كجم', conversionFactor: 1, price: 20 },
          { name: 'شوال 5كجم', conversionFactor: 5, price: 95 },
        ]),
        vatRate: 0,
        updatedAt: new Date().toISOString(),
      }),
    },
    adminToken
  );
  assert.equal(kgProdRes.status, 201);
  const kgProdId = kgProdRes.data.id;

  // Box + piece product (12 pcs per box)
  const boxProdRes = await api(
    '/api/products',
    {
      method: 'POST',
      body: JSON.stringify({
        barcode: 'BOX-12',
        name: 'مياه معبأة',
        categoryId,
        costPrice: 0,
        sellingPrice: 10,
        stockQuantity: 0,
        unit: 'piece',
        conversionFactor: 12,
        allowFractions: 0,
        itemType: 'stock',
        unitsJson: JSON.stringify([
          { name: 'piece', conversionFactor: 1, price: 10 },
          { name: 'box', conversionFactor: 12, price: 110, barcode: 'BOX-12-CARTON' },
        ]),
        vatRate: 0,
        updatedAt: new Date().toISOString(),
      }),
    },
    adminToken
  );
  assert.equal(boxProdRes.status, 201);
  const boxProdId = boxProdRes.data.id;

  // Purchase 2 sacks (2 * 5 = 10 kg @ 50 per sack => 10/kg) and 1 box (12 pcs @ 72 per box => 6/pc)
  const purRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'purchase',
        operationId: crypto.randomUUID(),
        deviceId: 'test-dev',
        payload: {
          purchase: {
            id: crypto.randomUUID(),
            supplierId,
            supplierName: 'مورد الجملة',
            totalAmount: 172,
            paidAmount: 172,
            date: '2026-03-01T09:00:00.000Z',
          },
          items: [
            {
              productId: kgProdId,
              productName: 'أرز بسمتي',
              quantity: 2,
              unit: 'شوال 5كجم',
              conversionFactor: 5,
              costPrice: 50,
            },
            {
              productId: boxProdId,
              productName: 'مياه معبأة',
              quantity: 1,
              unit: 'box',
              conversionFactor: 12,
              costPrice: 72,
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(purRes.status, 201);

  // Sell 1.25 kg of rice + 1 box (12 pcs) of water
  const saleRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          order: {
            id: crypto.randomUUID(),
            receiptNumber: 'INV-MULTI-1',
            totalAmount: 135,
            discountAmount: 0,
            taxAmount: 0,
            netAmount: 135,
            paymentMethod: 'cash',
            status: 'completed',
            createdAt: '2026-03-02T10:00:00.000Z',
          },
          items: [
            {
              productId: kgProdId,
              productName: 'أرز بسمتي',
              quantity: 1.25,
              unit: 'كجم',
              conversionFactor: 1,
              unitPrice: 20,
              subTotal: 25,
              taxAmount: 0,
              total: 25,
            },
            {
              productId: boxProdId,
              productName: 'مياه معبأة',
              quantity: 1,
              unit: 'box',
              conversionFactor: 12,
              unitPrice: 110,
              subTotal: 110,
              taxAmount: 0,
              total: 110,
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(saleRes.status, 201);
  assert.equal(saleRes.data.result.items[0].costPriceAtTimeOfSale, 10);
  assert.equal(saleRes.data.result.items[1].costPriceAtTimeOfSale, 72);

  const prods = (await api('/api/products', {}, adminToken)).data as any[];
  const kgAfter = prods.find((p) => p.id === kgProdId);
  const boxAfter = prods.find((p) => p.id === boxProdId);
  assert.equal(kgAfter.stockQuantity, 8.75);
  assert.equal(boxAfter.stockQuantity, 0);
});

test('2. Landed Cost Allocation & Multi-Currency FX Purchase', async () => {
  const p1 = (
    await api(
      '/api/products',
      {
        method: 'POST',
        body: JSON.stringify({
          barcode: 'FX-1',
          name: 'شاشة مستوردة',
          categoryId,
          costPrice: 0,
          sellingPrice: 1200,
          stockQuantity: 0,
          unit: 'piece',
          conversionFactor: 1,
          vatRate: 0,
          updatedAt: new Date().toISOString(),
        }),
      },
      adminToken
    )
  ).data;

  const p2 = (
    await api(
      '/api/products',
      {
        method: 'POST',
        body: JSON.stringify({
          barcode: 'FX-2',
          name: 'لوحة مفاتيح مستوردة',
          categoryId,
          costPrice: 0,
          sellingPrice: 300,
          stockQuantity: 0,
          unit: 'piece',
          conversionFactor: 1,
          vatRate: 0,
          updatedAt: new Date().toISOString(),
        }),
      },
      adminToken
    )
  ).data;

  // FX rate = 3.75 SAR/USD. Item 1: 1 unit @ $100 (= 375 SAR). Item 2: 2 units @ $50 (= 187.5 SAR * 2 = 375 SAR).
  // Total goods = 750 SAR. Shipping = 70, Customs = 30 => extra = 100 SAR split 50 / 50.
  // So Item 1 landed cost/unit = (375 + 50)/1 = 425. Item 2 landed cost/unit = (375 + 50)/2 = 212.5.
  const purId = crypto.randomUUID();
  const purRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'purchase',
        operationId: crypto.randomUUID(),
        deviceId: 'test-dev',
        payload: {
          purchase: {
            id: purId,
            supplierId,
            supplierName: 'مورد الجملة',
            currency: 'USD',
            exchangeRate: 3.75,
            shippingCost: 70,
            customsCost: 30,
            otherCosts: 0,
            extraCostsPaymentMethod: 'cash',
            totalAmount: 750,
            paidAmount: 0,
            date: '2026-03-03T10:00:00.000Z',
          },
          items: [
            {
              productId: p1.id,
              productName: p1.name,
              quantity: 1,
              unit: 'piece',
              conversionFactor: 1,
              costPrice: 100,
              pricesInForeignCurrency: true,
            },
            {
              productId: p2.id,
              productName: p2.name,
              quantity: 2,
              unit: 'piece',
              conversionFactor: 1,
              costPrice: 50,
              pricesInForeignCurrency: true,
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(purRes.status, 201);

  const batches = ((await api('/api/inventoryBatches', {}, adminToken)).data as any[]).filter(
    (b) => b.purchaseId === purId
  );
  const b1 = batches.find((b) => b.productId === p1.id);
  const b2 = batches.find((b) => b.productId === p2.id);
  assert.equal(b1.costPrice, 425);
  assert.equal(b2.costPrice, 212.5);

  const prods = (await api('/api/products', {}, adminToken)).data as any[];
  assert.equal(prods.find((p) => p.id === p1.id).costPrice, 425);
  assert.equal(prods.find((p) => p.id === p2.id).costPrice, 212.5);

  // Verify Journal Entry lines for purchase (Debit 1200 = 850, Credit 2100 = 750, Credit 1010 = 100)
  const jes = (await api('/api/journalEntries', {}, adminToken)).data as any[];
  const je = jes.find((j) => j.referenceId === purId && j.referenceType === 'purchase');
  assert.ok(je, 'Expected journal entry for FX purchase');
  const txs = ((await api('/api/transactions', {}, adminToken)).data as any[]).filter(
    (t) => t.journalEntryId === je.id
  );
  const debit1200 = txs.find((t) => t.accountId === '1200')?.debit;
  const credit2100 = txs.find((t) => t.accountId === '2100')?.credit;
  const credit1010 = txs.find((t) => t.accountId === '1010')?.credit;
  assert.equal(debit1200, 850);
  assert.equal(credit2100, 750);
  assert.equal(credit1010, 100);
});

test('3. Inventory Valuation Method Toggle (Weighted Average vs FIFO)', async () => {
  const prod = (
    await api(
      '/api/products',
      {
        method: 'POST',
        body: JSON.stringify({
          barcode: 'VAL-1',
          name: 'قهوة مختصة',
          categoryId,
          costPrice: 0,
          sellingPrice: 50,
          stockQuantity: 0,
          unit: 'piece',
          conversionFactor: 1,
          vatRate: 0,
          updatedAt: new Date().toISOString(),
        }),
      },
      adminToken
    )
  ).data;

  // Buy 2 @ 10 and 2 @ 20 => weighted avg = 15
  for (const [idx, cost] of [10, 20].entries()) {
    await api(
      '/api/operations/execute',
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'purchase',
          operationId: crypto.randomUUID(),
          deviceId: 'test-dev',
          payload: {
            purchase: {
              id: crypto.randomUUID(),
              supplierId,
              supplierName: 'مورد الجملة',
              totalAmount: cost * 2,
              paidAmount: cost * 2,
              date: `2026-03-04T1${idx}:00:00.000Z`,
            },
            items: [{ productId: prod.id, productName: prod.name, quantity: 2, costPrice: cost }],
          },
        }),
      },
      adminToken
    );
  }

  // Switch valuation to weighted_average
  const setWa = await api(
    '/api/settings',
    { method: 'POST', body: JSON.stringify({ key: 'inventoryValuationMethod', value: 'weighted_average' }) },
    adminToken
  );
  assert.equal(setWa.status, 201);

  const saleWa = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          order: {
            id: crypto.randomUUID(),
            receiptNumber: 'INV-WA-1',
            totalAmount: 50,
            discountAmount: 0,
            taxAmount: 0,
            netAmount: 50,
            paymentMethod: 'cash',
            status: 'completed',
            createdAt: '2026-03-04T15:00:00.000Z',
          },
          items: [
            {
              productId: prod.id,
              productName: prod.name,
              quantity: 1,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 50,
              subTotal: 50,
              taxAmount: 0,
              total: 50,
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(saleWa.status, 201);
  assert.equal(saleWa.data.result.items[0].costPriceAtTimeOfSale, 15);

  // Switch back to FIFO -> next sale pulls from remaining Batch 1 (@ 10)
  await api(
    '/api/settings',
    { method: 'POST', body: JSON.stringify({ key: 'inventoryValuationMethod', value: 'fifo' }) },
    adminToken
  );
  const saleFifo = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          order: {
            id: crypto.randomUUID(),
            receiptNumber: 'INV-FIFO-RESTORE',
            totalAmount: 50,
            discountAmount: 0,
            taxAmount: 0,
            netAmount: 50,
            paymentMethod: 'cash',
            status: 'completed',
            createdAt: '2026-03-04T16:00:00.000Z',
          },
          items: [
            {
              productId: prod.id,
              productName: prod.name,
              quantity: 1,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 50,
              subTotal: 50,
              taxAmount: 0,
              total: 50,
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(saleFifo.status, 201);
  assert.equal(saleFifo.data.result.items[0].costPriceAtTimeOfSale, 10);
});

test('4 & 5. Duplicate Product Lines Partial Return (orderItemId) + Resalable vs Damaged Returns', async () => {
  const prod = (
    await api(
      '/api/products',
      {
        method: 'POST',
        body: JSON.stringify({
          barcode: 'RET-DUP-1',
          name: 'شاحن سريع',
          categoryId,
          costPrice: 20,
          sellingPrice: 50,
          stockQuantity: 10,
          unit: 'piece',
          conversionFactor: 1,
          vatRate: 0,
          updatedAt: new Date().toISOString(),
        }),
      },
      adminToken
    )
  ).data;

  // Order containing 2 separate lines of the exact same productId
  const orderId = crypto.randomUUID();
  const saleRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          order: {
            id: orderId,
            receiptNumber: 'INV-DUP-LINE',
            totalAmount: 350,
            discountAmount: 0,
            taxAmount: 0,
            netAmount: 350,
            paymentMethod: 'cash',
            status: 'completed',
            createdAt: '2026-03-05T10:00:00.000Z',
          },
          items: [
            {
              productId: prod.id,
              productName: prod.name,
              quantity: 3,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 50,
              subTotal: 150,
              taxAmount: 0,
              total: 150,
            },
            {
              productId: prod.id,
              productName: prod.name,
              quantity: 4,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 50,
              subTotal: 200,
              taxAmount: 0,
              total: 200,
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(saleRes.status, 201);
  const line1 = saleRes.data.result.items[0];
  const line2 = saleRes.data.result.items[1];
  assert.notEqual(line1.id, line2.id);

  // Stock after selling 7 out of 10 = 3
  let prodNow = ((await api('/api/products', {}, adminToken)).data as any[]).find((p) => p.id === prod.id);
  assert.equal(prodNow.stockQuantity, 3);

  // Partial RESALABLE return targeting strictly line #2 (qty 2)
  const retResalable = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'return',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          id: crypto.randomUUID(),
          returnNumber: 'RET-DUP-RESALE',
          originalOrderId: orderId,
          refundMethod: 'cash',
          reason: 'تغيير رأي العميل',
          items: [
            {
              orderItemId: line2.id,
              productId: prod.id,
              productName: prod.name,
              quantity: 2,
              condition: 'resalable',
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(retResalable.status, 201);

  const oItemsAfter1 = ((await api('/api/orderItems', {}, adminToken)).data as any[]).filter(
    (oi) => oi.orderId === orderId
  );
  assert.equal(oItemsAfter1.find((i) => i.id === line1.id).returnedQuantity, 0);
  assert.equal(oItemsAfter1.find((i) => i.id === line2.id).returnedQuantity, 2);

  // Resalable return restored 2 units => stock becomes 5
  prodNow = ((await api('/api/products', {}, adminToken)).data as any[]).find((p) => p.id === prod.id);
  assert.equal(prodNow.stockQuantity, 5);

  // Partial DAMAGED return targeting line #1 (qty 1)
  const damagedRetId = crypto.randomUUID();
  const retDamaged = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'return',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          id: damagedRetId,
          returnNumber: 'RET-DUP-DAMAGED',
          originalOrderId: orderId,
          refundMethod: 'cash',
          reason: 'عطل مصنعي',
          items: [
            {
              orderItemId: line1.id,
              productId: prod.id,
              productName: prod.name,
              quantity: 1,
              condition: 'damaged',
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(retDamaged.status, 201);

  // Damaged return must NOT increase sellable stock (remains 5)
  prodNow = ((await api('/api/products', {}, adminToken)).data as any[]).find((p) => p.id === prod.id);
  assert.equal(prodNow.stockQuantity, 5);

  // Damaged return must post Debit 5400 / Credit 5100 for cost (20)
  const jes = (await api('/api/journalEntries', {}, adminToken)).data as any[];
  const dmgCostJe = jes.find(
    (j) => j.referenceId === damagedRetId && String(j.description).includes('تالف')
  );
  assert.ok(dmgCostJe, 'Expected damaged return write-off journal entry');
  const dmgTxs = ((await api('/api/transactions', {}, adminToken)).data as any[]).filter(
    (t) => t.journalEntryId === dmgCostJe.id
  );
  assert.equal(dmgTxs.find((t) => t.accountId === '5400')?.debit, 20);
  assert.equal(dmgTxs.find((t) => t.accountId === '5100')?.credit, 20);
});

test('6. Service Items & Service-with-Materials Recipe Deduction + Void Restoration', async () => {
  const ingRes = await api(
    '/api/products',
    {
      method: 'POST',
      body: JSON.stringify({
        barcode: 'OIL-5W30',
        name: 'زيت محرك 1 لتر',
        categoryId,
        costPrice: 25,
        sellingPrice: 40,
        stockQuantity: 20,
        unit: 'لتر',
        conversionFactor: 1,
        itemType: 'stock',
        vatRate: 0,
        updatedAt: new Date().toISOString(),
      }),
    },
    adminToken
  );
  const ingId = ingRes.data.id;

  const pureService = (
    await api(
      '/api/products',
      {
        method: 'POST',
        body: JSON.stringify({
          barcode: 'SRV-DIAG',
          name: 'فحص كمبيوتر',
          categoryId,
          costPrice: 0,
          sellingPrice: 100,
          stockQuantity: 0,
          unit: 'خدمة',
          conversionFactor: 1,
          itemType: 'service',
          vatRate: 0,
          updatedAt: new Date().toISOString(),
        }),
      },
      adminToken
    )
  ).data;

  const recipeService = (
    await api(
      '/api/products',
      {
        method: 'POST',
        body: JSON.stringify({
          barcode: 'SRV-OIL',
          name: 'خدمة غيار زيت كاملة',
          categoryId,
          costPrice: 0,
          sellingPrice: 250,
          stockQuantity: 0,
          unit: 'خدمة',
          conversionFactor: 1,
          itemType: 'service_with_materials',
          vatRate: 0,
          updatedAt: new Date().toISOString(),
        }),
      },
      adminToken
    )
  ).data;

  const recSave = await api(
    '/api/serviceRecipes',
    {
      method: 'POST',
      body: JSON.stringify({
        parentProductId: recipeService.id,
        ingredientProductId: ingId,
        ingredientName: 'زيت محرك 1 لتر',
        quantity: 4,
        unit: 'لتر',
      }),
    },
    adminToken
  );
  assert.equal(recSave.status, 201);

  const srvOrderId = crypto.randomUUID();
  const saleRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          order: {
            id: srvOrderId,
            receiptNumber: 'INV-SRV-1',
            totalAmount: 350,
            discountAmount: 0,
            taxAmount: 0,
            netAmount: 350,
            paymentMethod: 'cash',
            status: 'completed',
            createdAt: '2026-03-06T10:00:00.000Z',
          },
          items: [
            {
              productId: pureService.id,
              productName: pureService.name,
              itemType: 'service',
              quantity: 1,
              unit: 'خدمة',
              conversionFactor: 1,
              unitPrice: 100,
              subTotal: 100,
              taxAmount: 0,
              total: 100,
            },
            {
              productId: recipeService.id,
              productName: recipeService.name,
              itemType: 'service_with_materials',
              quantity: 1,
              unit: 'خدمة',
              conversionFactor: 1,
              unitPrice: 250,
              subTotal: 250,
              taxAmount: 0,
              total: 250,
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(saleRes.status, 201);
  assert.equal(saleRes.data.result.items[0].costPriceAtTimeOfSale, 0);
  assert.equal(saleRes.data.result.items[1].costPriceAtTimeOfSale, 100); // 4L * 25 = 100

  let ingNow = ((await api('/api/products', {}, adminToken)).data as any[]).find((p) => p.id === ingId);
  assert.equal(ingNow.stockQuantity, 16);

  // Void the order -> must restore 4L of ingredient oil back to 20L
  const voidRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'order_void',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: { orderId: srvOrderId, reason: 'إلغاء تجربة خدمة' },
      }),
    },
    adminToken
  );
  assert.equal(voidRes.status, 201);

  ingNow = ((await api('/api/products', {}, adminToken)).data as any[]).find((p) => p.id === ingId);
  assert.equal(ingNow.stockQuantity, 20);
});

test('7. Fiscal Period Lock & Cross-Period Return Protection', async () => {
  const prod = (
    await api(
      '/api/products',
      {
        method: 'POST',
        body: JSON.stringify({
          barcode: 'FP-1',
          name: 'صنف فترة مالية',
          categoryId,
          costPrice: 10,
          sellingPrice: 30,
          stockQuantity: 10,
          unit: 'piece',
          conversionFactor: 1,
          vatRate: 0,
          updatedAt: new Date().toISOString(),
        }),
      },
      adminToken
    )
  ).data;

  // Create & complete a sale inside Jan 2025 BEFORE closing Jan 2025
  const oldOrderId = crypto.randomUUID();
  const oldSale = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          order: {
            id: oldOrderId,
            receiptNumber: 'INV-JAN-2025',
            totalAmount: 60,
            discountAmount: 0,
            taxAmount: 0,
            netAmount: 60,
            paymentMethod: 'cash',
            status: 'completed',
            createdAt: '2025-01-15T12:00:00.000Z',
          },
          items: [
            {
              productId: prod.id,
              productName: prod.name,
              quantity: 2,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 30,
              subTotal: 60,
              taxAmount: 0,
              total: 60,
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(oldSale.status, 201);

  // Create fiscal period Jan 2025 and close it
  const fpRes = await api(
    '/api/fiscalPeriods',
    {
      method: 'POST',
      body: JSON.stringify({ name: 'يناير 2025', startDate: '2025-01-01', endDate: '2025-01-31' }),
    },
    adminToken
  );
  assert.equal(fpRes.status, 201);
  const closeRes = await api(`/api/fiscalPeriods/${fpRes.data.id}/close`, { method: 'POST' }, adminToken);
  assert.equal(closeRes.status, 200);
  assert.equal(closeRes.data.status, 'closed');

  // Sale dated inside closed period must be rejected with 403
  const blockedSale = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          order: {
            id: crypto.randomUUID(),
            receiptNumber: 'INV-BLOCKED',
            totalAmount: 30,
            discountAmount: 0,
            taxAmount: 0,
            netAmount: 30,
            paymentMethod: 'cash',
            status: 'completed',
            createdAt: '2025-01-20T10:00:00.000Z',
          },
          items: [
            {
              productId: prod.id,
              productName: prod.name,
              quantity: 1,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 30,
              subTotal: 30,
              taxAmount: 0,
              total: 30,
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(blockedSale.status, 403);

  // Purchase dated inside closed period must be rejected with 403
  const blockedPurchase = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'purchase',
        operationId: crypto.randomUUID(),
        deviceId: 'test-dev',
        payload: {
          purchase: {
            id: crypto.randomUUID(),
            supplierId,
            supplierName: 'مورد الجملة',
            totalAmount: 10,
            paidAmount: 10,
            date: '2025-01-22T10:00:00.000Z',
          },
          items: [{ productId: prod.id, productName: prod.name, quantity: 1, costPrice: 10 }],
        },
      }),
    },
    adminToken
  );
  assert.equal(blockedPurchase.status, 403);

  // Expense dated inside closed period must be rejected with 403
  const blockedExpense = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'expense',
        operationId: crypto.randomUUID(),
        deviceId: 'test-dev',
        payload: {
          description: 'فاتورة مقفلة',
          amount: 50,
          category: 'عام',
          paymentMethod: 'cash',
          date: '2025-01-25T10:00:00.000Z',
        },
      }),
    },
    adminToken
  );
  assert.equal(blockedExpense.status, 403);

  // Cross-period return: returning Jan 2025 invoice dated in current OPEN period (2026-03-07) must succeed
  const crossReturn = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'return',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          id: crypto.randomUUID(),
          returnNumber: 'RET-CROSS-PERIOD',
          originalOrderId: oldOrderId,
          returnDate: '2026-03-07T10:00:00.000Z',
          refundMethod: 'cash',
          reason: 'مرتجع عبر الفترات',
          items: [{ productId: prod.id, productName: prod.name, quantity: 1, condition: 'resalable' }],
        },
      }),
    },
    adminToken
  );
  assert.equal(crossReturn.status, 201);
});

test('8 & 9. Negative Stock Policy Enforcement, RBAC Cashier Restrictions, CORS, System Status & Global Ledger Balance', async () => {
  // Create cashier employee with only view_pos
  const empRes = await api(
    '/api/employees',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'كاشير 1',
        username: 'cashier1',
        password: 'cashier_password_123',
        pinCode: '5678',
        role: 'cashier',
        phone: '0509998877',
        salary: 4000,
        joinDate: new Date().toISOString(),
        status: 'active',
        permissions: ['view_pos'],
      }),
    },
    adminToken
  );
  assert.equal(empRes.status, 201);

  const cashierLogin = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'cashier1', password: 'cashier_password_123' }),
  });
  assert.equal(cashierLogin.status, 200);
  cashierToken = cashierLogin.data.token;

  // RBAC: Cashier must get 403 on Fiscal Periods, Sync Queue, and Settings entity_upsert
  const r1 = await api(
    '/api/fiscalPeriods',
    { method: 'POST', body: JSON.stringify({ name: 'Test', startDate: '2026-01-01', endDate: '2026-12-31' }) },
    cashierToken
  );
  assert.equal(r1.status, 403);

  const r2 = await api('/api/sync-queue', {}, cashierToken);
  assert.equal(r2.status, 403);

  const r3 = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'entity_upsert',
        operationId: crypto.randomUUID(),
        payload: { table: 'settings', record: { key: 'taxRate', value: '0' } },
      }),
    },
    cashierToken
  );
  assert.equal(r3.status, 403);

  // Stock policy enforcement
  const lowProd = (
    await api(
      '/api/products',
      {
        method: 'POST',
        body: JSON.stringify({
          barcode: 'NEG-1',
          name: 'صنف محدود',
          categoryId,
          costPrice: 10,
          sellingPrice: 25,
          stockQuantity: 1,
          unit: 'piece',
          conversionFactor: 1,
          vatRate: 0,
          updatedAt: new Date().toISOString(),
        }),
      },
      adminToken
    )
  ).data;

  // Set policy = block
  await api(
    '/api/settings',
    { method: 'POST', body: JSON.stringify({ key: 'offlineStockPolicy', value: 'block' }) },
    adminToken
  );

  const blockedNeg = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          order: {
            id: crypto.randomUUID(),
            receiptNumber: 'INV-NEG-BLK',
            totalAmount: 50,
            discountAmount: 0,
            taxAmount: 0,
            netAmount: 50,
            paymentMethod: 'cash',
            status: 'completed',
            createdAt: '2026-03-08T10:00:00.000Z',
          },
          items: [
            {
              productId: lowProd.id,
              productName: lowProd.name,
              quantity: 2,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 25,
              subTotal: 50,
              taxAmount: 0,
              total: 50,
            },
          ],
        },
      }),
    },
    cashierToken
  );
  assert.equal(blockedNeg.status, 400);

  // Policy = manager_override: cashier trying to spoof managerOverride: true STILL fails with 400; admin succeeds with 201
  await api(
    '/api/settings',
    { method: 'POST', body: JSON.stringify({ key: 'offlineStockPolicy', value: 'manager_override' }) },
    adminToken
  );

  const spoofedOverride = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          managerOverride: true,
          order: {
            id: crypto.randomUUID(),
            receiptNumber: 'INV-NEG-SPOOF',
            totalAmount: 50,
            discountAmount: 0,
            taxAmount: 0,
            netAmount: 50,
            paymentMethod: 'cash',
            status: 'completed',
            createdAt: '2026-03-08T11:00:00.000Z',
          },
          items: [
            {
              productId: lowProd.id,
              productName: lowProd.name,
              quantity: 2,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 25,
              subTotal: 50,
              taxAmount: 0,
              total: 50,
            },
          ],
        },
      }),
    },
    cashierToken
  );
  assert.equal(spoofedOverride.status, 400);

  const adminOverrideOpId = crypto.randomUUID();
  const validOverride = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: adminOverrideOpId,
        deviceId: 'pos-1',
        payload: {
          managerOverride: true,
          order: {
            id: crypto.randomUUID(),
            receiptNumber: 'INV-NEG-OVR',
            totalAmount: 50,
            discountAmount: 0,
            taxAmount: 0,
            netAmount: 50,
            paymentMethod: 'cash',
            status: 'completed',
            createdAt: '2026-03-08T12:00:00.000Z',
          },
          items: [
            {
              productId: lowProd.id,
              productName: lowProd.name,
              quantity: 2,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 25,
              subTotal: 50,
              taxAmount: 0,
              total: 50,
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(validOverride.status, 201);

  const alerts = (await api('/api/inventoryAlerts', {}, adminToken)).data as any[];
  assert.ok(alerts.some((a) => a.operationId === adminOverrideOpId && a.resultingQty === -1));

  // CORS verification
  assert.equal(isAllowedCorsOrigin('http://localhost:3000'), true);
  assert.equal(isAllowedCorsOrigin('http://192.168.1.50:3000'), true);
  assert.equal(isAllowedCorsOrigin('https://pos-app.run.app'), true);
  assert.equal(isAllowedCorsOrigin('https://evil.example.com'), false);

  // System status check
  const sysRes = await api('/api/system/status', {}, adminToken);
  assert.equal(sysRes.status, 200);
  assert.equal(sysRes.data.integrity, 'ok');
  assert.equal(sysRes.data.walMode, 'wal');

  // Authoritative Financial Report (Aging + CashFlow + Balanced BS)
  const finRes = await api('/api/reports/financial', {}, adminToken);
  assert.equal(finRes.status, 200);
  assert.ok(finRes.data.aging);
  assert.ok(finRes.data.cashFlow);
  assert.equal(finRes.data.balanceSheet.balanced, true);

  // Global Double-Entry Invariant across ALL transactions
  const allTxs = (await api('/api/transactions', {}, adminToken)).data as Array<{ debit: number; credit: number }>;
  const sumDebit = Math.round(allTxs.reduce((s, t) => s + Number(t.debit || 0), 0) * 100) / 100;
  const sumCredit = Math.round(allTxs.reduce((s, t) => s + Number(t.credit || 0), 0) * 100) / 100;
  assert.equal(sumDebit, sumCredit, `Unbalanced double-entry ledger: debit=${sumDebit}, credit=${sumCredit}`);
});
