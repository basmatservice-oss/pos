import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  sqliteInstance,
  getDbPath,
  closeDatabaseConnection,
  reopenDatabaseConnection,
} from '../drizzle/db.js';
import { ensureSchemaUpgrades } from '../migrate.js';
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
  inventoryAlerts,
  inventoryMovements,
  syncQueue,
  serviceRecipes,
  exchangeRateHistory,
  fiscalPeriods,
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
import { ensureChartOfAccountsAsync, postJournalEntry, recordInventoryMovement } from './accounting.js';
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

export function isAllowedCorsOrigin(origin?: string | null): boolean {
  if (!origin) return true; // Electron, mobile native, curl, same-origin
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (host.endsWith('.run.app')) return true;
    if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) return true;
    const extra = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (extra.includes(origin) || extra.includes(host)) return true;
    return false;
  } catch {
    return false;
  }
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
  'baseCurrency',
  'currencyDecimals',
  'quantityDecimals',
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
  const now = new Date().toISOString();
  if (admins.length === 0) {
    await db.insert(employees).values({
      name: 'المدير العام',
      username: 'admin',
      password: hashSecret('admin'),
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
    return;
  }

  // Upgrade only the untouched bootstrap account from older installations.
  // Never overwrite credentials after the administrator has changed them.
  const admin = admins[0];
  if (admin.mustChangePassword && verifySecret('123456', admin.password)) {
    await db.update(employees)
      .set({ password: hashSecret('admin'), mustChangePassword: 1, updatedAt: now, isSynced: 0 })
      .where(eq(employees.id, admin.id));
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
      origin: (origin, callback) => {
        if (isAllowedCorsOrigin(origin)) return callback(null, true);
        callback(new Error('CORS origin not allowed'));
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      credentials: true,
    },
  });

  const connectedTerminals = new Map<
    string,
    { socketId: string; ip: string; deviceName: string; userName?: string; connectedAt: string }
  >();

  io.on('connection', (socket) => {
    const ip =
      (socket.handshake.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      socket.handshake.address ||
      'unknown';
    connectedTerminals.set(socket.id, {
      socketId: socket.id,
      ip,
      deviceName: (socket.handshake.query?.deviceName as string) || 'Terminal',
      userName: (socket.handshake.query?.userName as string) || undefined,
      connectedAt: new Date().toISOString(),
    });

    socket.on('register-terminal', (info: any) => {
      const existing = connectedTerminals.get(socket.id);
      if (existing) {
        connectedTerminals.set(socket.id, {
          ...existing,
          deviceName: info?.deviceName || existing.deviceName,
          userName: info?.userName || existing.userName,
        });
      }
    });

    socket.on('disconnect', () => {
      connectedTerminals.delete(socket.id);
    });
  });

  app.set('io', io);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (isAllowedCorsOrigin(origin)) return callback(null, true);
        callback(new Error('CORS origin not allowed'));
      },
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
        if (tbl === 'products' || tbl === 'serviceRecipes') requireAny(['add_product', 'edit_product']);
        else if (tbl === 'categories') requireOne('manage_categories');
        else if (tbl === 'customers') requireAny(['add_customer', 'edit_customer']);
        else if (tbl === 'suppliers') requireAny(['add_supplier', 'edit_supplier']);
        else if (tbl === 'employees') requireAny(['add_employee', 'edit_employee']);
        else if (tbl === 'expenses') requireAny(['add_expense', 'edit_expense']);
        else if (tbl === 'shifts') requireAny(['manage_shifts', 'view_pos', 'view_mobile_sales']);
        else if (tbl === 'branches') requireOne('manage_branches');
        else if (tbl === 'offers') requireOne('manage_offers');
        else if (tbl === 'attendance') requireOne('manage_attendance');
        else if (tbl === 'settings' || tbl === 'exchangeRateHistory' || tbl === 'fiscalPeriods') requireOne('manage_settings');
        else if (tbl === 'stocktakingSessions' || tbl === 'stocktakingEntries') requireOne('manage_stocktaking');
        else if (tbl === 'inventoryBatches') requireOne('edit_product');
        break;
      }
      case 'entity_delete': {
        const tbl = payload?.table;
        if (tbl === 'products' || tbl === 'serviceRecipes') requireOne('delete_product');
        else if (tbl === 'categories') requireOne('manage_categories');
        else if (tbl === 'customers') requireOne('delete_customer');
        else if (tbl === 'suppliers') requireOne('delete_supplier');
        else if (tbl === 'employees') requireOne('delete_employee');
        else if (tbl === 'expenses') requireOne('delete_expense');
        else if (tbl === 'branches') requireOne('manage_branches');
        else if (tbl === 'offers') requireOne('manage_offers');
        else if (tbl === 'attendance') requireOne('manage_attendance');
        else if (tbl === 'exchangeRateHistory' || tbl === 'fiscalPeriods') requireOne('manage_settings');
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
        userRole: req.authUser?.role,
        branchId: req.authUser?.branchId ?? undefined,
      });

      io.emit('operation:applied', {
        operationId: outcome.operationId,
        type,
        duplicate: outcome.duplicate,
      });

      res.status(outcome.duplicate ? 200 : 201).json(outcome);
    } catch (error) {
      if (error instanceof OperationError || typeof (error as any)?.statusCode === 'number') {
        return res.status((error as any).statusCode).json({ error: (error as Error).message });
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
          userRole: req.authUser?.role,
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
          statusCode:
            error instanceof OperationError || typeof (error as any)?.statusCode === 'number'
              ? (error as any).statusCode
              : 500,
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
          userRole: req.authUser?.role,
        }
      );
      res.status(201).json(outcome.result);
    } catch (error) {
      if (error instanceof OperationError || typeof (error as any)?.statusCode === 'number') {
        return res.status((error as any).statusCode).json({ error: (error as Error).message });
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

  app.post('/api/products', requirePermission('add_product'), async (req: AuthenticatedRequest, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return res.status(400).json({ error: 'Product name is required' });
      const data: Record<string, any> = {};
      const allowedFields = [
        'barcode', 'categoryId', 'costPrice', 'sellingPrice', 'costInUSD', 'priceInUSD',
        'stockQuantity', 'minStockLevel', 'unit', 'conversionFactor', 'itemType',
        'allowFractions', 'unitsJson', 'baseUnitCode', 'quantityPrecision', 'isActive',
        'vatRate', 'imageUrl', 'branchId', 'expiryDate', 'batchNumber',
      ];
      for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(body, field)) data[field] = body[field];
      }
      data.name = name;
      const numericFields = ['costPrice', 'sellingPrice', 'costInUSD', 'priceInUSD', 'stockQuantity',
        'minStockLevel', 'conversionFactor', 'quantityPrecision', 'vatRate'];
      for (const field of numericFields) {
        if (data[field] !== undefined && (!Number.isFinite(Number(data[field])) || Number(data[field]) < 0)) {
          return res.status(400).json({ error: `Invalid product field: ${field}` });
        }
        if (data[field] !== undefined) data[field] = Number(data[field]);
      }
      if (data.conversionFactor !== undefined && Number(data.conversionFactor) <= 0) {
        return res.status(400).json({ error: 'Product conversion factor must be greater than zero' });
      }
      if (data.quantityPrecision !== undefined && !Number.isSafeInteger(Number(data.quantityPrecision))) {
        return res.status(400).json({ error: 'Product quantity precision must be an integer' });
      }
      if (Number(data.stockQuantity || 0) > 0 && String(data.itemType || 'stock') !== 'stock') {
        return res.status(400).json({ error: 'Opening stock is only supported for stock-tracked products' });
      }
      if (data.categoryId !== undefined && data.categoryId !== null) data.categoryId = Number(data.categoryId);
      if (data.branchId !== undefined && data.branchId !== null) data.branchId = Number(data.branchId);
      if (typeof data.allowFractions === 'boolean') data.allowFractions = data.allowFractions ? 1 : 0;
      if (typeof data.isActive === 'boolean') data.isActive = data.isActive ? 1 : 0;
      const requestedId = Number(body.id);
      const now = new Date().toISOString();
      const product = db.transaction((tx) => {
        const created = tx.insert(products).values({
          ...(Number.isSafeInteger(requestedId) && requestedId > 0 ? { id: requestedId } : {}),
          ...data,
          name,
          stockQuantity: Number(data.stockQuantity || 0),
          costPrice: Number(data.costPrice || 0),
          isSynced: 0,
          createdAt: now,
          updatedAt: now,
        }).returning().get();

        if (Number(created.stockQuantity || 0) > 0) {
          if (String(created.itemType || 'stock') !== 'stock') {
            throw new Error('Opening stock is only supported for stock-tracked products');
          }
          const openingQuantity = Number(created.stockQuantity);
          const openingUnitCost = Number(created.costPrice || 0);
          tx.insert(inventoryBatches).values({
            id: crypto.randomUUID(),
            productId: created.id,
            purchaseId: null,
            quantity: openingQuantity,
            remainingQuantity: openingQuantity,
            costPrice: openingUnitCost,
            purchaseDate: now,
            branchId: created.branchId || null,
            isSynced: 0,
            createdAt: now,
            updatedAt: now,
          }).run();
          const openingTotalCost = Math.round(openingQuantity * openingUnitCost * 100) / 100;
          recordInventoryMovement(tx, {
            movementKey: `opening:${created.id}`,
            productId: created.id,
            movementType: 'opening_balance',
            sourceType: 'product',
            sourceId: String(created.id),
            quantityDeltaBase: openingQuantity,
            baseUnitCode: created.baseUnitCode || created.unit || 'piece',
            unitCost: openingUnitCost,
            totalCost: openingTotalCost,
            branchId: created.branchId || null,
            reason: 'رصيد افتتاحي للصنف',
            createdBy: req.authUser?.name || 'System',
            createdAt: now,
          });
          if (openingTotalCost > 0) {
            postJournalEntry(tx, {
              date: now,
              referenceId: `opening:${created.id}`,
              referenceType: 'opening',
              description: `رصيد افتتاحي للمخزون: ${created.name}`,
              lines: [
                { accountCode: '1200', debit: openingTotalCost, credit: 0 },
                { accountCode: '3100', debit: 0, credit: openingTotalCost },
              ],
              createdBy: req.authUser?.name || 'System',
              branchId: created.branchId || undefined,
            });
          }
        }
        return created;
      });
      res.status(201).json(product);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to create product' });
    }
  });

  app.put('/api/products/:id', requirePermission('edit_product'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid product id' });
      // Generic product edits are metadata-only. Inventory quantity and valuation
      // may only change through purchase, sale, return, stocktake or adjustment operations.
      const allowedFields = [
        'name', 'barcode', 'categoryId', 'sellingPrice', 'vatRate', 'minStockLevel',
        'unit', 'baseUnitCode', 'itemType', 'allowFractions', 'unitsJson',
        'quantityPrecision', 'isActive', 'imageUrl', 'branchId', 'expiryDate', 'batchNumber',
        'priceInUSD',
      ];
      const data: Record<string, any> = {};
      for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) data[field] = req.body[field];
      }
      if (typeof data.allowFractions === 'boolean') data.allowFractions = data.allowFractions ? 1 : 0;
      if (typeof data.isActive === 'boolean') data.isActive = data.isActive ? 1 : 0;
      for (const field of ['sellingPrice', 'vatRate', 'minStockLevel', 'quantityPrecision', 'priceInUSD']) {
        if (data[field] !== undefined && (!Number.isFinite(Number(data[field])) || Number(data[field]) < 0)) {
          return res.status(400).json({ error: `Invalid product metadata field: ${field}` });
        }
      }
      if (!Object.keys(data).length) return res.status(400).json({ error: 'No editable product metadata was supplied' });
      const [product] = await db
        .update(products)
        .set({ ...data, isSynced: 0, updatedAt: new Date().toISOString() })
        .where(eq(products.id, id))
        .returning();
      if (!product) return res.status(404).json({ error: 'Product not found' });
      res.json(product);
    } catch {
      res.status(500).json({ error: 'Failed to update product' });
    }
  });

  app.delete('/api/products/:id', requirePermission('delete_product'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid product id' });
      const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
      if (!product) return res.status(404).json({ error: 'Product not found' });
      const [batches, soldItems, purchasedItems, movements] = await Promise.all([
        db.select({ id: inventoryBatches.id }).from(inventoryBatches).where(eq(inventoryBatches.productId, id)).limit(1),
        db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.productId, id)).limit(1),
        db.select({ id: purchaseItems.id }).from(purchaseItems).where(eq(purchaseItems.productId, id)).limit(1),
        db.select({ id: inventoryMovements.id }).from(inventoryMovements).where(eq(inventoryMovements.productId, id)).limit(1),
      ]);
      if (Number(product.stockQuantity || 0) > 0 || batches.length || soldItems.length || purchasedItems.length || movements.length) {
        return res.status(409).json({ error: 'لا يمكن حذف صنف له رصيد أو دفعات أو حركات مخزون أو مستندات بيع وشراء؛ عطّله بدلًا من حذفه' });
      }
      await db.delete(products).where(eq(products.id, id));
      res.json({ message: 'Product deleted' });
    } catch {
      res.status(500).json({ error: 'Failed to delete product' });
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
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return res.status(400).json({ error: 'Customer name is required' });
      const now = new Date().toISOString();
      const requestedId = Number(body.id);
      const [customer] = await db.insert(customers).values({
        ...(Number.isSafeInteger(requestedId) && requestedId > 0 ? { id: requestedId } : {}),
        name,
        ...(typeof body.phone === 'string' ? { phone: body.phone } : {}),
        ...(typeof body.email === 'string' ? { email: body.email } : {}),
        ...(Number.isSafeInteger(Number(body.branchId)) && Number(body.branchId) > 0 ? { branchId: Number(body.branchId) } : {}),
        // Balances and loyalty points are ledger-controlled, never client-supplied.
        balance: 0,
        points: 0,
        isSynced: 0,
        createdAt: now,
        updatedAt: now,
      }).returning();
      res.status(201).json(customer);
    } catch {
      res.status(500).json({ error: 'Failed to create customer' });
    }
  });

  app.put('/api/customers/:id', requirePermission('edit_customer'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid customer id' });
      // Customer balances are ledger-controlled and must never be overwritten by CRUD.
      const allowedFields = ['name', 'phone', 'email', 'branchId'];
      const data: Record<string, any> = {};
      for (const field of allowedFields) if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) data[field] = req.body[field];
      if (!Object.keys(data).length) return res.status(400).json({ error: 'No editable customer metadata was supplied' });
      const [customer] = await db.update(customers)
        .set({ ...data, isSynced: 0, updatedAt: new Date().toISOString() })
        .where(eq(customers.id, id)).returning();
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      res.json(customer);
    } catch {
      res.status(500).json({ error: 'Failed to update customer' });
    }
  });

  app.delete('/api/customers/:id', requirePermission('delete_customer'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid customer id' });
      const [customer] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      const [sales, payments, returnDocs] = await Promise.all([
        db.select({ id: orders.id }).from(orders).where(eq(orders.customerId, id)).limit(1),
        db.select({ id: customerPayments.id }).from(customerPayments).where(eq(customerPayments.customerId, id)).limit(1),
        db.select({ id: returns.id }).from(returns).where(eq(returns.customerId, id)).limit(1),
      ]);
      if (Math.abs(Number(customer.balance || 0)) > 0.005 || sales.length || payments.length || returnDocs.length) {
        return res.status(409).json({ error: 'لا يمكن حذف عميل له رصيد أو مستندات بيع أو مرتجعات أو دفعات؛ عطّل التعامل معه بدلًا من حذف سجله' });
      }
      await db.delete(customers).where(eq(customers.id, id));
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
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return res.status(400).json({ error: 'Supplier name is required' });
      const now = new Date().toISOString();
      const requestedId = Number(body.id);
      const [supplier] = await db.insert(suppliers).values({
        ...(Number.isSafeInteger(requestedId) && requestedId > 0 ? { id: requestedId } : {}),
        name,
        ...(typeof body.phone === 'string' ? { phone: body.phone } : {}),
        ...(typeof body.email === 'string' ? { email: body.email } : {}),
        ...(typeof body.address === 'string' ? { address: body.address } : {}),
        // Supplier balances are purchase/payment-ledger controlled.
        balance: 0,
        isSynced: 0,
        createdAt: now,
        updatedAt: now,
      }).returning();
      res.status(201).json(supplier);
    } catch {
      res.status(500).json({ error: 'Failed to create supplier' });
    }
  });

  app.put('/api/suppliers/:id', requirePermission('edit_supplier'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid supplier id' });
      // Supplier balances are purchase/payment-ledger controlled.
      const allowedFields = ['name', 'phone', 'email', 'address'];
      const data: Record<string, any> = {};
      for (const field of allowedFields) if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) data[field] = req.body[field];
      if (!Object.keys(data).length) return res.status(400).json({ error: 'No editable supplier metadata was supplied' });
      const [supplier] = await db.update(suppliers)
        .set({ ...data, isSynced: 0, updatedAt: new Date().toISOString() })
        .where(eq(suppliers.id, id)).returning();
      if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
      res.json(supplier);
    } catch {
      res.status(500).json({ error: 'Failed to update supplier' });
    }
  });

  app.delete('/api/suppliers/:id', requirePermission('delete_supplier'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid supplier id' });
      const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
      if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
      const [purchaseDocs, returnsDocs, payments] = await Promise.all([
        db.select({ id: purchases.id }).from(purchases).where(eq(purchases.supplierId, id)).limit(1),
        db.select({ id: purchaseReturns.id }).from(purchaseReturns).where(eq(purchaseReturns.supplierId, id)).limit(1),
        db.select({ id: supplierPayments.id }).from(supplierPayments).where(eq(supplierPayments.supplierId, id)).limit(1),
      ]);
      if (Math.abs(Number(supplier.balance || 0)) > 0.005 || purchaseDocs.length || returnsDocs.length || payments.length) {
        return res.status(409).json({ error: 'لا يمكن حذف مورد له رصيد أو فواتير شراء أو مرتجعات أو دفعات؛ احتفظ بسجله التاريخي' });
      }
      await db.delete(suppliers).where(eq(suppliers.id, id));
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

  app.post('/api/orders', requireAnyPermission(['view_pos', 'view_mobile_sales']), (_req, res) => {
    return res.status(400).json({
      error: 'لا يمكن إنشاء الطلبات مباشرة خارج محرك العمليات؛ استخدم /api/operations/execute (sale) لضمان خصم المخزون والقيود المحاسبية',
    });
  });

  app.put('/api/orders/:id', requirePermission('void_items'), (_req, res) => {
    return res.status(400).json({
      error: 'لا يمكن تعديل حالة الفاتورة مباشرة؛ استخدم sale أو return أو order_void عبر محرك العمليات الذري',
    });
  });

  app.get('/api/orderItems', async (_req, res) => {
    try {
      res.json(await db.select().from(orderItems));
    } catch {
      res.status(500).json({ error: 'Failed to fetch order items' });
    }
  });

  app.post('/api/orderItems', requireAnyPermission(['view_pos', 'view_mobile_sales']), (_req, res) => {
    return res.status(400).json({
      error: 'لا يمكن تعديل أصناف الفاتورة مباشرة خارج محرك العمليات الذرية',
    });
  });

  app.delete('/api/orderItems/:id', requirePermission('void_items'), (_req, res) => {
    return res.status(400).json({
      error: 'لا يمكن حذف أصناف الفاتورة مباشرة؛ استخدم مرتجع المبيعات أو إلغاء الفاتورة',
    });
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
        userRole: req.authUser?.role,
      });
      res.status(201).json(outcome.result);
    } catch (error) {
      if (error instanceof OperationError || typeof (error as any)?.statusCode === 'number') {
        return res.status((error as any).statusCode).json({ error: (error as Error).message });
      }
      res.status(500).json({ error: 'Failed to process return' });
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

  app.post('/api/inventoryBatches', requirePermission('edit_product'), (_req, res) => {
    return res.status(400).json({
      error: 'لا يمكن إنشاء دفعات المخزون مباشرة؛ يجب ترحيلها عبر عملية شراء أو رصيد افتتاحي أو تسوية مخزون ذرية',
    });
  });

  app.put('/api/inventoryBatches/:id', requirePermission('edit_product'), (_req, res) => {
    return res.status(400).json({
      error: 'لا يمكن تعديل كمية أو تكلفة دفعة المخزون مباشرة؛ استخدم محرك عمليات المخزون',
    });
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

  // --- Inventory Movement Ledger & Reconciliation ---
  app.get('/api/inventoryMovements', async (req, res) => {
    try {
      const {
        productId,
        latest,
        offset: rawOffset,
        limit: rawLimit,
        branchId,
        sourceType,
        movementType,
        startDate,
        endDate,
      } = req.query;

      let rows = await db.select().from(inventoryMovements);

      if (productId !== undefined && productId !== '') {
        rows = rows.filter((r) => Number(r.productId) === Number(productId));
      }
      if (branchId !== undefined && branchId !== '' && branchId !== 'all') {
        rows = rows.filter((r) => Number(r.branchId) === Number(branchId));
      }
      if (sourceType && sourceType !== 'all') {
        rows = rows.filter((r) => r.sourceType === String(sourceType));
      }
      if (movementType && movementType !== 'all') {
        rows = rows.filter((r) => r.movementType === String(movementType));
      }
      if (startDate) {
        const startDay = String(startDate).slice(0, 10);
        rows = rows.filter((r) => String(r.createdAt || '').slice(0, 10) >= startDay);
      }
      if (endDate) {
        const endDay = String(endDate).slice(0, 10);
        rows = rows.filter((r) => String(r.createdAt || '').slice(0, 10) <= endDay);
      }

      const sortDesc = String(latest) === 'true' || String(latest) === '1';
      rows.sort((a, b) => {
        const cmp =
          String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
          String(a.id).localeCompare(String(b.id));
        return sortDesc ? -cmp : cmp;
      });

      const offset = Math.max(0, Number(rawOffset || 0));
      const limit = Math.min(2000, Math.max(1, Number(rawLimit || 500)));
      const items = rows.slice(offset, offset + limit);
      const nextOffset = offset + items.length < rows.length ? offset + items.length : null;

      res.json({ items, nextOffset, total: rows.length });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch inventory movements' });
    }
  });

  app.get('/api/inventoryMovements/reconciliation', requirePermission('view_inventory'), async (_req, res) => {
    try {
      const roundQty = (n: number) => Math.round((Number(n) || 0) * 10000) / 10000;
      const allProducts = await db.select().from(products);
      const allBatches = await db.select().from(inventoryBatches);
      const allMovements = await db.select().from(inventoryMovements);

      const batchesByProduct = new Map<number, any[]>();
      for (const b of allBatches) {
        const arr = batchesByProduct.get(b.productId) || [];
        arr.push(b);
        batchesByProduct.set(b.productId, arr);
      }

      const movementsByProduct = new Map<number, any[]>();
      for (const m of allMovements) {
        const arr = movementsByProduct.get(m.productId) || [];
        arr.push(m);
        movementsByProduct.set(m.productId, arr);
      }

      let productsWithBatchMismatch = 0;
      let productsWithLedgerMismatch = 0;
      const items: any[] = [];

      for (const p of allProducts) {
        if (p.itemType === 'service') continue;
        const pBatches = batchesByProduct.get(p.id) || [];
        const pMovements = movementsByProduct.get(p.id) || [];

        const stockQuantity = roundQty(Number(p.stockQuantity || 0));
        const batchQuantity = roundQty(
          pBatches.reduce((s, b) => s + Number(b.remainingQuantity || 0), 0)
        );
        const ledgerQuantity = roundQty(
          pMovements.reduce((s, m) => s + Number(m.quantityDeltaBase || 0), 0)
        );

        const stockVsBatchDifference = roundQty(stockQuantity - batchQuantity);
        const batchVsLedgerDifference = roundQty(batchQuantity - ledgerQuantity);

        const hasBatchDiff = Math.abs(stockVsBatchDifference) > 1e-6;
        const hasLedgerDiff = Math.abs(batchVsLedgerDifference) > 1e-6;

        if (hasBatchDiff) productsWithBatchMismatch++;
        if (hasLedgerDiff) productsWithLedgerMismatch++;

        if (hasBatchDiff || hasLedgerDiff) {
          items.push({
            productId: p.id,
            productName: p.name,
            baseUnitCode: p.baseUnitCode || p.unit || 'piece',
            stockQuantity,
            batchQuantity,
            ledgerQuantity,
            stockVsBatchDifference,
            batchVsLedgerDifference,
            batchCount: pBatches.length,
            movementCount: pMovements.length,
          });
        }
      }

      res.json({
        summary: {
          productsChecked: allProducts.filter((p) => p.itemType !== 'service').length,
          productsWithBatchMismatch,
          productsWithLedgerMismatch,
        },
        items,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to reconcile inventory movements' });
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

  app.delete('/api/settings/:key', requirePermission('manage_settings'), async (req, res) => {
    try {
      const key = req.params.key;
      if (SENSITIVE_SETTING_KEYS.has(key)) {
        return res.status(403).json({ error: 'Forbidden setting key' });
      }
      const deleted = await db.delete(settings).where(eq(settings.key, key)).returning({ key: settings.key });
      res.json({ deleted: deleted.length, key });
    } catch {
      res.status(500).json({ error: 'Failed to delete setting' });
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
      if (error instanceof OperationError || typeof (error as any)?.statusCode === 'number') {
        return res.status((error as any).statusCode).json({ error: (error as Error).message });
      }
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

  app.post('/api/purchaseItems', requirePermission('add_purchase'), (_req, res) => {
    return res.status(400).json({
      error: 'لا يمكن إنشاء أصناف شراء منفصلة؛ استخدم عملية purchase أو purchase_update لضمان تحديث المخزون والأستاذ معًا',
    });
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
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const openingCash = Number(body.openingCash || 0);
      if (!Number.isFinite(openingCash) || openingCash < 0) {
        return res.status(400).json({ error: 'Invalid opening cash amount' });
      }
      const now = new Date().toISOString();
      const startTime = body.startTime ? new Date(body.startTime) : new Date(now);
      if (!Number.isFinite(startTime.getTime())) return res.status(400).json({ error: 'Invalid shift start time' });
      const [shift] = await db.insert(shifts).values({
        id: body.id ? String(body.id) : crypto.randomUUID(),
        startTime: startTime.toISOString(),
        endTime: null,
        openingCash,
        expectedCash: openingCash,
        actualCash: null,
        branchId: Number.isSafeInteger(Number(body.branchId)) && Number(body.branchId) > 0 ? Number(body.branchId) : null,
        status: 'open',
        isSynced: 0,
        createdAt: now,
        updatedAt: now,
      }).returning();
      res.status(201).json(shift);
    } catch {
      res.status(500).json({ error: 'Failed to create shift' });
    }
  });

  app.put('/api/shifts/:id', requireAnyPermission(['manage_shifts', 'view_pos', 'view_mobile_sales']), (_req, res) => {
    return res.status(400).json({
      error: 'لا يمكن تعديل حالة الوردية أو النقدية مباشرة؛ استخدم shift_close أو shift_movement عبر محرك العمليات',
    });
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
    } catch (error) {
      if (error instanceof OperationError || typeof (error as any)?.statusCode === 'number') {
        return res.status((error as any).statusCode).json({ error: (error as Error).message });
      }
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
    } catch (error) {
      if (error instanceof OperationError || typeof (error as any)?.statusCode === 'number') {
        return res.status((error as any).statusCode).json({ error: (error as Error).message });
      }
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

  app.post('/api/loyalty-transactions', requireAnyPermission(['view_pos', 'view_mobile_sales', 'edit_customer']), (_req, res) => {
    return res.status(400).json({
      error: 'لا يمكن إنشاء حركة نقاط الولاء مباشرة؛ تُرحّل النقاط مع عملية البيع أو الإلغاء الذرية',
    });
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
    } catch (error) {
      if (error instanceof OperationError || typeof (error as any)?.statusCode === 'number') {
        return res.status((error as any).statusCode).json({ error: (error as Error).message });
      }
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
      const data = { ...req.body };
      if (typeof data.isActive === 'boolean') {
        if (!data.status) data.status = data.isActive ? 'active' : 'inactive';
        data.isActive = data.isActive ? 1 : 0;
      }
      const [record] = await db
        .insert(branches)
        .values({ ...data, isSynced: 0, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: branches.id,
          set: { ...data, isSynced: 0, updatedAt: now },
        })
        .returning();
      res.status(201).json(record);
    } catch {
      res.status(500).json({ error: 'Failed to create branch' });
    }
  });

  app.put('/api/branches/:id', requirePermission('manage_branches'), async (req, res) => {
    try {
      const data = { ...req.body };
      if (typeof data.isActive === 'boolean') {
        if (!data.status) data.status = data.isActive ? 'active' : 'inactive';
        data.isActive = data.isActive ? 1 : 0;
      }
      const [record] = await db
        .update(branches)
        .set({ ...data, isSynced: 0, updatedAt: new Date().toISOString() })
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
      const data = { ...req.body };
      if (Array.isArray(data.applicableProducts)) {
        data.applicableProducts = JSON.stringify(data.applicableProducts);
      }
      if (typeof data.isActive === 'boolean') {
        if (!data.status) data.status = data.isActive ? 'active' : 'inactive';
        data.isActive = data.isActive ? 1 : 0;
      }
      const [record] = await db
        .insert(offers)
        .values({ ...data, isSynced: 0, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: offers.id,
          set: { ...data, isSynced: 0, updatedAt: now },
        })
        .returning();
      res.status(201).json(record);
    } catch {
      res.status(500).json({ error: 'Failed to create offer' });
    }
  });

  app.put('/api/offers/:id', requirePermission('manage_offers'), async (req, res) => {
    try {
      const data = { ...req.body };
      if (Array.isArray(data.applicableProducts)) {
        data.applicableProducts = JSON.stringify(data.applicableProducts);
      }
      if (typeof data.isActive === 'boolean') {
        if (!data.status) data.status = data.isActive ? 'active' : 'inactive';
        data.isActive = data.isActive ? 1 : 0;
      }
      const [record] = await db
        .update(offers)
        .set({ ...data, isSynced: 0, updatedAt: new Date().toISOString() })
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
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const id = body.id ? String(body.id) : crypto.randomUUID();
      const [session] = await db.insert(stocktakingSessions).values({
        id,
        status: 'open',
        createdBy: (req as AuthenticatedRequest).authUser?.name || (typeof body.createdBy === 'string' ? body.createdBy : 'System'),
        branchId: Number.isSafeInteger(Number(body.branchId)) && Number(body.branchId) > 0 ? Number(body.branchId) : null,
        isSynced: 0,
        createdAt: new Date().toISOString(),
      }).returning();
      res.status(201).json(session);
    } catch {
      res.status(500).json({ error: 'Failed to create stocktaking session' });
    }
  });

  app.put('/api/stocktakingSessions/:id', requirePermission('manage_stocktaking'), async (req, res) => {
    try {
      const data: Record<string, any> = {};
      if (typeof req.body?.createdBy === 'string') data.createdBy = req.body.createdBy;
      if (Number.isSafeInteger(Number(req.body?.branchId)) && Number(req.body.branchId) > 0) data.branchId = Number(req.body.branchId);
      if (!Object.keys(data).length) return res.status(400).json({ error: 'Only stocktake session metadata can be edited directly' });
      const [session] = await db.update(stocktakingSessions)
        .set({ ...data, isSynced: 0 })
        .where(eq(stocktakingSessions.id, req.params.id))
        .returning();
      if (!session) return res.status(404).json({ error: 'Stocktaking session not found' });
      res.json(session);
    } catch {
      res.status(500).json({ error: 'Failed to update stocktaking session' });
    }
  });

  app.delete('/api/stocktakingSessions/:id', requirePermission('manage_stocktaking'), async (req, res) => {
    try {
      const [session] = await db.select().from(stocktakingSessions)
        .where(eq(stocktakingSessions.id, req.params.id)).limit(1);
      if (!session) return res.status(404).json({ error: 'Stocktaking session not found' });
      if (session.status === 'approved') {
        return res.status(409).json({ error: 'لا يمكن حذف جلسة جرد معتمدة؛ فهي جزء من سجل تسويات المخزون' });
      }
      db.transaction((tx) => {
        tx.delete(stocktakingEntries).where(eq(stocktakingEntries.sessionId, req.params.id)).run();
        tx.delete(stocktakingSessions).where(eq(stocktakingSessions.id, req.params.id)).run();
      });
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
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const sessionId = String(body.sessionId || '');
      const productId = Number(body.productId);
      const actualQuantity = Number(body.actualQuantity);
      if (!sessionId || !Number.isSafeInteger(productId) || productId <= 0 ||
          !Number.isFinite(actualQuantity) || actualQuantity < 0) {
        return res.status(400).json({ error: 'Invalid stocktake entry data' });
      }
      const [session, product, existingEntries] = await Promise.all([
        db.select().from(stocktakingSessions).where(eq(stocktakingSessions.id, sessionId)).limit(1),
        db.select().from(products).where(eq(products.id, productId)).limit(1),
        db.select().from(stocktakingEntries).where(eq(stocktakingEntries.sessionId, sessionId)),
      ]);
      if (!session[0] || session[0].status !== 'open') return res.status(409).json({ error: 'Stocktaking session is not open' });
      if (!product[0]) return res.status(404).json({ error: 'Product not found' });
      if (existingEntries.some((entry: any) => Number(entry.productId) === productId)) {
        return res.status(409).json({ error: 'A product can appear only once in a stocktaking session' });
      }
      const [entry] = await db.insert(stocktakingEntries).values({
        id: body.id ? String(body.id) : crypto.randomUUID(),
        sessionId,
        productId,
        productName: product[0].name,
        barcode: product[0].barcode || null,
        systemQuantity: Number(product[0].stockQuantity || 0),
        actualQuantity,
        scannedBy: (req as AuthenticatedRequest).authUser?.name || (typeof body.scannedBy === 'string' ? body.scannedBy : null),
        isSynced: 0,
        scannedAt: new Date().toISOString(),
      }).returning();
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

  app.post('/api/auditLogs', async (req: AuthenticatedRequest, res) => {
    try {
      const [log] = await db
        .insert(auditLogs)
        .values({
          ...req.body,
          id: req.body.id ? String(req.body.id) : crypto.randomUUID(),
          userName: req.authUser?.name || req.body.userName || 'System',
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

  // --- Unit catalogs ---
  app.get('/api/unitDefinitions', async (_req, res) => {
    try {
      res.json(await db.select().from(unitDefinitions));
    } catch {
      res.status(500).json({ error: 'Failed to fetch unit definitions' });
    }
  });

  app.get('/api/productUnits', async (_req, res) => {
    try {
      res.json(await db.select().from(productUnits));
    } catch {
      res.status(500).json({ error: 'Failed to fetch product units' });
    }
  });

  // --- Service Recipes, Exchange Rate History & Fiscal Periods ---
  app.get('/api/serviceRecipes', async (_req, res) => {
    try {
      res.json(await db.select().from(serviceRecipes));
    } catch {
      res.status(500).json({ error: 'Failed to fetch service recipes' });
    }
  });

  app.post('/api/serviceRecipes', requireAnyPermission(['add_product', 'edit_product']), async (req, res) => {
    try {
      const now = new Date().toISOString();
      const id = req.body.id ? String(req.body.id) : crypto.randomUUID();
      const [rec] = await db
        .insert(serviceRecipes)
        .values({
          id,
          parentProductId: Number(req.body.parentProductId),
          ingredientProductId: Number(req.body.ingredientProductId),
          ingredientName: req.body.ingredientName || null,
          quantity: Number(req.body.quantity || 0),
          unit: req.body.unit || 'piece',
          isSynced: 0,
          createdAt: req.body.createdAt || now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: serviceRecipes.id,
          set: {
            quantity: Number(req.body.quantity || 0),
            unit: req.body.unit || 'piece',
            ingredientName: req.body.ingredientName || null,
            isSynced: 0,
            updatedAt: now,
          },
        })
        .returning();
      res.status(201).json(rec);
    } catch {
      res.status(500).json({ error: 'Failed to save service recipe' });
    }
  });

  app.delete('/api/serviceRecipes/:id', requireAnyPermission(['edit_product', 'delete_product']), async (req, res) => {
    try {
      await db.delete(serviceRecipes).where(eq(serviceRecipes.id, String(req.params.id)));
      res.json({ deleted: req.params.id });
    } catch {
      res.status(500).json({ error: 'Failed to delete service recipe' });
    }
  });

  app.get('/api/exchangeRateHistory', async (_req, res) => {
    try {
      res.json(
        await db
          .select()
          .from(exchangeRateHistory)
          .orderBy(sql`${exchangeRateHistory.effectiveFrom} DESC`)
      );
    } catch {
      res.status(500).json({ error: 'Failed to fetch exchange rate history' });
    }
  });

  app.post('/api/exchangeRateHistory', requirePermission('manage_settings'), async (req: AuthenticatedRequest, res) => {
    try {
      const now = new Date().toISOString();
      const rateVal = Number(req.body.rate || 0);
      if (rateVal <= 0) return res.status(400).json({ error: 'سعر الصرف يجب أن يكون أكبر من صفر' });

      const currency = String(req.body.currency || 'USD').toUpperCase();
      const id = req.body.id ? String(req.body.id) : crypto.randomUUID();

      const [saved] = await db
        .insert(exchangeRateHistory)
        .values({
          id,
          currency,
          rate: rateVal,
          source: req.body.source || 'manual',
          effectiveFrom: req.body.effectiveFrom || now,
          notes: req.body.notes || null,
          createdBy: req.authUser?.name || 'System',
          isSynced: 0,
          createdAt: now,
        })
        .returning();

      // Also sync active exchangeRate setting if currency is USD
      if (currency === 'USD') {
        await db
          .insert(settings)
          .values({ key: 'exchangeRate', value: String(rateVal), isSynced: 0, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: String(rateVal), isSynced: 0, updatedAt: now },
          });
      }

      res.status(201).json(saved);
    } catch {
      res.status(500).json({ error: 'Failed to save exchange rate' });
    }
  });

  app.get('/api/fiscalPeriods', async (_req, res) => {
    try {
      res.json(await db.select().from(fiscalPeriods).orderBy(sql`${fiscalPeriods.startDate} DESC`));
    } catch {
      res.status(500).json({ error: 'Failed to fetch fiscal periods' });
    }
  });

  app.post('/api/fiscalPeriods', requirePermission('manage_settings'), async (req, res) => {
    try {
      const now = new Date().toISOString();
      const { id, name, startDate, endDate, notes } = req.body || {};
      if (!name || !startDate || !endDate) {
        return res.status(400).json({ error: 'اسم الفترة وتاريخ البداية والنهاية مطلوبة' });
      }
      const periodId = id ? String(id) : crypto.randomUUID();
      const [saved] = await db
        .insert(fiscalPeriods)
        .values({
          id: periodId,
          name: String(name),
          startDate: String(startDate).slice(0, 10),
          endDate: String(endDate).slice(0, 10),
          status: 'open',
          notes: notes || null,
          isSynced: 0,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: fiscalPeriods.id,
          set: {
            name: String(name),
            startDate: String(startDate).slice(0, 10),
            endDate: String(endDate).slice(0, 10),
            notes: notes || null,
            isSynced: 0,
            updatedAt: now,
          },
        })
        .returning();
      res.status(201).json(saved);
    } catch {
      res.status(500).json({ error: 'Failed to save fiscal period' });
    }
  });

  app.post('/api/fiscalPeriods/:id/close', requirePermission('manage_settings'), async (req: AuthenticatedRequest, res) => {
    try {
      const now = new Date().toISOString();
      const [updated] = await db
        .update(fiscalPeriods)
        .set({
          status: 'closed',
          closedAt: now,
          closedBy: req.authUser?.name || 'System',
          updatedAt: now,
          isSynced: 0,
        })
        .where(eq(fiscalPeriods.id, String(req.params.id)))
        .returning();
      if (!updated) return res.status(404).json({ error: 'Fiscal period not found' });
      res.json(updated);
    } catch {
      res.status(500).json({ error: 'Failed to close fiscal period' });
    }
  });

  app.post('/api/fiscalPeriods/:id/reopen', requirePermission('manage_settings'), async (req: AuthenticatedRequest, res) => {
    try {
      if (req.authUser?.role !== 'admin' && req.authUser?.role !== 'manager') {
        return res.status(403).json({ error: 'إعادة فتح الفترة المالية يتطلب صلاحية مدير أو مسؤول' });
      }
      const now = new Date().toISOString();
      const [updated] = await db
        .update(fiscalPeriods)
        .set({
          status: 'open',
          closedAt: null,
          closedBy: null,
          updatedAt: now,
          isSynced: 0,
        })
        .where(eq(fiscalPeriods.id, String(req.params.id)))
        .returning();
      if (!updated) return res.status(404).json({ error: 'Fiscal period not found' });
      res.json(updated);
    } catch {
      res.status(500).json({ error: 'Failed to reopen fiscal period' });
    }
  });

  app.get('/api/system/status', async (_req, res) => {
    try {
      const dbPath = getDbPath();
      const stats = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;
      const walMode = sqliteInstance.pragma('journal_mode', { simple: true });
      const integrity = sqliteInstance.pragma('quick_check', { simple: true });
      const [lastBackupRow] = await db.select().from(settings).where(eq(settings.key, 'lastAutoBackup'));

      res.json({
        ip: getLocalIPAddress(),
        port: Number(process.env.PORT) || 3000,
        uptimeSeconds: Math.floor(process.uptime()),
        dbPath,
        dbSizeBytes: stats ? stats.size : 0,
        walMode,
        integrity,
        lastAutoBackup: lastBackupRow?.value || null,
        connectedCount: connectedTerminals.size,
        connectedTerminals: Array.from(connectedTerminals.values()),
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Status check failed' });
    }
  });

  // --- Authoritative Financial Report (Income Statement, VAT Summary, Balance Sheet, Trial Balance, Aging & Cash Flow) ---
  app.get('/api/reports/financial', requirePermission('view_reports'), async (req, res) => {
    try {
      const { startDate, endDate, branchId } = req.query;
      const allOrders = await db.select().from(orders);
      const allOrderItems = await db.select().from(orderItems);
      const allReturns = await db.select().from(returns);
      const allPurchases = await db.select().from(purchases);
      const allPurchaseReturns = await db.select().from(purchaseReturns);
      const allExpenses = await db.select().from(expenses);
      const allPayrolls = await db.select().from(payrolls);
      const allBatches = await db.select().from(inventoryBatches);
      const allAccounts = await db.select().from(accounts);
      const allJournalEntries = await db.select().from(journalEntries);
      const allTransactions = await db.select().from(transactions);
      const allCustomers = await db.select().from(customers);
      const allSuppliers = await db.select().from(suppliers);

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

      const grossCogs = round(
        fItems.reduce((s, i) => s + Number(i.costPriceAtTimeOfSale || 0) * Number(i.quantity || 0), 0)
      );
      const returnedCogs = round(fReturns.reduce((s, r) => s + Number(r.totalCostReversed || 0), 0));

      const periodJournalIds = new Set(
        allJournalEntries
          .filter((je) => inRange(je.date) && matchBranch(je.branchId))
          .map((je) => je.id)
      );
      const cogsTxs = allTransactions.filter(
        (t) => t.accountId === '5100' && periodJournalIds.has(t.journalEntryId)
      );
      const netCogs =
        cogsTxs.length > 0
          ? round(cogsTxs.reduce((s, t) => s + Number(t.debit || 0) - Number(t.credit || 0), 0))
          : round(grossCogs - returnedCogs);

      const grossProfit = round(netSalesExclTax - netCogs);
      const operatingExpenses = round(fExpenses.reduce((s, e) => s + Number(e.amount || 0), 0));
      const payrollExpenses = round(fPayrolls.reduce((s, p) => s + Number(p.netSalary || 0), 0));
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

      // Debt Aging (Receivables from credit orders) & Payables Summary
      const nowMs = Date.now();
      const aging = { bucket0_30: 0, bucket31_60: 0, bucket61_90: 0, bucket90Plus: 0, totalReceivables: 0, totalPayables: 0 };
      aging.totalReceivables = round(allCustomers.reduce((s, c) => s + Math.max(0, Number(c.balance || 0)), 0));
      aging.totalPayables = round(allSuppliers.reduce((s, sup) => s + Math.max(0, Number(sup.balance || 0)), 0));

      for (const o of allOrders) {
        if (o.status === 'void' || o.paymentMethod !== 'credit' || !matchBranch(o.branchId)) continue;
        const unpaid = round(Number(o.netAmount || 0) - Number(o.paidAmount || 0) - Number(o.returnedAmount || 0));
        if (unpaid <= 0.01) continue;
        const ageDays = Math.floor((nowMs - new Date(o.createdAt).getTime()) / (1000 * 60 * 60 * 24));
        if (ageDays <= 30) aging.bucket0_30 = round(aging.bucket0_30 + unpaid);
        else if (ageDays <= 60) aging.bucket31_60 = round(aging.bucket31_60 + unpaid);
        else if (ageDays <= 90) aging.bucket61_90 = round(aging.bucket61_90 + unpaid);
        else aging.bucket90Plus = round(aging.bucket90Plus + unpaid);
      }

      // Cash Flow Summary (Cash 1010 + Bank 1020 movements during period)
      let cashInflows = 0;
      let cashOutflows = 0;
      for (const t of allTransactions) {
        if (t.accountId !== '1010' && t.accountId !== '1020') continue;
        const je = allJournalEntries.find((j) => j.id === t.journalEntryId);
        if (je && (!inRange(je.date) || !matchBranch(je.branchId))) continue;
        cashInflows = round(cashInflows + Number(t.debit || 0));
        cashOutflows = round(cashOutflows + Number(t.credit || 0));
      }

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
        aging,
        cashFlow: {
          inflows: cashInflows,
          outflows: cashOutflows,
          netCashFlow: round(cashInflows - cashOutflows),
        },
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

  // --- Sync Queue (Admin / Settings Protected) ---
  app.get('/api/sync-queue', requirePermission('manage_settings'), async (_req, res) => {
    try {
      res.json(
        await db.select().from(syncQueue).orderBy(sql`${syncQueue.createdAt} DESC`).limit(100)
      );
    } catch {
      res.status(500).json({ error: 'Failed to fetch sync queue' });
    }
  });

  app.delete('/api/sync-queue/:id', requirePermission('manage_settings'), async (req, res) => {
    try {
      await db.delete(syncQueue).where(eq(syncQueue.id, req.params.id));
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Failed to delete sync queue item' });
    }
  });

  app.post('/api/sync-queue/:id/retry', requirePermission('manage_settings'), async (req, res) => {
    try {
      await db.update(syncQueue).set({ status: 'pending' }).where(eq(syncQueue.id, req.params.id));
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Failed to retry sync queue item' });
    }
  });

  app.post('/api/sync-queue/process', requirePermission('manage_settings'), async (_req, res) => {
    try {
      const { processSyncQueue } = await import('../syncEngine.js');
      await processSyncQueue();
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Failed to process sync queue' });
    }
  });

  // --- WAL-Safe Backup & Restore (Windows File-Lock Safe) ---
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
        // Take safety backup before closing handle
        await createSafeBackup();
        const dbPath = getDbPath();

        // Close live connection & remove stale WAL/SHM files so Windows does not EBUSY
        closeDatabaseConnection();
        for (const ext of ['-wal', '-shm']) {
          if (fs.existsSync(dbPath + ext)) {
            fs.unlinkSync(dbPath + ext);
          }
        }

        fs.copyFileSync(req.file.path, dbPath);
        fs.unlinkSync(req.file.path);

        const { sqliteInstance: freshSqlite } = reopenDatabaseConnection();
        ensureSchemaUpgrades(freshSqlite);
        await seedDefaultUsersAndAccounts();

        res.json({ message: 'تم استعادة قاعدة البيانات بنجاح وتحديث الاتصال.' });
      } catch (error) {
        try {
          reopenDatabaseConnection();
        } catch {}
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to import data' });
      }
    }
  );

  app.post('/api/settings/clearData', requirePermission('manage_settings'), async (_req, res) => {
    try {
      await createSafeBackup();
      const dbPath = getDbPath();
      closeDatabaseConnection();

      for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (fs.existsSync(target)) {
          fs.unlinkSync(target);
        }
      }

      const { sqliteInstance: freshSqlite } = reopenDatabaseConnection();
      ensureSchemaUpgrades(freshSqlite);
      await seedDefaultUsersAndAccounts();

      res.json({ message: 'تم حفظ نسخة احتياطية وتصفير قاعدة البيانات بأمان.' });
    } catch (error) {
      try {
        reopenDatabaseConnection();
      } catch {}
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to clear data' });
    }
  });

  return { app, httpServer, io };
}
