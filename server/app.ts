import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { eq, and, sql, asc, desc, gt, gte, lte, or, inArray } from 'drizzle-orm';
import { db, sqliteInstance, getDbPath } from '../drizzle/db.js';
import { normalizeUnitDefinition, normalizeProductUnit, assertCompatibleUnitDimensions, assertBaseUnitChangeAllowed } from '../src/utils/unitConversion.js';
import { getHistoricalCostAmount } from '../src/utils/inventoryUnits.js';
import {
  products,
  categories,
  customers,
  suppliers,
  orders,
  orderItems,
  returns,
  returnItems,
  shifts,
  shiftMovements,
  expenses,
  employees,
  settings,
  attendance,
  loyaltyTransactions,
  branches,
  payrolls,
  offers,
  purchases,
  purchaseItems,
  purchaseReturns,
  purchaseReturnItems,
  customerPayments,
  supplierPayments,
  auditLogs,
  accounts,
  journalEntries,
  transactions,
  stocktakingSessions,
  stocktakingEntries,
  inventoryBatches,
  inventoryMovements,
  inventoryAlerts,
  syncQueue,
  currencies,
  exchangeRates,
  unitDefinitions,
  productUnits,
} from '../drizzle/schema.js';
import {
  signToken,
  hashSecret,
  verifySecret,
  sanitizeEmployee,
  parsePermissions,
  loginRateLimiter,
  resetLoginRateLimit,
  requireAuth,
  requirePermission,
  requireAnyPermission,
  AuthenticatedRequest,
  AuthPayload,
} from './auth.js';
import { ensureChartOfAccountsAsync } from './accounting.js';
import { executeBusinessOperation, OperationError } from './operations.js';
import os from 'os';

const upload = multer({ dest: 'uploads/' });

export const getLocalIPAddress = () => {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    if (!iface) continue;
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '127.0.0.1';
};

async function appendApiInventoryMovement(input: {
  operationId: string;
  movementKey: string;
  productId: number;
  branchId?: number | null;
  movementType: string;
  sourceType: string;
  sourceId: string;
  sourceLineId?: string | number | null;
  deviceId?: string | null;
  createdBy?: string | null;
  inputQuantity?: number | null;
  unitCode?: string | null;
  baseUnitCode?: string | null;
  conversionToBase?: number;
  quantityDeltaBase: number;
  unitCost?: number;
  totalCost?: number;
  batchAllocations?: any[] | string | null;
  reason?: string | null;
  createdAt: string;
}, executor: any = db) {
  const allocations = typeof input.batchAllocations === 'string'
    ? input.batchAllocations
    : input.batchAllocations ? JSON.stringify(input.batchAllocations) : null;
  await executor.insert(inventoryMovements).values({
    id: `${input.operationId}:${input.movementKey}`,
    movementKey: input.movementKey,
    productId: Number(input.productId),
    branchId: input.branchId ?? null,
    movementType: input.movementType,
    sourceType: input.sourceType,
    sourceId: String(input.sourceId),
    sourceLineId: input.sourceLineId == null ? null : String(input.sourceLineId),
    operationId: input.operationId,
    deviceId: input.deviceId ?? null,
    createdBy: input.createdBy ?? null,
    inputQuantity: input.inputQuantity ?? null,
    unitCode: input.unitCode ?? null,
    baseUnitCode: input.baseUnitCode ?? null,
    conversionToBase: Number(input.conversionToBase || 1),
    quantityDeltaBase: Number(input.quantityDeltaBase),
    unitCost: Number(input.unitCost || 0),
    totalCost: Math.abs(Number(input.totalCost || 0)),
    batchAllocations: allocations,
    reason: input.reason ?? null,
    createdAt: input.createdAt,
  }).onConflictDoNothing();
}

const SAFE_PUBLIC_SETTING_KEYS = new Set([
  'businessName',
  'businessType',
  'businessLogo',
  'businessAddress',
  'businessPhone',
  'taxNumber',
  'taxRate',
  'currency',
  'loginMethod',
  'themeName',
  'primaryColor',
  'secondaryColor',
  'sidebarColor',
  'headerColor',
  'backgroundColor',
  'textColor',
  'fontSize',
  'borderRadius',
  'fontFamily',
  'enableNotifications',
  'enableDirectPrint',
  'printerType',
  'receiptFooter',
]);

const SENSITIVE_SETTING_KEYS = new Set(['authSecret', 'supabaseKey']);

export async function seedDefaultUsersAndAccounts() {
  await ensureChartOfAccountsAsync(db);

  const admins = await db.select().from(employees).where(eq(employees.username, 'admin'));
  if (admins.length === 0) {
    const now = new Date().toISOString();
    await db.insert(employees).values({
      name: 'المدير العام',
      username: 'admin',
      password: hashSecret('123456'),
      pinCode: hashSecret('1234'),
      mustChangePassword: 1,
      role: 'admin',
      phone: '0000000000',
      salary: 0,
      joinDate: now,
      status: 'active',
      deviceType: 'desktop',
      permissions: JSON.stringify([
        'view_dashboard', 'view_pos', 'apply_discounts', 'void_items',
        'view_returns', 'process_returns', 'view_inventory', 'add_product',
        'edit_product', 'delete_product', 'manage_categories', 'view_stocktaking',
        'manage_stocktaking', 'view_purchases', 'add_purchase', 'edit_purchase',
        'delete_purchase', 'view_customers', 'add_customer', 'edit_customer',
        'delete_customer', 'view_suppliers', 'add_supplier', 'edit_supplier',
        'delete_supplier', 'view_employees', 'add_employee', 'edit_employee',
        'delete_employee', 'view_attendance', 'manage_attendance', 'view_payroll',
        'manage_payroll', 'view_offers', 'manage_offers', 'view_branches',
        'manage_branches', 'view_mobile_sales', 'view_shifts', 'manage_shifts',
        'view_expenses', 'add_expense', 'edit_expense', 'delete_expense',
        'view_reports', 'manage_settings',
      ]),
      isSynced: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export async function createSafeBackup(): Promise<{ filename: string; path: string }> {
  const dbPath = getDbPath();
  const backupsDir = path.join(path.dirname(dbPath), 'backups');
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${timestamp}.db`;
  const backupPath = path.join(backupsDir, filename);
  await sqliteInstance.backup(backupPath);
  return { filename, path: backupPath };
}

export function createPosApp() {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, true),
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      credentials: true,
    },
  });

  app.set('io', io);

  app.use(
    cors({
      origin: (origin, callback) => callback(null, true),
      credentials: true,
    })
  );
  app.use(express.json({ limit: '50mb' }));

  // Strip syncStatus from request bodies
  app.use((req, _res, next) => {
    if (req.body && typeof req.body === 'object') {
      if ('syncStatus' in req.body) delete req.body.syncStatus;
      if (Array.isArray(req.body)) {
        req.body.forEach((item) => {
          if (item && typeof item === 'object' && 'syncStatus' in item) delete item.syncStatus;
        });
      }
    }
    next();
  });

  // Auto-queue cloud sync + Socket.io broadcast for mutations
  app.use((req, res, next) => {
    const originalJson = res.json;
    res.json = function (body) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const method = req.method;
        const p = req.path;
        if (
          p.startsWith('/api/') &&
          !p.startsWith('/api/sync') &&
          !p.startsWith('/api/health') &&
          !p.startsWith('/api/login') &&
          !p.startsWith('/api/auth')
        ) {
          const parts = p.split('/');
          const resource = parts[2];
          const idFromPath = parts[3];

          if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
            io.emit('data-updated', { resource, method, id: idFromPath });

            const typeMap: Record<string, string> = {
              products: 'Product',
              categories: 'Category',
              customers: 'Customer',
              suppliers: 'Supplier',
              employees: 'Employee',
              expenses: 'Expense',
              shifts: 'Shift',
              shiftMovements: 'ShiftMovement',
              orders: 'Order',
              checkout: 'Order',
              purchases: 'Purchase',
              purchaseReturns: 'PurchaseReturn',
              purchaseReturnItems: 'PurchaseReturnItem',
              customerPayments: 'CustomerPayment',
              supplierPayments: 'SupplierPayment',
              returns: 'Return',
              attendance: 'Attendance',
              branches: 'Branch',
              payrolls: 'Payroll',
              offers: 'Offer',
              'loyalty-transactions': 'LoyaltyTransaction',
              settings: 'Setting',
              auditLogs: 'AuditLog',
              stocktakingSessions: 'StocktakingSession',
              stocktakingEntries: 'StocktakingEntry',
            };

            const type = typeMap[resource];
            if (type && body) {
              const action = method === 'POST' ? 'create' : method === 'PUT' ? 'update' : 'delete';
              const items = Array.isArray(body) ? body : [body];
              Promise.all(
                items.map((item) =>
                  db.insert(syncQueue).values({
                    id: crypto.randomUUID(),
                    type,
                    action,
                    data: JSON.stringify(action === 'delete' ? { id: idFromPath } : item),
                    status: 'pending',
                    createdAt: new Date().toISOString(),
                  })
                )
              ).catch(() => {});
            }
          }
        }
      }
      return originalJson.call(this, body);
    };
    next();
  });

  // ==========================================
  // PUBLIC ENDPOINTS (Health, Pairing, Login)
  // ==========================================
  app.get('/api/health', async (_req, res) => {
    try {
      await db.select().from(settings).limit(1);
      res.json({
        status: 'ok',
        database: 'sqlite',
        connected: true,
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        database: 'sqlite',
        connected: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get('/api/server-ip', (_req, res) => {
    try {
      res.json({ ip: getLocalIPAddress() });
    } catch {
      res.status(500).json({ error: 'Failed to get server IP' });
    }
  });

  app.get('/api/public-config', async (_req, res) => {
    try {
      const all = await db.select().from(settings);
      const safe = all.filter((s) => SAFE_PUBLIC_SETTING_KEYS.has(s.key));
      res.json(safe);
    } catch {
      res.status(500).json({ error: 'Failed to load public config' });
    }
  });

  app.get('/api/settings/businessType', async (_req, res) => {
    try {
      const [setting] = await db.select().from(settings).where(eq(settings.key, 'businessType'));
      res.json(setting || { value: null });
    } catch {
      res.status(500).json({ error: 'Failed to fetch business type' });
    }
  });

  // Initial onboarding businessType setup (allowed only once if unset, otherwise requires auth)
  app.post('/api/settings/initial-setup', async (req, res) => {
    try {
      const { businessType } = req.body;
      if (!businessType) {
        return res.status(400).json({ error: 'businessType is required' });
      }
      const existing = await db.select().from(settings).where(eq(settings.key, 'businessType'));
      if (existing.length > 0 && existing[0].value) {
        return res.status(409).json({ error: 'Initial setup already completed' });
      }
      const now = new Date().toISOString();
      const [saved] = await db
        .insert(settings)
        .values({ key: 'businessType', value: String(businessType), isSynced: 0, createdAt: now, updatedAt: now })
        .returning();
      res.status(201).json(saved);
    } catch {
      res.status(500).json({ error: 'Failed to save initial setup' });
    }
  });

  app.post('/api/login', loginRateLimiter, async (req, res) => {
    const { username, password, pinCode } = req.body || {};

    try {
      let employee: any = null;
      if (pinCode) {
        const allActive = await db.select().from(employees).where(eq(employees.status, 'active'));
        employee = allActive.find((emp) => verifySecret(String(pinCode), emp.pinCode));
        if (!employee) {
          return res.status(401).json({ message: 'رمز الدخول (PIN) غير صحيح' });
        }
        // Upgrade legacy plaintext PIN to bcrypt hash automatically
        if (employee.pinCode && !employee.pinCode.startsWith('$2')) {
          await db
            .update(employees)
            .set({ pinCode: hashSecret(String(pinCode)), updatedAt: new Date().toISOString() })
            .where(eq(employees.id, employee.id));
        }
      } else if (username && password) {
        const cleanUsername = String(username).trim().toLowerCase();
        const allEmployees = await db.select().from(employees);
        employee = allEmployees.find(
          (e) =>
            e.username?.trim().toLowerCase() === cleanUsername &&
            (e.status === 'active' || !e.status)
        );
        if (!employee || !verifySecret(String(password), employee.password)) {
          return res.status(401).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        }
        // Upgrade legacy plaintext password to bcrypt hash automatically
        if (employee.password && !employee.password.startsWith('$2')) {
          await db
            .update(employees)
            .set({ password: hashSecret(String(password)), updatedAt: new Date().toISOString() })
            .where(eq(employees.id, employee.id));
        }
      } else {
        return res.status(400).json({ message: 'يرجى إدخال بيانات الدخول' });
      }

      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      resetLoginRateLimit(ip);

      const permissions = parsePermissions(employee.permissions);
      const token = await signToken({
        userId: employee.id,
        username: employee.username,
        name: employee.name,
        role: employee.role,
        branchId: employee.branchId,
        deviceType: employee.deviceType,
        permissions,
      });

      res.json({
        token,
        user: sanitizeEmployee(employee),
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // ==========================================
  // AUTHENTICATED ENDPOINTS
  // ==========================================
  app.use('/api', requireAuth);

  app.get('/api/auth/me', async (req: AuthenticatedRequest, res) => {
    try {
      const [emp] = await db
        .select()
        .from(employees)
        .where(eq(employees.id, req.authUser!.userId));
      if (!emp) return res.status(404).json({ error: 'User not found' });
      res.json({ user: sanitizeEmployee(emp) });
    } catch {
      res.status(500).json({ error: 'Failed to load profile' });
    }
  });

  app.post('/api/auth/change-password', async (req: AuthenticatedRequest, res) => {
    try {
      const { currentPassword, newPassword, newPinCode } = req.body || {};
      const [emp] = await db
        .select()
        .from(employees)
        .where(eq(employees.id, req.authUser!.userId));
      if (!emp) return res.status(404).json({ error: 'User not found' });

      if (currentPassword && !verifySecret(String(currentPassword), emp.password)) {
        return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
      }

      const updates: any = {
        mustChangePassword: 0,
        updatedAt: new Date().toISOString(),
        isSynced: 0,
      };
      if (newPassword) updates.password = hashSecret(String(newPassword));
      if (newPinCode) updates.pinCode = hashSecret(String(newPinCode));

      const [updated] = await db
        .update(employees)
        .set(updates)
        .where(eq(employees.id, emp.id))
        .returning();

      res.json({ user: sanitizeEmployee(updated) });
    } catch {
      res.status(500).json({ error: 'Failed to update credentials' });
    }
  });

  function assertOperationPermission(user: AuthPayload, type: string, payload: any) {
    if (user.role === 'admin') return;
    const perms = new Set(user.permissions || []);
    const requireOne = (perm: string) => {
      if (!perms.has(perm)) {
        throw new OperationError(`Forbidden: missing permission '${perm}'`, 403);
      }
    };
    const requireAny = (list: string[]) => {
      if (!list.some((p) => perms.has(p))) {
        throw new OperationError(`Forbidden: missing permission (${list.join(' or ')})`, 403);
      }
    };

    switch (type) {
      case 'sale':
        requireAny(['view_pos', 'view_mobile_sales']);
        if (Number(payload?.order?.discountAmount || 0) > 0) {
          requireOne('apply_discounts');
        }
        break;
      case 'return':
        requireOne('process_returns');
        break;
      case 'order_void':
        requireOne('void_items');
        break;
      case 'purchase':
        requireOne('add_purchase');
        break;
      case 'purchase_update':
        requireOne('edit_purchase');
        break;
      case 'purchase_delete':
        requireOne('delete_purchase');
        break;
      case 'purchase_return':
        requireOne('edit_purchase');
        break;
      case 'expense':
        requireOne('add_expense');
        break;
      case 'expense_delete':
        requireOne('delete_expense');
        break;
      case 'customer_payment':
        requireOne('edit_customer');
        break;
      case 'supplier_payment':
        requireOne('edit_supplier');
        break;
      case 'payroll':
        requireOne('manage_payroll');
        break;
      case 'shift_open':
      case 'shift_close':
      case 'shift_movement':
        requireAny(['manage_shifts', 'view_pos', 'view_mobile_sales']);
        break;
      case 'stocktake_approve':
        requireOne('manage_stocktaking');
        break;
      case 'entity_upsert': {
        const tbl = payload?.table;
        if (tbl === 'products') requireAny(['add_product', 'edit_product']);
        else if (tbl === 'categories') requireOne('manage_categories');
        else if (tbl === 'customers') requireAny(['add_customer', 'edit_customer']);
        else if (tbl === 'suppliers') requireAny(['add_supplier', 'edit_supplier']);
        else if (tbl === 'employees') requireAny(['add_employee', 'edit_employee']);
        else if (tbl === 'expenses') requireAny(['add_expense', 'edit_expense']);
        else if (tbl === 'shifts') requireAny(['manage_shifts', 'view_pos', 'view_mobile_sales']);
        else if (tbl === 'branches') requireOne('manage_branches');
        else if (tbl === 'offers') requireOne('manage_offers');
        else if (tbl === 'attendance') requireOne('manage_attendance');
        else if (tbl === 'settings') requireOne('manage_settings');
        else if (tbl === 'stocktakingSessions' || tbl === 'stocktakingEntries') requireOne('manage_stocktaking');
        else if (tbl === 'inventoryBatches') requireOne('edit_product');
        break;
      }
      case 'entity_delete': {
        const tbl = payload?.table;
        if (tbl === 'products') requireOne('delete_product');
        else if (tbl === 'categories') requireOne('manage_categories');
        else if (tbl === 'customers') requireOne('delete_customer');
        else if (tbl === 'suppliers') requireOne('delete_supplier');
        else if (tbl === 'employees') requireOne('delete_employee');
        else if (tbl === 'expenses') requireOne('delete_expense');
        else if (tbl === 'branches') requireOne('manage_branches');
        else if (tbl === 'offers') requireOne('manage_offers');
        else if (tbl === 'attendance') requireOne('manage_attendance');
        else if (tbl === 'stocktakingSessions' || tbl === 'stocktakingEntries') requireOne('manage_stocktaking');
        break;
      }
    }
  }

  // --- Unified Idempotent Business Operations ---
  app.post('/api/operations/execute', async (req: AuthenticatedRequest, res) => {
    try {
      const { type, payload, operationId, deviceId } = req.body || {};
      if (!type || !payload) {
        return res.status(400).json({ error: 'Missing type or payload' });
      }
      assertOperationPermission(req.authUser!, type, payload);
      const outcome = executeBusinessOperation(db, type, payload, {
        operationId,
        deviceId,
        userName: req.authUser?.name || 'System',
        branchId: req.authUser?.branchId ?? undefined,
      });

      io.emit('operation:applied', {
        operationId: outcome.operationId,
        type,
        duplicate: outcome.duplicate,
      });

      res.status(outcome.duplicate ? 200 : 201).json(outcome);
    } catch (error) {
      if (error instanceof OperationError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error('Operation execution failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Operation execution failed',
      });
    }
  });

  app.post('/api/operations/batch', async (req: AuthenticatedRequest, res) => {
    const { operations } = req.body || {};
    if (!Array.isArray(operations)) {
      return res.status(400).json({ error: 'operations array required' });
    }

    const results: any[] = [];
    for (const op of operations) {
      try {
        assertOperationPermission(req.authUser!, op.type, op.payload);
        const outcome = executeBusinessOperation(db, op.type, op.payload, {
          operationId: op.id || op.operationId,
          deviceId: op.deviceId,
          userName: req.authUser?.name || 'System',
          branchId: op.branchId ?? req.authUser?.branchId ?? undefined,
        });
        results.push({
          operationId: outcome.operationId,
          status: outcome.duplicate ? 'duplicate' : 'ok',
          result: outcome.result,
        });
      } catch (error) {
        results.push({
          operationId: op.id || op.operationId,
          status: 'error',
          statusCode: error instanceof OperationError ? error.statusCode : 500,
          error: error instanceof Error ? error.message : 'Operation failed',
        });
      }
    }

    io.emit('operation:applied', { batch: true, count: results.length });
    res.json({ results });
  });

  // --- Legacy /api/checkout forwarded through atomic operations engine ---
  app.post('/api/checkout', async (req: AuthenticatedRequest, res) => {
    try {
      const { order, orderItems: items, pointsEarned, pointsRedeemed } = req.body || {};
      assertOperationPermission(req.authUser!, 'sale', { order, items });
      const outcome = executeBusinessOperation(
        db,
        'sale',
        { order, items, pointsEarned, pointsRedeemed },
        {
          operationId: order?.operationId || order?.id,
          deviceId: order?.deviceId || 'client',
          userName: req.authUser?.name || 'System',
        }
      );
      res.status(201).json(outcome.result);
    } catch (error) {
      if (error instanceof OperationError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Checkout failed' });
    }
  });

  // --- Products ---
  app.get('/api/products', async (_req, res) => {
    try {
      res.json(await db.select().from(products));
    } catch {
      res.status(500).json({ error: 'Failed to fetch products' });
    }
  });

  app.post('/api/products', requirePermission('add_product'), async (req, res) => {
    try {
      const data = { ...req.body };
      const now = new Date().toISOString();
      let existingProduct: any;
      if (data.id) {
        const [foundProduct] = await db.select().from(products)
          .where(eq(products.id, Number(data.id))).limit(1);
        existingProduct = foundProduct;
      }
      let product: any;
      if (existingProduct) {
        delete data.stockQuantity;
        delete data.baseUnitCode;
        delete data.quantityPrecision;
        const [existingBatch] = await db.select({ id: inventoryBatches.id })
          .from(inventoryBatches).where(eq(inventoryBatches.productId, existingProduct.id)).limit(1);
        if (existingBatch) delete data.costPrice;
        [product] = await db.update(products)
          .set({ ...data, isSynced: 0, updatedAt: now })
          .where(eq(products.id, existingProduct.id))
          .returning();
      } else {
        [product] = await db.insert(products)
          .values({ ...data, isSynced: 0, updatedAt: now })
          .returning();
      }

      // New product opening stock is stored as a base-unit FIFO layer.
      if (product && Number(product.stockQuantity) > 0) {
        const existingBatches = await db
          .select({ id: inventoryBatches.id })
          .from(inventoryBatches)
          .where(eq(inventoryBatches.productId, product.id));
        if (existingBatches.length === 0) {
          const openingBatchId = `opening-${product.id}`;
          const openingQuantity = Number(product.stockQuantity);
          const openingUnitCost = Number(product.costPrice || 0);
          await db.transaction(async (tx: any) => {
            await tx.insert(inventoryBatches).values({
              id: openingBatchId,
              productId: product.id,
              purchaseId: null,
              quantity: openingQuantity,
              remainingQuantity: openingQuantity,
              costPrice: openingUnitCost,
              unitCode: product.baseUnitCode || null,
              baseUnitCode: product.baseUnitCode || null,
              conversionToBase: 1,
              baseQuantity: openingQuantity,
              purchaseDate: product.createdAt || now,
              branchId: product.branchId || null,
              isSynced: 0,
              createdAt: product.createdAt || now,
              updatedAt: now,
            });
            const movementKey = `opening_balance:product:${product.id}:${openingBatchId}`;
            await appendApiInventoryMovement({
              operationId: `legacy-api:product:${product.id}:${openingBatchId}`,
              movementKey,
              productId: product.id,
              branchId: product.branchId || null,
              movementType: 'opening_balance',
              sourceType: 'product',
              sourceId: String(product.id),
              sourceLineId: openingBatchId,
              inputQuantity: openingQuantity,
              unitCode: product.baseUnitCode || null,
              baseUnitCode: product.baseUnitCode || null,
              conversionToBase: 1,
              quantityDeltaBase: openingQuantity,
              unitCost: openingUnitCost,
              totalCost: openingQuantity * openingUnitCost,
              batchAllocations: [{ batchId: openingBatchId, quantity: openingQuantity, costPrice: openingUnitCost }],
              createdAt: product.createdAt || now,
            }, tx);
          });
        }
      }

      res.status(201).json(product);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to create product' });
    }
  });

  app.put('/api/products/:id', requirePermission('edit_product'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updateData = { ...req.body };
      delete updateData.stockQuantity;
      delete updateData.baseUnitCode;
      delete updateData.quantityPrecision;
      const [existingBatch] = await db.select({ id: inventoryBatches.id })
        .from(inventoryBatches).where(eq(inventoryBatches.productId, id)).limit(1);
      if (existingBatch) delete updateData.costPrice;
      const now = new Date().toISOString();
      const [product] = await db
        .update(products)
        .set({ ...updateData, isSynced: 0, updatedAt: now })
        .where(eq(products.id, id))
        .returning();
      if (product && !existingBatch && Number(product.stockQuantity || 0) > 0) {
        const openingBatchId = `opening-${product.id}`;
        const openingQuantity = Number(product.stockQuantity);
        const openingUnitCost = Number(product.costPrice || 0);
        await db.transaction(async (tx: any) => {
          await tx.insert(inventoryBatches).values({
            id: openingBatchId,
            productId: product.id,
            purchaseId: null,
            quantity: openingQuantity,
            remainingQuantity: openingQuantity,
            costPrice: openingUnitCost,
            unitCode: product.baseUnitCode || null,
            baseUnitCode: product.baseUnitCode || null,
            conversionToBase: 1,
            baseQuantity: openingQuantity,
            purchaseDate: product.createdAt || now,
            branchId: product.branchId || null,
            isSynced: 0,
            createdAt: product.createdAt || now,
            updatedAt: now,
          }).onConflictDoNothing();
          const movementKey = `opening_balance:product:${product.id}:${openingBatchId}`;
          await appendApiInventoryMovement({
            operationId: `legacy-api:product:${product.id}:${openingBatchId}`,
            movementKey,
            productId: product.id,
            branchId: product.branchId || null,
            movementType: 'opening_balance',
            sourceType: 'product',
            sourceId: String(product.id),
            sourceLineId: openingBatchId,
            inputQuantity: openingQuantity,
            unitCode: product.baseUnitCode || null,
            baseUnitCode: product.baseUnitCode || null,
            conversionToBase: 1,
            quantityDeltaBase: openingQuantity,
            unitCost: openingUnitCost,
            totalCost: openingQuantity * openingUnitCost,
            batchAllocations: [{ batchId: openingBatchId, quantity: openingQuantity, costPrice: openingUnitCost }],
            createdAt: product.createdAt || now,
          }, tx);
        });
      }
      res.json(product);
    } catch {
      res.status(500).json({ error: 'Failed to update product' });
    }
  });

  app.delete('/api/products/:id', async (req, res) => {
    try {
      const productId = Number(req.params.id);
      const [product] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
      if (!product) return res.status(404).json({ error: 'Product not found' });
      const [batch] = await db.select().from(inventoryBatches)
        .where(eq(inventoryBatches.productId, productId)).limit(1);
      const [movement] = await db.select().from(inventoryMovements)
        .where(eq(inventoryMovements.productId, productId)).limit(1);
      if (Math.abs(Number(product.stockQuantity || 0)) > 1e-9 || batch || movement) {
        return res.status(409).json({
          error: 'Product has stock or inventory history. Deactivate it instead of deleting it.',
        });
      }
      await db.delete(products).where(eq(products.id, productId));
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // --- Categories ---
  app.get('/api/categories', async (_req, res) => {
    try {
      res.json(await db.select().from(categories));
    } catch {
      res.status(500).json({ error: 'Failed to fetch categories' });
    }
  });

  app.post('/api/categories', requirePermission('manage_categories'), async (req, res) => {
    try {
      const now = new Date().toISOString();
      const [category] = await db
        .insert(categories)
        .values({ ...req.body, isSynced: 0, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: categories.id,
          set: { ...req.body, isSynced: 0, updatedAt: now },
        })
        .returning();
      res.status(201).json(category);
    } catch {
      res.status(500).json({ error: 'Failed to create category' });
    }
  });

  app.put('/api/categories/:id', requirePermission('manage_categories'), async (req, res) => {
    try {
      const [category] = await db
        .update(categories)
        .set({ ...req.body, isSynced: 0, updatedAt: new Date().toISOString() })
        .where(eq(categories.id, parseInt(req.params.id)))
        .returning();
      res.json(category);
    } catch {
      res.status(500).json({ error: 'Failed to update category' });
    }
  });

  app.delete('/api/categories/:id', requirePermission('manage_categories'), async (req, res) => {
    try {
      await db.delete(categories).where(eq(categories.id, parseInt(req.params.id)));
      res.json({ message: 'Category deleted' });
    } catch {
      res.status(500).json({ error: 'Failed to delete category' });
    }
  });

  // --- Customers ---
  app.get('/api/customers', async (_req, res) => {
    try {
      res.json(await db.select().from(customers));
    } catch {
      res.status(500).json({ error: 'Failed to fetch customers' });
    }
  });

  app.post('/api/customers', requirePermission('add_customer'), async (req, res) => {
    try {
      const now = new Date().toISOString();
      const [customer] = await db
        .insert(customers)
        .values({ ...req.body, isSynced: 0, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: customers.id,
          set: { ...req.body, isSynced: 0, updatedAt: now },
        })
        .returning();
      res.status(201).json(customer);
    } catch {
      res.status(500).json({ error: 'Failed to create customer' });
    }
  });

  app.put('/api/customers/:id', requirePermission('edit_customer'), async (req, res) => {
    try {
      const [customer] = await db
        .update(customers)
        .set({ ...req.body, isSynced: 0, updatedAt: new Date().toISOString() })
        .where(eq(customers.id, parseInt(req.params.id)))
        .returning();
      res.json(customer);
    } catch {
      res.status(500).json({ error: 'Failed to update customer' });
    }
  });

  app.delete('/api/customers/:id', requirePermission('delete_customer'), async (req, res) => {
    try {
      await db.delete(customers).where(eq(customers.id, parseInt(req.params.id)));
      res.json({ message: 'Customer deleted' });
    } catch {
      res.status(500).json({ error: 'Failed to delete customer' });
    }
  });

  // --- Suppliers ---
  app.get('/api/suppliers', async (_req, res) => {
    try {
      res.json(await db.select().from(suppliers));
    } catch {
      res.status(500).json({ error: 'Failed to fetch suppliers' });
    }
  });

  app.post('/api/suppliers', requirePermission('add_supplier'), async (req, res) => {
    try {
      const now = new Date().toISOString();
      const [supplier] = await db
        .insert(suppliers)
        .values({ ...req.body, isSynced: 0, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: suppliers.id,
          set: { ...req.body, isSynced: 0, updatedAt: now },
        })
        .returning();
      res.status(201).json(supplier);
    } catch {
      res.status(500).json({ error: 'Failed to create supplier' });
    }
  });

  app.put('/api/suppliers/:id', requirePermission('edit_supplier'), async (req, res) => {
    try {
      const [supplier] = await db
        .update(suppliers)
        .set({ ...req.body, isSynced: 0, updatedAt: new Date().toISOString() })
        .where(eq(suppliers.id, parseInt(req.params.id)))
        .returning();
      res.json(supplier);
    } catch {
      res.status(500).json({ error: 'Failed to update supplier' });
    }
  });

  app.delete('/api/suppliers/:id', requirePermission('delete_supplier'), async (req, res) => {
    try {
      await db.delete(suppliers).where(eq(suppliers.id, parseInt(req.params.id)));
      res.json({ message: 'Supplier deleted' });
    } catch {
      res.status(500).json({ error: 'Failed to delete supplier' });
    }
  });

  // --- Orders & OrderItems ---
  app.get('/api/orders', async (_req, res) => {
    try {
      res.json(await db.select().from(orders));
    } catch {
      res.status(500).json({ error: 'Failed to fetch orders' });
    }
  });

  app.post('/api/orders', requireAnyPermission(['view_pos', 'view_mobile_sales']), async (req, res) => {
    try {
      const now = new Date().toISOString();
      const [order] = await db
        .insert(orders)
        .values({ ...req.body, isSynced: 0, createdAt: req.body.createdAt || now, updatedAt: now })
        .onConflictDoUpdate({
          target: orders.id,
          set: { ...req.body, isSynced: 0, updatedAt: now },
        })
        .returning();
      res.status(201).json(order);
    } catch {
      res.status(500).json({ error: 'Failed to create order' });
    }
  });

  app.put('/api/orders/:id', requirePermission('void_items'), async (req, res) => {
    try {
      if (req.body?.status === 'void') {
        return res.status(400).json({
          error: 'لا يمكن إلغاء الفاتورة مباشرة؛ استخدم عملية order_void لضمان استرجاع المخزون وعكس القيود المحاسبية',
        });
      }
      const [order] = await db
        .update(orders)
        .set({ status: req.body.status, isSynced: 0, updatedAt: new Date().toISOString() })
        .where(eq(orders.id, req.params.id))
        .returning();
      res.json(order);
    } catch {
      res.status(500).json({ error: 'Failed to update order' });
    }
  });

  app.get('/api/orderItems', async (_req, res) => {
    try {
      res.json(await db.select().from(orderItems));
    } catch {
      res.status(500).json({ error: 'Failed to fetch order items' });
    }
  });

  app.post('/api/orderItems', requireAnyPermission(['view_pos', 'view_mobile_sales']), async (req, res) => {
    try {
      const [item] = await db
        .insert(orderItems)
        .values({ ...req.body, isSynced: 0, createdAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: orderItems.id,
          set: { ...req.body, isSynced: 0 },
        })
        .returning();
      res.status(201).json(item);
    } catch {
      res.status(500).json({ error: 'Failed to create order item' });
    }
  });

  app.delete('/api/orderItems/:id', requirePermission('void_items'), async (req, res) => {
    try {
      await db.delete(orderItems).where(eq(orderItems.id, parseInt(req.params.id)));
      res.json({ message: 'Order item deleted' });
    } catch {
      res.status(500).json({ error: 'Failed to delete order item' });
    }
  });

  // --- Returns & Return Items ---
  app.get('/api/returns', async (_req, res) => {
    try {
      res.json(await db.select().from(returns));
    } catch {
      res.status(500).json({ error: 'Failed to fetch returns' });
    }
  });

  app.get('/api/returnItems', async (_req, res) => {
    try {
      res.json(await db.select().from(returnItems));
    } catch {
      res.status(500).json({ error: 'Failed to fetch return items' });
    }
  });

  app.post('/api/returns', requirePermission('process_returns'), async (req: AuthenticatedRequest, res) => {
    try {
      const outcome = executeBusinessOperation(db, 'return', req.body, {
        operationId: req.body?.operationId || req.body?.id,
        deviceId: req.body?.deviceId || 'client',
        userName: req.authUser?.name || 'System',
      });
      res.status(201).json(outcome.result);
    } catch (error) {
      if (error instanceof OperationError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({ error: 'Failed to process return' });
    }
  });

  // --- Immutable Inventory Movement Ledger ---
  app.get('/api/inventoryMovements', async (req, res) => {
    try {
      const parsedLimit = Number.parseInt(String(req.query.limit || '500'), 10);
      const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(2000, parsedLimit)) : 500;
      const parsedOffset = Number.parseInt(String(req.query.offset || '0'), 10);
      const offset = Number.isFinite(parsedOffset) ? Math.max(0, Math.min(500000, parsedOffset)) : 0;
      const productId = Number(req.query.productId);
      const afterCreatedAt = typeof req.query.afterCreatedAt === 'string' ? req.query.afterCreatedAt : '';
      const afterId = typeof req.query.afterId === 'string' ? req.query.afterId : '';
      const movementKeys = typeof req.query.movementKeys === 'string'
        ? req.query.movementKeys.split(',').filter(Boolean).slice(0, 200)
        : [];
      const latest = req.query.latest === 'true';
      const branchId = Number(req.query.branchId);
      const sourceType = typeof req.query.sourceType === 'string' ? req.query.sourceType : '';
      const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : '';
      const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : '';
      const filters: any[] = [];

      if (movementKeys.length > 0) {
        filters.push(inArray(inventoryMovements.movementKey, movementKeys));
      } else {
        if (Number.isSafeInteger(productId) && productId > 0) {
          filters.push(eq(inventoryMovements.productId, productId));
        }
        if (Number.isSafeInteger(branchId) && branchId > 0) {
          filters.push(eq(inventoryMovements.branchId, branchId));
        }
        if (sourceType) filters.push(eq(inventoryMovements.sourceType, sourceType));
        if (startDate) filters.push(gte(inventoryMovements.createdAt, startDate));
        if (endDate) filters.push(lte(inventoryMovements.createdAt, `${endDate}T23:59:59.999Z`));
      }
      if (movementKeys.length === 0 && afterCreatedAt && afterId) {
        filters.push(or(
          gt(inventoryMovements.createdAt, afterCreatedAt),
          and(
            eq(inventoryMovements.createdAt, afterCreatedAt),
            gt(inventoryMovements.id, afterId)
          )
        ));
      }

      let query: any = db.select().from(inventoryMovements);
      if (filters.length === 1) query = query.where(filters[0]);
      else if (filters.length > 1) query = query.where(and(...filters));

      const orderedQuery = query.orderBy(
        latest && movementKeys.length === 0
          ? desc(inventoryMovements.createdAt)
          : asc(inventoryMovements.createdAt),
        latest && movementKeys.length === 0
          ? desc(inventoryMovements.id)
          : asc(inventoryMovements.id)
      );
      const rows = await (latest && movementKeys.length === 0 ? orderedQuery.offset(offset) : orderedQuery)
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1];
      res.json({
        items,
        hasMore,
        nextCursor: latest || movementKeys.length > 0 || !last
          ? null
          : { createdAt: last.createdAt, id: last.id },
        nextOffset: latest && movementKeys.length === 0 && hasMore ? offset + limit : null,
      });
    } catch {
      res.status(500).json({ error: 'Failed to fetch inventory movements' });
    }
  });

  // --- Inventory Batches & Alerts ---
  app.get('/api/inventoryBatches', async (_req, res) => {
    try {
      res.json(await db.select().from(inventoryBatches));
    } catch {
      res.status(500).json({ error: 'Failed to fetch inventory batches' });
    }
  });

  app.post('/api/inventoryBatches', requirePermission('edit_product'), async (req, res) => {
    try {
      const now = new Date().toISOString();
      const batchId = req.body.id ? String(req.body.id) : crypto.randomUUID();
      const batchQuantity = Number(req.body.baseQuantity ?? req.body.quantity ?? 0);
      const factor = Number(req.body.conversionToBase || 1);
      const remainingQuantity = Number(req.body.remainingQuantity ?? batchQuantity);
      const costPrice = Number(req.body.costPrice || 0);
      if (!Number.isFinite(batchQuantity) || batchQuantity <= 0 ||
          !Number.isFinite(factor) || factor <= 0 ||
          !Number.isFinite(remainingQuantity) || remainingQuantity < 0 || remainingQuantity > batchQuantity ||
          !Number.isFinite(costPrice) || costPrice < 0) {
        return res.status(400).json({ error: 'Invalid inventory batch quantity, conversion or cost' });
      }
      const batch = await db.transaction(async (tx: any) => {
        const [createdBatch] = await tx
          .insert(inventoryBatches)
          .values({
            id: batchId,
            productId: Number(req.body.productId),
            purchaseId: req.body.purchaseId || null,
            quantity: batchQuantity,
            remainingQuantity,
            costPrice,
            originalCostPrice: req.body.originalCostPrice ?? null,
            currencyCode: req.body.currencyCode ?? null,
            exchangeRate: req.body.exchangeRate ?? null,
            exchangeRateId: req.body.exchangeRateId ?? null,
            unitCode: req.body.unitCode ?? null,
            baseUnitCode: req.body.baseUnitCode ?? null,
            conversionToBase: factor,
            baseQuantity: batchQuantity,
            purchaseDate: req.body.purchaseDate || now,
            expiryDate: req.body.expiryDate ?? null,
            batchNumber: req.body.batchNumber ?? null,
            branchId: req.body.branchId || null,
            isSynced: 0,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const movementType = createdBatch.purchaseId ? 'purchase_receipt' : 'opening_balance';
        const sourceType = createdBatch.purchaseId ? 'purchase' : 'product';
        const sourceId = createdBatch.purchaseId ? String(createdBatch.purchaseId) : String(createdBatch.productId);
        const operationId = String(req.body.operationId || `legacy-api:batch:${createdBatch.id}`);
        const movementKey = `${movementType}:${sourceType}:${sourceId}:${createdBatch.id}`;
        await appendApiInventoryMovement({
          operationId,
          movementKey,
          productId: createdBatch.productId,
          branchId: createdBatch.branchId,
          movementType,
          sourceType,
          sourceId,
          sourceLineId: createdBatch.id,
          deviceId: req.body.deviceId,
          createdBy: req.body.createdBy,
          inputQuantity: factor > 0 ? batchQuantity / factor : batchQuantity,
          unitCode: createdBatch.unitCode,
          baseUnitCode: createdBatch.baseUnitCode,
          conversionToBase: factor,
          quantityDeltaBase: batchQuantity,
          unitCost: createdBatch.costPrice,
          totalCost: batchQuantity * createdBatch.costPrice,
          batchAllocations: [{ batchId: createdBatch.id, quantity: batchQuantity, costPrice: createdBatch.costPrice }],
          createdAt: now,
        }, tx);
        return createdBatch;
      });
      res.status(201).json(batch);
    } catch {
      res.status(500).json({ error: 'Failed to create inventory batch' });
    }
  });

  app.put('/api/inventoryBatches/:id', requirePermission('edit_product'), async (req, res) => {
    try {
      const batchId = String(req.params.id);
      const now = new Date().toISOString();
      const updateData = { ...req.body };
      delete updateData.id;
      delete updateData.productId;
      delete updateData.purchaseId;
      delete updateData.quantity;
      delete updateData.baseQuantity;
      delete updateData.costPrice;
      delete updateData.unitCode;
      delete updateData.baseUnitCode;
      delete updateData.conversionToBase;
      delete updateData.operationId;
      delete updateData.deviceId;
      delete updateData.createdBy;
      delete updateData.isSynced;
      delete updateData.createdAt;
      delete updateData.updatedAt;
      delete updateData.remainingQuantity;

      const result = await db.transaction(async (tx: any) => {
        const [existing] = await tx.select().from(inventoryBatches)
          .where(eq(inventoryBatches.id, batchId)).limit(1);
        if (!existing) return { status: 404 as const };

        const nextRemaining = Number(req.body.remainingQuantity ?? existing.remainingQuantity);
        if (!Number.isFinite(nextRemaining) || nextRemaining < 0 ||
            nextRemaining > Number(existing.quantity) + 1e-9) {
          return { status: 400 as const };
        }

        const [batch] = await tx
          .update(inventoryBatches)
          .set({ ...updateData, remainingQuantity: nextRemaining, isSynced: 0, updatedAt: now })
          .where(eq(inventoryBatches.id, batchId))
          .returning();

        const delta = nextRemaining - Number(existing.remainingQuantity || 0);
        if (Math.abs(delta) > 1e-9) {
          const operationId = String(req.body.operationId || `legacy-api:batch-adjust:${batchId}:${now}`);
          const movementKey = `legacy_batch_adjustment:inventory_batch:${batchId}:${now}`;
          await appendApiInventoryMovement({
            operationId,
            movementKey,
            productId: existing.productId,
            branchId: existing.branchId,
            movementType: 'legacy_batch_adjustment',
            sourceType: 'inventory_batch',
            sourceId: batchId,
            sourceLineId: batchId,
            deviceId: req.body.deviceId,
            createdBy: req.body.createdBy,
            inputQuantity: Math.abs(delta),
            unitCode: existing.unitCode,
            baseUnitCode: existing.baseUnitCode,
            conversionToBase: Number(existing.conversionToBase || 1),
            quantityDeltaBase: delta,
            unitCost: Number(existing.costPrice || 0),
            totalCost: Math.abs(delta * Number(existing.costPrice || 0)),
            batchAllocations: [{ batchId, quantity: Math.abs(delta), costPrice: Number(existing.costPrice || 0) }],
            reason: 'legacy_batch_update',
            createdAt: now,
          }, tx);
        }
        return { batch };
      });

      if ('status' in result && result.status === 404) {
        return res.status(404).json({ error: 'Inventory batch not found' });
      }
      if ('status' in result && result.status === 400) {
        return res.status(400).json({ error: 'Remaining quantity must stay within the original batch quantity' });
      }
      res.json(result.batch);
    } catch {
      res.status(500).json({ error: 'Failed to update inventory batch' });
    }
  });

  app.get('/api/inventoryAlerts', async (_req, res) => {
    try {
      res.json(await db.select().from(inventoryAlerts));
    } catch {
      res.status(500).json({ error: 'Failed to fetch inventory alerts' });
    }
  });

  app.post('/api/inventoryAlerts/:id/resolve', requirePermission('view_inventory'), async (req, res) => {
    try {
      const [alert] = await db
        .update(inventoryAlerts)
        .set({ resolved: 1 })
        .where(eq(inventoryAlerts.id, req.params.id))
        .returning();
      res.json(alert);
    } catch {
      res.status(500).json({ error: 'Failed to resolve alert' });
    }
  });

  // --- Accounts, Journal Entries & Transactions (Double-Entry Ledger) ---
  app.get('/api/accounts', async (_req, res) => {
    try {
      res.json(await db.select().from(accounts));
    } catch {
      res.status(500).json({ error: 'Failed to fetch accounts' });
    }
  });

  app.get('/api/journalEntries', async (_req, res) => {
    try {
      res.json(await db.select().from(journalEntries));
    } catch {
      res.status(500).json({ error: 'Failed to fetch journal entries' });
    }
  });

  app.get('/api/transactions', async (_req, res) => {
    try {
      res.json(await db.select().from(transactions));
    } catch {
      res.status(500).json({ error: 'Failed to fetch transactions' });
    }
  });

  // --- Employees (NEVER leak password or pinCode!) ---
  app.get('/api/employees', async (_req, res) => {
    try {
      const employeesList = await db.select().from(employees);
      res.json(employeesList.map(sanitizeEmployee));
    } catch {
      res.status(500).json({ error: 'Failed to fetch employees' });
    }
  });

  app.post('/api/employees', requirePermission('add_employee'), async (req, res) => {
    try {
      const data = { ...req.body };
      if (Array.isArray(data.permissions)) {
        data.permissions = JSON.stringify(data.permissions);
      }
      if (data.password) {
        data.password = data.password.startsWith('$2') ? data.password : hashSecret(String(data.password));
      } else {
        data.password = hashSecret(crypto.randomBytes(12).toString('hex'));
      }
      if (data.pinCode) {
        data.pinCode = data.pinCode.startsWith('$2') ? data.pinCode : hashSecret(String(data.pinCode));
      }
      const now = new Date().toISOString();
      const [employee] = await db
        .insert(employees)
        .values({ ...data, isSynced: 0, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: employees.id,
          set: { ...data, isSynced: 0, updatedAt: now },
        })
        .returning();
      res.status(201).json(sanitizeEmployee(employee));
    } catch {
      res.status(500).json({ error: 'Failed to create employee' });
    }
  });

  app.put('/api/employees/:id', requirePermission('edit_employee'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const data = { ...req.body };
      delete data.hasPin;
      if (Array.isArray(data.permissions)) {
        data.permissions = JSON.stringify(data.permissions);
      }
      if (data.password) {
        data.password = data.password.startsWith('$2') ? data.password : hashSecret(String(data.password));
      } else {
        delete data.password;
      }
      if (data.pinCode) {
        data.pinCode = data.pinCode.startsWith('$2') ? data.pinCode : hashSecret(String(data.pinCode));
      } else {
        delete data.pinCode;
      }
      if (typeof data.mustChangePassword === 'boolean') {
        data.mustChangePassword = data.mustChangePassword ? 1 : 0;
      }
      const [employee] = await db
        .update(employees)
        .set({ ...data, isSynced: 0, updatedAt: new Date().toISOString() })
        .where(eq(employees.id, id))
        .returning();
      res.json(sanitizeEmployee(employee));
    } catch {
      res.status(500).json({ error: 'Failed to update employee' });
    }
  });

  app.delete('/api/employees/:id', requirePermission('delete_employee'), async (req, res) => {
    try {
      await db.delete(employees).where(eq(employees.id, parseInt(req.params.id)));
      res.json({ message: 'Employee deleted' });
    } catch {
      res.status(500).json({ error: 'Failed to delete employee' });
    }
  });

  // --- Unit catalogue and per-product unit conversions ---
  app.get('/api/unit-definitions', async (_req, res) => {
    try {
      res.json(await db.select().from(unitDefinitions));
    } catch {
      res.status(500).json({ error: 'Failed to fetch unit definitions' });
    }
  });

  app.post('/api/unit-definitions', requirePermission('manage_settings'), async (req, res) => {
    try {
      const { code, name, symbol, dimension, decimalPlaces, isFractional } = normalizeUnitDefinition(req.body);
      const [existingDefinition] = await db.select().from(unitDefinitions).where(eq(unitDefinitions.code, code));
      if (existingDefinition) {
        const linkedUnits = await db.select().from(productUnits).where(eq(productUnits.unitCode, code));
        const linkedProducts = await db.select().from(products).where(eq(products.baseUnitCode, code));
        if (existingDefinition.dimension !== dimension && (linkedUnits.length > 0 || linkedProducts.length > 0)) {
          return res.status(409).json({ error: 'لا يمكن تغيير بُعد وحدة مستخدمة في أصناف؛ أنشئ رمز وحدة جديداً' });
        }
        if (existingDefinition.decimalPlaces !== decimalPlaces && (linkedUnits.length > 0 || linkedProducts.length > 0)) {
          return res.status(409).json({ error: 'لا يمكن تغيير دقة وحدة مرتبطة بأصناف؛ أنشئ رمز وحدة جديداً أو نفّذ ترحيلاً موثقاً' });
        }
      }
      const now = new Date().toISOString();
      const [saved] = await db.insert(unitDefinitions).values({
        code, name, symbol, dimension, decimalPlaces, isFractional,
        isActive: 1, createdAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        target: unitDefinitions.code,
        set: { name, symbol, dimension, decimalPlaces, isFractional: decimalPlaces > 0 ? 1 : 0, updatedAt: now },
      }).returning();
      res.status(201).json(saved);
    } catch (error: any) {
      const message = error?.message || 'Failed to save unit definition';
      res.status(error instanceof TypeError ? 400 : 500).json({ error: message });
    }
  });

  app.get('/api/product-units', async (req, res) => {
    try {
      const productId = Number(req.query.productId);
      const rows = await db.select().from(productUnits);
      res.json(Number.isInteger(productId) && productId > 0 ? rows.filter((row) => row.productId === productId) : rows);
    } catch {
      res.status(500).json({ error: 'Failed to fetch product units' });
    }
  });

  app.post('/api/product-units', requirePermission('edit_product'), async (req, res) => {
    try {
      const { productId, unitCode, conversionToBase, isBaseUnit, sellingPrice, barcode } = normalizeProductUnit(req.body);

      const saved = await db.transaction(async (tx) => {
        const [product] = await tx.select().from(products).where(eq(products.id, productId));
        const [unit] = await tx.select().from(unitDefinitions).where(eq(unitDefinitions.code, unitCode));
        if (!product || !unit || !unit.isActive) throw new Error('الصنف أو تعريف الوحدة غير موجود أو غير نشط');

        const existingUnits = await tx.select().from(productUnits).where(eq(productUnits.productId, productId));
        const existingBase = existingUnits.find((row) => row.isBaseUnit === 1);
        const existing = existingUnits.find((row) => row.unitCode === unitCode);
        if (barcode) {
          const [duplicateUnitBarcode] = await tx.select().from(productUnits).where(eq(productUnits.barcode, barcode));
          if (duplicateUnitBarcode && duplicateUnitBarcode.id !== existing?.id) {
            throw new RangeError('هذا الباركود مستخدم بالفعل لوحدة أخرى');
          }
          const [duplicateProductBarcode] = await tx.select().from(products).where(eq(products.barcode, barcode));
          if (duplicateProductBarcode) {
            throw new RangeError('هذا الباركود مستخدم بالفعل كرمز صنف؛ استخدم باركوداً مختلفاً للوحدة');
          }
        }

        if (!isBaseUnit && existingBase?.unitCode === unitCode) {
          throw new Error('لا يمكن إلغاء وحدة الأساس دون تعيين وحدة أساس بديلة');
        }
        if (!isBaseUnit && !existingBase && !product.baseUnitCode) {
          throw new Error('يجب تحديد وحدة أساس للصنف قبل إضافة وحدات التحويل');
        }
        const currentBaseCode = existingBase?.unitCode || product.baseUnitCode;
        if (!currentBaseCode && !isBaseUnit) {
          throw new RangeError('يجب تحديد وحدة الأساس أولاً قبل إضافة وحدات بديلة');
        }
        const [orderMovement] = await tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.productId, productId)).limit(1);
        const [purchaseMovement] = await tx.select({ id: purchaseItems.id }).from(purchaseItems).where(eq(purchaseItems.productId, productId)).limit(1);
        const [inventoryMovement] = await tx.select({ id: inventoryBatches.id }).from(inventoryBatches).where(eq(inventoryBatches.productId, productId)).limit(1);
        const hasMovementHistory = Boolean(orderMovement || purchaseMovement || inventoryMovement);

        if (isBaseUnit && !currentBaseCode &&
            (hasMovementHistory || Number(product.stockQuantity || 0) > 0)) {
          throw new RangeError('لا يمكن تعيين وحدة أساس لصنف له مخزون أو حركات سابقة؛ أنشئ الصنف بكمية صفر وحدد وحدة الأساس قبل إدخال المخزون، أو نفّذ ترحيلاً موثقاً');
        }

        if (isBaseUnit && currentBaseCode && currentBaseCode !== unitCode) {
          if (hasMovementHistory) {
            throw new RangeError('لا يمكن تغيير وحدة الأساس بعد وجود حركات مخزون تاريخية');
          }
          assertBaseUnitChangeAllowed({
            hasStock: Number(product.stockQuantity || 0) > 0,
            hasDependentAlternateUnits: existingUnits.some((row) => row.unitCode !== currentBaseCode),
          });
          throw new RangeError('لا يمكن استبدال وحدة أساس مثبتة مباشرة؛ أنشئ صنفاً جديداً أو نفّذ ترحيلاً موثقاً حتى لا تتغير معاني المخزون');
        }
        if (existing && Math.abs(Number(existing.conversionToBase) - conversionToBase) > 1e-10 && hasMovementHistory) {
          throw new RangeError('لا يمكن تغيير معامل التحويل بعد وجود حركات مخزون تاريخية؛ أنشئ وحدة جديدة بدلاً من تعديل القديمة');
        }
        if (currentBaseCode && currentBaseCode !== unitCode) {
          const [baseDefinition] = await tx.select().from(unitDefinitions).where(eq(unitDefinitions.code, currentBaseCode));
          if (baseDefinition) assertCompatibleUnitDimensions(baseDefinition.dimension, unit.dimension);
        }

        const now = new Date().toISOString();
        let result: any;
        if (existing) {
          [result] = await tx.update(productUnits).set({
            conversionToBase, isBaseUnit, sellingPrice, barcode, isActive: 1, updatedAt: now,
          }).where(eq(productUnits.id, existing.id)).returning();
        } else {
          [result] = await tx.insert(productUnits).values({
            id: crypto.randomUUID(), productId, unitCode, conversionToBase, isBaseUnit,
            sellingPrice, barcode, isActive: 1, createdAt: now, updatedAt: now,
          }).returning();
        }

        if (isBaseUnit) {
          for (const row of existingUnits) {
            if (row.unitCode !== unitCode && row.isBaseUnit) {
              await tx.update(productUnits).set({ isBaseUnit: 0, updatedAt: now }).where(eq(productUnits.id, row.id));
            }
          }
          await tx.update(products).set({
            baseUnitCode: unitCode,
            quantityPrecision: unit.decimalPlaces,
            updatedAt: now,
          }).where(eq(products.id, productId));
        }
        return result;
      });
      res.status(201).json(saved);
    } catch (error: any) {
      const message = error?.message || 'Failed to save product unit';
      const status = /غير موجود|غير نشط/.test(message) ? 404 : error instanceof RangeError ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  // --- Currency master data and append-only exchange-rate ledger ---
  app.get('/api/currencies', async (_req, res) => {
    try {
      res.json(await db.select().from(currencies));
    } catch {
      res.status(500).json({ error: 'Failed to fetch currencies' });
    }
  });

  app.post('/api/currencies', requirePermission('manage_settings'), async (req: AuthenticatedRequest, res) => {
    try {
      const code = String(req.body?.code || '').trim().toUpperCase();
      const name = String(req.body?.name || '').trim();
      const symbol = req.body?.symbol == null ? null : String(req.body.symbol).trim();
      const decimalPlaces = Number(req.body?.decimalPlaces ?? 2);
      const supportedCurrencyCodes: string[] =
        typeof (Intl as any).supportedValuesOf === 'function'
          ? (Intl as any).supportedValuesOf('currency')
          : [];
      const recognizedCode = supportedCurrencyCodes.includes(code);
      if (!/^[A-Z]{3}$/.test(code) || !recognizedCode || !name || !Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 4) {
        return res.status(400).json({ error: 'Currency requires a recognized ISO 4217 code, name, and 0-4 decimal places' });
      }
      const now = new Date().toISOString();
      const [saved] = await db.insert(currencies).values({
        code, name, symbol, decimalPlaces, isActive: 1, createdAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        target: currencies.code,
        set: { name, symbol, decimalPlaces, updatedAt: now },
      }).returning();
      res.status(201).json(saved);
    } catch {
      res.status(500).json({ error: 'Failed to save currency' });
    }
  });

  app.put('/api/currencies/:code/status', requirePermission('manage_settings'), async (req, res) => {
    try {
      const code = String(req.params.code || '').trim().toUpperCase();
      const isActive = req.body?.isActive === true || req.body?.isActive === 1 ? 1 : 0;
      if (!isActive) {
        const [baseSetting] = await db.select().from(settings).where(eq(settings.key, 'baseCurrencyCode'));
        if (baseSetting?.value === code) return res.status(409).json({ error: 'The configured base currency cannot be deactivated' });
      }
      const [saved] = await db.update(currencies).set({ isActive, updatedAt: new Date().toISOString() })
        .where(eq(currencies.code, code)).returning();
      if (!saved) return res.status(404).json({ error: 'Currency not found' });
      res.json(saved);
    } catch {
      res.status(500).json({ error: 'Failed to update currency status' });
    }
  });

  app.get('/api/currencies/base', async (_req, res) => {
    try {
      const [setting] = await db.select().from(settings).where(eq(settings.key, 'baseCurrencyCode'));
      res.json({ baseCurrencyCode: setting?.value || null });
    } catch {
      res.status(500).json({ error: 'Failed to fetch base currency' });
    }
  });

  app.put('/api/currencies/base', requirePermission('manage_settings'), async (req, res) => {
    try {
      const code = String(req.body?.code || '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) return res.status(400).json({ error: 'A valid 3-letter currency code is required' });
      const [currency] = await db.select().from(currencies).where(eq(currencies.code, code));
      if (!currency || !currency.isActive) return res.status(400).json({ error: 'Base currency must exist and be active' });
      const [existingBase] = await db.select().from(settings).where(eq(settings.key, 'baseCurrencyCode'));
      if (existingBase?.value && existingBase.value !== code) {
        const [existingPurchase] = await db.select({ id: purchases.id }).from(purchases).limit(1);
        const [existingOrder] = await db.select({ id: orders.id }).from(orders).limit(1);
        if (existingPurchase || existingOrder) {
          return res.status(409).json({ error: 'لا يمكن تغيير العملة الأساسية بعد تسجيل حركات مالية؛ يلزم إجراء تحويل محاسبي مستقل' });
        }
      }
      const now = new Date().toISOString();
      const [saved] = await db.insert(settings).values({ key: 'baseCurrencyCode', value: code, isSynced: 0, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { value: code, isSynced: 0, updatedAt: now } }).returning();
      res.json({ baseCurrencyCode: saved.value });
    } catch {
      res.status(500).json({ error: 'Failed to set base currency' });
    }
  });

  app.get('/api/exchange-rates', async (req, res) => {
    try {
      const base = req.query.base ? String(req.query.base).toUpperCase() : undefined;
      const quote = req.query.quote ? String(req.query.quote).toUpperCase() : undefined;
      const rows = await db.select().from(exchangeRates);
      res.json(rows.filter((row) => (!base || row.baseCurrencyCode === base) && (!quote || row.quoteCurrencyCode === quote))
        .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt)));
    } catch {
      res.status(500).json({ error: 'Failed to fetch exchange rates' });
    }
  });

  app.post('/api/exchange-rates', requirePermission('manage_settings'), async (req: AuthenticatedRequest, res) => {
    try {
      const baseCurrencyCode = String(req.body?.baseCurrencyCode || '').trim().toUpperCase();
      const quoteCurrencyCode = String(req.body?.quoteCurrencyCode || '').trim().toUpperCase();
      const rate = Number(req.body?.rate);
      const effectiveAt = String(req.body?.effectiveAt || '').trim();
      const source = String(req.body?.source || '').trim();
      if (!/^[A-Z]{3}$/.test(baseCurrencyCode) || !/^[A-Z]{3}$/.test(quoteCurrencyCode) || baseCurrencyCode === quoteCurrencyCode || !Number.isFinite(rate) || rate <= 0 || !effectiveAt || Number.isNaN(Date.parse(effectiveAt)) || !source) {
        return res.status(400).json({ error: 'Valid distinct currencies, positive rate, effective date, and source are required' });
      }
      const active = await db.select().from(currencies);
      if (![baseCurrencyCode, quoteCurrencyCode].every((code) => active.some((currency) => currency.code === code && currency.isActive))) {
        return res.status(400).json({ error: 'Both currencies must be registered and active' });
      }
      const now = new Date().toISOString();
      const [saved] = await db.insert(exchangeRates).values({
        id: crypto.randomUUID(), baseCurrencyCode, quoteCurrencyCode, rate, effectiveAt, source,
        createdBy: req.authUser?.username || null, createdAt: now, approvedBy: null, approvedAt: null, isSynced: 0,
      }).returning();
      res.status(201).json(saved);
    } catch {
      res.status(500).json({ error: 'Failed to create exchange rate' });
    }
  });

  app.post('/api/exchange-rates/:id/approve', requirePermission('manage_settings'), async (req: AuthenticatedRequest, res) => {
    try {
      const [rate] = await db.select().from(exchangeRates).where(eq(exchangeRates.id, req.params.id));
      if (!rate) return res.status(404).json({ error: 'Exchange rate not found' });
      if (rate.approvedAt) return res.status(409).json({ error: 'Approved exchange rates are immutable' });
      const now = new Date().toISOString();
      const [approved] = await db.update(exchangeRates).set({
        approvedBy: req.authUser?.username || 'admin', approvedAt: now, isSynced: 0,
      }).where(eq(exchangeRates.id, req.params.id)).returning();
      res.json(approved);
    } catch {
      res.status(500).json({ error: 'Failed to approve exchange rate' });
    }
  });

  // --- Settings (Filter sensitive keys) ---
  app.get('/api/settings', async (_req, res) => {
    try {
      const settingsList = await db.select().from(settings);
      res.json(settingsList.filter((s) => !SENSITIVE_SETTING_KEYS.has(s.key)));
    } catch {
      res.status(500).json({ error: 'Failed to fetch settings' });
    }
  });

  app.get('/api/settings/:key', async (req, res) => {
    try {
      if (SENSITIVE_SETTING_KEYS.has(req.params.key)) {
        return res.status(403).json({ error: 'Forbidden setting key' });
      }
      const [setting] = await db.select().from(settings).where(eq(settings.key, req.params.key));
      res.json(setting || { value: null });
    } catch {
      res.status(500).json({ error: 'Failed to fetch setting' });
    }
  });

  app.post('/api/settings', requirePermission('manage_settings'), async (req, res) => {
    try {
      const { key, value } = req.body;
      if (key === 'authSecret') {
        return res.status(403).json({ error: 'Cannot overwrite authSecret' });
      }
      const now = new Date().toISOString();
      const [setting] = await db
        .insert(settings)
        .values({ key, value: String(value), isSynced: 0, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: String(value), isSynced: 0, updatedAt: now },
        })
        .returning();
      res.status(201).json(setting);
    } catch {
      res.status(500).json({ error: 'Failed to save setting' });
    }
  });

  app.put('/api/settings/:key', requirePermission('manage_settings'), async (req, res) => {
    try {
      const key = req.params.key;
      if (key === 'authSecret') {
        return res.status(403).json({ error: 'Cannot overwrite authSecret' });
      }
      const value = req.body.value;
      const now = new Date().toISOString();
      const [setting] = await db
        .insert(settings)
        .values({ key, value: String(value), isSynced: 0, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: String(value), isSynced: 0, updatedAt: now },
        })
        .returning();
      res.json(setting);
    } catch {
      res.status(500).json({ error: 'Failed to update setting' });
    }
  });

  // --- Purchases ---
  app.get('/api/purchases', async (_req, res) => {
    try {
      res.json(await db.select().from(purchases));
    } catch {
      res.status(500).json({ error: 'Failed to fetch purchases' });
    }
  });

  app.get('/api/purchaseItems', async (_req, res) => {
    try {
      res.json(await db.select().from(purchaseItems));
    } catch {
      res.status(500).json({ error: 'Failed to fetch purchase items' });
    }
  });

  app.post('/api/purchases', requirePermission('add_purchase'), async (req: AuthenticatedRequest, res) => {
    try {
      const { purchase, purchaseItems: items } = req.body || {};
      const outcome = executeBusinessOperation(
        db,
        'purchase',
        { purchase, items },
        {
          operationId: purchase?.operationId || purchase?.id,
          deviceId: purchase?.deviceId || 'client',
          userName: req.authUser?.name || 'System',
        }
      );
      res.status(201).json(outcome.result);
    } catch (error) {
      console.error('Purchase failed:', error);
      res.status(500).json({ error: 'Purchase failed' });
    }
  });

  app.put('/api/purchases/:id', requirePermission('edit_purchase'), async (req: AuthenticatedRequest, res) => {
    try {
      const { purchase, purchaseItems: items } = req.body || {};
      const outcome = executeBusinessOperation(
        db,
        'purchase_update',
        { purchase: purchase || { ...req.body, id: req.params.id }, items: items || [] },
        { userName: req.authUser?.name || 'System' }
      );
      res.json(outcome.result);
    } catch (error) {
      if (error instanceof OperationError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({ error: 'Failed to update purchase' });
    }
  });

  app.delete('/api/purchases/:id', requirePermission('delete_purchase'), async (req: AuthenticatedRequest, res) => {
    try {
      const outcome = executeBusinessOperation(
        db,
        'purchase_delete',
        { id: req.params.id },
        { userName: req.authUser?.name || 'System' }
      );
      res.json(outcome.result);
    } catch (error) {
      if (error instanceof OperationError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({ error: 'Failed to delete purchase' });
    }
  });

  app.get('/api/purchaseReturns', async (_req, res) => {
    try {
      res.json(await db.select().from(purchaseReturns));
    } catch {
      res.status(500).json({ error: 'Failed to fetch purchase returns' });
    }
  });

  app.get('/api/purchaseReturnItems', async (_req, res) => {
    try {
      res.json(await db.select().from(purchaseReturnItems));
    } catch {
      res.status(500).json({ error: 'Failed to fetch purchase return items' });
    }
  });

  app.get('/api/customerPayments', async (_req, res) => {
    try {
      res.json(await db.select().from(customerPayments));
    } catch {
      res.status(500).json({ error: 'Failed to fetch customer payments' });
    }
  });

  app.get('/api/supplierPayments', async (_req, res) => {
    try {
      res.json(await db.select().from(supplierPayments));
    } catch {
      res.status(500).json({ error: 'Failed to fetch supplier payments' });
    }
  });

  app.post('/api/purchaseItems', requirePermission('add_purchase'), async (req, res) => {
    try {
      const [record] = await db
        .insert(purchaseItems)
        .values({ ...req.body, isSynced: 0, createdAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: purchaseItems.id,
          set: { ...req.body, isSynced: 0 },
        })
        .returning();
      res.status(201).json(record);
    } catch {
      res.status(500).json({ error: 'Failed to create purchase item' });
    }
  });

  // --- Shifts ---
  app.get('/api/shifts', async (_req, res) => {
    try {
      res.json(await db.select().from(shifts));
    } catch {
      res.status(500).json({ error: 'Failed to fetch shifts' });
    }
  });

  app.post('/api/shifts', requireAnyPermission(['manage_shifts', 'view_pos', 'view_mobile_sales']), async (req, res) => {
    try {
      const now = new Date().toISOString();
      const [shift] = await db
        .insert(shifts)
        .values({
          ...req.body,
          startTime: new Date(req.body.startTime || now).toISOString(),
          endTime: req.body.endTime ? new Date(req.body.endTime).toISOString() : null,
          isSynced: 0,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: shifts.id,
          set: { ...req.body, isSynced: 0, updatedAt: now },
        })
        .returning();
      res.status(201).json(shift);
    } catch {
      res.status(500).json({ error: 'Failed to create shift' });
    }
  });

  app.put('/api/shifts/:id', requireAnyPermission(['manage_shifts', 'view_pos', 'view_mobile_sales']), async (req, res) => {
    try {
      const [shift] = await db
        .update(shifts)
        .set({
          ...req.body,
          endTime: req.body.endTime ? new Date(req.body.endTime).toISOString() : null,
          isSynced: 0,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(shifts.id, req.params.id))
        .returning();
      res.json(shift);
    } catch {
      res.status(500).json({ error: 'Failed to update shift' });
    }
  });

  app.get('/api/shiftMovements', async (_req, res) => {
    try {
      res.json(await db.select().from(shiftMovements));
    } catch {
      res.status(500).json({ error: 'Failed to fetch shift movements' });
    }
  });

  // --- Expenses ---
  app.get('/api/expenses', async (_req, res) => {
    try {
      res.json(await db.select().from(expenses));
    } catch {
      res.status(500).json({ error: 'Failed to fetch expenses' });
    }
  });

  app.post('/api/expenses', requirePermission('add_expense'), async (req: AuthenticatedRequest, res) => {
    try {
      const outcome = executeBusinessOperation(db, 'expense', req.body, {
        userName: req.authUser?.name || 'System',
      });
      res.status(201).json(outcome.result);
    } catch {
      res.status(500).json({ error: 'Failed to create expense' });
    }
  });

  app.delete('/api/expenses/:id', requirePermission('delete_expense'), async (req: AuthenticatedRequest, res) => {
    try {
      const outcome = executeBusinessOperation(
        db,
        'expense_delete',
        { id: parseInt(req.params.id) },
        { userName: req.authUser?.name || 'System' }
      );
      res.json(outcome.result);
    } catch {
      res.status(500).json({ error: 'Failed to delete expense' });
    }
  });

  // --- Attendance, Loyalty, Payroll, Branches, Offers ---
  app.get('/api/attendance', async (_req, res) => {
    try {
      res.json(await db.select().from(attendance));
    } catch {
      res.status(500).json({ error: 'Failed to fetch attendance' });
    }
  });

  app.post('/api/attendance', requirePermission('manage_attendance'), async (req, res) => {
    try {
      const now = new Date().toISOString();
      const [record] = await db
        .insert(attendance)
        .values({ ...req.body, isSynced: 0, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: attendance.id,
          set: { ...req.body, isSynced: 0, updatedAt: now },
        })
        .returning();
      res.status(201).json(record);
    } catch {
      res.status(500).json({ error: 'Failed to record attendance' });
    }
  });

  app.put('/api/attendance/:id', requirePermission('manage_attendance'), async (req, res) => {
    try {
      const [record] = await db
        .update(attendance)
        .set({ ...req.body, isSynced: 0, updatedAt: new Date().toISOString() })
        .where(eq(attendance.id, req.params.id))
        .returning();
      res.json(record);
    } catch {
      res.status(500).json({ error: 'Failed to update attendance' });
    }
  });

  app.get('/api/loyalty-transactions', async (_req, res) => {
    try {
      res.json(await db.select().from(loyaltyTransactions));
    } catch {
      res.status(500).json({ error: 'Failed to fetch loyalty transactions' });
    }
  });

  app.post('/api/loyalty-transactions', requireAnyPermission(['view_pos', 'view_mobile_sales', 'edit_customer']), async (req, res) => {
    try {
      const [record] = await db
        .insert(loyaltyTransactions)
        .values({ ...req.body, isSynced: 0, createdAt: new Date().toISOString() })
        .onConflictDoNothing()
        .returning();
      res.status(201).json(record || req.body);
    } catch {
      res.status(500).json({ error: 'Failed to create loyalty transaction' });
    }
  });

  app.get('/api/payroll', async (_req, res) => {
    try {
      res.json(await db.select().from(payrolls));
    } catch {
      res.status(500).json({ error: 'Failed to fetch payroll' });
    }
  });

  app.post('/api/payroll', requirePermission('manage_payroll'), async (req: AuthenticatedRequest, res) => {
    try {
      const outcome = executeBusinessOperation(db, 'payroll', req.body, {
        userName: req.authUser?.name || 'System',
      });
      res.status(201).json(outcome.result);
    } catch {
      res.status(500).json({ error: 'Failed to create payroll' });
    }
  });

  app.get('/api/branches', async (_req, res) => {
    try {
      res.json(await db.select().from(branches));
    } catch {
      res.status(500).json({ error: 'Failed to fetch branches' });
    }
  });

  app.post('/api/branches', requirePermission('manage_branches'), async (req, res) => {
    try {
      const now = new Date().toISOString();
      const [record] = await db
        .insert(branches)
        .values({ ...req.body, isSynced: 0, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: branches.id,
          set: { ...req.body, isSynced: 0, updatedAt: now },
        })
        .returning();
      res.status(201).json(record);
    } catch {
      res.status(500).json({ error: 'Failed to create branch' });
    }
  });

  app.put('/api/branches/:id', requirePermission('manage_branches'), async (req, res) => {
    try {
      const [record] = await db
        .update(branches)
        .set({ ...req.body, isSynced: 0, updatedAt: new Date().toISOString() })
        .where(eq(branches.id, parseInt(req.params.id)))
        .returning();
      res.json(record);
    } catch {
      res.status(500).json({ error: 'Failed to update branch' });
    }
  });

  app.delete('/api/branches/:id', requirePermission('manage_branches'), async (req, res) => {
    try {
      await db.delete(branches).where(eq(branches.id, parseInt(req.params.id)));
      res.json({ message: 'Branch deleted' });
    } catch {
      res.status(500).json({ error: 'Failed to delete branch' });
    }
  });

  app.get('/api/offers', async (_req, res) => {
    try {
      res.json(await db.select().from(offers));
    } catch {
      res.status(500).json({ error: 'Failed to fetch offers' });
    }
  });

  app.post('/api/offers', requirePermission('manage_offers'), async (req, res) => {
    try {
      const now = new Date().toISOString();
      const [record] = await db
        .insert(offers)
        .values({ ...req.body, isSynced: 0, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: offers.id,
          set: { ...req.body, isSynced: 0, updatedAt: now },
        })
        .returning();
      res.status(201).json(record);
    } catch {
      res.status(500).json({ error: 'Failed to create offer' });
    }
  });

  app.put('/api/offers/:id', requirePermission('manage_offers'), async (req, res) => {
    try {
      const [record] = await db
        .update(offers)
        .set({ ...req.body, isSynced: 0, updatedAt: new Date().toISOString() })
        .where(eq(offers.id, parseInt(req.params.id)))
        .returning();
      res.json(record);
    } catch {
      res.status(500).json({ error: 'Failed to update offer' });
    }
  });

  app.delete('/api/offers/:id', requirePermission('manage_offers'), async (req, res) => {
    try {
      await db.delete(offers).where(eq(offers.id, parseInt(req.params.id)));
      res.json({ message: 'Offer deleted' });
    } catch {
      res.status(500).json({ error: 'Failed to delete offer' });
    }
  });

  // --- Stocktaking & Audit Logs ---
  app.get('/api/stocktakingSessions', async (_req, res) => {
    try {
      res.json(await db.select().from(stocktakingSessions));
    } catch {
      res.status(500).json({ error: 'Failed to fetch stocktaking sessions' });
    }
  });

  app.post('/api/stocktakingSessions', requirePermission('manage_stocktaking'), async (req, res) => {
    try {
      const [session] = await db
        .insert(stocktakingSessions)
        .values({ ...req.body, isSynced: 0, createdAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: stocktakingSessions.id,
          set: { ...req.body, isSynced: 0 },
        })
        .returning();
      res.status(201).json(session);
    } catch {
      res.status(500).json({ error: 'Failed to create stocktaking session' });
    }
  });

  app.put('/api/stocktakingSessions/:id', requirePermission('manage_stocktaking'), async (req, res) => {
    try {
      const [session] = await db
        .update(stocktakingSessions)
        .set({ ...req.body, isSynced: 0 })
        .where(eq(stocktakingSessions.id, req.params.id))
        .returning();
      res.json(session);
    } catch {
      res.status(500).json({ error: 'Failed to update stocktaking session' });
    }
  });

  app.delete('/api/stocktakingSessions/:id', requirePermission('manage_stocktaking'), async (req, res) => {
    try {
      await db.delete(stocktakingSessions).where(eq(stocktakingSessions.id, req.params.id));
      await db.delete(stocktakingEntries).where(eq(stocktakingEntries.sessionId, req.params.id));
      res.json({ message: 'Stocktaking session deleted' });
    } catch {
      res.status(500).json({ error: 'Failed to delete stocktaking session' });
    }
  });

  app.get('/api/stocktakingEntries', async (_req, res) => {
    try {
      res.json(await db.select().from(stocktakingEntries));
    } catch {
      res.status(500).json({ error: 'Failed to fetch stocktaking entries' });
    }
  });

  app.post('/api/stocktakingEntries', requirePermission('manage_stocktaking'), async (req, res) => {
    try {
      const [entry] = await db
        .insert(stocktakingEntries)
        .values({
          ...req.body,
          id: req.body.id ? String(req.body.id) : crypto.randomUUID(),
          isSynced: 0,
          scannedAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: stocktakingEntries.id,
          set: { ...req.body, isSynced: 0 },
        })
        .returning();
      res.status(201).json(entry);
    } catch {
      res.status(500).json({ error: 'Failed to create stocktaking entry' });
    }
  });

  app.get('/api/auditLogs', async (_req, res) => {
    try {
      res.json(await db.select().from(auditLogs).orderBy(sql`${auditLogs.date} DESC`).limit(200));
    } catch {
      res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
  });

  app.post('/api/auditLogs', async (req, res) => {
    try {
      const [log] = await db
        .insert(auditLogs)
        .values({
          ...req.body,
          id: req.body.id ? String(req.body.id) : crypto.randomUUID(),
          action: req.body.action || req.body.operationName || req.body.type || 'log',
          date: req.body.date || new Date().toISOString(),
        })
        .onConflictDoNothing()
        .returning();
      res.status(201).json(log || req.body);
    } catch {
      res.status(500).json({ error: 'Failed to create audit log' });
    }
  });

  // --- Authoritative Financial Report (Income Statement, VAT Summary, Balance Sheet, Trial Balance) ---
  app.get('/api/reports/financial', requirePermission('view_reports'), async (req, res) => {
    try {
      const { startDate, endDate, branchId } = req.query;
      const allOrders = await db.select().from(orders);
      const allOrderItems = await db.select().from(orderItems);
      const allProducts = await db.select().from(products);
      const allReturns = await db.select().from(returns);
      const allPurchases = await db.select().from(purchases);
      const allPurchaseReturns = await db.select().from(purchaseReturns);
      const allExpenses = await db.select().from(expenses);
      const allPayrolls = await db.select().from(payrolls);
      const allBatches = await db.select().from(inventoryBatches);
      const allAccounts = await db.select().from(accounts);
      const allJournalEntries = await db.select().from(journalEntries);
      const allTransactions = await db.select().from(transactions);

      const round = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
      const startMs = startDate ? new Date(String(startDate)).getTime() : null;
      const endMs = endDate ? new Date(String(endDate)).getTime() : null;

      const inRange = (iso?: string | null) => {
        if (!iso) return false;
        const d = new Date(iso).getTime();
        if (startMs !== null && d < startMs) return false;
        if (endMs !== null && d > endMs) return false;
        return true;
      };

      const matchBranch = (bId?: number | null) =>
        !branchId || Number(bId) === Number(branchId);

      const fOrders = allOrders.filter(
        (o) => o.status !== 'void' && inRange(o.createdAt) && matchBranch(o.branchId)
      );
      const fOrderIds = new Set(fOrders.map((o) => o.id));
      const fItems = allOrderItems.filter((i) => fOrderIds.has(i.orderId));
      const fReturns = allReturns.filter((r) => inRange(r.createdAt) && matchBranch(r.branchId));
      const fPurchases = allPurchases.filter((p) => inRange(p.date) && matchBranch(p.branchId));
      const fPurchaseReturns = allPurchaseReturns.filter((pr) => inRange(pr.createdAt) && matchBranch(pr.branchId));
      const fExpenses = allExpenses.filter((e) => inRange(e.date) && matchBranch(e.branchId));
      const fPayrolls = allPayrolls.filter((p) => inRange(p.paymentDate) && matchBranch(p.branchId));

      const grossSales = round(fOrders.reduce((s, o) => s + Number(o.totalAmount || 0), 0));
      const discounts = round(fOrders.reduce((s, o) => s + Number(o.discountAmount || 0), 0));
      const salesTax = round(fOrders.reduce((s, o) => s + Number(o.taxAmount || 0), 0));
      const returnsExclTax = round(
        fReturns.reduce((s, r) => s + (Number(r.totalRefund || 0) - Number(r.taxAmount || 0)), 0)
      );
      const returnsTax = round(fReturns.reduce((s, r) => s + Number(r.taxAmount || 0), 0));
      const returnsTotal = round(fReturns.reduce((s, r) => s + Number(r.totalRefund || 0), 0));

      const netSalesExclTax = round(grossSales - discounts - returnsExclTax);
      const netVatPayable = round(salesTax - returnsTax);

      const productsById = new Map(allProducts.map((product) => [product.id, product]));
      const grossCogs = round(
        fItems.reduce((sum, item) => sum + getHistoricalCostAmount(item, productsById.get(item.productId)), 0)
      );
      const returnedCogs = round(fReturns.reduce((s, r) => s + Number(r.totalCostReversed || 0), 0));
      const netCogs = round(grossCogs - returnedCogs);

      const grossProfit = round(netSalesExclTax - netCogs);
      const operatingExpenses = round(fExpenses.reduce((s, e) => s + Number(e.amount || 0), 0));
      const payrollExpenses = round(fPayrolls.reduce((s, p) => s + Number(p.netSalary || 0), 0));

      // Stocktaking variance expense/gain (Account 5400)
      const periodJournalIds = new Set(
        allJournalEntries
          .filter((je) => je.referenceType === 'stocktake' && inRange(je.date) && matchBranch(je.branchId))
          .map((je) => je.id)
      );
      const stocktakeAdjustments = round(
        allTransactions
          .filter((t) => t.accountId === '5400' && periodJournalIds.has(t.journalEntryId))
          .reduce((s, t) => s + Number(t.debit || 0) - Number(t.credit || 0), 0)
      );

      const netProfit = round(grossProfit - operatingExpenses - payrollExpenses - stocktakeAdjustments);

      const filteredBatches = allBatches.filter((b) => matchBranch(b.branchId));
      const inventoryCostValue = round(
        filteredBatches.reduce((s, b) => s + Number(b.remainingQuantity || 0) * Number(b.costPrice || 0), 0)
      );

      // Balance sheet from authoritative account balances
      const assets = allAccounts
        .filter((a) => a.type === 'asset')
        .map((a) => ({ code: a.code, name: a.name, balance: round(Number(a.balance || 0)) }));
      const liabilities = allAccounts
        .filter((a) => a.type === 'liability')
        .map((a) => ({ code: a.code, name: a.name, balance: round(Number(a.balance || 0)) }));
      const equity = allAccounts
        .filter((a) => a.type === 'equity')
        .map((a) => ({ code: a.code, name: a.name, balance: round(Number(a.balance || 0)) }));

      const cumulativeNetIncome = round(
        allAccounts.filter((a) => a.type === 'revenue').reduce((s, a) => s + Number(a.balance || 0), 0) -
          allAccounts.filter((a) => a.type === 'expense').reduce((s, a) => s + Number(a.balance || 0), 0)
      );

      const totalAssets = round(assets.reduce((s, a) => s + a.balance, 0));
      const totalLiabilities = round(liabilities.reduce((s, l) => s + l.balance, 0));
      const totalEquityAccounts = round(equity.reduce((s, e) => s + e.balance, 0));
      const totalLiabilitiesAndEquity = round(totalLiabilities + totalEquityAccounts + cumulativeNetIncome);

      // Trial Balance across filtered dates & branch
      const jeById = new Map(allJournalEntries.map((je) => [je.id, je]));
      const trialBalance = allAccounts.map((acc) => {
        let openingNet = 0;
        let periodDebit = 0;
        let periodCredit = 0;

        for (const t of allTransactions) {
          if (t.accountId !== acc.code) continue;
          const je = jeById.get(t.journalEntryId);
          if (je && !matchBranch(je.branchId)) continue;
          const tMs = new Date(je?.date || t.createdAt || 0).getTime();
          const d = Number(t.debit || 0);
          const c = Number(t.credit || 0);
          if (startMs !== null && tMs < startMs) {
            openingNet += d - c;
          } else if ((startMs === null || tMs >= startMs) && (endMs === null || tMs <= endMs)) {
            periodDebit += d;
            periodCredit += c;
          }
        }

        const closingNet = round(openingNet + periodDebit - periodCredit);
        return {
          code: acc.code,
          name: acc.name,
          type: acc.type,
          openingDebit: openingNet > 0 ? round(openingNet) : 0,
          openingCredit: openingNet < 0 ? round(Math.abs(openingNet)) : 0,
          periodDebit: round(periodDebit),
          periodCredit: round(periodCredit),
          closingDebit: closingNet > 0 ? round(closingNet) : 0,
          closingCredit: closingNet < 0 ? round(Math.abs(closingNet)) : 0,
        };
      });

      res.json({
        grossSales,
        discounts,
        returnsTotal,
        returnsExclTax,
        salesTax,
        returnsTax,
        netSalesExclTax,
        netVatPayable,
        netCogs,
        grossProfit,
        operatingExpenses,
        payrollExpenses,
        stocktakeAdjustments,
        netProfit,
        inventoryCostValue,
        purchasesTotal: round(fPurchases.reduce((s, p) => s + Number(p.totalAmount || 0), 0)),
        purchaseReturnsTotal: round(fPurchaseReturns.reduce((s, pr) => s + Number(pr.totalReturn || 0), 0)),
        salesCount: fOrders.length,
        accounts: allAccounts,
        balanceSheet: {
          assets,
          liabilities,
          equity,
          netIncome: cumulativeNetIncome,
          totalAssets,
          totalLiabilities,
          totalEquity: totalEquityAccounts,
          totalLiabilitiesAndEquity,
          balanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) <= 0.05,
        },
        trialBalance,
      });
    } catch {
      res.status(500).json({ error: 'Failed to generate financial report' });
    }
  });

  app.get('/api/reports/sales', requirePermission('view_reports'), async (req, res) => {
    try {
      const { startDate, endDate, branchId } = req.query;
      const all = await db.select().from(orders);
      const filtered = all.filter((o) => {
        if (branchId && Number(o.branchId) !== Number(branchId)) return false;
        if (startDate && new Date(o.createdAt) < new Date(String(startDate))) return false;
        if (endDate && new Date(o.createdAt) > new Date(String(endDate))) return false;
        return true;
      });
      res.json(filtered);
    } catch {
      res.status(500).json({ error: 'Failed to fetch sales report' });
    }
  });

  // --- Sync Queue ---
  app.get('/api/sync-queue', async (_req, res) => {
    try {
      res.json(
        await db.select().from(syncQueue).orderBy(sql`${syncQueue.createdAt} DESC`).limit(100)
      );
    } catch {
      res.status(500).json({ error: 'Failed to fetch sync queue' });
    }
  });

  app.delete('/api/sync-queue/:id', async (req, res) => {
    try {
      await db.delete(syncQueue).where(eq(syncQueue.id, req.params.id));
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Failed to delete sync queue item' });
    }
  });

  app.post('/api/sync-queue/:id/retry', async (req, res) => {
    try {
      await db.update(syncQueue).set({ status: 'pending' }).where(eq(syncQueue.id, req.params.id));
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Failed to retry sync queue item' });
    }
  });

  app.post('/api/sync-queue/process', async (_req, res) => {
    try {
      const { processSyncQueue } = await import('../syncEngine.js');
      await processSyncQueue();
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Failed to process sync queue' });
    }
  });

  // --- WAL-Safe Backup & Restore ---
  app.get('/api/backup', requirePermission('manage_settings'), async (_req, res) => {
    try {
      const { filename, path: backupPath } = await createSafeBackup();
      res.download(backupPath, filename);
    } catch (error) {
      console.error('Backup generation failed:', error);
      res.status(500).json({ error: 'Failed to generate backup' });
    }
  });

  app.get('/api/backup/list', requirePermission('manage_settings'), async (_req, res) => {
    try {
      const backupsDir = path.join(path.dirname(getDbPath()), 'backups');
      if (!fs.existsSync(backupsDir)) return res.json([]);
      const files = fs
        .readdirSync(backupsDir)
        .filter((f) => f.endsWith('.db'))
        .map((f) => {
          const stat = fs.statSync(path.join(backupsDir, f));
          return { filename: f, size: stat.size, createdAt: stat.mtime.toISOString() };
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json(files);
    } catch {
      res.status(500).json({ error: 'Failed to list backups' });
    }
  });

  app.post('/api/backup/verify', requirePermission('manage_settings'), async (req, res) => {
    try {
      const { filename } = req.body || {};
      const backupsDir = path.join(path.dirname(getDbPath()), 'backups');
      const targetPath = path.join(backupsDir, path.basename(String(filename || '')));
      if (!filename || !fs.existsSync(targetPath)) {
        return res.status(404).json({ error: 'Backup file not found' });
      }
      const testDb = new Database(targetPath, { readonly: true });
      const check = testDb.pragma('integrity_check', { simple: true });
      const orderCount = (testDb.prepare('SELECT COUNT(*) as count FROM "Order"').get() as any)?.count ?? 0;
      const productCount = (testDb.prepare('SELECT COUNT(*) as count FROM "Product"').get() as any)?.count ?? 0;
      testDb.close();
      res.json({ ok: check === 'ok', integrity: check, orderCount, productCount });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Verification failed' });
    }
  });

  app.post(
    '/api/settings/importSql',
    requirePermission('manage_settings'),
    upload.single('file'),
    async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        // Verify uploaded SQLite integrity BEFORE overwriting live database
        const uploadedDb = new Database(req.file.path, { readonly: true });
        const check = uploadedDb.pragma('integrity_check', { simple: true });
        uploadedDb.close();
        if (check !== 'ok') {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ error: 'Uploaded SQLite file failed integrity check' });
        }
        // Take safety backup before restoring
        await createSafeBackup();
        const dbPath = getDbPath();
        await sqliteInstance.backup(dbPath + '.tmp-restore');
        fs.copyFileSync(req.file.path, dbPath);
        fs.unlinkSync(req.file.path);
        res.json({ message: 'Data imported safely. Please restart the server.' });
      } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Failed to import data' });
      }
    }
  );

  app.post('/api/settings/clearData', requirePermission('manage_settings'), async (_req, res) => {
    try {
      await createSafeBackup();
      const dbPath = getDbPath();
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      res.json({ message: 'Backup saved and data cleared. Please restart the server.' });
    } catch {
      res.status(500).json({ error: 'Failed to clear data' });
    }
  });

  return { app, httpServer, io };
}
