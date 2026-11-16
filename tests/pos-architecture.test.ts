import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// Set isolated test DB path BEFORE importing drizzle/migrate/server modules
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-arch-test-'));
const testDbPath = path.join(tmpDir, 'test-pos.db');
process.env.POS_DB_PATH = testDbPath;

const { runMigrations } = await import('../migrate.js');
const { sqliteInstance } = await import('../drizzle/db.js');
const { createPosApp, seedDefaultUsersAndAccounts, createSafeBackup } = await import('../server/app.js');

let baseUrl = '';
let httpServer: any;
let authToken = '';
let productId = 0;

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

test('1. Database integrity, seeded accounts, and authentication security', async () => {
  const integrity = sqliteInstance.pragma('integrity_check', { simple: true });
  assert.equal(integrity, 'ok');

  // Public health check
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.status, 'ok');

  // Unauthenticated access to protected routes must fail with 401
  const unauthProducts = await api('/api/products');
  assert.equal(unauthProducts.status, 401);

  // Login with seeded admin credentials
  const login = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  assert.equal(login.status, 200);
  assert.ok(login.data.token, 'Expected JWT token on login');
  assert.equal(login.data.user.username, 'admin');
  assert.equal(login.data.user.password, undefined, 'Password hash must never leak');
  assert.equal(login.data.user.pinCode, undefined, 'PIN hash must never leak');
  authToken = login.data.token;

  // Verify /api/employees does not leak password or pinCode
  const emps = await api('/api/employees', {}, authToken);
  assert.equal(emps.status, 200);
  assert.ok(Array.isArray(emps.data) && emps.data.length >= 1);
  for (const emp of emps.data) {
    assert.equal(emp.password, undefined);
    assert.equal(emp.pinCode, undefined);
  }

  // Verify /api/settings never leaks authSecret or supabaseKey
  const settingsRes = await api('/api/settings', {}, authToken);
  assert.equal(settingsRes.status, 200);
  const keys = new Set((settingsRes.data as any[]).map((s) => s.key));
  assert.equal(keys.has('authSecret'), false);
  assert.equal(keys.has('supabaseKey'), false);

  // Verify default Chart of Accounts is seeded
  const accountsRes = await api('/api/accounts', {}, authToken);
  assert.equal(accountsRes.status, 200);
  const codes = new Set((accountsRes.data as any[]).map((a) => a.code));
  for (const requiredCode of ['1010', '1020', '1100', '1200', '2100', '2200', '4100', '4200', '5100']) {
    assert.ok(codes.has(requiredCode), `Missing system account ${requiredCode}`);
  }
});

test('2. FIFO Inventory Costing & Historical COGS Invariance', async () => {
  // Create category & product with 0 initial stock
  const catRes = await api(
    '/api/categories',
    { method: 'POST', body: JSON.stringify({ name: 'إلكترونيات', color: '#4f46e5' }) },
    authToken
  );
  assert.equal(catRes.status, 201);

  const prodRes = await api(
    '/api/products',
    {
      method: 'POST',
      body: JSON.stringify({
        barcode: 'FIFO-1001',
        name: 'سماعة اختبار',
        categoryId: catRes.data.id,
        costPrice: 0,
        sellingPrice: 30,
        stockQuantity: 0,
        unit: 'piece',
        conversionFactor: 1,
        vatRate: 0,
        updatedAt: new Date().toISOString(),
      }),
    },
    authToken
  );
  assert.equal(prodRes.status, 201);
  productId = prodRes.data.id;

  // Create supplier
  const supRes = await api(
    '/api/suppliers',
    {
      method: 'POST',
      body: JSON.stringify({ name: 'مورد الاختبار', phone: '0500000001', balance: 0 }),
    },
    authToken
  );
  assert.equal(supRes.status, 201);

  // Purchase Batch 1: 10 units @ cost 10
  const p1Id = crypto.randomUUID();
  const p1Res = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'purchase',
        operationId: crypto.randomUUID(),
        deviceId: 'test-server',
        payload: {
          purchase: {
            id: p1Id,
            supplierId: supRes.data.id,
            supplierName: 'مورد الاختبار',
            totalAmount: 100,
            paidAmount: 100,
            date: '2026-01-01T10:00:00.000Z',
          },
          items: [
            {
              productId,
              productName: 'سماعة اختبار',
              quantity: 10,
              costPrice: 10,
            },
          ],
        },
      }),
    },
    authToken
  );
  assert.equal(p1Res.status, 201);

  // Sale 1: Sell 4 units @ sellingPrice 30 (Total 120) -> Must consume Batch 1 (COGS = 4 * 10 = 40)
  const order1Id = crypto.randomUUID();
  const sale1Res = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          order: {
            id: order1Id,
            receiptNumber: 'INV-FIFO-1',
            totalAmount: 120,
            discountAmount: 0,
            taxAmount: 0,
            netAmount: 120,
            paymentMethod: 'cash',
            status: 'completed',
            createdAt: '2026-01-02T10:00:00.000Z',
          },
          items: [
            {
              productId,
              productName: 'سماعة اختبار',
              quantity: 4,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 30,
              subTotal: 120,
              taxAmount: 0,
              total: 120,
            },
          ],
        },
      }),
    },
    authToken
  );
  assert.equal(sale1Res.status, 201);
  assert.equal(sale1Res.data.result.items[0].costPriceAtTimeOfSale, 10);

  // Purchase Batch 2: 10 units @ cost 15 (new batch should NOT alter Sale 1's historical cost!)
  const p2Res = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'purchase',
        operationId: crypto.randomUUID(),
        deviceId: 'test-server',
        payload: {
          purchase: {
            id: crypto.randomUUID(),
            supplierId: supRes.data.id,
            supplierName: 'مورد الاختبار',
            totalAmount: 150,
            paidAmount: 150,
            date: '2026-01-03T10:00:00.000Z',
          },
          items: [
            {
              productId,
              productName: 'سماعة اختبار',
              quantity: 10,
              costPrice: 15,
            },
          ],
        },
      }),
    },
    authToken
  );
  assert.equal(p2Res.status, 201);

  // Sale 2: Sell 8 units -> consumes remaining 6 from Batch 1 (@10 = 60) + 2 from Batch 2 (@15 = 30) => total COGS = 90, avg unit cost = 11.25
  const order2Id = crypto.randomUUID();
  const sale2Res = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          order: {
            id: order2Id,
            receiptNumber: 'INV-FIFO-2',
            totalAmount: 240,
            discountAmount: 0,
            taxAmount: 0,
            netAmount: 240,
            paymentMethod: 'card',
            status: 'completed',
            createdAt: '2026-01-04T10:00:00.000Z',
          },
          items: [
            {
              productId,
              productName: 'سماعة اختبار',
              quantity: 8,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 30,
              subTotal: 240,
              taxAmount: 0,
              total: 240,
            },
          ],
        },
      }),
    },
    authToken
  );
  assert.equal(sale2Res.status, 201);
  assert.equal(sale2Res.data.result.items[0].costPriceAtTimeOfSale, 11.25);

  // Check authoritative financial report: Total Sales = 360, Total Historical COGS = 40 + 90 = 130, Gross Profit = 230
  const finReport = await api('/api/reports/financial', {}, authToken);
  assert.equal(finReport.status, 200);
  assert.equal(finReport.data.netSalesExclTax, 360);
  assert.equal(finReport.data.netCogs, 130);
  assert.equal(finReport.data.grossProfit, 230);
  // Remaining inventory: 8 units from Batch 2 @ 15 = 120
  assert.equal(finReport.data.inventoryCostValue, 120);
});

test('3. Independent Returns & Over-Return Prevention', async () => {
  const ordersRes = await api('/api/orders', {}, authToken);
  const sale1 = (ordersRes.data as any[]).find((o) => o.receiptNumber === 'INV-FIFO-1');
  assert.ok(sale1, 'Expected INV-FIFO-1 order');

  // Partial return of 2 units out of 4
  const retRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'return',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          id: crypto.randomUUID(),
          returnNumber: 'RET-TEST-1',
          originalOrderId: sale1.id,
          refundMethod: 'cash',
          reason: 'تالف',
          items: [{ productId, productName: 'سماعة اختبار', quantity: 2 }],
        },
      }),
    },
    authToken
  );
  assert.equal(retRes.status, 201);
  assert.equal(retRes.data.result.returnRecord.totalRefund, 60);
  assert.equal(retRes.data.result.returnRecord.totalCostReversed, 20);

  // Attempting to return 3 more units when only 2 remain returnable MUST fail
  const overReturnRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'return',
        operationId: crypto.randomUUID(),
        deviceId: 'pos-1',
        payload: {
          id: crypto.randomUUID(),
          returnNumber: 'RET-TEST-OVER',
          originalOrderId: sale1.id,
          refundMethod: 'cash',
          reason: 'تجاوز الكمية',
          items: [{ productId, productName: 'سماعة اختبار', quantity: 3 }],
        },
      }),
    },
    authToken
  );
  assert.equal(overReturnRes.status, 400);
});

test('4. Offline LAN Idempotent Batch Sync & Offline Oversell Deficit Alert', async () => {
  // Currently remaining stock: 20 purchased - 4 - 8 + 2 returned = 10 units
  const prodsBefore = await api('/api/products', {}, authToken);
  const prodBefore = (prodsBefore.data as any[]).find((p) => p.id === productId);
  assert.equal(prodBefore.stockQuantity, 10);

  // Offline POS client submits a sale of 12 units (exceeds available 10 units by 2 -> oversell allowed + alert logged)
  const offlineOpId = crypto.randomUUID();
  const offlineOrderId = crypto.randomUUID();
  const batchPayload = {
    operations: [
      {
        id: offlineOpId,
        type: 'sale',
        deviceId: 'offline-terminal-2',
        payload: {
          order: {
            id: offlineOrderId,
            receiptNumber: 'INV-OFFLINE-OVERSELL',
            totalAmount: 360,
            discountAmount: 0,
            taxAmount: 0,
            netAmount: 360,
            paymentMethod: 'cash',
            status: 'completed',
            createdAt: '2026-01-05T12:00:00.000Z',
          },
          items: [
            {
              productId,
              productName: 'سماعة اختبار',
              quantity: 12,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 30,
              subTotal: 360,
              taxAmount: 0,
              total: 360,
            },
          ],
        },
      },
    ],
  };

  // First sync delivery
  const sync1 = await api('/api/operations/batch', { method: 'POST', body: JSON.stringify(batchPayload) }, authToken);
  assert.equal(sync1.status, 200);
  assert.equal(sync1.data.results[0].status, 'ok');

  // Re-sending exact same operationId (e.g. client retry after LAN timeout) must return duplicate & NOT double-deduct stock
  const sync2 = await api('/api/operations/batch', { method: 'POST', body: JSON.stringify(batchPayload) }, authToken);
  assert.equal(sync2.status, 200);
  assert.equal(sync2.data.results[0].status, 'duplicate');

  const prodsAfter = await api('/api/products', {}, authToken);
  const prodAfter = (prodsAfter.data as any[]).find((p) => p.id === productId);
  assert.equal(prodAfter.stockQuantity, -2);

  // Verify unresolved InventoryAlert created for the deficit
  const alertsRes = await api('/api/inventoryAlerts', {}, authToken);
  assert.equal(alertsRes.status, 200);
  const alert = (alertsRes.data as any[]).find((a) => a.operationId === offlineOpId);
  assert.ok(alert, 'Expected InventoryAlert for offline oversell');
  assert.equal(alert.resultingQty, -2);
  assert.equal(alert.resolved, 0);
});

test('5. Double-Entry Accounting Ledger Balance (SUM(debit) === SUM(credit))', async () => {
  const txRes = await api('/api/transactions', {}, authToken);
  assert.equal(txRes.status, 200);
  const txs = txRes.data as Array<{ debit: number; credit: number }>;
  assert.ok(txs.length >= 4, 'Expected multiple journal transaction lines');

  const totalDebit = Math.round(txs.reduce((s, t) => s + Number(t.debit || 0), 0) * 100) / 100;
  const totalCredit = Math.round(txs.reduce((s, t) => s + Number(t.credit || 0), 0) * 100) / 100;
  assert.equal(totalDebit, totalCredit, `Unbalanced ledger: debit=${totalDebit}, credit=${totalCredit}`);
});

test('6. WAL-Safe Backup Creation & Integrity Verification', async () => {
  const { filename, path: backupPath } = await createSafeBackup();
  assert.ok(fs.existsSync(backupPath), 'Backup file must exist on disk');

  // Direct integrity check on backup DB
  const backupDb = new Database(backupPath, { readonly: true });
  const check = backupDb.pragma('integrity_check', { simple: true });
  backupDb.close();
  assert.equal(check, 'ok');

  // Verify via API endpoint too
  const verifyRes = await api(
    '/api/backup/verify',
    { method: 'POST', body: JSON.stringify({ filename }) },
    authToken
  );
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.data.ok, true);
  assert.ok(verifyRes.data.orderCount >= 3);
});
