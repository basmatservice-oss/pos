import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-e2e-journey-'));
const testDbPath = path.join(tmpDir, 'e2e-pos.db');
process.env.POS_DB_PATH = testDbPath;

const { runMigrations } = await import('../migrate.js');
const { sqliteInstance } = await import('../drizzle/db.js');
const { createPosApp, seedDefaultUsersAndAccounts } = await import('../server/app.js');

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n: number) => Math.round((Number(n) || 0) * 10000) / 10000;

let baseUrl = '';
let httpServer: any;

// Shared state across the user journey
let adminToken = '';
let cashierToken = '';
let branch1Id = 0;
let branch2Id = 0;
let drinksCatId = 0;
let pantryCatId = 0;
let supplierId = 0;
let customerId = 0;

let prodJuiceId = 0; // P1: opening stock 10 pcs @ 5, multi-unit piece/box(12)
let prodRiceId = 0; // P2: bulk fractional kg + 5kg sack, stock 0 initially
let prodSugarId = 0; // P3: service ingredient (base piece)
let prodCoffeeServiceId = 0; // P4: service_with_materials using prodSugarId
let prodWashServiceId = 0; // P5: pure service
let prodInactiveId = 0; // P6: archived/inactive product

let shiftId = '';
let fxPurchaseId = '';
let extraSaleCashOrderId = '';
let mixedSaleOrderId = '';
let creditSaleOrderId = '';
let voidSaleOrderId = '';
let multiLineOrderId = '';

// Running expected GL balances (positive in normal balance direction)
const expectedGL: Record<string, number> = {
  '1010': 0, // Cash
  '1020': 0, // Bank / Card
  '1100': 0, // AR
  '1200': 0, // Inventory
  '2100': 0, // AP
  '2200': 0, // VAT Payable
  '3100': 0, // Capital & Opening
  '3200': 0, // Retained Earnings
  '4100': 0, // Sales Revenue
  '4200': 0, // Sales Returns
  '4300': 0, // Discounts Allowed
  '5100': 0, // COGS
  '5200': 0, // OpEx
  '5300': 0, // Payroll
  '5400': 0, // Inventory Adjustments
};

function postExpectedGL(
  debits: Array<[string, number]>,
  credits: Array<[string, number]>
) {
  const debitAccs = new Set(['1010', '1020', '1100', '1200', '5100', '5200', '5300', '5400']);
  // Note: 4200 & 4300 are type='revenue' in SYSTEM_ACCOUNTS so credit-debit in DB (they go negative on debit)
  for (const [code, amt] of debits) {
    const a = round2(amt);
    expectedGL[code] = round2(expectedGL[code] + (debitAccs.has(code) ? a : -a));
  }
  for (const [code, amt] of credits) {
    const a = round2(amt);
    expectedGL[code] = round2(expectedGL[code] + (debitAccs.has(code) ? -a : a));
  }
}

async function api(route: string, init: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${route}`, { ...init, headers });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

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
    if (httpServer) httpServer.close(() => resolve());
    else resolve();
  });
  try {
    sqliteInstance.close();
  } catch {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

test('E2E 01: Cold Boot, Health, Security Guard, Onboarding & Default Password Change + PIN Login', async () => {
  // 1. Health & Public Config before login
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.status, 'ok');
  assert.equal(health.data.connected, true);

  const pubCfg = await api('/api/public-config');
  assert.equal(pubCfg.status, 200);
  assert.ok(Array.isArray(pubCfg.data));

  // 2. Unauthenticated routes blocked
  const unauthProd = await api('/api/products');
  assert.equal(unauthProd.status, 401);
  const unauthReports = await api('/api/reports/financial');
  assert.equal(unauthReports.status, 401);

  // 3. Initial businessType onboarding (allowed once, duplicate rejected 409)
  const onboard = await api('/api/settings/initial-setup', {
    method: 'POST',
    body: JSON.stringify({ businessType: 'supermarket' }),
  });
  assert.equal(onboard.status, 201);
  assert.equal(onboard.data.value, 'supermarket');

  const duplicateOnboard = await api('/api/settings/initial-setup', {
    method: 'POST',
    body: JSON.stringify({ businessType: 'restaurant' }),
  });
  assert.equal(duplicateOnboard.status, 409);

  // 4. First login with seeded admin (123456) -> mustChangePassword === 1, secrets stripped
  const login1 = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  assert.equal(login1.status, 200);
  assert.ok(login1.data.token);
  assert.equal(login1.data.user.mustChangePassword, true);
  assert.equal(login1.data.user.password, undefined);
  assert.equal(login1.data.user.pinCode, undefined);

  // 5. Change password & PIN
  const changeRes = await api(
    '/api/auth/change-password',
    {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: '123456',
        newPassword: 'ProdAdmin!2026',
        newPinCode: '9876',
      }),
    },
    login1.data.token
  );
  assert.equal(changeRes.status, 200);
  assert.equal(changeRes.data.user.mustChangePassword, false);

  // Old password rejected, new password + PIN work
  const badLogin = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  assert.equal(badLogin.status, 401);

  const goodPassLogin = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'ProdAdmin!2026' }),
  });
  assert.equal(goodPassLogin.status, 200);

  const pinLogin = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ pinCode: '9876' }),
  });
  assert.equal(pinLogin.status, 200);
  adminToken = pinLogin.data.token;
});

test('E2E 02: Organization Setup (Branches, Settings, Fiscal Periods, FX History & Cashier RBAC)', async () => {
  // Branches
  const b1 = await api(
    '/api/branches',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'الفرع الرئيسي - الرياض',
        address: 'طريق الملك فهد',
        phone: '0112223344',
        isActive: true,
        status: 'active',
      }),
    },
    adminToken
  );
  assert.equal(b1.status, 201);
  branch1Id = b1.data.id;

  const b2 = await api(
    '/api/branches',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'فرع جدة',
        address: 'التحلية',
        phone: '0122223344',
        isActive: true,
        status: 'active',
      }),
    },
    adminToken
  );
  assert.equal(b2.status, 201);
  branch2Id = b2.data.id;

  // Settings
  const settingsPairs = [
    { key: 'storeName', value: 'سوبرماركت النخبة للإنتاج' },
    { key: 'currency', value: 'ر.س' },
    { key: 'taxRate', value: '15' },
    { key: 'offlineStockPolicy', value: 'block' },
    { key: 'inventoryValuationMethod', value: 'fifo' },
    { key: 'loyaltyPointsPerCurrency', value: '0.1' },
  ];
  for (const s of settingsPairs) {
    const res = await api(
      '/api/settings',
      { method: 'POST', body: JSON.stringify(s) },
      adminToken
    );
    assert.equal(res.status, 201);
  }

  // Record Exchange Rate (USD = 3.75)
  const fxRes = await api(
    '/api/exchangeRateHistory',
    {
      method: 'POST',
      body: JSON.stringify({
        currency: 'USD',
        rate: 3.75,
        source: 'manual',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        notes: 'سعر الصرف الثابت',
      }),
    },
    adminToken
  );
  assert.equal(fxRes.status, 201);
  assert.equal(fxRes.data.rate, 3.75);

  // Fiscal Periods: closed 2025 + open 2026-2027
  const p2025 = await api(
    '/api/fiscalPeriods',
    {
      method: 'POST',
      body: JSON.stringify({
        id: 'fy-2025',
        name: 'السنة المالية 2025',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
      }),
    },
    adminToken
  );
  assert.equal(p2025.status, 201);
  const close2025 = await api('/api/fiscalPeriods/fy-2025/close', { method: 'POST' }, adminToken);
  assert.equal(close2025.status, 200);
  assert.equal(close2025.data.status, 'closed');

  const p2026 = await api(
    '/api/fiscalPeriods',
    {
      method: 'POST',
      body: JSON.stringify({
        id: 'fy-2026',
        name: 'الفترة الحالية 2026-2027',
        startDate: '2026-01-01',
        endDate: '2027-12-31',
      }),
    },
    adminToken
  );
  assert.equal(p2026.status, 201);

  // Cashier User & RBAC Check
  const empRes = await api(
    '/api/employees',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'سارة - كاشير',
        username: 'sara_cashier',
        password: 'CashierPass!1',
        pinCode: '2468',
        role: 'cashier',
        branchId: branch1Id,
        status: 'active',
        permissions: ['view_pos', 'add_customer', 'edit_customer', 'manage_shifts', 'process_returns'],
      }),
    },
    adminToken
  );
  assert.equal(empRes.status, 201);
  assert.equal(empRes.data.password, undefined);

  const cashierLogin = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'sara_cashier', password: 'CashierPass!1' }),
  });
  assert.equal(cashierLogin.status, 200);
  cashierToken = cashierLogin.data.token;

  // Verify cashier is blocked from admin endpoints
  assert.equal((await api('/api/reports/financial', {}, cashierToken)).status, 403);
  assert.equal((await api('/api/sync-queue', {}, cashierToken)).status, 403);
  assert.equal(
    (
      await api(
        '/api/fiscalPeriods',
        { method: 'POST', body: JSON.stringify({ name: 'bad', startDate: '2026-01-01', endDate: '2026-01-31' }) },
        cashierToken
      )
    ).status,
    403
  );
});

test('E2E 03: Master Data Setup (Categories, Supplier, Customer, Products, Units, Recipes)', async () => {
  const c1 = await api('/api/categories', { method: 'POST', body: JSON.stringify({ name: 'مشروبات', color: '#0284c7' }) }, adminToken);
  const c2 = await api('/api/categories', { method: 'POST', body: JSON.stringify({ name: 'مواد غذائية وخدمات', color: '#16a34a' }) }, adminToken);
  assert.equal(c1.status, 201);
  assert.equal(c2.status, 201);
  drinksCatId = c1.data.id;
  pantryCatId = c2.data.id;

  const sup = await api(
    '/api/suppliers',
    { method: 'POST', body: JSON.stringify({ name: 'شركة الأغذية الدولية', phone: '0501234567', balance: 0 }) },
    adminToken
  );
  assert.equal(sup.status, 201);
  supplierId = sup.data.id;

  const cust = await api(
    '/api/customers',
    { method: 'POST', body: JSON.stringify({ name: 'فهد المنصور', phone: '0559876543', balance: 0, points: 0 }) },
    cashierToken
  );
  assert.equal(cust.status, 201);
  customerId = cust.data.id;

  // P1: Juice with opening stock 10 pcs @ 5 = 50.00 opening balance
  const p1 = await api(
    '/api/products',
    {
      method: 'POST',
      body: JSON.stringify({
        barcode: 'JUICE-1',
        name: 'عصير برتقال طازج',
        categoryId: drinksCatId,
        costPrice: 5,
        sellingPrice: 11.5, // VAT-inclusive 15% => 10 net + 1.50 VAT
        stockQuantity: 10,
        unit: 'piece',
        baseUnitCode: 'piece',
        conversionFactor: 12,
        allowFractions: false,
        isActive: true,
        quantityPrecision: 0,
        itemType: 'stock',
        unitsJson: JSON.stringify([
          { name: 'piece', conversionFactor: 1, price: 11.5 },
          { name: 'box', conversionFactor: 12, price: 126.5, barcode: 'JUICE-BOX-12' },
        ]),
        branchId: branch1Id,
      }),
    },
    adminToken
  );
  assert.equal(p1.status, 201);
  prodJuiceId = p1.data.id;
  // Opening stock GL: Dr 1200 (50) / Cr 3100 (50)
  postExpectedGL([['1200', 50]], [['3100', 50]]);

  // P2: Bulk Rice (fractional kg + 5kg sack), starts at 0 stock
  const p2 = await api(
    '/api/products',
    {
      method: 'POST',
      body: JSON.stringify({
        barcode: 'RICE-KG',
        name: 'أرز بسمتي فاخر',
        categoryId: pantryCatId,
        costPrice: 0,
        sellingPrice: 23, // 20 + 3 VAT per kg
        stockQuantity: 0,
        unit: 'كجم',
        baseUnitCode: 'kg',
        conversionFactor: 1,
        allowFractions: true,
        isActive: true,
        quantityPrecision: 3,
        itemType: 'stock',
        unitsJson: JSON.stringify([
          { name: 'كجم', conversionFactor: 1, price: 23 },
          { name: 'شوال 5كجم', conversionFactor: 5, price: 115 },
        ]),
        branchId: branch1Id,
      }),
    },
    adminToken
  );
  assert.equal(p2.status, 201);
  prodRiceId = p2.data.id;

  // P3: Sugar ingredient (opening stock 20 @ 2 = 40.00)
  const p3 = await api(
    '/api/products',
    {
      method: 'POST',
      body: JSON.stringify({
        barcode: 'SUGAR-BAG',
        name: 'سكر خام (مادة خام)',
        categoryId: pantryCatId,
        costPrice: 2,
        sellingPrice: 5,
        stockQuantity: 20,
        unit: 'piece',
        baseUnitCode: 'piece',
        allowFractions: false,
        isActive: true,
        itemType: 'stock',
        branchId: branch1Id,
      }),
    },
    adminToken
  );
  assert.equal(p3.status, 201);
  prodSugarId = p3.data.id;
  postExpectedGL([['1200', 40]], [['3100', 40]]);

  // P4: Service with Materials (Espresso Drink consumes 2 pcs of Sugar per order)
  const p4 = await api(
    '/api/products',
    {
      method: 'POST',
      body: JSON.stringify({
        barcode: 'SRV-COFFEE',
        name: 'قهوة مختصة (مع مواد)',
        categoryId: drinksCatId,
        costPrice: 0,
        sellingPrice: 23,
        stockQuantity: 0,
        unit: 'piece',
        itemType: 'service_with_materials',
        isActive: true,
        branchId: branch1Id,
      }),
    },
    adminToken
  );
  assert.equal(p4.status, 201);
  prodCoffeeServiceId = p4.data.id;

  const rec = await api(
    '/api/serviceRecipes',
    {
      method: 'POST',
      body: JSON.stringify({
        parentProductId: prodCoffeeServiceId,
        ingredientProductId: prodSugarId,
        ingredientName: 'سكر خام (مادة خام)',
        quantity: 2,
        unit: 'piece',
      }),
    },
    adminToken
  );
  assert.equal(rec.status, 201);

  // P5: Pure Service (no inventory deduction)
  const p5 = await api(
    '/api/products',
    {
      method: 'POST',
      body: JSON.stringify({
        barcode: 'SRV-DELIV',
        name: 'خدمة تغليف وتوصيل',
        categoryId: pantryCatId,
        costPrice: 0,
        sellingPrice: 11.5,
        stockQuantity: 0,
        unit: 'piece',
        itemType: 'service',
        isActive: true,
        branchId: branch1Id,
      }),
    },
    adminToken
  );
  assert.equal(p5.status, 201);
  prodWashServiceId = p5.data.id;

  // P6: Inactive archived product
  const p6 = await api(
    '/api/products',
    {
      method: 'POST',
      body: JSON.stringify({
        barcode: 'OLD-ITEM',
        name: 'صنف موقوف قديم',
        categoryId: pantryCatId,
        costPrice: 0,
        sellingPrice: 10,
        stockQuantity: 0,
        unit: 'piece',
        itemType: 'stock',
        isActive: false,
        branchId: branch1Id,
      }),
    },
    adminToken
  );
  assert.equal(p6.status, 201);
  assert.equal(p6.data.isActive, 0);
  prodInactiveId = p6.data.id;
  assert.ok(prodInactiveId > 0);
});

test('E2E 04: Shift Opening, Cash Float Deposit & Withdrawal', async () => {
  shiftId = `shift-${crypto.randomUUID()}`;
  const openRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'shift_open',
        operationId: `op-open-${shiftId}`,
        payload: {
          id: shiftId,
          employeeId: 2,
          employeeName: 'سارة - كاشير',
          openingCash: 500,
          branchId: branch1Id,
        },
      }),
    },
    cashierToken
  );
  assert.equal(openRes.status, 201);
  assert.equal(openRes.data.result.status, 'open');

  // Cash deposit +200
  const depRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'shift_movement',
        operationId: `op-dep-${shiftId}`,
        payload: {
          shiftId,
          type: 'deposit',
          amount: 200,
          reason: 'تغذية درج الكاشير',
          branchId: branch1Id,
        },
      }),
    },
    cashierToken
  );
  assert.equal(depRes.status, 201);
  postExpectedGL([['1010', 200]], [['3100', 200]]);

  // Cash withdrawal -50
  const wdrRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'shift_movement',
        operationId: `op-wdr-${shiftId}`,
        payload: {
          shiftId,
          type: 'withdrawal',
          amount: 50,
          reason: 'سحب فكة لصندوق الاحتياط',
          branchId: branch1Id,
        },
      }),
    },
    cashierToken
  );
  assert.equal(wdrRes.status, 201);
  postExpectedGL([['3100', 50]], [['1010', 50]]);
});

test('E2E 05: Purchasing Cycle (FX USD + Landed Costs + Batch FIFO + Purchase Return + Supplier Payment)', async () => {
  // FX Purchase in USD:
  // Line 1: 2 boxes (2 * 12 = 24 pcs) of Juice @ $20/box => 20 * 3.75 = 75 SAR/box => 150 SAR
  // Line 2: 20 kg of Rice @ $4/kg => 4 * 3.75 = 15 SAR/kg => 300 SAR
  // Goods Total = 450 SAR
  // Shipping = 60 SAR, Customs = 30 SAR => Extra Landed Cost = 90 SAR (paid from Cash 1010)
  // Allocated Extra proportionally:
  //   Juice extra = (150/450)*90 = 30 => Total Juice = 180 / 24 pcs = 7.50 SAR/pc
  //   Rice extra = 90 - 30 = 60 => Total Rice = 360 / 20 kg = 18.00 SAR/kg
  // Supplier paid = 200 SAR by Card (1020), Remaining payable = 450 - 200 = 250 SAR (AP 2100)
  fxPurchaseId = `pur-${crypto.randomUUID()}`;
  const purRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'purchase',
        operationId: `op-${fxPurchaseId}`,
        payload: {
          purchase: {
            id: fxPurchaseId,
            supplierId,
            supplierName: 'شركة الأغذية الدولية',
            currency: 'USD',
            exchangeRate: 3.75,
            shippingCost: 60,
            customsCost: 30,
            otherCosts: 0,
            extraCostsPaymentMethod: 'cash',
            totalAmount: 450,
            paidAmount: 200,
            paymentMethod: 'card',
            branchId: branch1Id,
          },
          items: [
            {
              productId: prodJuiceId,
              productName: 'عصير برتقال طازج',
              quantity: 2,
              unit: 'box',
              conversionFactor: 12,
              costPrice: 20,
              pricesInForeignCurrency: true,
            },
            {
              productId: prodRiceId,
              productName: 'أرز بسمتي فاخر',
              quantity: 20,
              unit: 'كجم',
              conversionFactor: 1,
              costPrice: 4,
              pricesInForeignCurrency: true,
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(purRes.status, 201);
  // Purchase GL:
  //   Dr 1200 (540) / Cr 2100 (450), Cr 1010 (90)
  //   Payment Dr 2100 (200) / Cr 1020 (200)
  postExpectedGL([['1200', 540]], [['2100', 450], ['1010', 90]]);
  postExpectedGL([['2100', 200]], [['1020', 200]]);

  // Verify stock: Juice = 10 + 24 = 34; Rice = 20
  const prodsAfterPur = (await api('/api/products', {}, adminToken)).data as any[];
  const juice = prodsAfterPur.find((p) => p.id === prodJuiceId);
  const rice = prodsAfterPur.find((p) => p.id === prodRiceId);
  assert.equal(juice.stockQuantity, 34);
  assert.equal(rice.stockQuantity, 20);

  // Verify Purchase Return: Return 2 kg of Rice @ 18 SAR/kg = 36 SAR to supplier credit adjustment
  const pretRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'purchase_return',
        operationId: `op-pret-${crypto.randomUUID()}`,
        payload: {
          originalPurchaseId: fxPurchaseId,
          refundMethod: 'credit_adjustment',
          reason: 'وزن زائد عن الطلب',
          branchId: branch1Id,
          items: [
            {
              productId: prodRiceId,
              productName: 'أرز بسمتي فاخر',
              quantity: 2,
              costPrice: 18,
            },
          ],
        },
      }),
    },
    adminToken
  );
  assert.equal(pretRes.status, 201);
  assert.equal(pretRes.data.result.purchaseReturn.totalReturn, 36);
  // Purchase Return GL: Dr 2100 (36) / Cr 1200 (36)
  postExpectedGL([['2100', 36]], [['1200', 36]]);

  // Pay Supplier 114 SAR in Cash (Remaining supplier balance was 250 - 36 = 214 => 214 - 114 = 100 remaining AP)
  const supPayRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'supplier_payment',
        operationId: `op-suppay-${crypto.randomUUID()}`,
        payload: {
          supplierId,
          purchaseId: fxPurchaseId,
          amount: 114,
          paymentMethod: 'cash',
          branchId: branch1Id,
          shiftId,
          notes: 'دفعة من حساب المورد',
        },
      }),
    },
    adminToken
  );
  assert.equal(supPayRes.status, 201);
  assert.equal(round2(supPayRes.data.result.supplier.balance), 100);
  postExpectedGL([['2100', 114]], [['1010', 114]]);
});

test('E2E 06: Complete POS Sales Matrix (Cash FIFO Multi-Layer, Mixed, Credit + Loyalty, Fractional, Recipe Service, Multi-Line)', async () => {
  // Sale 1 (Cash FIFO): Sell 15 pcs of Juice @ 11.50 (10 excl VAT + 1.50 VAT):
  //   - Consumes ALL 10 pcs from Opening Batch (@ 5 = 50) + 5 pcs from FX Purchase Batch (@ 7.50 = 37.50)
  //   - Total COGS = 87.50!
  //   - Revenue = 150.00, VAT = 22.50, Net = 172.50 Cash (1010)
  extraSaleCashOrderId = `ord-cash-${crypto.randomUUID()}`;
  const sale1 = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: `op-${extraSaleCashOrderId}`,
        payload: {
          order: {
            id: extraSaleCashOrderId,
            receiptNumber: 'POS-E2E-001',
            totalAmount: 150,
            discountAmount: 0,
            taxAmount: 22.5,
            netAmount: 172.5,
            paymentMethod: 'cash',
            branchId: branch1Id,
            shiftId,
          },
          items: [
            {
              productId: prodJuiceId,
              productName: 'عصير برتقال طازج',
              quantity: 15,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 11.5,
              subTotal: 150,
              taxAmount: 22.5,
              total: 172.5,
            },
          ],
        },
      }),
    },
    cashierToken
  );
  assert.equal(sale1.status, 201);
  assert.equal(round2(sale1.data.result.items[0].costPriceAtTimeOfSale), 5.83); // 87.50 / 15 = 5.8333 -> 5.83
  postExpectedGL([['1010', 172.5]], [['4100', 150], ['2200', 22.5]]);
  postExpectedGL([['5100', 87.5]], [['1200', 87.5]]);

  // Sale 2 (Mixed Cash+Card + Discount + Fractional Rice + Pure Service):
  //   - Item 1: 1.5 kg Rice @ 23 (20 excl + 3 VAT) => subTotal 30, tax 4.5, total 34.50, COGS = 1.5 * 18 = 27
  //   - Item 2: 1 Pure Delivery Service @ 11.50 (10 excl + 1.50 VAT) => subTotal 10, tax 1.50, total 11.50, COGS = 0
  //   - Gross = 40, Tax = 6, Discount = 6 (so Net = 40.00! Note totalAmount=40, taxAmount=6, netAmount=40 => discount = 40+6-40 = 6)
  //   - Mixed payment: Cash = 15.00, Card = 25.00
  mixedSaleOrderId = `ord-mix-${crypto.randomUUID()}`;
  const sale2Payload = {
    type: 'sale',
    operationId: `op-${mixedSaleOrderId}`,
    payload: {
      order: {
        id: mixedSaleOrderId,
        receiptNumber: 'POS-E2E-002',
        totalAmount: 40,
        discountAmount: 6,
        taxAmount: 6,
        netAmount: 40,
        paymentMethod: 'mixed',
        cashAmount: 15,
        cardAmount: 25,
        branchId: branch1Id,
        shiftId,
      },
      items: [
        {
          productId: prodRiceId,
          productName: 'أرز بسمتي فاخر',
          quantity: 1.5,
          unit: 'كجم',
          conversionFactor: 1,
          unitPrice: 23,
          subTotal: 30,
          taxAmount: 4.5,
          total: 34.5,
        },
        {
          productId: prodWashServiceId,
          productName: 'خدمة تغليف وتوصيل',
          quantity: 1,
          unit: 'piece',
          conversionFactor: 1,
          itemType: 'service',
          unitPrice: 11.5,
          subTotal: 10,
          taxAmount: 1.5,
          total: 11.5,
        },
      ],
    },
  };
  // Cashier without apply_discounts permission must be blocked (403)
  const cashierDiscountAttempt = await api(
    '/api/operations/execute',
    { method: 'POST', body: JSON.stringify(sale2Payload) },
    cashierToken
  );
  assert.equal(cashierDiscountAttempt.status, 403);

  // Admin executes discounted mixed sale
  const sale2 = await api(
    '/api/operations/execute',
    { method: 'POST', body: JSON.stringify(sale2Payload) },
    adminToken
  );
  assert.equal(sale2.status, 201);
  postExpectedGL([['1010', 15], ['1020', 25], ['4300', 6]], [['4100', 40], ['2200', 6]]);
  postExpectedGL([['5100', 27]], [['1200', 27]]);

  // Sale 3 (Credit Customer Sale with Loyalty + Multi-Unit Box Sale + Recipe Service):
  //   - Line 1: 1 Box (12 pcs) Juice @ 126.50 (110 excl + 16.50 VAT), COGS = 12 * 7.50 = 90
  //   - Line 2: 2 Espresso Services (deducts 2*2=4 Sugar @ 2 = 8 COGS), @ 23 (20 excl + 3 VAT => sub 40, tax 6, tot 46)
  //   - Order Totals: totalAmount = 150, tax = 22.50, netAmount = 172.50 (Credit -> Customer AR 1100), pointsEarned = 17
  creditSaleOrderId = `ord-cr-${crypto.randomUUID()}`;
  const sale3 = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: `op-${creditSaleOrderId}`,
        payload: {
          order: {
            id: creditSaleOrderId,
            receiptNumber: 'POS-E2E-003',
            totalAmount: 150,
            discountAmount: 0,
            taxAmount: 22.5,
            netAmount: 172.5,
            paymentMethod: 'credit',
            customerId,
            customerName: 'فهد المنصور',
            branchId: branch1Id,
            shiftId,
          },
          pointsEarned: 17,
          items: [
            {
              productId: prodJuiceId,
              productName: 'عصير برتقال طازج (كرتون)',
              quantity: 1,
              unit: 'box',
              conversionFactor: 12,
              unitPrice: 126.5,
              subTotal: 110,
              taxAmount: 16.5,
              total: 126.5,
            },
            {
              productId: prodCoffeeServiceId,
              productName: 'قهوة مختصة (مع مواد)',
              quantity: 2,
              unit: 'piece',
              conversionFactor: 1,
              itemType: 'service_with_materials',
              unitPrice: 23,
              subTotal: 40,
              taxAmount: 6,
              total: 46,
            },
          ],
        },
      }),
    },
    cashierToken
  );
  assert.equal(sale3.status, 201);
  postExpectedGL([['1100', 172.5]], [['4100', 150], ['2200', 22.5]]);
  postExpectedGL([['5100', 98]], [['1200', 98]]); // 90 juice + 8 sugar

  // Collect partial payment 100 SAR via Card (1020) from customer
  const custPay = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'customer_payment',
        operationId: `op-cpay-${crypto.randomUUID()}`,
        payload: {
          customerId,
          orderId: creditSaleOrderId,
          amount: 100,
          paymentMethod: 'card',
          branchId: branch1Id,
          shiftId,
          notes: 'سداد جزء من الفاتورة الآجلة',
        },
      }),
    },
    cashierToken
  );
  assert.equal(custPay.status, 201);
  assert.equal(round2(custPay.data.result.customer.balance), 72.5);
  assert.equal(custPay.data.result.customer.points, 17);
  postExpectedGL([['1020', 100]], [['1100', 100]]);
});

test('E2E 07: Order Void, Duplicate-Line Partial Return, Damaged Return, Fiscal Period Lock & Stock Policy', async () => {
  // 1. Order Void Test: Sell 2 Coffee Services (consumes 4 Sugar @ 2 = 8 COGS), Net 46 (40+6 VAT) Cash, then VOID it
  voidSaleOrderId = `ord-void-${crypto.randomUUID()}`;
  const preVoidSale = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: `op-${voidSaleOrderId}`,
        payload: {
          order: {
            id: voidSaleOrderId,
            receiptNumber: 'POS-E2E-VOID',
            totalAmount: 40,
            taxAmount: 6,
            netAmount: 46,
            paymentMethod: 'cash',
            branchId: branch1Id,
            shiftId,
          },
          items: [
            {
              productId: prodCoffeeServiceId,
              productName: 'قهوة مختصة (مع مواد)',
              quantity: 2,
              unit: 'piece',
              conversionFactor: 1,
              itemType: 'service_with_materials',
              unitPrice: 23,
              subTotal: 40,
              taxAmount: 6,
              total: 46,
            },
          ],
        },
      }),
    },
    cashierToken
  );
  assert.equal(preVoidSale.status, 201);

  const sugarDuring = (await api('/api/products', {}, adminToken)).data.find((p: any) => p.id === prodSugarId);
  assert.equal(sugarDuring.stockQuantity, 12); // 20 - 4 (credit sale) - 4 (this sale) = 12

  const voidRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'order_void',
        operationId: `op-void-${voidSaleOrderId}`,
        payload: { orderId: voidSaleOrderId, reason: 'خطأ في الإدخال' },
      }),
    },
    adminToken
  );
  assert.equal(voidRes.status, 201);
  assert.equal(voidRes.data.result.order.status, 'void');

  const sugarAfterVoid = (await api('/api/products', {}, adminToken)).data.find((p: any) => p.id === prodSugarId);
  assert.equal(sugarAfterVoid.stockQuantity, 16); // Restored back to 16! (GL net effect = 0)

  // 2. Duplicate Lines Order + Strict orderItemId Return (Resalable + Damaged)
  // Sell 4 pcs of Juice across 2 lines (Line A = 2 @ 11.50, Line B = 2 @ 11.50), COGS = 4 * 7.50 = 30
  multiLineOrderId = `ord-dup-${crypto.randomUUID()}`;
  const saleDup = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: `op-${multiLineOrderId}`,
        payload: {
          order: {
            id: multiLineOrderId,
            receiptNumber: 'POS-E2E-004',
            totalAmount: 40,
            taxAmount: 6,
            netAmount: 46,
            paymentMethod: 'cash',
            branchId: branch1Id,
            shiftId,
          },
          items: [
            {
              productId: prodJuiceId,
              productName: 'عصير برتقال طازج (مبرد)',
              quantity: 2,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 11.5,
              subTotal: 20,
              taxAmount: 3,
              total: 23,
            },
            {
              productId: prodJuiceId,
              productName: 'عصير برتقال طازج (عادي)',
              quantity: 2,
              unit: 'piece',
              conversionFactor: 1,
              unitPrice: 11.5,
              subTotal: 20,
              taxAmount: 3,
              total: 23,
            },
          ],
        },
      }),
    },
    cashierToken
  );
  assert.equal(saleDup.status, 201);
  postExpectedGL([['1010', 46]], [['4100', 40], ['2200', 6]]);
  postExpectedGL([['5100', 30]], [['1200', 30]]);

  const [lineA, lineB] = saleDup.data.result.items;

  // Return 1 resalable from Line B + 1 damaged from Line A
  const retRes = await api(
    '/api/returns',
    {
      method: 'POST',
      body: JSON.stringify({
        originalOrderId: multiLineOrderId,
        refundMethod: 'cash',
        reason: 'إرجاع تجريبي سطرين',
        branchId: branch1Id,
        shiftId,
        items: [
          {
            orderItemId: lineB.id,
            productId: prodJuiceId,
            productName: 'عصير برتقال طازج',
            quantity: 1,
            condition: 'resalable',
          },
          {
            orderItemId: lineA.id,
            productId: prodJuiceId,
            productName: 'عصير برتقال طازج',
            quantity: 1,
            condition: 'damaged',
          },
        ],
      }),
    },
    cashierToken
  );
  assert.equal(retRes.status, 201);
  assert.equal(retRes.data.returnRecord.totalRefund, 23);

  // Verify strict orderItemId tracking updated both lines independently (1 each)
  const orderItemsNow = (await api('/api/orderItems', {}, adminToken)).data.filter(
    (oi: any) => oi.orderId === multiLineOrderId
  );
  assert.equal(orderItemsNow.find((i: any) => i.id === lineA.id).returnedQuantity, 1);
  assert.equal(orderItemsNow.find((i: any) => i.id === lineB.id).returnedQuantity, 1);

  // Return GL:
  //   Dr 4200 (20), Dr 2200 (3) / Cr 1010 (23)
  //   Resalable 1 pc @ 7.50: Dr 1200 (7.50) / Cr 5100 (7.50)
  //   Damaged 1 pc @ 7.50: Dr 5400 (7.50) / Cr 5100 (7.50)
  postExpectedGL([['4200', 20], ['2200', 3]], [['1010', 23]]);
  postExpectedGL([['1200', 7.5]], [['5100', 7.5]]);
  postExpectedGL([['5400', 7.5]], [['5100', 7.5]]);

  // Over-return protection (Line B only has 1 left, trying to return 2 must fail 400)
  const overRet = await api(
    '/api/returns',
    {
      method: 'POST',
      body: JSON.stringify({
        originalOrderId: multiLineOrderId,
        refundMethod: 'cash',
        items: [{ orderItemId: lineB.id, productId: prodJuiceId, quantity: 2 }],
      }),
    },
    cashierToken
  );
  assert.equal(overRet.status, 400);

  // 3. Closed Fiscal Period Protection (reject sale dated in closed 2025)
  const closedSale = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: `op-closed-${crypto.randomUUID()}`,
        payload: {
          order: {
            id: `ord-closed-${crypto.randomUUID()}`,
            totalAmount: 10,
            taxAmount: 1.5,
            netAmount: 11.5,
            paymentMethod: 'cash',
            createdAt: '2025-06-15T12:00:00.000Z',
          },
          items: [{ productId: prodWashServiceId, quantity: 1, itemType: 'service', unitPrice: 11.5, subTotal: 10, taxAmount: 1.5, total: 11.5 }],
        },
      }),
    },
    adminToken
  );
  assert.equal(closedSale.status, 403);

  // 4. Negative Stock Policy Enforcement (block prevents selling > remaining Juice stock)
  // Remaining Juice: 34 - 15 (Sale1) - 12 (Sale3) - 4 (Sale4) + 1 (resalable) = 4 pcs
  const overSell = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'sale',
        operationId: `op-oversell-${crypto.randomUUID()}`,
        payload: {
          managerOverride: true, // cashier spoof must be ignored under block policy!
          order: {
            id: `ord-oversell-${crypto.randomUUID()}`,
            totalAmount: 50,
            taxAmount: 7.5,
            netAmount: 57.5,
            paymentMethod: 'cash',
          },
          items: [{ productId: prodJuiceId, quantity: 10, unit: 'piece', unitPrice: 11.5, subTotal: 100, taxAmount: 15, total: 115 }],
        },
      }),
    },
    cashierToken
  );
  assert.equal(overSell.status, 400);
});

test('E2E 08: Operating Expenses (+ Expense Delete Reversal), Payroll, Stocktaking Approval & Shift Close', async () => {
  // Expense 1: 120 SAR Cash Electricity
  const exp1 = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'expense',
        operationId: `op-exp1-${crypto.randomUUID()}`,
        payload: {
          description: 'فاتورة كهرباء الفرع',
          amount: 120,
          category: 'مرافق',
          paymentMethod: 'cash',
          shiftId,
          branchId: branch1Id,
        },
      }),
    },
    adminToken
  );
  assert.equal(exp1.status, 201);
  postExpectedGL([['5200', 120]], [['1010', 120]]);

  // Expense 2: Wrong entry 80 SAR Cash -> then deleted (must cleanly reverse JE)
  const exp2 = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'expense',
        operationId: `op-exp2-${crypto.randomUUID()}`,
        payload: {
          description: 'مصروف خاطئ',
          amount: 80,
          category: 'عام',
          paymentMethod: 'cash',
          branchId: branch1Id,
        },
      }),
    },
    adminToken
  );
  assert.equal(exp2.status, 201);
  const exp2Del = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'expense_delete',
        operationId: `op-exp2-del-${crypto.randomUUID()}`,
        payload: { id: exp2.data.result.id },
      }),
    },
    adminToken
  );
  assert.equal(exp2Del.status, 201);

  // Payroll: 300 SAR Card for Cashier
  const payRes = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'payroll',
        operationId: `op-pay-${crypto.randomUUID()}`,
        payload: {
          employeeId: 2,
          employeeName: 'سارة - كاشير',
          periodStart: '2026-01-01',
          periodEnd: '2026-01-31',
          salaryType: 'monthly',
          basicSalary: 300,
          bonuses: 0,
          deductions: 0,
          netSalary: 300,
          paymentMethod: 'card',
          branchId: branch1Id,
          status: 'paid',
        },
      }),
    },
    adminToken
  );
  assert.equal(payRes.status, 201);
  postExpectedGL([['5300', 300]], [['1020', 300]]);

  // Stocktaking Session & Approval:
  // Rice: System remaining = 20 - 2 (purchase return) - 1.5 (sale 2) = 16.5 kg @ 18 SAR/kg
  // Actual count = 16.0 kg (-0.5 kg shortage => loss = 0.5 * 18 = 9.00 SAR Dr 5400 / Cr 1200)
  // Sugar: System remaining = 16 pcs @ 2 SAR/pc
  // Actual count = 17 pcs (+1 pc surplus => gain = 1 * 2 = 2.00 SAR Dr 1200 / Cr 5400)
  // Net Stocktake Adjustment = 9.00 - 2.00 = 7.00 SAR net debit to 5400
  const stSessionId = `st-${crypto.randomUUID()}`;
  const stSess = await api(
    '/api/stocktakingSessions',
    {
      method: 'POST',
      body: JSON.stringify({ id: stSessionId, status: 'open', createdBy: 'مدير النظام', branchId: branch1Id }),
    },
    adminToken
  );
  assert.equal(stSess.status, 201);

  await api(
    '/api/stocktakingEntries',
    {
      method: 'POST',
      body: JSON.stringify({
        id: `ste-1-${crypto.randomUUID()}`,
        sessionId: stSessionId,
        productId: prodRiceId,
        productName: 'أرز بسمتي فاخر',
        systemQuantity: 16.5,
        actualQuantity: 16,
        unitCode: 'kg',
        baseUnitCode: 'kg',
        scannedBy: 'مدير النظام',
      }),
    },
    adminToken
  );
  await api(
    '/api/stocktakingEntries',
    {
      method: 'POST',
      body: JSON.stringify({
        id: `ste-2-${crypto.randomUUID()}`,
        sessionId: stSessionId,
        productId: prodSugarId,
        productName: 'سكر خام (مادة خام)',
        systemQuantity: 16,
        actualQuantity: 17,
        unitCode: 'piece',
        baseUnitCode: 'piece',
        scannedBy: 'مدير النظام',
      }),
    },
    adminToken
  );

  const stApprove = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'stocktake_approve',
        operationId: `op-st-${stSessionId}`,
        payload: { sessionId: stSessionId },
      }),
    },
    adminToken
  );
  assert.equal(stApprove.status, 201);
  assert.equal(stApprove.data.result.status, 'approved');
  assert.equal(stApprove.data.result.netAdjustmentValue, -7);
  postExpectedGL([['5400', 7]], [['1200', 7]]);

  // Close Shift
  const closeShift = await api(
    '/api/operations/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'shift_close',
        operationId: `op-close-${shiftId}`,
        payload: {
          id: shiftId,
          actualCash: 720,
          expectedCash: 720,
        },
      }),
    },
    cashierToken
  );
  assert.equal(closeShift.status, 201);
  assert.equal(closeShift.data.result.status, 'closed');
});

test('E2E 09: Offline Batch Idempotency Replay & Inventory Movement Ledger / Reconciliation Audit', async () => {
  // Replay an already executed operationId via /api/operations/batch -> must return duplicate and change NOTHING
  const replay = await api(
    '/api/operations/batch',
    {
      method: 'POST',
      body: JSON.stringify({
        operations: [
          {
            id: `op-${extraSaleCashOrderId}`,
            type: 'sale',
            deviceId: 'offline-tablet-1',
            payload: {
              order: { id: extraSaleCashOrderId, netAmount: 172.5, totalAmount: 150, taxAmount: 22.5, paymentMethod: 'cash' },
              items: [{ productId: prodJuiceId, quantity: 15 }],
            },
          },
        ],
      }),
    },
    cashierToken
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.data.results[0].status, 'duplicate');

  // Verify Inventory Movement Ledger & Reconciliation endpoint
  const movsRes = await api(
    '/api/inventoryMovements?latest=true&limit=200',
    {},
    adminToken
  );
  assert.equal(movsRes.status, 200);
  assert.ok(movsRes.data.items.length >= 12);

  const reconRes = await api('/api/inventoryMovements/reconciliation', {}, adminToken);
  assert.equal(reconRes.status, 200);
  assert.equal(reconRes.data.summary.productsWithBatchMismatch, 0);
  assert.equal(reconRes.data.summary.productsWithLedgerMismatch, 0);
  assert.equal(reconRes.data.items.length, 0);
});

test('E2E 10: Comprehensive Financial, Double-Entry, Balance Sheet, Trial Balance, Aging & WAL Backup Audit', async () => {
  const reportRes = await api('/api/reports/financial', {}, adminToken);
  assert.equal(reportRes.status, 200);
  const rep = reportRes.data;

  // 1. Account-by-Account GL Reconciliation against independent trace
  const accountMap = new Map<string, any>(rep.accounts.map((a: any) => [a.code, a]));
  for (const [code, expectedBal] of Object.entries(expectedGL)) {
    const actualBal = round2(accountMap.get(code)?.balance ?? 0);
    assert.equal(
      actualBal,
      round2(expectedBal),
      `Account ${code} mismatch: actual=${actualBal}, expected=${expectedBal}`
    );
  }

  // 2. P&L Report Numbers Verification:
  //   Gross Sales = 150 + 40 + 150 + 40 = 380.00
  //   Discounts = 6.00
  //   Sales Returns Excl Tax = 20.00
  //   Net Sales Excl Tax = 380 - 6 - 20 = 354.00
  //   Sales Tax = 22.5 + 6 + 22.5 + 6 = 57.00; Returns Tax = 3.00 => Net VAT Payable = 54.00
  //   Gross COGS = 87.50 + 27.00 + 98.00 + 30.00 = 242.50
  //   Returned COGS = 7.50 (resalable) + 7.50 (damaged) = 15.00 => Net COGS = 227.50
  //   Gross Profit = 354.00 - 227.50 = 126.50
  //   OpEx = 120.00, Payroll = 300.00
  //   Account 5400 Adjustments = 7.50 (damaged return) + 7.00 (stocktake) = 14.50
  //   Net Profit = 126.50 - 120.00 - 300.00 - 14.50 = -308.00
  assert.equal(rep.grossSales, 380);
  assert.equal(rep.discounts, 6);
  assert.equal(rep.returnsExclTax, 20);
  assert.equal(rep.netSalesExclTax, 354);
  assert.equal(rep.netVatPayable, 54);
  assert.equal(rep.netCogs, 227.5);
  assert.equal(rep.grossProfit, 126.5);
  assert.equal(rep.operatingExpenses, 120);
  assert.equal(rep.payrollExpenses, 300);
  assert.equal(rep.stocktakeAdjustments, 14.5);
  assert.equal(rep.netProfit, -308);
  assert.equal(rep.netProfit, rep.balanceSheet.netIncome);

  // 3. Balance Sheet Invariant & Subsidiary Ledgers Parity
  assert.equal(rep.balanceSheet.balanced, true);
  assert.equal(rep.balanceSheet.totalAssets, rep.balanceSheet.totalLiabilitiesAndEquity);

  // Inventory Valuation (Batches SUM === GL 1200 === P1: 4*7.5=30 + P2: 16*18=288 + P3: 17*2=34 => 352.00)
  assert.equal(rep.inventoryCostValue, 352);
  assert.equal(round2(accountMap.get('1200')?.balance ?? 0), rep.inventoryCostValue);

  // Receivables & Payables Aging Parity
  assert.equal(rep.aging.totalReceivables, 72.5);
  assert.equal(round2(accountMap.get('1100')?.balance ?? 0), rep.aging.totalReceivables);
  assert.equal(rep.aging.totalPayables, 100);
  assert.equal(round2(accountMap.get('2100')?.balance ?? 0), rep.aging.totalPayables);

  // 4. Trial Balance Equality
  const tbClosingDebit = round2(rep.trialBalance.reduce((s: number, r: any) => s + r.closingDebit, 0));
  const tbClosingCredit = round2(rep.trialBalance.reduce((s: number, r: any) => s + r.closingCredit, 0));
  assert.equal(tbClosingDebit, tbClosingCredit);
  assert.ok(tbClosingDebit > 0);

  // 5. Cash Flow Summary Verification
  assert.equal(round2(rep.cashFlow.netCashFlow), round2(expectedGL['1010'] + expectedGL['1020']));

  // 6. Every Journal Entry & Global Transaction Ledger Must Strictly Balance
  const jes = (await api('/api/journalEntries', {}, adminToken)).data as any[];
  const txs = (await api('/api/transactions', {}, adminToken)).data as any[];
  assert.ok(jes.length >= 10);
  for (const je of jes) {
    const jeTxs = txs.filter((t) => t.journalEntryId === je.id);
    const d = round2(jeTxs.reduce((s, t) => s + Number(t.debit || 0), 0));
    const c = round2(jeTxs.reduce((s, t) => s + Number(t.credit || 0), 0));
    assert.equal(d, c, `Unbalanced Journal Entry ${je.id} (${je.description}): D=${d}, C=${c}`);
  }
  const globalDebit = round2(txs.reduce((s, t) => s + Number(t.debit || 0), 0));
  const globalCredit = round2(txs.reduce((s, t) => s + Number(t.credit || 0), 0));
  assert.equal(globalDebit, globalCredit);

  // 7. System Status, Audit Logs & WAL-Safe Backup Download + Verify
  const sysRes = await api('/api/system/status', {}, adminToken);
  assert.equal(sysRes.status, 200);
  assert.equal(sysRes.data.walMode, 'wal');
  assert.equal(sysRes.data.integrity, 'ok');

  const auditRes = await api('/api/auditLogs', {}, adminToken);
  assert.equal(auditRes.status, 200);
  assert.ok(auditRes.data.length >= 8);

  const dlRes = await fetch(`${baseUrl}/api/backup`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(dlRes.status, 200);
  const backupBuf = Buffer.from(await dlRes.arrayBuffer());
  const downloadedPath = path.join(tmpDir, 'downloaded-backup.db');
  fs.writeFileSync(downloadedPath, backupBuf);

  const verifyDb = new Database(downloadedPath, { readonly: true });
  assert.equal(verifyDb.pragma('integrity_check', { simple: true }), 'ok');
  const orderCount = (verifyDb.prepare('SELECT COUNT(*) as c FROM "Order"').get() as any).c;
  assert.equal(orderCount, 5); // 4 completed/partially_returned + 1 void
  verifyDb.close();
});
