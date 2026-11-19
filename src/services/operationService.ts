import {
  db,
  SyncOperation,
  ReturnRecord,
  ReturnItem,
  PurchaseReturn,
  PurchaseReturnItem,
} from '../db/db';
import { apiService, getAuthToken } from './apiService';
import { generateUUID } from '../utils/uuid';
import { useSyncStore } from '../store/syncStore';
import { roundQty } from '../utils/format';
import { consumeLocalInventoryFIFO, restoreLocalInventoryFIFO, recordLocalInventoryMovement } from './localInventoryEngine';
import { postLocalJournalEntry, reverseLocalJournalEntriesByReference, setLocalAccountingStandaloneMode } from './localAccountingEngine';
import { reconcileLocalOperationAfterAck } from './localOperationReconciliation';
import { enqueueNativePosOperation, acknowledgeNativePosOperation, markNativePosOperationError, markNativePosOperationConflict, isNativeAndroid } from '../native/posLocalDatabase';
import { flushNativeDatabaseMirrorWrites } from './nativeDatabaseMirror';
import { nativePosRepository, NATIVE_POS_ENTITIES } from '../native/nativePosRepository';

const DEVICE_ID_KEY = 'pos_device_id';
let currentDeviceRole: 'server' | 'client' | 'standalone' = 'server';

export function getDeviceId(): string {
  if (typeof window === 'undefined') return 'server';
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

async function getLocalSettingByKey(key: string): Promise<{ key: string; value: any } | undefined> {
  if (isNativeAndroid()) {
    return (await nativePosRepository.firstWhereEquals<{ key: string; value: any }>('settings', 'key', key)) ?? undefined;
  }
  return db.settings.where('key').equals(key).first();
}

async function getLocalRecord<T extends Record<string, any>>(entity: any, key: unknown): Promise<T | undefined> {
  if (isNativeAndroid()) return (await nativePosRepository.get<T>(entity, key)) ?? undefined;
  return (await (db as any)[entity].get(key)) ?? undefined;
}

async function getLocalRecordsByIndex<T extends Record<string, any>>(
  entity: any,
  indexName: string,
  value: string | number | boolean,
): Promise<T[]> {
  if (isNativeAndroid()) return nativePosRepository.whereEquals<T>(entity, indexName, value);
  return (await (db as any)[entity].where(indexName).equals(value).toArray()) as T[];
}

async function getLocalRecords<T extends Record<string, any>>(entity: any): Promise<T[]> {
  if (isNativeAndroid()) return nativePosRepository.getAll<T>(entity);
  return (await (db as any)[entity].toArray()) as T[];
}

async function getDeviceRole(): Promise<'server' | 'client' | 'standalone'> {
  try {
    const setting = await getLocalSettingByKey('deviceRole');
    currentDeviceRole = setting?.value === 'standalone' ? 'standalone' : setting?.value === 'client' ? 'client' : 'server';
    return currentDeviceRole;
  } catch (error) {
    if (isNativeAndroid()) throw error;
    currentDeviceRole = 'server';
    return currentDeviceRole;
  }
}

function roundMoney(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function shouldPostLocalAccounting(syncStatus: 'synced' | 'pending'): boolean {
  return syncStatus === 'pending' || currentDeviceRole === 'standalone';
}

function resolveLocalUnitFactor(product: any, item: any): number {
  if (Number(item?.conversionFactor) > 0 && item?.unit && item.unit !== 'piece') {
    return Number(item.conversionFactor);
  }
  const unitName = String(item?.unit || item?.selectedUnit || 'piece');
  if (product?.unitsJson) {
    try {
      const units = JSON.parse(product.unitsJson);
      if (Array.isArray(units)) {
        const matched = units.find((u: any) => u?.name === unitName);
        if (matched && Number(matched.conversionFactor) > 0) {
          return Number(matched.conversionFactor);
        }
      }
    } catch {}
  }
  if (unitName === 'box') {
    return Number(item?.conversionFactor || product?.conversionFactor || 1);
  }
  return Number(item?.conversionFactor || 1) || 1;
}

async function applySaleLocallyNative(payload: any, syncStatus: 'synced' | 'pending') {
  const { order, items = [], pointsEarned = 0, pointsRedeemed = 0, _serverItems } = payload;
  const now = order.createdAt || new Date().toISOString();
  const operationId = String(payload.operationId || order.operationId || order.id);
  const deviceId = String(payload.deviceId || 'local-device');
  const policyRow = await nativePosRepository.firstWhereEquals<any>('settings', 'key', 'offlineStockPolicy');
  const legacyPolicy = policyRow ? null : await nativePosRepository.firstWhereEquals<any>('settings', 'key', 'allowNegativeStock');
  const stockPolicy = policyRow?.value || (legacyPolicy?.value === 'false' || legacyPolicy?.value === false ? 'block' : 'allow_with_alert');
  const actorRole = String(payload.actor?.role || payload.userRole || payload.role || '').toLowerCase();
  const override = Boolean(payload.managerOverride || payload.allowNegativeOverride) && (actorRole === 'admin' || actorRole === 'manager');
  const allowNegative = !['block', 'manager_override'].includes(String(stockPolicy)) || override;
  const netAmount = roundMoney(Number(order.netAmount || 0));
  const totalAmount = roundMoney(Number(order.totalAmount || 0));
  const taxAmount = roundMoney(Number(order.taxAmount || 0));
  const paymentMethod = String(order.paymentMethod || 'cash');
  let paidAmount = netAmount, cashAmount = 0, cardAmount = 0;
  if (paymentMethod === 'mixed') {
    cashAmount = roundMoney(Number(order.cashAmount || 0)); cardAmount = roundMoney(Number(order.cardAmount || 0));
    if (cashAmount < 0 || cardAmount < 0 || Math.abs(roundMoney(cashAmount + cardAmount) - netAmount) > 0.02)
      throw new Error('قيمة الدفع المختلط (نقد + شبكة) يجب أن تساوي صافي الفاتورة');
  } else if (paymentMethod === 'cash') cashAmount = netAmount;
  else if (paymentMethod === 'card') cardAmount = netAmount;
  else if (paymentMethod === 'credit') paidAmount = 0;
  const normalizedOrder = { ...order, totalAmount, taxAmount, netAmount,
    discountAmount: roundMoney(Math.max(0, totalAmount + taxAmount - netAmount)), paidAmount, cashAmount, cardAmount,
    returnedAmount: 0, paymentMethod, status: order.status || 'completed', currency: order.currency || 'ر.س',
    exchangeRate: Number(order.exchangeRate || 1) };
  if (await nativePosRepository.get<any>('orders', order.id)) return;
  const productIds = [...new Set(items.filter((x: any) => Number(x.quantity || 0) > 0).map((x: any) => Number(x.productId)))];
  const [products, recipes, batches, movements, alerts, customers, accounts, journals] = await Promise.all([
    nativePosRepository.getMany<any>('products', productIds), nativePosRepository.getAll<any>('serviceRecipes'),
    nativePosRepository.getAll<any>('inventoryBatches'), nativePosRepository.getAll<any>('inventoryMovements'),
    nativePosRepository.getAll<any>('inventoryAlerts'), order.customerId ? nativePosRepository.get<any>('customers', order.customerId) : Promise.resolve(null),
    nativePosRepository.getAll<any>('accounts'), nativePosRepository.getAll<any>('journalEntries'),
  ]);
  const productMap = new Map<number, any>(products.map((x: any) => [Number(x.id), x]));
  const batchMap = new Map<string, any>(batches.map((x: any) => [String(x.id), x]));
  const changes = new Map<string, any>();
  const stage = (entity: string, record: any) => {
    const key = entity === 'accounts' ? record.code : record.id;
    changes.set(entity + ':' + JSON.stringify(key), { action: 'put', entity, record, syncState: syncStatus });
  };
  const valuationSetting = await nativePosRepository.firstWhereEquals<any>('settings', 'key', 'inventoryValuationMethod');
  const weightedAverage = valuationSetting?.value === 'weighted_average';
  const movementKeys = new Set(movements.map((x: any) => String(x.movementKey)));
  let totalCogs = 0;
  const consume = (productId: number, qtyInput: number, suffix: string, movementType: string, reason?: string) => {
    const product: any = productMap.get(Number(productId));
    if (!product) throw new Error('الصنف غير موجود (ID: ' + String(productId) + ')');
    const qtyNeeded = roundQty(qtyInput);
    if (qtyNeeded <= 0) return { totalCost: 0, allocations: [] as any[] };
    const previousQty = roundQty(Number(product.stockQuantity || 0));
    const nextQty = roundQty(previousQty - qtyNeeded);
    if (!allowNegative && nextQty < -1e-6) throw new Error('الكمية المتاحة لا تكفي للمنتج ' + String(product.name));
    const activeBatches = [...batchMap.values()].filter((x: any) => Number(x.productId) === Number(productId) && Number(x.remainingQuantity || 0) > 0)
      .sort((a: any, b: any) => String(a.purchaseDate || '').localeCompare(String(b.purchaseDate || '')) ||
        String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    let weightedCost = Number(product.costPrice || 0);
    if (weightedAverage && activeBatches.length) {
      const activeQty = activeBatches.reduce((sum: number, x: any) => sum + Number(x.remainingQuantity || 0), 0);
      const activeValue = activeBatches.reduce((sum: number, x: any) => sum + Number(x.remainingQuantity || 0) * Number(x.costPrice || 0), 0);
      if (activeQty > 0) weightedCost = activeValue / activeQty;
    }
    let remaining = qtyNeeded, totalCost = 0;
    const allocations: any[] = [];
    for (const batch of activeBatches) {
      if (remaining <= 1e-6) break;
      const available = Number(batch.remainingQuantity || 0), take = roundQty(Math.min(remaining, available));
      if (take <= 0) continue;
      const costPrice = weightedAverage ? weightedCost : Number(batch.costPrice || 0);
      const updated = { ...batch, remainingQuantity: roundQty(Math.max(0, available - take)), updatedAt: now, syncStatus };
      batchMap.set(String(batch.id), updated); stage('inventoryBatches', updated);
      totalCost += take * costPrice; allocations.push({ batchId: String(batch.id), quantity: take, costPrice });
      remaining = roundQty(remaining - take);
    }
    if (remaining > 1e-6) {
      const fallback = weightedAverage ? weightedCost : Number(product.costPrice || 0);
      totalCost += remaining * fallback; allocations.push({ batchId: null, quantity: remaining, costPrice: fallback });
    }
    const updatedProduct = { ...product, stockQuantity: nextQty, updatedAt: now, syncStatus };
    productMap.set(Number(productId), updatedProduct); stage('products', updatedProduct);
    if (nextQty < -1e-6) {
      const alertId = 'offline-oversell:' + operationId + ':' + String(productId) + ':' + suffix;
      if (!alerts.some((x: any) => String(x.id) === alertId)) stage('inventoryAlerts', {
        id: alertId, productId: Number(productId), productName: product.name, previousQty,
        changeQty: -qtyNeeded, resultingQty: nextQty, operationId, deviceId,
        reason: 'offline_oversell', resolved: 0, createdAt: now });
    }
    const movementKey = 'order:' + String(order.id) + ':out:' + String(productId) + ':' + suffix;
    if (!movementKeys.has(movementKey)) {
      const movement = { id: generateUUID(), movementKey, productId: Number(productId), movementType,
        sourceType: 'order', sourceId: String(order.id), quantityDeltaBase: -qtyNeeded,
        unitCost: totalCost / qtyNeeded, totalCost: roundMoney(totalCost), branchId: order.branchId,
        operationId, reason, createdBy: order.createdBy, createdAt: now, syncStatus };
      movements.push(movement); movementKeys.add(movementKey); stage('inventoryMovements', movement);
    }
    return { totalCost: roundMoney(totalCost), allocations };
  };

  const serverItems = Array.isArray(_serverItems) ? _serverItems : [];
  let serverItemIndex = 0;
  const localOrderItems: any[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index], quantity = roundQty(Number(item.quantity || 0));
    if (quantity <= 0) continue;
    const serverItem = serverItems[serverItemIndex++];
    const product: any = productMap.get(Number(item.productId));
    if (!product) throw new Error('الصنف غير موجود (ID: ' + String(item.productId) + ')');
    const factor = resolveLocalUnitFactor(product, item);
    const baseQty = roundQty(quantity * factor);
    const itemType = String(item.itemType || product.itemType || 'stock');
    let costTotal = 0, batchAllocations: any = [];
    if (itemType === 'service') batchAllocations = { kind: 'service' };
    else if (itemType === 'service_with_materials' || itemType === 'bundle') {
      const productRecipes = recipes.filter((x: any) => Number(x.parentProductId) === Number(product.id));
      if (productRecipes.length) {
        const ingredientAllocations: any[] = [];
        for (const recipe of productRecipes) {
          const ingredientQty = roundQty(baseQty * Number(recipe.quantity || 0));
          if (ingredientQty <= 0) continue;
          const consumed = consume(Number(recipe.ingredientProductId), ingredientQty,
            'recipe-' + String(index) + '-' + String(recipe.id || recipe.ingredientProductId),
            'service_consumption', 'استهلاك مواد الخدمة');
          costTotal = roundMoney(costTotal + consumed.totalCost);
          ingredientAllocations.push({ ingredientProductId: Number(recipe.ingredientProductId),
            ingredientName: recipe.ingredientName, quantityConsumed: ingredientQty, allocations: consumed.allocations });
        }
        batchAllocations = { kind: 'recipe', ingredients: ingredientAllocations };
      } else if (itemType === 'bundle') {
        const consumed = consume(Number(product.id), baseQty, String(index), 'sale');
        costTotal = consumed.totalCost; batchAllocations = consumed.allocations;
      } else batchAllocations = { kind: 'service' };
    } else {
      const consumed = consume(Number(product.id), baseQty, String(index), 'sale');
      costTotal = consumed.totalCost; batchAllocations = consumed.allocations;
    }
    totalCogs = roundMoney(totalCogs + costTotal);
    const localItem: any = { ...(serverItem || {}), id: serverItem?.id ?? (Date.now() * 1000 + index),
      orderId: order.id, productId: Number(product.id), productName: item.productName || product.name,
      quantity, returnedQuantity: Number(serverItem?.returnedQuantity || 0),
      unit: item.unit || item.selectedUnit || product.unit || 'piece', conversionFactor: factor, itemType,
      unitPrice: Number(item.unitPrice || 0),
      costPriceAtTimeOfSale: serverItem?.costPriceAtTimeOfSale !== undefined ? Number(serverItem.costPriceAtTimeOfSale) :
        quantity > 0 ? roundQty(costTotal / quantity) : 0,
      discountAmount: Number(item.discountAmount || 0), subTotal: Number(item.subTotal || 0),
      taxAmount: Number(item.taxAmount || 0), total: Number(item.total || 0),
      batchAllocations: serverItem?.batchAllocations || JSON.stringify(batchAllocations), syncStatus };
    localOrderItems.push(localItem); stage('orderItems', localItem);
  }
  stage('orders', { ...normalizedOrder, syncStatus });
  if (order.customerId && customers) {
    const balanceDelta = paymentMethod === 'credit' ? netAmount : 0;
    const pointsDelta = Number(pointsEarned || 0) - Number(pointsRedeemed || 0);
    stage('customers', { ...customers, balance: roundMoney((customers.balance || 0) + balanceDelta),
      points: Math.max(0, (customers.points || 0) + pointsDelta), updatedAt: now, syncStatus });
    const addLoyalty = (type: string, points: number, offset: number) => {
      if (points <= 0) return;
      stage('loyaltyTransactions', { id: Date.now() * 1000 + 500 + offset, customerId: order.customerId,
        orderId: order.id, type, points, date: now, syncStatus });
    };
    addLoyalty('earn', Number(pointsEarned || 0), 0);
    addLoyalty('redeem', Number(pointsRedeemed || 0), 1);
  }

  const journalSyncStatus = currentDeviceRole === 'standalone' ? 'synced' : 'pending';
  const accountDefaults: Record<string, any> = {
    '1010': { name: 'الصندوق', type: 'asset' }, '1020': { name: 'البنك / الشبكة', type: 'asset' },
    '1100': { name: 'ذمم العملاء', type: 'asset' }, '1200': { name: 'المخزون', type: 'asset' },
    '2100': { name: 'ذمم الموردين', type: 'liability' }, '2200': { name: 'ضريبة القيمة المضافة المستحقة', type: 'liability' },
    '3100': { name: 'رأس المال والأرصدة الافتتاحية', type: 'equity' }, '3200': { name: 'الأرباح المحتجزة', type: 'equity' },
    '4100': { name: 'المبيعات', type: 'revenue' }, '4200': { name: 'مرتجعات المبيعات', type: 'revenue' },
    '4300': { name: 'خصومات مسموحة', type: 'revenue' }, '5100': { name: 'تكلفة البضاعة المباعة', type: 'expense' },
    '5200': { name: 'المصروفات التشغيلية', type: 'expense' }, '5300': { name: 'الرواتب والأجور', type: 'expense' },
    '5400': { name: 'تسويات الجرد', type: 'expense' },
  };
  const accountMap = new Map<string, any>(accounts.map((x: any) => [String(x.code), x]));
  const journalMap = new Map<string, any>(journals.map((x: any) => [String(x.id), x]));
  if (shouldPostLocalAccounting(syncStatus)) {
    for (const [code, definition] of Object.entries(accountDefaults)) {
      if (!accountMap.has(code)) {
        const account = { code, ...definition, balance: 0, isSystem: 1, createdAt: now, updatedAt: now };
        accountMap.set(code, account);
        stage('accounts', account);
      }
    }
  }
  const postJournal = (entryKey: string, description: string, lines: any[]) => {
    const normalized = lines.map((x: any) => ({ ...x, debit: roundMoney(x.debit), credit: roundMoney(x.credit) }))
      .filter((x: any) => x.debit > 0 || x.credit > 0);
    if (!normalized.length) return;
    const entryId = 'local-je:order:' + String(order.id) + ':' + entryKey;
    if (journalMap.has(entryId)) return;
    let debit = roundMoney(normalized.reduce((sum: number, x: any) => sum + x.debit, 0));
    let credit = roundMoney(normalized.reduce((sum: number, x: any) => sum + x.credit, 0));
    const difference = roundMoney(debit - credit);
    if (Math.abs(difference) > 0.02) throw new Error('قيد محاسبي غير متوازن: ' + description + ' (مدين ' + debit + ' / دائن ' + credit + ')');
    if (difference !== 0) {
      const last = normalized[normalized.length - 1];
      if (last.credit > 0) last.credit = roundMoney(last.credit + difference); else last.debit = roundMoney(last.debit - difference);
      debit = roundMoney(normalized.reduce((sum: number, x: any) => sum + x.debit, 0));
      credit = roundMoney(normalized.reduce((sum: number, x: any) => sum + x.credit, 0));
    }
    const entry = { id: entryId, entryNumber: 'LOCAL-' + entryKey + '-' + String(order.id).slice(0, 8),
      date: now, referenceId: String(order.id), referenceType: 'order', description, totalDebit: debit, totalCredit: credit,
      status: 'posted', createdBy: order.createdBy || 'System', branchId: order.branchId,
      syncStatus: journalSyncStatus, createdAt: now };
    stage('journalEntries', entry); journalMap.set(entryId, entry);
    normalized.forEach((line: any, index: number) => {
      const code = String(line.accountCode);
      let account = accountMap.get(code);
      if (!account && accountDefaults[code]) {
        account = { code, ...accountDefaults[code], balance: 0, isSystem: 1, createdAt: now, updatedAt: now };
        accountMap.set(code, account);
      }
      stage('transactions', { id: entryId + ':' + String(index), journalEntryId: entryId, accountId: code,
        accountName: account?.name || accountDefaults[code]?.name || code, type: line.debit > 0 ? 'debit' : 'credit',
        amount: line.debit > 0 ? line.debit : line.credit, debit: line.debit, credit: line.credit,
        description: line.description || description, orderId: line.orderId, purchaseId: line.purchaseId,
        returnId: line.returnId, syncStatus: journalSyncStatus, createdAt: now });
      if (account) {
        const normalDebit = account.type === 'asset' || account.type === 'expense';
        const updated = { ...account, balance: roundMoney(Number(account.balance || 0) +
          (normalDebit ? line.debit - line.credit : line.credit - line.debit)), updatedAt: now };
        accountMap.set(code, updated); stage('accounts', updated);
      }
    });
  };
  if (shouldPostLocalAccounting(syncStatus)) {
    const discountAmount = roundMoney(Math.max(0, totalAmount + taxAmount - netAmount));
    const debitLines: any[] = [];
    if (cashAmount > 0) debitLines.push({ accountCode: '1010', debit: cashAmount, credit: 0, orderId: order.id });
    if (cardAmount > 0) debitLines.push({ accountCode: '1020', debit: cardAmount, credit: 0, orderId: order.id });
    if (paymentMethod !== 'mixed' && paymentMethod !== 'cash' && paymentMethod !== 'card' && netAmount > 0)
      debitLines.push({ accountCode: '1100', debit: netAmount, credit: 0, orderId: order.id });
    const revenueLines = [...debitLines,
      ...(discountAmount > 0 ? [{ accountCode: '4300', debit: discountAmount, credit: 0, orderId: order.id }] : []),
      ...(totalAmount > 0 ? [{ accountCode: '4100', debit: 0, credit: totalAmount, orderId: order.id }] : []),
      ...(taxAmount > 0 ? [{ accountCode: '2200', debit: 0, credit: taxAmount, orderId: order.id }] : [])];
    postJournal('sale-revenue', 'فاتورة مبيعات رقم ' + String(order.receiptNumber || order.id), revenueLines);
    if (totalCogs > 0) postJournal('sale-cogs', 'تكلفة مبيعات فاتورة رقم ' + String(order.receiptNumber || order.id), [
      { accountCode: '5100', debit: roundMoney(totalCogs), credit: 0, orderId: order.id },
      { accountCode: '1200', debit: 0, credit: roundMoney(totalCogs), orderId: order.id }]);
  }
  const nativeChanges = [...changes.values()];
  const applied = await nativePosRepository.applyChanges(nativeChanges);
  if (applied !== nativeChanges.length) throw new Error('لم تؤكد SQLite حفظ جميع سجلات فاتورة المبيعات');
  const grouped = new Map<string, any[]>();
  for (const change of nativeChanges) {
    const list = grouped.get(change.entity) || []; list.push(change.record); grouped.set(change.entity, list);
  }
  const tableNames = [...grouped.keys()];
  await db.transaction('rw', tableNames.map((name) => (db as any)[name]), async () => {
    for (const [entity, records] of grouped) await (db as any)[entity].bulkPut(records);
  });
  await flushNativeDatabaseMirrorWrites();
}

async function applySaleLocally(payload: any, syncStatus: 'synced' | 'pending') {
  if (isNativeAndroid()) return applySaleLocallyNative(payload, syncStatus);
  const { order, items = [], pointsEarned = 0, pointsRedeemed = 0, _serverItems } = payload;
  const now = order.createdAt || new Date().toISOString();
  const operationId = String(payload.operationId || order.operationId || order.id);
  const deviceId = String(payload.deviceId || 'local-device');
  const policyRow = await getLocalSettingByKey('offlineStockPolicy');
  const legacyPolicy = await getLocalSettingByKey('allowNegativeStock');
  const stockPolicy = policyRow?.value || (legacyPolicy?.value === 'false' || legacyPolicy?.value === false ? 'block' : 'allow_with_alert');
  const actorRole = String(payload.actor?.role || payload.userRole || payload.role || '').toLowerCase();
  const isPrivilegedOverride = Boolean(payload.managerOverride || payload.allowNegativeOverride) && (actorRole === 'admin' || actorRole === 'manager');
  const allowNegative = !['block', 'manager_override'].includes(String(stockPolicy)) || isPrivilegedOverride;
  let totalCogs = 0;
  const netAmount = roundMoney(Number(order.netAmount || 0));
  const totalAmount = roundMoney(Number(order.totalAmount || 0));
  const taxAmount = roundMoney(Number(order.taxAmount || 0));
  const paymentMethod = String(order.paymentMethod || 'cash');
  let paidAmount = netAmount;
  let cashAmount = 0;
  let cardAmount = 0;
  if (paymentMethod === 'mixed') {
    cashAmount = roundMoney(Number(order.cashAmount || 0));
    cardAmount = roundMoney(Number(order.cardAmount || 0));
    if (cashAmount < 0 || cardAmount < 0 || Math.abs(roundMoney(cashAmount + cardAmount) - netAmount) > 0.02) {
      throw new Error('قيمة الدفع المختلط (نقد + شبكة) يجب أن تساوي صافي الفاتورة');
    }
  } else if (paymentMethod === 'cash') cashAmount = netAmount;
  else if (paymentMethod === 'card') cardAmount = netAmount;
  else if (paymentMethod === 'credit') paidAmount = 0;
  const normalizedOrder = {
    ...order, totalAmount, taxAmount, netAmount,
    discountAmount: roundMoney(Math.max(0, totalAmount + taxAmount - netAmount)),
    paidAmount, cashAmount, cardAmount, returnedAmount: 0, paymentMethod,
    status: order.status || 'completed', currency: order.currency || 'ر.س',
    exchangeRate: Number(order.exchangeRate || 1),
  };

  await db.transaction(
    'rw',
    [
      db.orders, db.orderItems, db.products, db.customers, db.loyaltyTransactions,
      db.inventoryBatches, db.serviceRecipes, db.inventoryMovements, db.inventoryAlerts,
      db.accounts, db.journalEntries, db.transactions,
    ],
    async () => {
      const existingLocalOrder = isNativeAndroid()
        ? await nativePosRepository.get<any>('orders', order.id)
        : await db.orders.get(order.id);
      if (existingLocalOrder) return;
      await db.orders.put({ ...normalizedOrder, syncStatus });
      await db.orderItems.where('orderId').equals(order.id).delete();

      const savedServerItems = Array.isArray(_serverItems) ? _serverItems : [];
      let serverItemIndex = 0;
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const quantity = roundQty(Number(item.quantity || 0));
        if (quantity <= 0) continue;
        const serverItem = savedServerItems[serverItemIndex++];
        const product = await db.products.get(Number(item.productId));
        if (!product) throw new Error(`الصنف غير موجود (ID: ${item.productId})`);

        const factor = resolveLocalUnitFactor(product, item);
        const baseQty = roundQty(quantity * factor);
        const itemType = String(item.itemType || product.itemType || 'stock');
        let costTotal = 0;
        let batchAllocations: any = [];

        if (itemType === 'service') {
          batchAllocations = { kind: 'service' };
        } else if (itemType === 'service_with_materials' || itemType === 'bundle') {
          const recipes = await db.serviceRecipes.where('parentProductId').equals(Number(product.id)).toArray();
          if (recipes.length > 0) {
            const ingredientAllocations: any[] = [];
            for (const recipe of recipes) {
              const ingredientQty = roundQty(baseQty * Number(recipe.quantity || 0));
              if (ingredientQty <= 0) continue;
              const consumed = await consumeLocalInventoryFIFO({
                productId: Number(recipe.ingredientProductId),
                quantityInBaseUnits: ingredientQty,
                operationId,
                deviceId,
                sourceId: String(order.id),
                movementKeySuffix: `recipe-${index}-${recipe.id || recipe.ingredientProductId}`,
                movementType: 'service_consumption',
                sourceType: 'order',
                branchId: order.branchId,
                reason: 'استهلاك مواد الخدمة',
                createdBy: order.createdBy,
                createdAt: now,
                allowNegative,
                syncStatus,
              });
              costTotal += consumed.totalCost;
              ingredientAllocations.push({
                ingredientProductId: Number(recipe.ingredientProductId),
                ingredientName: recipe.ingredientName,
                quantityConsumed: ingredientQty,
                allocations: consumed.allocations,
              });
            }
            batchAllocations = { kind: 'recipe', ingredients: ingredientAllocations };
          } else if (itemType === 'bundle') {
            const consumed = await consumeLocalInventoryFIFO({
              productId: Number(product.id),
              quantityInBaseUnits: baseQty,
              operationId,
              deviceId,
              sourceId: String(order.id),
              movementKeySuffix: String(index),
              movementType: 'sale',
              sourceType: 'order',
              branchId: order.branchId,
              createdBy: order.createdBy,
              createdAt: now,
              allowNegative,
              syncStatus,
            });
            costTotal = consumed.totalCost;
            batchAllocations = consumed.allocations;
          } else {
            batchAllocations = { kind: 'service' };
          }
        } else {
          const consumed = await consumeLocalInventoryFIFO({
            productId: Number(product.id),
            quantityInBaseUnits: baseQty,
            operationId,
            deviceId,
            sourceId: String(order.id),
            movementKeySuffix: String(index),
            movementType: 'sale',
            sourceType: 'order',
            branchId: order.branchId,
            createdBy: order.createdBy,
            createdAt: now,
            allowNegative,
            syncStatus,
          });
          costTotal = consumed.totalCost;
          batchAllocations = consumed.allocations;
        }

        totalCogs = roundMoney(totalCogs + costTotal);
        const localItem = {
          ...(serverItem || {}),
          orderId: order.id,
          productId: Number(product.id),
          productName: item.productName || product.name,
          quantity,
          returnedQuantity: Number(serverItem?.returnedQuantity || 0),
          unit: item.unit || item.selectedUnit || product.unit || 'piece',
          conversionFactor: factor,
          itemType: itemType as any,
          unitPrice: Number(item.unitPrice || 0),
          costPriceAtTimeOfSale: serverItem?.costPriceAtTimeOfSale !== undefined
            ? Number(serverItem.costPriceAtTimeOfSale)
            : quantity > 0 ? roundQty((costTotal / quantity)) : 0,
          discountAmount: Number(item.discountAmount || 0),
          subTotal: Number(item.subTotal || 0),
          taxAmount: Number(item.taxAmount || 0),
          total: Number(item.total || 0),
          batchAllocations: serverItem?.batchAllocations || JSON.stringify(batchAllocations),
          syncStatus,
        };
        if (serverItem?.id !== undefined) {
          await db.orderItems.put(localItem);
        } else {
          delete (localItem as any).id;
          await db.orderItems.add(localItem);
        }
      }

      if (order.customerId) {
        const customer = await db.customers.get(order.customerId);
        if (customer) {
          const balanceDelta = paymentMethod === 'credit' ? netAmount : 0;
          const pointsDelta = Number(pointsEarned || 0) - Number(pointsRedeemed || 0);
          await db.customers.update(customer.id!, {
            balance: roundMoney((customer.balance || 0) + balanceDelta),
            points: Math.max(0, (customer.points || 0) + pointsDelta),
            updatedAt: now,
            syncStatus,
          });
        }

        if (pointsEarned > 0) {
          await db.loyaltyTransactions.add({
            customerId: order.customerId,
            orderId: order.id,
            type: 'earn',
            points: pointsEarned,
            date: now,
            syncStatus,
          });
        }
        if (pointsRedeemed > 0) {
          await db.loyaltyTransactions.add({
            customerId: order.customerId,
            orderId: order.id,
            type: 'redeem',
            points: pointsRedeemed,
            date: now,
            syncStatus,
          });
        }
      }

      if (shouldPostLocalAccounting(syncStatus)) {
        const netAmount = roundMoney(Number(order.netAmount || 0));
        const totalAmount = roundMoney(Number(order.totalAmount || 0));
        const taxAmount = roundMoney(Number(order.taxAmount || 0));
        const discountAmount = roundMoney(Math.max(0, totalAmount + taxAmount - netAmount));
        const paymentMethod = String(order.paymentMethod || 'cash');
        const cashAmount = paymentMethod === 'mixed' ? roundMoney(Number(order.cashAmount || 0)) : paymentMethod === 'cash' ? netAmount : 0;
        const cardAmount = paymentMethod === 'mixed' ? roundMoney(Number(order.cardAmount || 0)) : paymentMethod === 'card' ? netAmount : 0;
        const debitLines: any[] = [];
        if (cashAmount > 0) debitLines.push({ accountCode: '1010', debit: cashAmount, credit: 0, orderId: order.id });
        if (cardAmount > 0) debitLines.push({ accountCode: '1020', debit: cardAmount, credit: 0, orderId: order.id });
        if (paymentMethod !== 'mixed' && paymentMethod !== 'cash' && paymentMethod !== 'card' && netAmount > 0) debitLines.push({ accountCode: '1100', debit: netAmount, credit: 0, orderId: order.id });
        const revenueLines = [
          ...debitLines,
          ...(discountAmount > 0 ? [{ accountCode: '4300', debit: discountAmount, credit: 0, orderId: order.id }] : []),
          ...(totalAmount > 0 ? [{ accountCode: '4100', debit: 0, credit: totalAmount, orderId: order.id }] : []),
          ...(taxAmount > 0 ? [{ accountCode: '2200', debit: 0, credit: taxAmount, orderId: order.id }] : []),
        ];
        await postLocalJournalEntry({
          referenceId: String(order.id), referenceType: 'order', entryKey: 'sale-revenue', date: now,
          description: 'فاتورة مبيعات رقم ' + String(order.receiptNumber || order.id),
          lines: revenueLines, createdBy: order.createdBy, branchId: order.branchId,
        });
        if (totalCogs > 0) {
          await postLocalJournalEntry({
            referenceId: String(order.id), referenceType: 'order', entryKey: 'sale-cogs', date: now,
            description: 'تكلفة مبيعات فاتورة رقم ' + String(order.receiptNumber || order.id),
            lines: [
              { accountCode: '5100', debit: roundMoney(totalCogs), credit: 0, orderId: order.id },
              { accountCode: '1200', debit: 0, credit: roundMoney(totalCogs), orderId: order.id },
            ], createdBy: order.createdBy, branchId: order.branchId,
          });
        }
      }
    }
  );
}

async function applyOrderVoidLocallyNative(payload: any, syncStatus: 'synced' | 'pending') {
  const targetOrderId = String(payload?.orderId || payload?.id || '');
  if (!targetOrderId) throw new Error('Missing orderId for void operation');
  const now = new Date().toISOString(), operationId = String(payload.operationId || targetOrderId);
  const deviceId = String(payload.deviceId || 'local-device');
  const [order, orderItems, customers, loyalty, batches, movements, journals, transactions, accounts] = await Promise.all([
    nativePosRepository.get<any>('orders', targetOrderId),
    nativePosRepository.whereEquals<any>('orderItems', 'orderId', targetOrderId),
    nativePosRepository.getAll<any>('customers'),
    nativePosRepository.whereEquals<any>('loyaltyTransactions', 'orderId', targetOrderId),
    nativePosRepository.getAll<any>('inventoryBatches'),
    nativePosRepository.getAll<any>('inventoryMovements'),
    nativePosRepository.whereEquals<any>('journalEntries', 'referenceId', targetOrderId),
    nativePosRepository.getAll<any>('transactions'),
    nativePosRepository.getAll<any>('accounts'),
  ]);
  if (!order || order.status === 'void') return;
  if (Number(order.returnedAmount || 0) > 0 || order.status === 'returned' || order.status === 'partially_returned')
    throw new Error('لا يمكن إلغاء فاتورة تم إرجاع أصناف منها مسبقاً');
  const customerMap = new Map(customers.map((x: any) => [String(x.id), x]));
  const batchMap = new Map(batches.map((x: any) => [String(x.id), x]));
  const movementKeys = new Set(movements.map((x: any) => String(x.movementKey)));
  const changes = new Map<string, any>();
  const stage = (entity: string, record: any) => {
    const key = entity === 'accounts' ? record.code : record.id;
    changes.set(entity + ':' + JSON.stringify(key), { action: 'put', entity, record, syncState: syncStatus });
  };
  const restore = (productId: number, quantity: number, allocations: any[], fallbackCost: number, suffix: string) => {
    let remaining = roundQty(quantity), totalCost = 0;
    for (let i = allocations.length - 1; i >= 0 && remaining > 1e-6; i--) {
      const allocation = allocations[i];
      if (!allocation || Number(allocation.quantity) <= 0) continue;
      let putBack = roundQty(Math.min(remaining, Number(allocation.quantity)));
      const cost = Number(allocation.costPrice ?? fallbackCost);
      let batchId = allocation.batchId ? String(allocation.batchId) : null;
      if (batchId && batchMap.has(batchId)) {
        const batch: any = batchMap.get(batchId);
        const current = Number(batch.remainingQuantity || 0);
        putBack = roundQty(Math.min(putBack, Math.max(0, Number(batch.quantity || 0) - current)));
        if (putBack <= 1e-6) continue;
        const updated = { ...batch, remainingQuantity: roundQty(current + putBack), updatedAt: now, syncStatus };
        batchMap.set(batchId, updated); stage('inventoryBatches', updated);
      } else {
        batchId = generateUUID();
        const batch = { id: batchId, productId, purchaseId: null, quantity: putBack, remainingQuantity: putBack,
          costPrice: cost, purchaseDate: now, branchId: order.branchId, syncStatus, createdAt: now, updatedAt: now };
        batchMap.set(batchId, batch); stage('inventoryBatches', batch);
      }
      totalCost += putBack * cost; remaining = roundQty(remaining - putBack);
    }
    if (remaining > 1e-6) {
      const id = generateUUID(), batch = { id, productId, purchaseId: null, quantity: remaining, remainingQuantity: remaining,
        costPrice: fallbackCost, purchaseDate: now, branchId: order.branchId, syncStatus, createdAt: now, updatedAt: now };
      batchMap.set(id, batch); stage('inventoryBatches', batch); totalCost += remaining * fallbackCost;
    }
    const product = productUpdates.get(productId) || productMap.get(productId);
    if (product) {
      const updated = { ...product, stockQuantity: roundQty(Number(product.stockQuantity || 0) + quantity), updatedAt: now, syncStatus };
      productUpdates.set(productId, updated); stage('products', updated);
    }
    const movementKey = 'order_void:' + targetOrderId + ':in:' + String(productId) + ':' + suffix;
    if (!movementKeys.has(movementKey)) {
      const movement = { id: generateUUID(), movementKey, productId, movementType: 'sale_void', sourceType: 'order_void',
        sourceId: targetOrderId, quantityDeltaBase: quantity, unitCost: quantity > 0 ? totalCost / quantity : fallbackCost,
        totalCost: roundMoney(totalCost), branchId: order.branchId, operationId, reason: String(payload.reason || 'إلغاء فاتورة مبيعات'),
        createdBy: payload.createdBy, createdAt: now, syncStatus };
      movementKeys.add(movementKey); stage('inventoryMovements', movement);
    }
  };
  const products = await nativePosRepository.getMany<any>('products', [...new Set(orderItems.map((x: any) => Number(x.productId)))]);
  const productMap = new Map(products.map((x: any) => [Number(x.id), x]));
  const productUpdates = new Map<number, any>();
  for (const item of orderItems) {
    if (String(item.itemType || 'stock') === 'service') continue;
    const factor = Number(item.conversionFactor || 1), baseQty = roundQty(Number(item.quantity || 0) * factor);
    if (baseQty <= 0) continue;
    let parsed: any = [];
    try { parsed = typeof item.batchAllocations === 'string' ? JSON.parse(item.batchAllocations) : item.batchAllocations || []; } catch { parsed = []; }
    if (parsed?.kind === 'service') continue;
    if (parsed?.kind === 'recipe' && Array.isArray(parsed.ingredients)) {
      for (const ingredient of parsed.ingredients) {
        const qty = roundQty(Number(ingredient.quantityConsumed || 0));
        if (qty > 0) restore(Number(ingredient.ingredientProductId), qty,
          Array.isArray(ingredient.allocations) ? ingredient.allocations : [], 0,
          'rec-' + String(item.id) + '-' + String(ingredient.ingredientProductId));
      }
      continue;
    }
    const allocations = Array.isArray(parsed) ? parsed : [];
    const fallback = factor > 0 ? Number(item.costPriceAtTimeOfSale || 0) / factor : Number(item.costPriceAtTimeOfSale || 0);
    restore(Number(item.productId), baseQty, allocations, fallback, String(item.id));
  }
  if (order.customerId) {
    const pointsDelta = loyalty.reduce((sum: number, entry: any) =>
      sum + (entry.type === 'earn' ? -Number(entry.points || 0) : entry.type === 'redeem' ? Number(entry.points || 0) : 0), 0);
    const customer: any = customerMap.get(String(order.customerId));
    if (customer) stage('customers', { ...customer,
      balance: roundMoney(Number(customer.balance || 0) + (order.paymentMethod === 'credit' ? -Number(order.netAmount || 0) : 0)),
      points: Math.max(0, Number(customer.points || 0) + pointsDelta), updatedAt: now, syncStatus });
  }
  stage('orders', { ...order, status: 'void', paidAmount: 0, updatedAt: now, syncStatus });

  if (shouldPostLocalAccounting(syncStatus)) {
    const accountMap = new Map(accounts.map((x: any) => [String(x.code), x]));
    const transactionMap = new Map(transactions.map((x: any) => [String(x.id), x]));
    const reversedIds = new Set(journals.map((x: any) => x.reversedEntryId).filter(Boolean).map(String));
    for (const entry of journals) {
      if (entry.status !== 'posted' || reversedIds.has(String(entry.id))) continue;
      const lines = transactions.filter((x: any) => String(x.journalEntryId) === String(entry.id));
      if (!lines.length) continue;
      const reversalId = 'local-je:' + String(entry.referenceType || 'order') + ':' + targetOrderId + ':reversal-' + String(entry.id);
      if (journals.some((x: any) => String(x.id) === reversalId)) continue;
      const reversalLines = lines.map((line: any) => ({
        accountCode: String(line.accountId), debit: roundMoney(Number(line.credit || 0)),
        credit: roundMoney(Number(line.debit || 0)), description: 'عكس: ' + String(line.description || entry.description) +
          ' (' + String(payload.reason || 'إلغاء فاتورة مبيعات') + ')',
        orderId: line.orderId, purchaseId: line.purchaseId, returnId: line.returnId,
      })).filter((line: any) => line.debit > 0 || line.credit > 0);
      const debit = roundMoney(reversalLines.reduce((sum: number, x: any) => sum + x.debit, 0));
      const credit = roundMoney(reversalLines.reduce((sum: number, x: any) => sum + x.credit, 0));
      if (Math.abs(debit - credit) > 0.02) throw new Error('قيد عكسي غير متوازن');
      const reversal = { id: reversalId, entryNumber: 'LOCAL-reversal-' + String(entry.id).slice(-16),
        date: now, referenceId: targetOrderId, referenceType: entry.referenceType || 'order',
        description: 'قيد عكسي - ' + String(entry.description) + ' (' + String(payload.reason || 'إلغاء فاتورة مبيعات') + ')',
        totalDebit: debit, totalCredit: credit, status: 'posted', createdBy: payload.createdBy || 'System',
        branchId: entry.branchId, syncStatus: currentDeviceRole === 'standalone' ? 'synced' : 'pending', createdAt: now };
      stage('journalEntries', reversal);
      reversalLines.forEach((line: any, index: number) => {
        const code = String(line.accountCode), account: any = accountMap.get(code);
        stage('transactions', { id: reversalId + ':' + String(index), journalEntryId: reversalId,
          accountId: code, accountName: account?.name || code, type: line.debit > 0 ? 'debit' : 'credit',
          amount: line.debit > 0 ? line.debit : line.credit, debit: line.debit, credit: line.credit,
          description: line.description, orderId: line.orderId, purchaseId: line.purchaseId, returnId: line.returnId,
          syncStatus: reversal.syncStatus, createdAt: now });
        if (account) {
          const normalDebit = account.type === 'asset' || account.type === 'expense';
          const updated = { ...account, balance: roundMoney(Number(account.balance || 0) +
            (normalDebit ? line.debit - line.credit : line.credit - line.debit)), updatedAt: now };
          accountMap.set(code, updated); stage('accounts', updated);
        }
      });
      stage('journalEntries', { ...entry, status: 'reversed', reversedEntryId: reversalId });
    }
  }
  const nativeChanges = [...changes.values()];
  const applied = await nativePosRepository.applyChanges(nativeChanges);
  if (applied !== nativeChanges.length) throw new Error('لم تؤكد SQLite حفظ جميع سجلات إلغاء الفاتورة');
  const grouped = new Map<string, any[]>();
  for (const change of nativeChanges) {
    const list = grouped.get(change.entity) || []; list.push(change.record); grouped.set(change.entity, list);
  }
  const tables = [...grouped.keys()];
  await db.transaction('rw', tables.map((name) => (db as any)[name]), async () => {
    for (const [entity, records] of grouped) await (db as any)[entity].bulkPut(records);
  });
  await flushNativeDatabaseMirrorWrites();
}

async function applyOrderVoidLocally(payload: any, syncStatus: 'synced' | 'pending') {
  if (isNativeAndroid()) return applyOrderVoidLocallyNative(payload, syncStatus);
  const targetOrderId = String(payload?.orderId || payload?.id || '');
  if (!targetOrderId) throw new Error('Missing orderId for void operation');
  const now = new Date().toISOString();
  const operationId = String(payload.operationId || targetOrderId);
  const deviceId = String(payload.deviceId || 'local-device');
  await db.transaction('rw', [
    db.orders, db.orderItems, db.products, db.customers, db.loyaltyTransactions, db.serviceRecipes,
    db.inventoryBatches, db.inventoryMovements, db.inventoryAlerts, db.accounts, db.journalEntries, db.transactions, db.auditLogs,
  ], async () => {
    const order = await db.orders.get(targetOrderId);
    if (!order || order.status === 'void') return;
    if (Number(order.returnedAmount || 0) > 0 || order.status === 'returned' || order.status === 'partially_returned') {
      throw new Error('لا يمكن إلغاء فاتورة تم إرجاع أصناف منها مسبقاً');
    }
    const orderItems = await db.orderItems.where('orderId').equals(targetOrderId).toArray();
    for (const item of orderItems) {
      const itemType = String(item.itemType || 'stock');
      if (itemType === 'service') continue;
      const factor = Number(item.conversionFactor || 1);
      const baseQty = roundQty(Number(item.quantity || 0) * factor);
      if (baseQty <= 0) continue;
      let parsedAlloc: any = [];
      try { parsedAlloc = typeof item.batchAllocations === 'string' ? JSON.parse(item.batchAllocations) : item.batchAllocations || []; } catch { parsedAlloc = []; }
      if (parsedAlloc?.kind === 'service') continue;
      if (parsedAlloc?.kind === 'recipe' && Array.isArray(parsedAlloc.ingredients)) {
        for (const ingredient of parsedAlloc.ingredients) {
          const ingredientQty = roundQty(Number(ingredient.quantityConsumed || 0));
          if (ingredientQty <= 0) continue;
          await restoreLocalInventoryFIFO({
            productId: Number(ingredient.ingredientProductId), quantityInBaseUnits: ingredientQty,
            allocations: Array.isArray(ingredient.allocations) ? ingredient.allocations : [], fallbackCost: 0,
            operationId, deviceId, sourceId: targetOrderId,
            movementKeySuffix: 'rec-' + String(item.id) + '-' + String(ingredient.ingredientProductId),
            movementType: 'sale_void', sourceType: 'order_void', branchId: order.branchId,
            reason: String(payload.reason || 'إلغاء فاتورة مبيعات'), createdBy: payload.createdBy, createdAt: now, syncStatus,
          });
        }
        continue;
      }
      const allocations = Array.isArray(parsedAlloc) ? parsedAlloc : [];
      const fallbackCost = factor > 0 ? Number(item.costPriceAtTimeOfSale || 0) / factor : Number(item.costPriceAtTimeOfSale || 0);
      await restoreLocalInventoryFIFO({
        productId: Number(item.productId), quantityInBaseUnits: baseQty, allocations, fallbackCost,
        operationId, deviceId, sourceId: targetOrderId, movementKeySuffix: String(item.id),
        movementType: 'sale_void', sourceType: 'order_void', branchId: order.branchId,
        reason: String(payload.reason || 'إلغاء فاتورة مبيعات'), createdBy: payload.createdBy, createdAt: now, syncStatus,
      });
    }
    if (order.customerId) {
      const loyalty = await db.loyaltyTransactions.where('orderId').equals(targetOrderId).toArray();
      let pointsDelta = 0;
      for (const entry of loyalty) {
        if (entry.type === 'earn') pointsDelta -= Number(entry.points || 0);
        if (entry.type === 'redeem') pointsDelta += Number(entry.points || 0);
      }
      const balanceDelta = order.paymentMethod === 'credit' ? -Number(order.netAmount || 0) : 0;
      const customer = await db.customers.get(order.customerId);
      if (customer) await db.customers.update(customer.id!, {
        balance: roundMoney(Number(customer.balance || 0) + balanceDelta),
        points: Math.max(0, Number(customer.points || 0) + pointsDelta), updatedAt: now, syncStatus,
      });
    }
    await db.orders.update(targetOrderId, { status: 'void', paidAmount: 0, updatedAt: now, syncStatus });
    if (shouldPostLocalAccounting(syncStatus)) {
      await reverseLocalJournalEntriesByReference(targetOrderId, String(payload.reason || 'إلغاء فاتورة مبيعات'), payload.createdBy);
    }
  });
}
async function applyReturnLocallyNative(payload: any, syncStatus: 'synced' | 'pending') {
  const { id, returnNumber, originalOrderId, items = [], refundMethod, reason, branchId, shiftId, createdBy } = payload;
  const now = new Date().toISOString();
  const effectiveReturnDate = payload.returnDate ? new Date(payload.returnDate).toISOString() : now;
  const [existingReturn, origOrder, origItems, products, customers, batches, movements, accounts, journals] = await Promise.all([
    nativePosRepository.get<any>('returns', id), nativePosRepository.get<any>('orders', originalOrderId),
    nativePosRepository.whereEquals<any>('orderItems', 'orderId', originalOrderId),
    nativePosRepository.getAll<any>('products'), nativePosRepository.getAll<any>('customers'),
    nativePosRepository.getAll<any>('inventoryBatches'), nativePosRepository.getAll<any>('inventoryMovements'),
    nativePosRepository.getAll<any>('accounts'), nativePosRepository.getAll<any>('journalEntries'),
  ]);
  if (existingReturn) return;
  if (!origOrder || origOrder.status === 'void') throw new Error('لا يمكن إرجاع فاتورة غير موجودة أو ملغاة');
  const changes = new Map<string, any>();
  const stage = (entity: string, record: any) => {
    const key = entity === 'accounts' ? record.code : record.id;
    changes.set(entity + ':' + JSON.stringify(key), { action: 'put', entity, record, syncState: syncStatus });
  };
  const productMap = new Map(products.map((x: any) => [Number(x.id), x]));
  const customerMap = new Map(customers.map((x: any) => [String(x.id), x]));
  const batchMap = new Map(batches.map((x: any) => [String(x.id), x]));
  const accountMap = new Map(accounts.map((x: any) => [String(x.code), x]));
  const journalMap = new Map(journals.map((x: any) => [String(x.id), x]));
  const effectiveRefundMethod = refundMethod || (origOrder.paymentMethod === 'credit' ? 'credit_adjustment' : origOrder.paymentMethod === 'card' ? 'card' : 'cash');
  const operationId = String(payload.operationId || id), deviceId = String(payload.deviceId || 'local-device');
  let totalRefund = 0, totalTax = 0, totalSub = 0, totalCostReversed = 0;
  let totalDiscount = 0, totalResalableCostReversed = 0, totalDamagedCostReversed = 0, processedItems = 0;

  const restore = (productId: number, quantity: number, allocations: any[], fallbackCost: number, suffix: string) => {
    const qtyToRestore = roundQty(quantity);
    if (qtyToRestore <= 0) return 0;
    let remaining = qtyToRestore, totalCost = 0;
    for (let i = allocations.length - 1; i >= 0 && remaining > 1e-6; i--) {
      const allocation = allocations[i];
      if (!allocation || Number(allocation.quantity) <= 0) continue;
      let putBack = roundQty(Math.min(remaining, Number(allocation.quantity)));
      const allocationCost = Number(allocation.costPrice ?? fallbackCost);
      if (allocation.batchId && batchMap.has(String(allocation.batchId))) {
        const batch: any = batchMap.get(String(allocation.batchId));
        const current = Number(batch.remainingQuantity || 0);
        putBack = roundQty(Math.min(putBack, Math.max(0, Number(batch.quantity) - current)));
        if (putBack <= 1e-6) continue;
        const updated = { ...batch, remainingQuantity: roundQty(current + putBack), updatedAt: effectiveReturnDate, syncStatus };
        batchMap.set(String(updated.id), updated); stage('inventoryBatches', updated);
      } else {
        const batchId = generateUUID();
        const created = { id: batchId, productId, purchaseId: null, quantity: putBack, remainingQuantity: putBack,
          costPrice: allocationCost, purchaseDate: effectiveReturnDate, branchId: branchId ?? origOrder.branchId,
          syncStatus, createdAt: effectiveReturnDate, updatedAt: effectiveReturnDate };
        batchMap.set(batchId, created); stage('inventoryBatches', created);
      }
      totalCost += putBack * allocationCost;
      remaining = roundQty(remaining - putBack);
    }
    if (remaining > 1e-6) {
      const batchId = generateUUID();
      const created = { id: batchId, productId, purchaseId: null, quantity: remaining, remainingQuantity: remaining,
        costPrice: fallbackCost, purchaseDate: effectiveReturnDate, branchId: branchId ?? origOrder.branchId,
        syncStatus, createdAt: effectiveReturnDate, updatedAt: effectiveReturnDate };
      batchMap.set(batchId, created); stage('inventoryBatches', created);
      totalCost += remaining * fallbackCost;
    }
    const product: any = productMap.get(Number(productId));
    if (product) {
      const updated = { ...product, stockQuantity: roundQty(Number(product.stockQuantity || 0) + qtyToRestore), updatedAt: effectiveReturnDate, syncStatus };
      productMap.set(Number(productId), updated); stage('products', updated);
    }
    const movementKey = 'return:' + String(id) + ':in:' + String(productId) + ':' + suffix;
    if (!movements.some((x: any) => x.movementKey === movementKey)) {
      const movement = { id: generateUUID(), movementKey, productId, movementType: 'sale_return', sourceType: 'return',
        sourceId: String(id), quantityDeltaBase: qtyToRestore, unitCost: totalCost / qtyToRestore, totalCost,
        branchId: branchId ?? origOrder.branchId, operationId, reason: reason || 'مرتجع مبيعات', createdBy,
        createdAt: effectiveReturnDate, syncStatus };
      movements.push(movement); stage('inventoryMovements', movement);
    }
    return roundMoney(totalCost);
  };

  for (const reqItem of items) {
    const requestedQuantity = roundQty(Number(reqItem.quantity || 0));
    if (requestedQuantity <= 0) continue;
    const origItem = reqItem.orderItemId !== undefined && reqItem.orderItemId !== null
      ? origItems.find((x: any) => Number(x.id) === Number(reqItem.orderItemId))
      : origItems.find((x: any) => Number(x.productId) === Number(reqItem.productId) &&
          roundQty(Number(x.quantity || 0) - Number(x.returnedQuantity || 0)) >= requestedQuantity - 1e-6)
        || origItems.find((x: any) => Number(x.productId) === Number(reqItem.productId));
    if (!origItem) throw new Error('الصنف غير موجود في الفاتورة الأصلية: ' + String(reqItem.productName || reqItem.productId));
    const qty = requestedQuantity;
    if (qty > roundQty(Number(origItem.quantity || 0) - Number(origItem.returnedQuantity || 0)) + 1e-6)
      throw new Error('الكمية المرتجعة تتجاوز الكمية المتبقية القابلة للإرجاع للمنتج ' + origItem.productName);
    const ratio = qty / Number(origItem.quantity);
    const lineSub = roundMoney(Number(origItem.subTotal) * ratio), lineTax = roundMoney(Number(origItem.taxAmount) * ratio);
    const lineTotal = roundMoney(Number(origItem.total) * ratio);
    const lineDiscount = roundMoney(Math.max(0, lineSub + lineTax - lineTotal));
    let lineCost = 0;
    const condition = reqItem.condition === 'damaged' ? 'damaged' : 'resalable';
    totalSub = roundMoney(totalSub + lineSub); totalDiscount = roundMoney(totalDiscount + lineDiscount);
    totalTax = roundMoney(totalTax + lineTax); totalRefund = roundMoney(totalRefund + lineTotal);
    const nextReturned = roundQty(Number(origItem.returnedQuantity || 0) + qty);
    origItem.returnedQuantity = nextReturned;
    if (origItem.id !== undefined && origItem.id !== null) stage('orderItems', { ...origItem, syncStatus });
    const itemType = String(origItem.itemType || 'stock'), factor = Number(origItem.conversionFactor || 1);
    const baseQty = roundQty(qty * factor);
    if (condition === 'resalable' && itemType !== 'service') {
      let parsedAlloc: any = [];
      try { parsedAlloc = typeof origItem.batchAllocations === 'string' ? JSON.parse(origItem.batchAllocations) : origItem.batchAllocations || []; } catch { parsedAlloc = []; }
      const fallbackCost = factor > 0 ? Number(origItem.costPriceAtTimeOfSale || 0) / factor : Number(origItem.costPriceAtTimeOfSale || 0);
      if (parsedAlloc?.kind === 'recipe' && Array.isArray(parsedAlloc.ingredients)) {
        for (const ingredient of parsedAlloc.ingredients) {
          const ingredientQty = roundQty(Number(ingredient.quantityConsumed || 0) * (qty / Number(origItem.quantity || 1)));
          if (ingredientQty > 0) lineCost = roundMoney(lineCost + restore(Number(ingredient.ingredientProductId), ingredientQty,
            Array.isArray(ingredient.allocations) ? ingredient.allocations : [], 0,
            'rec-' + String(processedItems) + '-' + String(ingredient.ingredientProductId)));
        }
      } else if (parsedAlloc?.kind !== 'service') {
        lineCost = restore(Number(origItem.productId), baseQty, Array.isArray(parsedAlloc) ? parsedAlloc : [], fallbackCost, String(processedItems));
      }
      totalResalableCostReversed = roundMoney(totalResalableCostReversed + lineCost);
    } else if (condition === 'damaged' && itemType !== 'service') {
      lineCost = roundMoney(Number(origItem.costPriceAtTimeOfSale || 0) * qty);
      totalDamagedCostReversed = roundMoney(totalDamagedCostReversed + lineCost);
      const damagedProduct: any = productMap.get(Number(origItem.productId));
      const previousQty = Number(damagedProduct?.stockQuantity || 0);
      stage('inventoryAlerts', { id: 'damaged-return:' + operationId + ':' + String(processedItems),
        productId: Number(origItem.productId), productName: origItem.productName, previousQty, changeQty: 0,
        resultingQty: previousQty, operationId, deviceId, reason: 'damaged_return (' + qty + ')', resolved: 0, createdAt: effectiveReturnDate });
    }
    totalCostReversed = roundMoney(totalCostReversed + lineCost);
    stage('returnItems', { id: generateUUID(), returnId: id, orderItemId: origItem.id, productId: origItem.productId,
      productName: origItem.productName, quantity: qty, condition, unitPrice: origItem.unitPrice,
      costPrice: origItem.costPriceAtTimeOfSale || 0, taxAmount: lineTax, total: lineTotal, syncStatus, createdAt: effectiveReturnDate });
    processedItems++;
  }
  if (!processedItems) throw new Error('لا توجد أصناف صالحة للإرجاع');
  if (roundMoney(totalRefund) > roundMoney(Number(origOrder.netAmount || 0) - Number(origOrder.returnedAmount || 0)) + 0.05)
    throw new Error('إجمالي المرتجع يتجاوز المتبقي من الفاتورة الأصلية');
  const fullReturn = origItems.every((x: any) => roundQty(Number(x.returnedQuantity || 0)) >= roundQty(Number(x.quantity || 0)) - 1e-6);
  stage('orders', { ...origOrder, status: fullReturn ? 'returned' : 'partially_returned',
    returnedAmount: Math.min(roundMoney((origOrder.returnedAmount || 0) + totalRefund), roundMoney(Number(origOrder.netAmount || 0))),
    updatedAt: now, syncStatus });
  if (origOrder.customerId && effectiveRefundMethod === 'credit_adjustment') {
    const customer: any = customerMap.get(String(origOrder.customerId));
    if (customer) stage('customers', { ...customer, balance: roundMoney((customer.balance || 0) - totalRefund), updatedAt: now, syncStatus });
  }
  stage('returns', { id, returnNumber, originalOrderId, originalReceiptNumber: origOrder.receiptNumber,
    customerId: origOrder.customerId, customerName: origOrder.customerName, branchId: branchId ?? origOrder.branchId,
    shiftId: shiftId ?? origOrder.shiftId, refundMethod: effectiveRefundMethod, subTotal: roundMoney(totalSub),
    discountAmount: roundMoney(totalDiscount), taxAmount: roundMoney(totalTax), totalRefund: roundMoney(totalRefund),
    totalCostReversed, reason, createdBy, createdAt: effectiveReturnDate, updatedAt: now, syncStatus });

  const journalSyncStatus = currentDeviceRole === 'standalone' ? 'synced' : 'pending';
  const accountDefaults: Record<string, any> = {
    '1010': { name: 'الصندوق', type: 'asset' }, '1020': { name: 'البنك / الشبكة', type: 'asset' },
    '1100': { name: 'ذمم العملاء', type: 'asset' }, '1200': { name: 'المخزون', type: 'asset' },
    '2200': { name: 'ضريبة القيمة المضافة المستحقة', type: 'liability' },
    '4200': { name: 'مرتجعات المبيعات', type: 'revenue' }, '5100': { name: 'تكلفة البضاعة المباعة', type: 'expense' },
    '5400': { name: 'تسويات الجرد', type: 'expense' },
  };
  const postJournal = (entryKey: string, description: string, lines: any[]) => {
    const normalized = lines.map((x: any) => ({ ...x, debit: roundMoney(x.debit), credit: roundMoney(x.credit) }))
      .filter((x: any) => x.debit > 0 || x.credit > 0);
    if (!normalized.length) return;
    const entryId = 'local-je:return:' + String(id) + ':' + entryKey;
    if (journalMap.has(entryId)) return;
    let debit = roundMoney(normalized.reduce((sum: number, x: any) => sum + x.debit, 0));
    let credit = roundMoney(normalized.reduce((sum: number, x: any) => sum + x.credit, 0));
    const difference = roundMoney(debit - credit);
    if (Math.abs(difference) > 0.02) throw new Error('قيد محاسبي غير متوازن: ' + description + ' (مدين ' + debit + ' / دائن ' + credit + ')');
    if (difference !== 0) {
      const last = normalized[normalized.length - 1];
      if (last.credit > 0) last.credit = roundMoney(last.credit + difference);
      else last.debit = roundMoney(last.debit - difference);
      debit = roundMoney(normalized.reduce((sum: number, x: any) => sum + x.debit, 0));
      credit = roundMoney(normalized.reduce((sum: number, x: any) => sum + x.credit, 0));
    }
    const entry = { id: entryId, entryNumber: 'LOCAL-' + entryKey + '-' + String(id).slice(0, 8),
      date: effectiveReturnDate, referenceId: String(id), referenceType: 'return', description, totalDebit: debit,
      totalCredit: credit, status: 'posted', createdBy: createdBy || 'System', branchId: branchId ?? origOrder.branchId,
      syncStatus: journalSyncStatus, createdAt: effectiveReturnDate };
    stage('journalEntries', entry); journalMap.set(entryId, entry);
    normalized.forEach((line: any, index: number) => {
      const code = String(line.accountCode);
      let account: any = accountMap.get(code);
      if (!account && accountDefaults[code]) {
        account = { code, ...accountDefaults[code], balance: 0, isSystem: 1, createdAt: effectiveReturnDate, updatedAt: effectiveReturnDate };
        accountMap.set(code, account);
      }
      stage('transactions', { id: entryId + ':' + String(index), journalEntryId: entryId, accountId: code,
        accountName: account?.name || accountDefaults[code]?.name || code, type: line.debit > 0 ? 'debit' : 'credit',
        amount: line.debit > 0 ? line.debit : line.credit, debit: line.debit, credit: line.credit,
        description: line.description || description, orderId: line.orderId, purchaseId: line.purchaseId,
        returnId: line.returnId, syncStatus: journalSyncStatus, createdAt: effectiveReturnDate });
      if (account) {
        const normalDebit = account.type === 'asset' || account.type === 'expense';
        const updated = { ...account, balance: roundMoney(Number(account.balance || 0) +
          (normalDebit ? line.debit - line.credit : line.credit - line.debit)), updatedAt: effectiveReturnDate };
        accountMap.set(code, updated); stage('accounts', updated);
      }
    });
  };
  if (shouldPostLocalAccounting(syncStatus) && totalRefund > 0) {
    const creditCode = effectiveRefundMethod === 'cash' ? '1010' : effectiveRefundMethod === 'card' ? '1020' : '1100';
    postJournal('return-refund', 'مرتجع مبيعات ' + String(returnNumber || id), [
      { accountCode: '4200', debit: roundMoney(totalRefund - totalTax), credit: 0, orderId: originalOrderId, returnId: id },
      ...(totalTax > 0 ? [{ accountCode: '2200', debit: roundMoney(totalTax), credit: 0, orderId: originalOrderId, returnId: id }] : []),
      { accountCode: creditCode, debit: 0, credit: roundMoney(totalRefund), orderId: originalOrderId, returnId: id },
    ]);
    if (totalResalableCostReversed > 0) postJournal('return-resalable-cogs', 'عكس تكلفة مرتجع صالح لإعادة البيع ' + String(returnNumber || id), [
      { accountCode: '1200', debit: totalResalableCostReversed, credit: 0, orderId: originalOrderId, returnId: id },
      { accountCode: '5100', debit: 0, credit: totalResalableCostReversed, orderId: originalOrderId, returnId: id },
    ]);
    if (totalDamagedCostReversed > 0) postJournal('return-damaged-cogs', 'تسوية تكلفة مرتجع تالف ' + String(returnNumber || id), [
      { accountCode: '5400', debit: totalDamagedCostReversed, credit: 0, orderId: originalOrderId, returnId: id },
      { accountCode: '5100', debit: 0, credit: totalDamagedCostReversed, orderId: originalOrderId, returnId: id },
    ]);
  }
  const nativeChanges = [...changes.values()];
  const applied = await nativePosRepository.applyChanges(nativeChanges);
  if (applied !== nativeChanges.length) throw new Error('لم تؤكد SQLite حفظ جميع سجلات مرتجع المبيعات');
  const grouped = new Map<string, any[]>();
  for (const change of nativeChanges) {
    const list = grouped.get(change.entity) || [];
    list.push(change.record); grouped.set(change.entity, list);
  }
  const tableNames = [...grouped.keys()];
  await db.transaction('rw', tableNames.map((name) => (db as any)[name]), async () => {
    for (const [entity, records] of grouped) await (db as any)[entity].bulkPut(records);
  });
  await flushNativeDatabaseMirrorWrites();
}

async function applyReturnLocally(payload: any, syncStatus: 'synced' | 'pending') {
  if (isNativeAndroid()) return applyReturnLocallyNative(payload, syncStatus);
  const { id, returnNumber, originalOrderId, items = [], refundMethod, reason, branchId, shiftId, createdBy } =
    payload;
  const now = new Date().toISOString();
  const effectiveReturnDate = payload.returnDate ? new Date(payload.returnDate).toISOString() : now;

  await db.transaction(
    'rw',
    [db.returns, db.returnItems, db.orders, db.orderItems, db.products, db.customers, db.serviceRecipes, db.inventoryBatches, db.inventoryMovements, db.inventoryAlerts, db.accounts, db.journalEntries, db.transactions],
    async () => {
      if (await db.returns.get(id)) return;
      const origOrder = await db.orders.get(originalOrderId);
      if (!origOrder || origOrder.status === 'void') throw new Error('لا يمكن إرجاع فاتورة غير موجودة أو ملغاة');
      const effectiveRefundMethod = refundMethod || (origOrder.paymentMethod === 'credit' ? 'credit_adjustment' : origOrder.paymentMethod === 'card' ? 'card' : 'cash');
      const origItems = await db.orderItems.where('orderId').equals(originalOrderId).toArray();

      let totalRefund = 0;
      let totalTax = 0;
      let totalSub = 0;
      let totalCostReversed = 0;
      let totalDiscount = 0;
      let totalResalableCostReversed = 0;
      let totalDamagedCostReversed = 0;
      let processedItems = 0;
      const operationId = String(payload.operationId || id);
      const deviceId = String(payload.deviceId || 'local-device');

      for (const reqItem of items) {
        const requestedQuantity = roundQty(Number(reqItem.quantity || 0));
        if (requestedQuantity <= 0) continue;
        const origItem = reqItem.orderItemId !== undefined && reqItem.orderItemId !== null
          ? origItems.find((oi) => Number(oi.id) === Number(reqItem.orderItemId))
          : origItems.find((oi) => Number(oi.productId) === Number(reqItem.productId) &&
              roundQty(Number(oi.quantity || 0) - Number(oi.returnedQuantity || 0)) >= requestedQuantity - 1e-6)
            || origItems.find((oi) => Number(oi.productId) === Number(reqItem.productId));
        if (!origItem) throw new Error('الصنف غير موجود في الفاتورة الأصلية: ' + String(reqItem.productName || reqItem.productId));

        const qty = requestedQuantity;
        const remainingReturnable = roundQty(Number(origItem.quantity || 0) - Number(origItem.returnedQuantity || 0));
        if (qty > remainingReturnable + 1e-6) throw new Error('الكمية المرتجعة تتجاوز الكمية المتبقية القابلة للإرجاع للمنتج ' + origItem.productName);

        const ratio = qty / Number(origItem.quantity);
        const lineSub = roundMoney(Number(origItem.subTotal) * ratio);
        const lineTax = roundMoney(Number(origItem.taxAmount) * ratio);
        const lineTotal = roundMoney(Number(origItem.total) * ratio);
        const lineDiscount = roundMoney(Math.max(0, lineSub + lineTax - lineTotal));
        let lineCost = 0;
        const condition: 'resalable' | 'damaged' =
          reqItem.condition === 'damaged' ? 'damaged' : 'resalable';

        totalSub = roundMoney(totalSub + lineSub);
        totalDiscount = roundMoney(totalDiscount + lineDiscount);
        totalTax = roundMoney(totalTax + lineTax);
        totalRefund = roundMoney(totalRefund + lineTotal);

        const nextReturned = roundQty(Number(origItem.returnedQuantity || 0) + qty);
        origItem.returnedQuantity = nextReturned;
        if (origItem.id) {
          await db.orderItems.update(origItem.id, {
            returnedQuantity: nextReturned,
            syncStatus,
          });
        }

        const itemType = String(origItem.itemType || 'stock');
        const factor = Number(origItem.conversionFactor || 1);
        const baseQty = roundQty(qty * factor);

        if (condition === 'resalable' && itemType !== 'service') {
          let parsedAlloc: any = [];
          try {
            parsedAlloc = typeof origItem.batchAllocations === 'string'
              ? JSON.parse(origItem.batchAllocations)
              : origItem.batchAllocations || [];
          } catch {
            parsedAlloc = [];
          }

          const fallbackCostPerBase = factor > 0
            ? Number(origItem.costPriceAtTimeOfSale || 0) / factor
            : Number(origItem.costPriceAtTimeOfSale || 0);

          if (parsedAlloc?.kind === 'recipe' && Array.isArray(parsedAlloc.ingredients)) {
            for (let recipeIndex = 0; recipeIndex < parsedAlloc.ingredients.length; recipeIndex++) {
              const ingredient = parsedAlloc.ingredients[recipeIndex];
              const ingredientQty = roundQty(Number(ingredient.quantityConsumed || 0) * (qty / Number(origItem.quantity || 1)));
              if (ingredientQty <= 0) continue;
              const restoredCost = await restoreLocalInventoryFIFO({
                productId: Number(ingredient.ingredientProductId),
                quantityInBaseUnits: ingredientQty,
                allocations: Array.isArray(ingredient.allocations) ? ingredient.allocations : [],
                fallbackCost: 0,
                operationId,
                deviceId,
                sourceId: String(id),
                movementKeySuffix: `rec-${processedItems}-${ingredient.ingredientProductId}`,
                branchId: branchId ?? origOrder?.branchId,
                reason: reason || 'مرتجع مبيعات',
                createdBy,
                createdAt: effectiveReturnDate,
                syncStatus,
              });
              lineCost = roundMoney(lineCost + restoredCost);
            }
          } else if (parsedAlloc?.kind !== 'service') {
            const allocations = Array.isArray(parsedAlloc) ? parsedAlloc : [];
            lineCost = await restoreLocalInventoryFIFO({
              productId: Number(origItem.productId),
              quantityInBaseUnits: baseQty,
              allocations,
              fallbackCost: fallbackCostPerBase,
              operationId,
              deviceId,
              sourceId: String(id),
              movementKeySuffix: String(processedItems),
              branchId: branchId ?? origOrder?.branchId,
              reason: reason || 'مرتجع مبيعات',
              createdBy,
              createdAt: effectiveReturnDate,
              syncStatus,
            });
          }
          totalResalableCostReversed = roundMoney(totalResalableCostReversed + lineCost);
        } else if (condition === 'damaged' && itemType !== 'service') {
          lineCost = roundMoney(Number(origItem.costPriceAtTimeOfSale || 0) * qty);
          totalDamagedCostReversed = roundMoney(totalDamagedCostReversed + lineCost);
          const damagedProduct = await db.products.get(Number(origItem.productId));
          await db.inventoryAlerts.put({
            id: 'damaged-return:' + operationId + ':' + String(processedItems),
            productId: Number(origItem.productId), productName: origItem.productName,
            previousQty: Number(damagedProduct?.stockQuantity || 0), changeQty: 0,
            resultingQty: Number(damagedProduct?.stockQuantity || 0), operationId, deviceId,
            reason: 'damaged_return (' + qty + ')', resolved: 0, createdAt: effectiveReturnDate,
          });
        }
        totalCostReversed = roundMoney(totalCostReversed + lineCost);
        processedItems += 1;

        const retItem: ReturnItem = {
          id: generateUUID(),
          returnId: id,
          orderItemId: origItem.id,
          productId: origItem.productId,
          productName: origItem.productName,
          quantity: qty,
          condition,
          unitPrice: origItem.unitPrice,
          costPrice: origItem.costPriceAtTimeOfSale || 0,
          taxAmount: lineTax,
          total: lineTotal,
          syncStatus,
          createdAt: effectiveReturnDate,
        };
        await db.returnItems.put(retItem);
      }

      if (origOrder) {
        const updatedItems = await db.orderItems.where('orderId').equals(originalOrderId).toArray();
        const fullReturn = updatedItems.every((i) => roundQty(Number(i.returnedQuantity || 0)) >= roundQty(Number(i.quantity || 0)) - 1e-6);

        await db.orders.update(originalOrderId, {
          status: fullReturn ? 'returned' : 'partially_returned',
          returnedAmount: Math.min(roundMoney((origOrder.returnedAmount || 0) + totalRefund), roundMoney(Number(origOrder.netAmount || 0))),
          updatedAt: now,
          syncStatus,
        });

        if (origOrder.customerId && effectiveRefundMethod === 'credit_adjustment') {
          const customer = await db.customers.get(origOrder.customerId);
          if (customer) {
            await db.customers.update(customer.id!, {
              balance: roundMoney((customer.balance || 0) - totalRefund),
              updatedAt: now,
              syncStatus,
            });
          }
        }
      }

      const retDoc: ReturnRecord = {
        id,
        returnNumber,
        originalOrderId,
        originalReceiptNumber: origOrder?.receiptNumber,
        customerId: origOrder?.customerId,
        customerName: origOrder?.customerName,
        branchId: branchId ?? origOrder?.branchId,
        shiftId: shiftId ?? origOrder?.shiftId,
        refundMethod: effectiveRefundMethod,
        subTotal: roundMoney(totalSub),
        discountAmount: roundMoney(totalDiscount),
        taxAmount: roundMoney(totalTax),
        totalRefund: roundMoney(totalRefund),
        totalCostReversed: roundMoney(totalCostReversed),
        reason,
        createdBy,
        createdAt: effectiveReturnDate,
        updatedAt: now,
        syncStatus,
      };
      await db.returns.put(retDoc);
      if (processedItems === 0) throw new Error('لا توجد أصناف صالحة للإرجاع');
      if (roundMoney(totalRefund) > roundMoney(Number(origOrder.netAmount || 0) - Number(origOrder.returnedAmount || 0)) + 0.05) throw new Error('إجمالي المرتجع يتجاوز المتبقي من الفاتورة الأصلية');
      if (shouldPostLocalAccounting(syncStatus) && totalRefund > 0) {
        const creditAccountCode = effectiveRefundMethod === 'cash' ? '1010' : effectiveRefundMethod === 'card' ? '1020' : '1100';
        await postLocalJournalEntry({
          referenceId: String(id), referenceType: 'return', entryKey: 'return-refund', date: effectiveReturnDate,
          description: 'مرتجع مبيعات ' + String(returnNumber || id),
          lines: [
            { accountCode: '4200', debit: roundMoney(totalRefund - totalTax), credit: 0, orderId: originalOrderId, returnId: id },
            ...(totalTax > 0 ? [{ accountCode: '2200', debit: roundMoney(totalTax), credit: 0, orderId: originalOrderId, returnId: id }] : []),
            { accountCode: creditAccountCode, debit: 0, credit: roundMoney(totalRefund), orderId: originalOrderId, returnId: id },
          ], createdBy, branchId: branchId ?? origOrder.branchId,
        });
        if (totalResalableCostReversed > 0) await postLocalJournalEntry({
          referenceId: String(id), referenceType: 'return', entryKey: 'return-resalable-cogs', date: effectiveReturnDate,
          description: 'عكس تكلفة مرتجع صالح لإعادة البيع ' + String(returnNumber || id),
          lines: [
            { accountCode: '1200', debit: totalResalableCostReversed, credit: 0, orderId: originalOrderId, returnId: id },
            { accountCode: '5100', debit: 0, credit: totalResalableCostReversed, orderId: originalOrderId, returnId: id },
          ], createdBy, branchId: branchId ?? origOrder.branchId,
        });
        if (totalDamagedCostReversed > 0) await postLocalJournalEntry({
          referenceId: String(id), referenceType: 'return', entryKey: 'return-damaged-cogs', date: effectiveReturnDate,
          description: 'تسوية تكلفة مرتجع تالف ' + String(returnNumber || id),
          lines: [
            { accountCode: '5400', debit: totalDamagedCostReversed, credit: 0, orderId: originalOrderId, returnId: id },
            { accountCode: '5100', debit: 0, credit: totalDamagedCostReversed, orderId: originalOrderId, returnId: id },
          ], createdBy, branchId: branchId ?? origOrder.branchId,
        });
      }    }
  );
}

async function applyPurchaseLocally(
  type: 'purchase' | 'purchase_update' | 'purchase_delete',
  payload: any,
  syncStatus: 'synced' | 'pending'
) {
  const now = new Date().toISOString();
  if (isNativeAndroid() && type === 'purchase') {
    const purchase = payload?.purchase;
    if (!purchase?.id) throw new Error('معرّف فاتورة الشراء غير صالح');
    if (await nativePosRepository.get<any>('purchases', String(purchase.id))) return;
    const items = Array.isArray(payload.items) ? payload.items : [];
    const fxRate = Number(purchase.exchangeRate || 1) > 0 ? Number(purchase.exchangeRate || 1) : 1;
    const extraCost = roundMoney(Number(purchase.shippingCost || 0) + Number(purchase.customsCost || 0) + Number(purchase.otherCosts || 0));
    const normalized = items.map((item: any) => {
      const quantity = roundQty(Number(item.quantity || 0));
      const factor = Number(item.conversionFactor || 1) > 0 ? Number(item.conversionFactor || 1) : 1;
      const unitCost = item.pricesInForeignCurrency ? Number(item.costPrice || 0) * fxRate : Number(item.costPrice || 0);
      return { ...item, quantity, factor, unitCost, lineTotal: roundMoney(quantity * unitCost) };
    }).filter((item: any) => item.quantity > 0);
    if (!normalized.length) throw new Error('لا توجد أصناف صالحة في فاتورة الشراء');
    const goodsTotal = Number(purchase.totalAmount || 0) > 0
      ? roundMoney(Number(purchase.totalAmount))
      : roundMoney(normalized.reduce((sum: number, item: any) => sum + item.lineTotal, 0));
    const itemsGoodsSum = roundMoney(normalized.reduce((sum: number, item: any) => sum + item.lineTotal, 0));
    const [products, supplier, allBatches, accounts, journals] = await Promise.all([
      nativePosRepository.getMany<any>('products', [...new Set(normalized.map((item: any) => Number(item.productId)))]),
      purchase.supplierId ? nativePosRepository.get<any>('suppliers', purchase.supplierId) : Promise.resolve(null),
      nativePosRepository.getAll<any>('inventoryBatches'),
      nativePosRepository.getAll<any>('accounts'),
      nativePosRepository.getAll<any>('journalEntries'),
    ]);
    const productMap = new Map<number, any>(products.map((product: any) => [Number(product.id), product]));
    const accountMap = new Map<string, any>(accounts.map((account: any) => [String(account.code), account]));
    const changes: any[] = [];
    const purchaseDoc = { ...purchase, totalAmount: goodsTotal, returnedAmount: purchase.returnedAmount || 0, syncStatus };
    changes.push({ action: 'put', entity: 'purchases', record: purchaseDoc, syncState: syncStatus });
    const itemDocs: any[] = Array.isArray(payload._serverItems) && payload._serverItems.length
      ? payload._serverItems.map((item: any) => ({ ...item, syncStatus }))
      : [];
    const batchDocs: any[] = [];
    const movementDocs: any[] = [];
    const productUpdates = new Map<number, any>();
    let extraRemaining = extraCost;
    for (let index = 0; index < normalized.length; index++) {
      const item = normalized[index];
      const product = productUpdates.get(Number(item.productId)) || productMap.get(Number(item.productId));
      if (!product) throw new Error('الصنف غير موجود (ID: ' + String(item.productId) + ')');
      const baseQty = roundQty(item.quantity * item.factor);
      let allocatedExtra = 0;
      if (extraCost > 0) {
        allocatedExtra = index === normalized.length - 1
          ? roundMoney(extraRemaining)
          : itemsGoodsSum > 0 ? roundMoney(item.lineTotal / itemsGoodsSum * extraCost) : 0;
        extraRemaining = roundMoney(extraRemaining - allocatedExtra);
      }
      const landedTotal = roundMoney(item.lineTotal + allocatedExtra);
      const landedCost = baseQty > 0 ? Math.round(landedTotal / baseQty * 10000) / 10000 : 0;
      if (!Array.isArray(payload._serverItems) || payload._serverItems.length === 0) {
        itemDocs.push({
          id: generateUUID(), purchaseId: String(purchase.id), productId: Number(item.productId),
          productName: item.productName || product.name, quantity: item.quantity, unit: item.unit || 'piece',
          conversionFactor: item.factor, costPrice: item.unitCost, landedCostPerBaseUnit: landedCost,
          total: item.lineTotal, expiryDate: item.expiryDate, batchNumber: item.batchNumber, syncStatus,
        });
      }
      const batch = {
        id: item.batchId || generateUUID(), productId: Number(item.productId), purchaseId: String(purchase.id),
        quantity: baseQty, remainingQuantity: baseQty, costPrice: landedCost, currency: purchase.currency,
        exchangeRate: fxRate, purchaseDate: purchase.date || now, expiryDate: item.expiryDate,
        batchNumber: item.batchNumber, branchId: purchase.branchId, syncStatus,
      };
      batchDocs.push(batch);
      const movement = {
        id: generateUUID(),
        movementKey: 'purchase:' + String(purchase.id) + ':' + String(payload.operationId || purchase.id) + ':in:' + String(item.productId) + ':' + String(index),
        productId: Number(item.productId), movementType: 'purchase_receipt', sourceType: 'purchase',
        sourceId: String(purchase.id), quantityDeltaBase: baseQty, unitCost: landedCost,
        totalCost: landedTotal, branchId: purchase.branchId, operationId: String(payload.operationId || purchase.id),
        reason: 'استلام مشتريات', createdBy: purchase.createdBy, createdAt: purchase.date || now, syncStatus,
      };
      movementDocs.push(movement);
      const effectiveBatches = [...allBatches.filter((b: any) => Number(b.productId) === Number(item.productId)), ...batchDocs.filter((b: any) => Number(b.productId) === Number(item.productId))];
      const active = effectiveBatches.filter((b: any) => Number(b.remainingQuantity || 0) > 0);
      const activeQty = active.reduce((sum: number, b: any) => sum + Number(b.remainingQuantity || 0), 0);
      const activeValue = active.reduce((sum: number, b: any) => sum + Number(b.remainingQuantity || 0) * Number(b.costPrice || 0), 0);
      const updatedProduct = {
        ...product, stockQuantity: roundQty(Number(product.stockQuantity || 0) + baseQty),
        costPrice: activeQty > 0 ? roundMoney(activeValue / activeQty) : landedCost,
        expiryDate: item.expiryDate || product.expiryDate, batchNumber: item.batchNumber || product.batchNumber,
        updatedAt: now, syncStatus,
      };
      productUpdates.set(Number(item.productId), updatedProduct);
    }
    for (const item of itemDocs) changes.push({ action: 'put', entity: 'purchaseItems', record: item, syncState: syncStatus });
    for (const batch of batchDocs) changes.push({ action: 'put', entity: 'inventoryBatches', record: batch, syncState: syncStatus });
    for (const movement of movementDocs) changes.push({ action: 'put', entity: 'inventoryMovements', record: movement, syncState: syncStatus });
    for (const product of productUpdates.values()) changes.push({ action: 'put', entity: 'products', record: product, syncState: syncStatus });
    const invoicePayable = purchase.extraCostsPaymentMethod === 'supplier' ? roundMoney(goodsTotal + extraCost) : goodsTotal;
    const remaining = roundMoney(invoicePayable - Number(purchase.paidAmount || 0));
    let updatedSupplier: any = null;
    if (supplier && remaining > 0) {
      updatedSupplier = { ...supplier, balance: roundMoney(Number(supplier.balance || 0) + remaining), updatedAt: now, syncStatus };
      changes.push({ action: 'put', entity: 'suppliers', record: updatedSupplier, syncState: syncStatus });
    }
    if (shouldPostLocalAccounting(syncStatus)) {
      const entryKey = String(payload.operationId || purchase.id);
      const postJournal = async (referenceType: 'purchase' | 'payment', journalEntryKey: string, description: string, lines: any[]) => {
        const entryId = 'local-je:' + referenceType + ':' + String(purchase.id) + ':' + journalEntryKey;
        if (journals.some((entry: any) => String(entry.id) === entryId)) return;
        const normalizedLines = lines.map((line: any) => ({
          ...line, debit: roundMoney(line.debit), credit: roundMoney(line.credit),
        })).filter((line: any) => line.debit > 0 || line.credit > 0);
        if (!normalizedLines.length) return;
        let totalDebit = roundMoney(normalizedLines.reduce((sum: number, line: any) => sum + line.debit, 0));
        let totalCredit = roundMoney(normalizedLines.reduce((sum: number, line: any) => sum + line.credit, 0));
        const difference = roundMoney(totalDebit - totalCredit);
        if (Math.abs(difference) > 0.02) throw new Error('قيد مشتريات غير متوازن: ' + description);
        if (difference !== 0) {
          const lastLine = normalizedLines[normalizedLines.length - 1];
          if (lastLine.credit > 0) lastLine.credit = roundMoney(lastLine.credit + difference);
          else lastLine.debit = roundMoney(lastLine.debit - difference);
          totalDebit = roundMoney(normalizedLines.reduce((sum: number, line: any) => sum + line.debit, 0));
          totalCredit = roundMoney(normalizedLines.reduce((sum: number, line: any) => sum + line.credit, 0));
        }
        for (const line of normalizedLines) {
          const definitions: any = {
            '1200': { name: 'المخزون', type: 'asset' }, '2100': { name: 'ذمم الموردين', type: 'liability' },
            '1010': { name: 'الصندوق', type: 'asset' }, '1020': { name: 'البنك / الشبكة', type: 'asset' },
          };
          const def = definitions[line.accountCode];
          const account = accountMap.get(line.accountCode) || { code: line.accountCode, ...def, balance: 0, isSystem: 1, createdAt: now, updatedAt: now };
          const delta = account.type === 'asset' || account.type === 'expense' ? line.debit - line.credit : line.credit - line.debit;
          const updated = { ...account, balance: roundMoney(Number(account.balance || 0) + delta), updatedAt: now };
          accountMap.set(line.accountCode, updated);
        }
        const journal = {
          id: entryId, entryNumber: 'LOCAL-' + journalEntryKey + '-' + String(purchase.id).slice(0, 8),
          date: purchase.date || now, referenceId: String(purchase.id), referenceType,
          description, totalDebit, totalCredit, status: 'posted',
          createdBy: purchase.createdBy || 'System', branchId: purchase.branchId,
          syncStatus: currentDeviceRole === 'standalone' ? 'synced' : 'pending', createdAt: now,
        };
        changes.push({ action: 'put', entity: 'journalEntries', record: journal, syncState: journal.syncStatus });
        normalizedLines.forEach((line: any, index: number) => changes.push({
          action: 'put', entity: 'transactions',
          record: {
            id: entryId + ':' + index, journalEntryId: entryId, accountId: line.accountCode,
            accountName: accountMap.get(line.accountCode)?.name || line.accountCode,
            type: line.debit > 0 ? 'debit' : 'credit', amount: line.debit || line.credit,
            debit: line.debit, credit: line.credit, description: line.description || description, purchaseId: String(purchase.id),
            syncStatus: journal.syncStatus, createdAt: now,
          }, syncState: journal.syncStatus,
        }));
        journals.push(journal);
      };
      const extraMethod = String(purchase.extraCostsPaymentMethod || 'cash');
      const capitalized = roundMoney(goodsTotal + extraCost);
      const credits = extraMethod === 'supplier'
        ? [{ accountCode: '2100', debit: 0, credit: capitalized, purchaseId: purchase.id }]
        : [
            ...(goodsTotal > 0 ? [{ accountCode: '2100', debit: 0, credit: goodsTotal, purchaseId: purchase.id }] : []),
            ...(extraCost > 0 ? [{ accountCode: extraMethod === 'card' ? '1020' : '1010', debit: 0, credit: extraCost, purchaseId: purchase.id }] : []),
          ];
      if (capitalized > 0) await postJournal('purchase', 'purchase-inventory-' + entryKey, 'فاتورة مشتريات من المورد: ' + String(purchase.supplierName || ''), [
        { accountCode: '1200', debit: capitalized, credit: 0, purchaseId: purchase.id }, ...credits,
      ]);
      const paid = roundMoney(Number(purchase.paidAmount || 0));
      if (paid > 0) await postJournal('payment', 'purchase-payment-' + entryKey, 'سداد للمورد عن فاتورة مشتريات: ' + String(purchase.supplierName || ''), [
        { accountCode: '2100', debit: paid, credit: 0, purchaseId: purchase.id },
        { accountCode: purchase.paymentMethod === 'card' ? '1020' : '1010', debit: 0, credit: paid, purchaseId: purchase.id },
      ]);
      const changedCodes = new Set<string>();
      for (const change of changes) if (change.entity === 'accounts') changedCodes.add(String(change.record.code));
      for (const [code, account] of accountMap) {
        if (!changedCodes.has(code)) {
          changes.push({ action: 'put', entity: 'accounts', record: account, syncState: syncStatus });
          changedCodes.add(code);
        }
      }
    }
    const applied = await nativePosRepository.applyChanges(changes);
    if (applied !== changes.length) throw new Error('لم تؤكد SQLite حفظ جميع سجلات فاتورة الشراء');
    await db.transaction('rw', [
      db.purchases, db.purchaseItems, db.products, db.suppliers, db.inventoryBatches,
      db.inventoryMovements, db.accounts, db.journalEntries, db.transactions,
    ], async () => {
      await db.purchases.put(purchaseDoc);
      await db.purchaseItems.bulkPut(itemDocs);
      await db.inventoryBatches.bulkPut(batchDocs);
      await db.inventoryMovements.bulkPut(movementDocs);
      if (productUpdates.size) await db.products.bulkPut([...productUpdates.values()]);
      if (updatedSupplier) await db.suppliers.put(updatedSupplier);
      for (const change of changes) {
        if (change.entity === 'accounts') await db.accounts.put(change.record);
        else if (change.entity === 'journalEntries') await db.journalEntries.put(change.record);
        else if (change.entity === 'transactions') await db.transactions.put(change.record);
      }
    });
    await flushNativeDatabaseMirrorWrites();
    return;
  }


  if (isNativeAndroid() && type === 'purchase_delete') {
    const purchaseId = String(payload?.id || '');
    if (!purchaseId) throw new Error('معرّف فاتورة الشراء غير صالح');
    const oldPurchase = await nativePosRepository.get<any>('purchases', purchaseId);
    if (!oldPurchase) throw new Error('فاتورة الشراء غير موجودة');
    const [returns, oldItems, oldBatches, allBatches, allProducts, suppliers, movements, journals, transactions, accounts] = await Promise.all([
      nativePosRepository.whereEquals<any>('purchaseReturns', 'originalPurchaseId', purchaseId),
      nativePosRepository.whereEquals<any>('purchaseItems', 'purchaseId', purchaseId),
      nativePosRepository.whereEquals<any>('inventoryBatches', 'purchaseId', purchaseId),
      nativePosRepository.getAll<any>('inventoryBatches'),
      nativePosRepository.getAll<any>('products'),
      nativePosRepository.getAll<any>('suppliers'),
      nativePosRepository.getAll<any>('inventoryMovements'),
      nativePosRepository.whereEquals<any>('journalEntries', 'referenceId', purchaseId),
      nativePosRepository.getAll<any>('transactions'),
      nativePosRepository.getAll<any>('accounts'),
    ]);
    if (returns.length) throw new Error('لا يمكن حذف فاتورة شراء لها مرتجعات مسجلة');
    if (oldBatches.some((batch: any) => Number(batch.remainingQuantity || 0) < Number(batch.quantity || 0))) {
      throw new Error('لا يمكن حذف فاتورة شراء تم بيع جزء من مخزونها؛ استخدم مرتجع المشتريات');
    }
    const now = new Date().toISOString();
    const operationId = String(payload.operationId || oldPurchase.operationId || purchaseId);
    const productMap = new Map<number, any>(allProducts.map((x: any) => [Number(x.id), x]));
    const supplierMap = new Map<string, any>(suppliers.map((x: any) => [String(x.id), x]));
    const accountMap = new Map<string, any>(accounts.map((x: any) => [String(x.code), x]));
    const changes: any[] = [];
    const cacheChanges: any[] = [];
    for (const item of oldItems) {
      const factor = Number(item.conversionFactor || 1) > 0 ? Number(item.conversionFactor) : 1;
      const baseQty = roundQty(Number(item.quantity || 0) * factor);
      const product = productMap.get(Number(item.productId));
      if (product) {
        const updated = { ...product, stockQuantity: roundQty(Number(product.stockQuantity || 0) - baseQty), updatedAt: now, syncStatus };
        productMap.set(Number(item.productId), updated);
        changes.push({ action: 'put', entity: 'products', record: updated, syncState: syncStatus });
        cacheChanges.push({ entity: 'products', record: updated });
      }
      const movement = {
        id: generateUUID(),
        movementKey: 'purchase_reversal:' + purchaseId + ':' + operationId + ':out:' + String(item.productId) + ':' + String(oldItems.indexOf(item)),
        productId: Number(item.productId), movementType: 'purchase_reversal', sourceType: 'purchase', sourceId: purchaseId,
        quantityDeltaBase: -baseQty, unitCost: Number(item.landedCostPerBaseUnit || item.costPrice || 0),
        totalCost: roundMoney(baseQty * Number(item.landedCostPerBaseUnit || item.costPrice || 0)),
        branchId: oldPurchase.branchId, operationId, reason: 'عكس فاتورة مشتريات', createdBy: payload.createdBy,
        createdAt: now, syncStatus,
      };
      changes.push({ action: 'put', entity: 'inventoryMovements', record: movement, syncState: syncStatus });
      cacheChanges.push({ entity: 'inventoryMovements', record: movement });
    }
    for (const productId of new Set(oldItems.map((x: any) => Number(x.productId)))) {
      const product = productMap.get(productId);
      if (!product) continue;
      const active = allBatches.filter((batch: any) => Number(batch.productId) === productId &&
        !oldBatches.some((old: any) => String(old.id) === String(batch.id)) && Number(batch.remainingQuantity || 0) > 0);
      const qty = active.reduce((sum: number, batch: any) => sum + Number(batch.remainingQuantity || 0), 0);
      const value = active.reduce((sum: number, batch: any) => sum + Number(batch.remainingQuantity || 0) * Number(batch.costPrice || 0), 0);
      const updated = { ...product, ...(qty > 0 ? { costPrice: roundMoney(value / qty) } : {}), updatedAt: now, syncStatus };
      productMap.set(productId, updated);
      changes.push({ action: 'put', entity: 'products', record: updated, syncState: syncStatus });
      cacheChanges.push({ entity: 'products', record: updated });
    }
    const supplier = oldPurchase.supplierId ? supplierMap.get(String(oldPurchase.supplierId)) : null;
    const oldExtraCost = roundMoney(Number(oldPurchase.shippingCost || 0) + Number(oldPurchase.customsCost || 0) + Number(oldPurchase.otherCosts || 0));
    const oldPayable = oldPurchase.extraCostsPaymentMethod === 'supplier'
      ? roundMoney(Number(oldPurchase.totalAmount || 0) + oldExtraCost)
      : roundMoney(Number(oldPurchase.totalAmount || 0));
    const oldRemaining = roundMoney(oldPayable - Number(oldPurchase.paidAmount || 0));
    if (supplier && oldRemaining > 0) {
      const updated = { ...supplier, balance: roundMoney(Number(supplier.balance || 0) - oldRemaining), updatedAt: now, syncStatus };
      changes.push({ action: 'put', entity: 'suppliers', record: updated, syncState: syncStatus });
      cacheChanges.push({ entity: 'suppliers', record: updated });
    }
    {
      const reversedIds = new Set(journals.map((entry: any) => entry.reversedEntryId).filter(Boolean).map(String));
      for (const entry of journals) {
        if (entry.status !== 'posted' || reversedIds.has(String(entry.id))) continue;
        const lines = transactions.filter((line: any) => String(line.journalEntryId) === String(entry.id));
        if (!lines.length) continue;
        const reversalId = 'local-je:' + String(entry.referenceType || 'purchase') + ':' + purchaseId + ':reversal-' + String(entry.id);
        if (journals.some((x: any) => String(x.id) === reversalId)) continue;
        const reversalLines = lines.map((line: any) => ({
          accountCode: String(line.accountId), debit: roundMoney(Number(line.credit || 0)),
          credit: roundMoney(Number(line.debit || 0)), description: 'عكس: ' + String(line.description || entry.description) + ' (حذف فاتورة مشتريات)',
          purchaseId: line.purchaseId, returnId: line.returnId,
        })).filter((line: any) => line.debit > 0 || line.credit > 0);
        const debit = roundMoney(reversalLines.reduce((sum: number, line: any) => sum + line.debit, 0));
        const credit = roundMoney(reversalLines.reduce((sum: number, line: any) => sum + line.credit, 0));
        if (Math.abs(debit - credit) > 0.02) throw new Error('قيد عكسي غير متوازن');
        const reversal = { id: reversalId, entryNumber: 'LOCAL-reversal-' + String(entry.id).slice(-16),
          date: now, referenceId: purchaseId, referenceType: entry.referenceType || 'purchase',
          description: 'قيد عكسي - ' + String(entry.description) + ' (حذف فاتورة مشتريات)',
          totalDebit: debit, totalCredit: credit, status: 'posted', createdBy: payload.createdBy || 'System',
          branchId: entry.branchId, syncStatus: currentDeviceRole === 'standalone' ? 'synced' : 'pending', createdAt: now };
        changes.push({ action: 'put', entity: 'journalEntries', record: reversal, syncState: reversal.syncStatus });
        cacheChanges.push({ entity: 'journalEntries', record: reversal });
        reversalLines.forEach((line: any, index: number) => {
          const code = String(line.accountCode), account = accountMap.get(code);
          const transaction = { id: reversalId + ':' + String(index), journalEntryId: reversalId, accountId: code,
            accountName: account?.name || code, type: line.debit > 0 ? 'debit' : 'credit',
            amount: line.debit > 0 ? line.debit : line.credit, debit: line.debit, credit: line.credit,
            description: line.description, purchaseId: line.purchaseId, returnId: line.returnId,
            syncStatus: reversal.syncStatus, createdAt: now };
          changes.push({ action: 'put', entity: 'transactions', record: transaction, syncState: reversal.syncStatus });
          cacheChanges.push({ entity: 'transactions', record: transaction });
          if (account) {
            const normalDebit = account.type === 'asset' || account.type === 'expense';
            const updated = { ...account, balance: roundMoney(Number(account.balance || 0) +
              (normalDebit ? line.debit - line.credit : line.credit - line.debit)), updatedAt: now };
            accountMap.set(code, updated);
          }
        });
        changes.push({ action: 'put', entity: 'journalEntries', record: { ...entry, status: 'reversed', reversedEntryId: reversalId }, syncState: syncStatus });
        cacheChanges.push({ entity: 'journalEntries', record: { ...entry, status: 'reversed', reversedEntryId: reversalId } });
      }
      for (const account of accountMap.values()) {
        if (changes.some((x: any) => x.entity === 'accounts' && String(x.record.code) === String(account.code))) continue;
        const changedByReversal = transactions.some((line: any) => String(line.accountId) === String(account.code) &&
          journals.some((entry: any) => String(entry.id) === String(line.journalEntryId) && entry.status === 'posted' && !reversedIds.has(String(entry.id))));
        if (changedByReversal) {
          changes.push({ action: 'put', entity: 'accounts', record: account, syncState: syncStatus });
          cacheChanges.push({ entity: 'accounts', record: account });
        }
      }
    }
    for (const item of oldItems) changes.push({ action: 'delete', entity: 'purchaseItems', key: item.id });
    for (const batch of oldBatches) changes.push({ action: 'delete', entity: 'inventoryBatches', key: batch.id });
    changes.push({ action: 'delete', entity: 'purchases', key: purchaseId });
    const applied = await nativePosRepository.applyChanges(changes);
    if (applied !== changes.length) throw new Error('لم تؤكد SQLite حذف جميع سجلات فاتورة الشراء');
    await db.transaction('rw', [db.purchases, db.purchaseItems, db.products, db.suppliers, db.inventoryBatches,
      db.inventoryMovements, db.accounts, db.journalEntries, db.transactions], async () => {
      await db.purchases.delete(purchaseId);
      await db.purchaseItems.where('purchaseId').equals(purchaseId).delete();
      await db.inventoryBatches.where('purchaseId').equals(purchaseId).delete();
      for (const item of cacheChanges) await (db as any)[item.entity].put(item.record);
      for (const movement of changes.filter((x: any) => x.entity === 'inventoryMovements')) await db.inventoryMovements.put(movement.record);
    });
    await flushNativeDatabaseMirrorWrites();
    return;
  }
  if (isNativeAndroid() && type === 'purchase_update') {
    throw new Error('تعديل فاتورة الشراء على Android غير متاح حتى اكتمال ترحيل عكس وإعادة تطبيق الفاتورة إلى SQLite');
  }

  await db.transaction(
    'rw',
    [db.purchases, db.purchaseItems, db.products, db.suppliers, db.inventoryBatches, db.purchaseReturns, db.inventoryMovements, db.accounts, db.journalEntries, db.transactions],
    async () => {
      if (type === 'purchase' && payload?.purchase?.id && await db.purchases.get(String(payload.purchase.id))) return;
      if (type === 'purchase_delete' || type === 'purchase_update') {
        const pid = type === 'purchase_delete' ? payload.id : payload.purchase.id;
        const oldPurchase = await db.purchases.get(pid);
        if (!oldPurchase) throw new Error('فاتورة الشراء غير موجودة');
        const existingReturns = await db.purchaseReturns.where('originalPurchaseId').equals(String(pid)).count();
        if (existingReturns > 0) throw new Error('لا يمكن تعديل أو حذف فاتورة شراء لها مرتجعات مسجلة');
        const oldBatches = await db.inventoryBatches.where('purchaseId').equals(String(pid)).toArray();
        if (oldBatches.some((batch) => Number(batch.remainingQuantity || 0) < Number(batch.quantity || 0))) {
          throw new Error('لا يمكن تعديل أو حذف فاتورة شراء تم بيع جزء من مخزونها؛ استخدم مرتجع المشتريات');
        }
        const oldItems = await db.purchaseItems.where('purchaseId').equals(pid).toArray();
        payload._localAffectedProductIds = oldItems.map((item) => Number(item.productId));
        payload._localAffectedSupplierId = oldPurchase.supplierId;
        const operationId = String(payload.operationId || oldPurchase.operationId || pid);
        await reverseLocalJournalEntriesByReference(String(pid), 'تعديل أو حذف فاتورة مشتريات', payload.createdBy);
        for (let oldIndex = 0; oldIndex < oldItems.length; oldIndex++) {
          const item = oldItems[oldIndex];
          const factor = Number(item.conversionFactor || 1) > 0 ? Number(item.conversionFactor) : 1;
          const baseQty = roundQty(Number(item.quantity || 0) * factor);
          const prod = await db.products.get(item.productId);
          if (prod) {
            await db.products.update(prod.id!, {
              stockQuantity: roundQty(prod.stockQuantity - baseQty),
              updatedAt: now,
              syncStatus,
            });
          }
          await recordLocalInventoryMovement({
            movementKey: 'purchase_reversal:' + String(pid) + ':' + operationId + ':out:' + String(item.productId) + ':' + String(oldIndex),
            productId: Number(item.productId), movementType: 'purchase_reversal', sourceType: 'purchase', sourceId: String(pid),
            quantityDeltaBase: -baseQty, unitCost: Number(item.landedCostPerBaseUnit || item.costPrice || 0),
            totalCost: roundMoney(baseQty * Number(item.landedCostPerBaseUnit || item.costPrice || 0)),
            branchId: oldPurchase.branchId, operationId, reason: 'عكس فاتورة مشتريات', createdBy: payload.createdBy,
            createdAt: now, syncStatus,
          });
        }
        await db.purchaseItems.where('purchaseId').equals(pid).delete();
        await db.inventoryBatches.where('purchaseId').equals(pid).delete();
        for (const productId of new Set(oldItems.map((item) => Number(item.productId)))) {
          const activeBatches = (await db.inventoryBatches.toArray()).filter((batch) => Number(batch.productId) === productId && Number(batch.remainingQuantity || 0) > 0);
          const activeQty = activeBatches.reduce((sum, batch) => sum + Number(batch.remainingQuantity || 0), 0);
          const activeValue = activeBatches.reduce((sum, batch) => sum + Number(batch.remainingQuantity || 0) * Number(batch.costPrice || 0), 0);
          if (activeQty > 0) await db.products.update(productId, { costPrice: roundMoney(activeValue / activeQty), updatedAt: now, syncStatus });
        }
        if (oldPurchase && oldPurchase.supplierId) {
          const oldExtraCosts = oldPurchase.extraCostsPaymentMethod === 'supplier'
            ? roundMoney(Number(oldPurchase.shippingCost || 0) + Number(oldPurchase.customsCost || 0) + Number(oldPurchase.otherCosts || 0))
            : 0;
          const oldRemaining = roundMoney(Number(oldPurchase.totalAmount || 0) + oldExtraCosts - Number(oldPurchase.paidAmount || 0));
          const sup = await db.suppliers.get(oldPurchase.supplierId);
          if (sup && oldRemaining > 0) {
            await db.suppliers.update(sup.id!, {
              balance: roundMoney(sup.balance - oldRemaining),
              updatedAt: now,
              syncStatus,
            });
          }
        }
        if (type === 'purchase_delete') {
          await db.purchases.delete(pid);
          return;
        }
      }

      const { purchase, items = [], _serverItems } = payload;
      const operationId = String(payload.operationId || purchase.operationId || purchase.id);
      await db.purchases.put({ ...purchase, returnedAmount: purchase.returnedAmount || 0, syncStatus });
      await db.purchaseItems.where('purchaseId').equals(purchase.id).delete();

      if (Array.isArray(_serverItems) && _serverItems.length > 0) {
        await db.purchaseItems.bulkPut(_serverItems.map((si: any) => ({ ...si, syncStatus })));
      }

      const fxRate = Number(purchase.exchangeRate || 1) > 0 ? Number(purchase.exchangeRate || 1) : 1;
      const extraCost = roundMoney(
        roundMoney(Number(purchase.shippingCost || 0)) +
        roundMoney(Number(purchase.customsCost || 0)) +
        roundMoney(Number(purchase.otherCosts || 0))
      );
      const normalizedItems = items.map((item: any) => {
        const qty = roundQty(Number(item.quantity || 0));
        const factor = Number(item.conversionFactor || 1) > 0 ? Number(item.conversionFactor || 1) : 1;
        const unitPurchaseCost = item.pricesInForeignCurrency
          ? Number(item.costPrice || 0) * fxRate
          : Number(item.costPrice || 0);
        return { ...item, qty, factor, unitPurchaseCost, lineTotal: roundMoney(qty * unitPurchaseCost) };
      }).filter((item: any) => item.qty > 0);
      const itemsGoodsSum = roundMoney(normalizedItems.reduce((sum: number, item: any) => sum + item.lineTotal, 0));
      const goodsTotal = Number(purchase.totalAmount || 0) > 0 ? roundMoney(Number(purchase.totalAmount)) : itemsGoodsSum;
      await db.purchases.update(purchase.id, { totalAmount: goodsTotal, updatedAt: now, syncStatus });
      let remainingExtra = extraCost;

      for (let itemIndex = 0; itemIndex < normalizedItems.length; itemIndex++) {
        const item = normalizedItems[itemIndex];
        const qty = item.qty;
        const factor = item.factor;
        const baseQty = roundQty(qty * factor);
        const unitPurchaseCost = item.unitPurchaseCost;
        const lineTotal = item.lineTotal;
        let allocatedExtra = 0;
        if (extraCost > 0) {
          if (itemIndex === normalizedItems.length - 1) {
            allocatedExtra = roundMoney(remainingExtra);
          } else if (itemsGoodsSum > 0) {
            allocatedExtra = roundMoney((lineTotal / itemsGoodsSum) * extraCost);
            remainingExtra = roundMoney(remainingExtra - allocatedExtra);
          }
        }
        const landedTotal = roundMoney(lineTotal + allocatedExtra);
        const landedCostPerBaseUnit =
          baseQty > 0 ? Math.round((landedTotal / baseQty) * 10000) / 10000 : 0;

        if (!Array.isArray(_serverItems) || _serverItems.length === 0) {
          await db.purchaseItems.add({
            purchaseId: purchase.id,
            productId: item.productId,
            productName: item.productName,
            quantity: qty,
            unit: item.unit || 'piece',
            conversionFactor: factor,
            costPrice: unitPurchaseCost,
            landedCostPerBaseUnit,
            total: lineTotal,
            expiryDate: item.expiryDate,
            batchNumber: item.batchNumber,
            syncStatus,
          });
        }
        await db.inventoryBatches.put({
          id: item.batchId || generateUUID(),
          productId: item.productId,
          purchaseId: purchase.id,
          quantity: baseQty,
          remainingQuantity: baseQty,
          costPrice: landedCostPerBaseUnit,
          currency: purchase.currency,
          exchangeRate: fxRate,
          purchaseDate: purchase.date || now,
          expiryDate: item.expiryDate,
          batchNumber: item.batchNumber,
          branchId: purchase.branchId,
          syncStatus,
        });
        const prod = await db.products.get(item.productId);
        if (prod) {
          const activeBatches = (await db.inventoryBatches.toArray()).filter((batch) => Number(batch.productId) === Number(item.productId) && Number(batch.remainingQuantity || 0) > 0);
          const activeQty = activeBatches.reduce((sum, batch) => sum + Number(batch.remainingQuantity || 0), 0);
          const activeValue = activeBatches.reduce((sum, batch) => sum + Number(batch.remainingQuantity || 0) * Number(batch.costPrice || 0), 0);
          const weightedCost = activeQty > 0 ? roundMoney(activeValue / activeQty) : landedCostPerBaseUnit;
          await db.products.update(prod.id!, {
            stockQuantity: roundQty(prod.stockQuantity + baseQty),
            costPrice: weightedCost,
            expiryDate: item.expiryDate || prod.expiryDate,
            batchNumber: item.batchNumber || prod.batchNumber,
            updatedAt: now,
            syncStatus,
          });
        }
        await recordLocalInventoryMovement({
          movementKey: 'purchase:' + String(purchase.id) + ':' + operationId + ':in:' + String(item.productId) + ':' + String(itemIndex),
          productId: Number(item.productId), movementType: 'purchase_receipt', sourceType: 'purchase', sourceId: String(purchase.id),
          quantityDeltaBase: baseQty, unitCost: landedCostPerBaseUnit, totalCost: landedTotal,
          branchId: purchase.branchId, operationId, reason: 'استلام مشتريات', createdBy: purchase.createdBy,
          createdAt: purchase.date || now, syncStatus,
        });
      }

      const invoicePayable =
        purchase.extraCostsPaymentMethod === 'supplier'
          ? roundMoney(goodsTotal + extraCost)
          : goodsTotal;
      const remaining = roundMoney(invoicePayable - Number(purchase.paidAmount || 0));
      if (purchase.supplierId && remaining > 0) {
        const sup = await db.suppliers.get(purchase.supplierId);
        if (sup) {
          await db.suppliers.update(sup.id!, {
            balance: roundMoney((sup.balance || 0) + remaining),
            updatedAt: now,
            syncStatus,
          });
        }
      }

      if (shouldPostLocalAccounting(syncStatus)) {
        const extraPaymentMethod = String(purchase.extraCostsPaymentMethod || 'cash');
        const totalCapitalized = roundMoney(goodsTotal + extraCost);
        const credits: any[] = [];
        if (extraPaymentMethod === 'supplier') {
          credits.push({ accountCode: '2100', debit: 0, credit: totalCapitalized, purchaseId: purchase.id });
        } else {
          if (goodsTotal > 0) credits.push({ accountCode: '2100', debit: 0, credit: goodsTotal, purchaseId: purchase.id });
          if (extraCost > 0) credits.push({ accountCode: extraPaymentMethod === 'card' ? '1020' : '1010', debit: 0, credit: extraCost, purchaseId: purchase.id });
        }
        if (totalCapitalized > 0) await postLocalJournalEntry({
          referenceId: String(purchase.id), referenceType: 'purchase', entryKey: 'purchase-inventory-' + operationId, date: purchase.date || now,
          description: 'فاتورة مشتريات من المورد: ' + String(purchase.supplierName || ''),
          lines: [{ accountCode: '1200', debit: totalCapitalized, credit: 0, purchaseId: purchase.id }, ...credits],
          createdBy: purchase.createdBy, branchId: purchase.branchId,
        });
        const paidAmount = roundMoney(Number(purchase.paidAmount || 0));
        if (paidAmount > 0) await postLocalJournalEntry({
          referenceId: String(purchase.id), referenceType: 'payment', entryKey: 'purchase-payment-' + operationId, date: purchase.date || now,
          description: 'سداد للمورد عن فاتورة مشتريات: ' + String(purchase.supplierName || ''),
          lines: [
            { accountCode: '2100', debit: paidAmount, credit: 0, purchaseId: purchase.id },
            { accountCode: purchase.paymentMethod === 'card' ? '1020' : '1010', debit: 0, credit: paidAmount, purchaseId: purchase.id },
          ], createdBy: purchase.createdBy, branchId: purchase.branchId,
        });
      }
    }
  );
}

async function applyPurchaseReturnLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const { id, returnNumber, originalPurchaseId, items = [], refundMethod = 'credit_adjustment', reason, branchId, shiftId, createdBy } = payload;
  const now = new Date().toISOString();
  const operationId = String(payload.operationId || id);
  if (isNativeAndroid()) {
    if (await nativePosRepository.get<any>('purchaseReturns', id)) return;
    const origPurchase = await nativePosRepository.get<any>('purchases', String(originalPurchaseId));
    if (!origPurchase) throw new Error('فاتورة الشراء الأصلية غير موجودة');
    const [purchaseBatches, allBatches, products, supplier, existingMovements, accounts] = await Promise.all([
      nativePosRepository.whereEquals<any>('inventoryBatches', 'purchaseId', String(originalPurchaseId)),
      nativePosRepository.getAll<any>('inventoryBatches'),
      nativePosRepository.getAll<any>('products'),
      origPurchase.supplierId ? nativePosRepository.get<any>('suppliers', origPurchase.supplierId) : Promise.resolve(null),
      nativePosRepository.getAll<any>('inventoryMovements'),
      nativePosRepository.getAll<any>('accounts'),
    ]);
    const productMap = new Map<number, any>(products.map((p: any) => [Number(p.id), p]));
    const accountMap = new Map<string, any>(accounts.map((a: any) => [String(a.code), a]));
    const batchMap = new Map<string, any>(purchaseBatches.map((b: any) => [String(b.id), b]));
    const movementKeys = new Set(existingMovements.map((m: any) => String(m.movementKey)));
    const changes: any[] = [];
    const itemDocs: any[] = [];
    let totalReturn = 0;
    let processedItems = 0;
    for (const reqItem of items) {
      const qty = roundQty(Number(reqItem.quantity || 0));
      if (qty <= 0) continue;
      const productId = Number(reqItem.productId);
      const batch = reqItem.batchId
        ? batchMap.get(String(reqItem.batchId))
        : [...batchMap.values()].find((entry: any) => Number(entry.productId) === productId && Number(entry.remainingQuantity || 0) >= qty)
          || [...batchMap.values()].find((entry: any) => Number(entry.productId) === productId);
      if (batch) {
        const remaining = Number(batch.remainingQuantity || 0);
        if (remaining < qty) throw new Error('الكمية المتبقية في الدفعة أقل من كمية مرتجع المشتريات');
        const updatedBatch = { ...batch, remainingQuantity: roundQty(remaining - qty), updatedAt: now, syncStatus };
        batchMap.set(String(batch.id), updatedBatch);
        changes.push({ action: 'put', entity: 'inventoryBatches', record: updatedBatch, syncState: syncStatus });
      }
      const product = productMap.get(productId);
      if (!batch && (!product || Number(product.stockQuantity || 0) < qty)) {
        throw new Error('المخزون المتاح لا يكفي لإرجاع المنتج ' + String(reqItem.productName || productId));
      }
      if (product) {
        const effectiveBatches = new Map<string, any>(allBatches.map((entry: any) => [String(entry.id), entry]));
        for (const [batchId, updatedBatch] of batchMap) effectiveBatches.set(batchId, updatedBatch);
        const activeBatches = [...effectiveBatches.values()].filter((entry: any) =>
          Number(entry.productId) === productId && Number(entry.remainingQuantity || 0) > 0);
        const activeQty = activeBatches.reduce((sum: number, entry: any) => sum + Number(entry.remainingQuantity || 0), 0);
        const activeValue = activeBatches.reduce((sum: number, entry: any) => sum + Number(entry.remainingQuantity || 0) * Number(entry.costPrice || 0), 0);
        const updatedProduct = {
          ...product, stockQuantity: roundQty(Number(product.stockQuantity || 0) - qty),
          ...(activeQty > 0 ? { costPrice: roundMoney(activeValue / activeQty) } : {}),
          updatedAt: now, syncStatus,
        };
        productMap.set(productId, updatedProduct);
        changes.push({ action: 'put', entity: 'products', record: updatedProduct, syncState: syncStatus });
      }
      const cost = Number(reqItem.costPrice ?? batch?.costPrice ?? 0);
      const lineTotal = roundMoney(qty * cost);
      totalReturn = roundMoney(totalReturn + lineTotal);
      const itemDoc: any = {
        id: generateUUID(), purchaseReturnId: id, productId, productName: reqItem.productName || '',
        quantity: qty, costPrice: cost, total: lineTotal, batchId: batch?.id ? String(batch.id) : undefined,
        syncStatus, createdAt: now,
      };
      itemDocs.push(itemDoc);
      changes.push({ action: 'put', entity: 'purchaseReturnItems', record: itemDoc, syncState: syncStatus });
      processedItems += 1;
      const movementKey = 'purchase_return:' + String(id) + ':out:' + String(productId) + ':' + String(processedItems);
      if (!movementKeys.has(movementKey)) {
        const movement = {
          id: generateUUID(), movementKey, productId, movementType: 'purchase_return',
          sourceType: 'purchase_return', sourceId: String(id), quantityDeltaBase: -qty,
          baseUnitCode: product?.baseUnitCode || product?.unit || 'piece',
          unitCost: cost, totalCost: lineTotal, branchId: branchId ?? origPurchase.branchId,
          operationId, reason: reason || 'مرتجع مشتريات للمورد', createdBy: createdBy || 'System',
          createdAt: now, syncStatus,
        };
        changes.push({ action: 'put', entity: 'inventoryMovements', record: movement, syncState: syncStatus });
        movementKeys.add(movementKey);
      }
    }
    if (processedItems === 0) throw new Error('لا توجد أصناف صالحة لمرتجع المشتريات');
    const newReturned = roundMoney(Number(origPurchase.returnedAmount || 0) + totalReturn);
    if (newReturned > roundMoney(Number(origPurchase.totalAmount || 0)) + 0.05) throw new Error('قيمة مرتجع المشتريات تتجاوز إجمالي فاتورة الشراء');
    const netPayable = Math.max(0, roundMoney(Number(origPurchase.totalAmount || 0) - newReturned));
    const paid = roundMoney(Number(origPurchase.paidAmount || 0));
    const updatedPurchase = {
      ...origPurchase, returnedAmount: newReturned,
      paymentStatus: paid >= netPayable ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
      updatedAt: now, syncStatus,
    };
    changes.push({ action: 'put', entity: 'purchases', record: updatedPurchase, syncState: syncStatus });
    let updatedSupplier: any = null;
    if (refundMethod === 'credit_adjustment' && supplier) {
      updatedSupplier = { ...supplier, balance: roundMoney(Number(supplier.balance || 0) - totalReturn), updatedAt: now, syncStatus };
      changes.push({ action: 'put', entity: 'suppliers', record: updatedSupplier, syncState: syncStatus });
    }
    const retDoc: any = {
      id, returnNumber, originalPurchaseId: String(originalPurchaseId), supplierId: origPurchase.supplierId,
      supplierName: origPurchase.supplierName, branchId: branchId ?? origPurchase.branchId, shiftId,
      refundMethod, totalReturn, reason, createdBy, createdAt: now, updatedAt: now, syncStatus,
    };
    changes.push({ action: 'put', entity: 'purchaseReturns', record: retDoc, syncState: syncStatus });
    let journalEntry: any = null;
    const journalLines: any[] = [];
    if (shouldPostLocalAccounting(syncStatus) && totalReturn > 0) {
      const debitCode = refundMethod === 'cash' ? '1010' : refundMethod === 'card' ? '1020' : '2100';
      const definitions: any = {
        [debitCode]: debitCode === '1010' ? { name: 'الصندوق', type: 'asset' } : debitCode === '1020' ? { name: 'البنك / الشبكة', type: 'asset' } : { name: 'ذمم الموردين', type: 'liability' },
        '1200': { name: 'المخزون', type: 'asset' },
      };
      const entryId = `local-je:purchase_return:${id}:purchase-return-${operationId}`;
      if (!(await nativePosRepository.get<any>('journalEntries', entryId))) {
        const lines = [
          { accountCode: debitCode, debit: totalReturn, credit: 0 },
          { accountCode: '1200', debit: 0, credit: totalReturn },
        ];
        for (const line of lines) {
          const definition = definitions[line.accountCode];
          const account = accountMap.get(line.accountCode) || {
            code: line.accountCode, name: definition.name, type: definition.type,
            balance: 0, isSystem: 1, createdAt: now, updatedAt: now,
          };
          const normalDebit = account.type === 'asset' || account.type === 'expense';
          const delta = normalDebit ? line.debit - line.credit : line.credit - line.debit;
          const updatedAccount = { ...account, balance: roundMoney(Number(account.balance || 0) + delta), updatedAt: now };
          accountMap.set(line.accountCode, updatedAccount);
          changes.push({ action: 'put', entity: 'accounts', record: updatedAccount, syncState: syncStatus });
        }
        journalEntry = {
          id: entryId, entryNumber: `LOCAL-purchase-return-${String(id).slice(0, 8)}`, date: now,
          referenceId: String(id), referenceType: 'purchase_return',
          description: 'مرتجع مشتريات ' + String(returnNumber || id) + ' للمورد ' + String(origPurchase.supplierName || ''),
          totalDebit: totalReturn, totalCredit: totalReturn, status: 'posted',
          createdBy: createdBy || 'System', branchId: branchId ?? origPurchase.branchId,
          syncStatus: currentDeviceRole === 'standalone' ? 'synced' : 'pending', createdAt: now,
        };
        changes.push({ action: 'put', entity: 'journalEntries', record: journalEntry, syncState: journalEntry.syncStatus });
        lines.forEach((line, index) => {
          const transaction = {
            id: `${entryId}:${index}`, journalEntryId: entryId, accountId: line.accountCode,
            accountName: accountMap.get(line.accountCode)?.name || line.accountCode,
            type: line.debit > 0 ? 'debit' : 'credit', amount: line.debit || line.credit,
            debit: line.debit, credit: line.credit, description: journalEntry.description,
            purchaseId: String(originalPurchaseId), syncStatus: journalEntry.syncStatus, createdAt: now,
          };
          journalLines.push(transaction);
          changes.push({ action: 'put', entity: 'transactions', record: transaction, syncState: journalEntry.syncStatus });
        });
      }
    }
    let audit: any = null;
    if (currentDeviceRole === 'standalone') {
      audit = {
        id: generateUUID(), date: now, userName: createdBy || 'System', type: 'purchase_return',
        action: 'مرتجع مشتريات', operationName: 'إرجاع مشتريات للمورد',
        details: 'مرتجع ' + String(returnNumber || id) + ' للمورد ' + String(origPurchase.supplierName || ''),
        quantity: processedItems, value: totalReturn, branchId: branchId ?? origPurchase.branchId,
        entityId: String(id), entityName: String(returnNumber || id), syncStatus,
      };
      changes.push({ action: 'put', entity: 'auditLogs', record: audit, syncState: syncStatus });
    }
    const uniqueChanges = new Map<string, any>();
    for (const change of changes) {
      const keyField = change.entity === 'accounts' ? 'code' : 'id';
      uniqueChanges.set(String(change.entity) + ':' + String(change.record[keyField]), change);
    }
    const finalChanges = [...uniqueChanges.values()];
    const applied = await nativePosRepository.applyChanges(finalChanges);
    if (applied !== finalChanges.length) throw new Error('لم تؤكد SQLite حفظ جميع سجلات مرتجع المشتريات');
    await db.transaction('rw', [
      db.purchaseReturns, db.purchaseReturnItems, db.purchases, db.inventoryBatches, db.products,
      db.suppliers, db.inventoryMovements, db.accounts, db.journalEntries, db.transactions, db.auditLogs,
    ], async () => {
      await db.purchaseReturns.put(retDoc);
      if (itemDocs.length) await db.purchaseReturnItems.bulkPut(itemDocs);
      await db.purchases.put(updatedPurchase);
      for (const change of finalChanges) {
        if (change.entity === 'inventoryBatches') await db.inventoryBatches.put(change.record);
        else if (change.entity === 'products') await db.products.put(change.record);
        else if (change.entity === 'inventoryMovements') await db.inventoryMovements.put(change.record);
        else if (change.entity === 'suppliers') await db.suppliers.put(change.record);
        else if (change.entity === 'accounts') await db.accounts.put(change.record);
        else if (change.entity === 'journalEntries') await db.journalEntries.put(change.record);
        else if (change.entity === 'transactions') await db.transactions.put(change.record);
        else if (change.entity === 'auditLogs') await db.auditLogs.put(change.record);
      }
    });
    await flushNativeDatabaseMirrorWrites();
    return;
  }
  await db.transaction('rw', [
    db.purchaseReturns, db.purchaseReturnItems, db.purchases, db.inventoryBatches, db.products, db.suppliers,
    db.inventoryMovements, db.accounts, db.journalEntries, db.transactions,
  ], async () => {
    if (await db.purchaseReturns.get(id)) return;
    const origPurchase = await db.purchases.get(String(originalPurchaseId));
    if (!origPurchase) throw new Error('فاتورة الشراء الأصلية غير موجودة');
    const batches = await db.inventoryBatches.where('purchaseId').equals(String(originalPurchaseId)).toArray();
    let totalReturn = 0;
    let processedItems = 0;
    for (const reqItem of items) {
      const qty = roundQty(Number(reqItem.quantity || 0));
      if (qty <= 0) continue;
      const productId = Number(reqItem.productId);
      const batch = reqItem.batchId
        ? batches.find((entry) => String(entry.id) === String(reqItem.batchId))
        : batches.find((entry) => Number(entry.productId) === productId && Number(entry.remainingQuantity || 0) >= qty) || batches.find((entry) => Number(entry.productId) === productId);
      if (batch && batch.id) {
        const remaining = Number(batch.remainingQuantity || 0);
        if (remaining < qty) throw new Error('الكمية المتبقية في الدفعة أقل من كمية مرتجع المشتريات');
        await db.inventoryBatches.update(batch.id, { remainingQuantity: roundQty(remaining - qty), updatedAt: now, syncStatus });
      }
      const product = await db.products.get(productId);
      if (!batch && (!product || Number(product.stockQuantity || 0) < qty)) throw new Error('المخزون المتاح لا يكفي لإرجاع المنتج ' + String(reqItem.productName || productId));
      if (product) {
        const activeBatches = (await db.inventoryBatches.toArray()).filter((entry) => Number(entry.productId) === productId && Number(entry.remainingQuantity || 0) > 0);
        const activeQty = activeBatches.reduce((sum, entry) => sum + Number(entry.remainingQuantity || 0), 0);
        const activeValue = activeBatches.reduce((sum, entry) => sum + Number(entry.remainingQuantity || 0) * Number(entry.costPrice || 0), 0);
        await db.products.update(product.id!, {
          stockQuantity: roundQty(Number(product.stockQuantity || 0) - qty),
          ...(activeQty > 0 ? { costPrice: roundMoney(activeValue / activeQty) } : {}),
          updatedAt: now, syncStatus,
        });
      }
      const cost = Number(reqItem.costPrice ?? batch?.costPrice ?? 0);
      const lineTotal = roundMoney(qty * cost);
      totalReturn = roundMoney(totalReturn + lineTotal);
      const itemDoc: PurchaseReturnItem = {
        id: generateUUID(), purchaseReturnId: id, productId, productName: reqItem.productName || '',
        quantity: qty, costPrice: cost, total: lineTotal, batchId: batch?.id ? String(batch.id) : undefined,
        syncStatus, createdAt: now,
      };
      await db.purchaseReturnItems.put(itemDoc);
      processedItems += 1;
      await recordLocalInventoryMovement({
        movementKey: 'purchase_return:' + String(id) + ':out:' + String(productId) + ':' + String(processedItems),
        productId, movementType: 'purchase_return', sourceType: 'purchase_return', sourceId: String(id),
        quantityDeltaBase: -qty, unitCost: cost, totalCost: lineTotal, branchId: branchId ?? origPurchase.branchId,
        operationId, reason: reason || 'مرتجع مشتريات للمورد', createdBy, createdAt: now, syncStatus,
      });
    }
    if (processedItems === 0) throw new Error('لا توجد أصناف صالحة لمرتجع المشتريات');
    const newReturned = roundMoney(Number(origPurchase.returnedAmount || 0) + totalReturn);
    if (newReturned > roundMoney(Number(origPurchase.totalAmount || 0)) + 0.05) throw new Error('قيمة مرتجع المشتريات تتجاوز إجمالي فاتورة الشراء');
    const netPayable = Math.max(0, roundMoney(Number(origPurchase.totalAmount || 0) - newReturned));
    const paid = roundMoney(Number(origPurchase.paidAmount || 0));
    await db.purchases.update(origPurchase.id!, {
      returnedAmount: newReturned,
      paymentStatus: paid >= netPayable ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
      updatedAt: now, syncStatus,
    });
    if (refundMethod === 'credit_adjustment' && origPurchase.supplierId) {
      const supplier = await db.suppliers.get(origPurchase.supplierId);
      if (supplier) await db.suppliers.update(supplier.id!, { balance: roundMoney(Number(supplier.balance || 0) - totalReturn), updatedAt: now, syncStatus });
    }
    const retDoc: PurchaseReturn = {
      id, returnNumber, originalPurchaseId: String(originalPurchaseId), supplierId: origPurchase.supplierId,
      supplierName: origPurchase.supplierName, branchId: branchId ?? origPurchase.branchId, shiftId,
      refundMethod, totalReturn, reason, createdBy, createdAt: now, updatedAt: now, syncStatus,
    };
    await db.purchaseReturns.put(retDoc);
    if (shouldPostLocalAccounting(syncStatus) && totalReturn > 0) {
      const debitAccount = refundMethod === 'cash' ? '1010' : refundMethod === 'card' ? '1020' : '2100';
      await postLocalJournalEntry({
        referenceId: String(id), referenceType: 'purchase_return', entryKey: 'purchase-return-' + operationId, date: now,
        description: 'مرتجع مشتريات ' + String(returnNumber || id) + ' للمورد ' + String(origPurchase.supplierName || ''),
        lines: [
          { accountCode: debitAccount, debit: totalReturn, credit: 0, purchaseId: String(originalPurchaseId) },
          { accountCode: '1200', debit: 0, credit: totalReturn, purchaseId: String(originalPurchaseId) },
        ], createdBy, branchId: branchId ?? origPurchase.branchId,
      });
    }
  });
}
async function applyExpenseLocally(type: 'expense' | 'expense_delete', payload: any, syncStatus: 'synced' | 'pending') {
  const now = new Date().toISOString();
  if (isNativeAndroid()) {
    const expenseId = Number(payload?.id);
    if (!Number.isSafeInteger(expenseId) || expenseId <= 0) throw new Error('معرّف المصروف غير صالح');
    const existing = await nativePosRepository.get<any>('expenses', expenseId);
    const changes: any[] = [];
    const cacheJournalRecords: any[] = [];
    let expenseRecord: any = null;
    let auditRecord: any = null;
    if (type === 'expense_delete') {
      if (existing) {
        const [journals, transactions, accounts] = await Promise.all([
          nativePosRepository.whereEquals<any>('journalEntries', 'referenceId', String(expenseId)).then((entries: any[]) => entries.filter((entry: any) => entry.referenceType === 'expense')),
          nativePosRepository.getAll<any>('transactions'),
          nativePosRepository.getAll<any>('accounts'),
        ]);
        const accountMap = new Map<string, any>(accounts.map((account: any) => [String(account.code), account]));
        const reversedIds = new Set(journals.map((entry: any) => entry.reversedEntryId).filter(Boolean).map(String));
        for (const entry of journals) {
          if (entry.status !== 'posted' || reversedIds.has(String(entry.id))) continue;
          const lines = transactions.filter((line: any) => String(line.journalEntryId) === String(entry.id));
          if (!lines.length) continue;
          const reversalId = 'local-je:' + String(entry.referenceType || 'expense') + ':' + String(expenseId) + ':reversal-' + String(entry.id);
          if (journals.some((item: any) => String(item.id) === reversalId)) continue;
          const reversalLines = lines.map((line: any) => ({
            accountCode: String(line.accountId),
            debit: roundMoney(Number(line.credit || 0)),
            credit: roundMoney(Number(line.debit || 0)),
            description: 'عكس: ' + String(line.description || entry.description) + ' (حذف مصروف)',
          })).filter((line: any) => line.debit > 0 || line.credit > 0);
          const debit = roundMoney(reversalLines.reduce((sum: number, line: any) => sum + line.debit, 0));
          const credit = roundMoney(reversalLines.reduce((sum: number, line: any) => sum + line.credit, 0));
          if (Math.abs(debit - credit) > 0.02) throw new Error('قيد عكسي غير متوازن');
          const reversal = {
            id: reversalId, entryNumber: 'LOCAL-reversal-' + String(entry.id).slice(-16),
            date: now, referenceId: String(expenseId), referenceType: entry.referenceType || 'expense',
            description: 'قيد عكسي - ' + String(entry.description) + ' (حذف مصروف)',
            totalDebit: debit, totalCredit: credit, status: 'posted',
            createdBy: payload.createdBy || 'System', branchId: entry.branchId,
            syncStatus: currentDeviceRole === 'standalone' ? 'synced' : 'pending', createdAt: now,
          };
          changes.push({ action: 'put', entity: 'journalEntries', record: reversal, syncState: reversal.syncStatus });
          cacheJournalRecords.push(reversal);
          reversalLines.forEach((line: any, index: number) => {
            const account = accountMap.get(line.accountCode);
            const transaction = {
              id: reversalId + ':' + String(index), journalEntryId: reversalId,
              accountId: line.accountCode, accountName: account?.name || line.accountCode,
              type: line.debit > 0 ? 'debit' : 'credit',
              amount: line.debit > 0 ? line.debit : line.credit,
              debit: line.debit, credit: line.credit, description: line.description,
              syncStatus: reversal.syncStatus, createdAt: now,
            };
            changes.push({ action: 'put', entity: 'transactions', record: transaction, syncState: reversal.syncStatus });
            cacheJournalRecords.push(transaction);
            if (account) {
              const normalDebit = account.type === 'asset' || account.type === 'expense';
              accountMap.set(line.accountCode, {
                ...account,
                balance: roundMoney(Number(account.balance || 0) + (normalDebit ? line.debit - line.credit : line.credit - line.debit)),
                updatedAt: now,
              });
            }
          });
          const reversedEntry = { ...entry, status: 'reversed', reversedEntryId: reversalId };
          changes.push({ action: 'put', entity: 'journalEntries', record: reversedEntry, syncState: syncStatus });
          cacheJournalRecords.push(reversedEntry);
        }
        for (const account of accountMap.values()) {
          if (changes.some((change: any) => change.entity === 'accounts' && String(change.record.code) === String(account.code))) continue;
          if (transactions.some((line: any) => String(line.accountId) === String(account.code) &&
            journals.some((entry: any) => String(entry.id) === String(line.journalEntryId) && entry.status === 'posted' && !reversedIds.has(String(entry.id))))) {
            changes.push({ action: 'put', entity: 'accounts', record: account, syncState: syncStatus });
            cacheJournalRecords.push(account);
          }
        }
        changes.push({ action: 'delete', entity: 'expenses', key: expenseId });
        if (currentDeviceRole === 'standalone') {
          auditRecord = {
            id: generateUUID(), date: now, userName: payload.createdBy || 'System',
            type: 'expense_delete', operationName: 'حذف مصروف', action: 'حذف',
            details: existing.description, quantity: 1, value: Number(existing.amount || 0),
            branchId: existing.branchId, entityId: String(expenseId),
            entityName: existing.category, syncStatus,
          };
          changes.push({ action: 'put', entity: 'auditLogs', record: auditRecord, syncState: syncStatus });
        }
      }
    } else {
      if (existing) return;
      const amount = roundMoney(Number(payload.amount || 0));
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('قيمة المصروف غير صالحة');
      expenseRecord = {
        id: expenseId, description: payload.description, amount: Number(payload.amount || 0),
        category: payload.category || 'عام',
        paymentMethod: payload.paymentMethod === 'card' ? 'card' : 'cash',
        shiftId: payload.shiftId, date: payload.date || now, branchId: payload.branchId,
        createdAt: payload.createdAt || now, updatedAt: now, syncStatus,
      };
      changes.push({ action: 'put', entity: 'expenses', record: expenseRecord, syncState: syncStatus });
      if (shouldPostLocalAccounting(syncStatus)) {
        const cashCode = expenseRecord.paymentMethod === 'card' ? '1020' : '1010';
        const definitions: any = {
          '5200': { name: 'المصروفات التشغيلية', type: 'expense' },
          '1010': { name: 'الصندوق', type: 'asset' },
          '1020': { name: 'البنك / الشبكة', type: 'asset' },
        };
        const entryId = 'local-je:expense:' + String(expenseId) + ':expense-' + String(payload.operationId || expenseId);
        if (!(await nativePosRepository.get<any>('journalEntries', entryId))) {
          const accounts = new Map<string, any>();
          for (const code of ['5200', cashCode]) {
            const current = await nativePosRepository.get<any>('accounts', code);
            accounts.set(code, current || {
              code, ...definitions[code], balance: 0, isSystem: 1,
              createdAt: now, updatedAt: now,
            });
          }
          const description = 'مصروف (' + String(expenseRecord.category) + '): ' + String(expenseRecord.description || '');
          const entrySyncStatus = currentDeviceRole === 'standalone' ? 'synced' : 'pending';
          const entry = {
            id: entryId, entryNumber: 'LOCAL-expense-' + String(payload.operationId || expenseId) + '-' + String(expenseId).slice(0, 8),
            date: expenseRecord.date, referenceId: String(expenseId), referenceType: 'expense',
            description, totalDebit: amount, totalCredit: amount, status: 'posted',
            createdBy: payload.createdBy || 'System', branchId: payload.branchId,
            syncStatus: entrySyncStatus, createdAt: now,
          };
          changes.push({ action: 'put', entity: 'journalEntries', record: entry, syncState: entrySyncStatus });
          cacheJournalRecords.push(entry);
          const lines = [
            { accountCode: '5200', debit: amount, credit: 0 },
            { accountCode: cashCode, debit: 0, credit: amount },
          ];
          lines.forEach((line: any, index: number) => {
            const account = accounts.get(line.accountCode);
            const normalDebit = account.type === 'asset' || account.type === 'expense';
            const updatedAccount = {
              ...account,
              balance: roundMoney(Number(account.balance || 0) + (normalDebit ? line.debit - line.credit : line.credit - line.debit)),
              updatedAt: now,
            };
            accounts.set(line.accountCode, updatedAccount);
            const transaction = {
              id: entryId + ':' + String(index), journalEntryId: entryId,
              accountId: line.accountCode, accountName: account.name,
              type: line.debit > 0 ? 'debit' : 'credit',
              amount, debit: line.debit, credit: line.credit,
              description, syncStatus: entrySyncStatus, createdAt: now,
            };
            changes.push({ action: 'put', entity: 'transactions', record: transaction, syncState: entrySyncStatus });
            cacheJournalRecords.push(transaction);
          });
          for (const account of accounts.values()) {
            changes.push({ action: 'put', entity: 'accounts', record: account, syncState: entrySyncStatus });
            cacheJournalRecords.push(account);
          }
        }
      }
      if (currentDeviceRole === 'standalone') {
        auditRecord = {
          id: generateUUID(), date: expenseRecord.date, userName: payload.createdBy || 'System',
          type: 'expense', operationName: 'تسجيل مصروف', action: 'مصروف',
          details: String(expenseRecord.category) + ': ' + String(expenseRecord.description || ''),
          quantity: 1, value: amount, branchId: payload.branchId,
          entityId: String(expenseId), entityName: String(expenseRecord.category), syncStatus,
        };
        changes.push({ action: 'put', entity: 'auditLogs', record: auditRecord, syncState: syncStatus });
      }
    }
    if (changes.length === 0) return;
    const applied = await nativePosRepository.applyChanges(changes);
    if (applied !== changes.length) throw new Error('لم تؤكد SQLite حفظ جميع سجلات المصروف');
    await db.transaction('rw', [
      db.expenses, db.accounts, db.journalEntries, db.transactions, db.auditLogs,
    ], async () => {
      if (type === 'expense_delete' && existing) await db.expenses.delete(expenseId);
      if (expenseRecord) await db.expenses.put(expenseRecord);
      for (const record of cacheJournalRecords) {
        if (record.code) await db.accounts.put(record);
        else if (record.referenceType) await db.journalEntries.put(record);
        else if (record.journalEntryId) await db.transactions.put(record);
      }
      if (auditRecord) await db.auditLogs.put(auditRecord);
    });
    await flushNativeDatabaseMirrorWrites();
    return;
  }
  await db.transaction('rw', [db.expenses, db.accounts, db.journalEntries, db.transactions, db.auditLogs], async () => {
    if (type === 'expense_delete') {
      if (payload?.id !== undefined) {
        const existing = await db.expenses.get(Number(payload.id));
        if (existing) {
          await reverseLocalJournalEntriesByReference(String(payload.id), 'حذف مصروف', payload.createdBy);
          await db.expenses.delete(Number(payload.id));
          if (currentDeviceRole === 'standalone') await db.auditLogs.add({
            date: now, userName: payload.createdBy || 'System', type: 'expense_delete',
            operationName: 'حذف مصروف', action: 'حذف', details: existing.description,
            quantity: 1, value: Number(existing.amount || 0), branchId: existing.branchId,
            entityId: String(payload.id), entityName: existing.category, syncStatus,
          });
        }
      }
      return;
    }
    const expenseId = Number(payload.id);
    if (!Number.isFinite(expenseId) || expenseId <= 0) throw new Error('معرّف المصروف غير صالح');
    await db.expenses.put({
      id: expenseId, description: payload.description, amount: Number(payload.amount || 0),
      category: payload.category || 'عام', paymentMethod: payload.paymentMethod === 'card' ? 'card' : 'cash',
      shiftId: payload.shiftId, date: payload.date || now, branchId: payload.branchId,
      createdAt: payload.createdAt || now, updatedAt: now, syncStatus,
    });
    const amount = roundMoney(Number(payload.amount || 0));
    if (shouldPostLocalAccounting(syncStatus) && amount > 0) {
      await postLocalJournalEntry({
        referenceId: String(expenseId), referenceType: 'expense', entryKey: 'expense-' + String(payload.operationId || expenseId),
        date: payload.date || now, description: 'مصروف (' + String(payload.category || 'عام') + '): ' + String(payload.description || ''),
        lines: [
          { accountCode: '5200', debit: amount, credit: 0 },
          { accountCode: payload.paymentMethod === 'card' ? '1020' : '1010', debit: 0, credit: amount },
        ], createdBy: payload.createdBy, branchId: payload.branchId,
      });
    }
    if (currentDeviceRole === 'standalone') await db.auditLogs.add({
      date: payload.date || now, userName: payload.createdBy || 'System', type: 'expense',
      operationName: 'تسجيل مصروف', action: 'مصروف',
      details: String(payload.category || 'عام') + ': ' + String(payload.description || ''),
      quantity: 1, value: amount, branchId: payload.branchId,
      entityId: String(expenseId), entityName: String(payload.category || 'عام'), syncStatus,
    });
  });
}
async function applyCustomerPaymentLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const now = new Date().toISOString();
  const payAmount = roundMoney(Number(payload.amount || 0));
  const paymentId = String(payload.paymentId || payload.operationId || generateUUID());

  if (isNativeAndroid()) {
    if (await nativePosRepository.get<any>('customerPayments', paymentId)) return;
    const customerId = Number(payload.customerId);
    const customer = await nativePosRepository.get<any>('customers', customerId);
    if (!customer || !Number.isFinite(payAmount) || payAmount <= 0) {
      throw new Error('بيانات تحصيل العميل غير صالحة');
    }
    const orderId = payload.orderId ? String(payload.orderId) : undefined;
    const order = orderId ? await nativePosRepository.get<any>('orders', orderId) : null;
    const branchId = payload.branchId ?? customer.branchId;
    const method = payload.paymentMethod === 'card' ? 'card' : 'cash';
    const payment = {
      id: paymentId, customerId, customerName: customer.name || payload.customerName,
      orderId, amount: payAmount, paymentMethod: method, notes: payload.notes,
      shiftId: payload.shiftId, branchId, createdBy: payload.createdBy,
      operationId: payload.operationId, syncStatus, createdAt: now,
    };
    const updatedCustomer = {
      ...customer,
      balance: roundMoney(Number(customer.balance || 0) - payAmount),
      updatedAt: now, syncStatus,
    };
    const changes: any[] = [
      { action: 'put', entity: 'customers', record: updatedCustomer, syncState: syncStatus },
      { action: 'put', entity: 'customerPayments', record: payment, syncState: syncStatus },
    ];
    let updatedOrder: any = null;
    if (order) {
      updatedOrder = {
        ...order, paidAmount: roundMoney(Number(order.paidAmount || 0) + payAmount),
        updatedAt: now, syncStatus,
      };
      changes.push({ action: 'put', entity: 'orders', record: updatedOrder, syncState: syncStatus });
    }

    const journalRecords: any[] = [];
    if (shouldPostLocalAccounting(syncStatus) && payAmount > 0) {
      const cashCode = method === 'card' ? '1020' : '1010';
      const definitions = [
        { code: cashCode, name: method === 'card' ? 'البنك / الشبكة' : 'الصندوق', type: 'asset' },
        { code: '1100', name: 'ذمم العملاء', type: 'asset' },
      ];
      const accounts = new Map<string, any>();
      for (const definition of definitions) {
        const current = await nativePosRepository.get<any>('accounts', definition.code);
        accounts.set(definition.code, current || {
          ...definition, balance: 0, isSystem: 1, createdAt: now, updatedAt: now,
        });
      }
      const entryId = `local-je:payment:${paymentId}:customer-payment-${String(payload.operationId || paymentId)}`;
      if (!(await nativePosRepository.get<any>('journalEntries', entryId))) {
        const lines = [
          { accountCode: cashCode, debit: payAmount, credit: 0, orderId },
          { accountCode: '1100', debit: 0, credit: payAmount, orderId },
        ];
        const entry = {
          id: entryId, entryNumber: `LOCAL-customer-payment-${paymentId.slice(0, 8)}`,
          date: now, referenceId: paymentId, referenceType: 'payment',
          description: 'تحصيل دفعة من العميل: ' + String(customer.name || payload.customerName || ''),
          totalDebit: payAmount, totalCredit: payAmount, status: 'posted',
          createdBy: payload.createdBy || 'System', branchId, syncStatus,
          createdAt: now,
        };
        changes.push({ action: 'put', entity: 'journalEntries', record: entry, syncState: syncStatus });
        journalRecords.push(entry);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          const account = accounts.get(line.accountCode);
          const updatedAccount = {
            ...account,
            balance: roundMoney(Number(account.balance || 0) + ((account.type === 'asset' || account.type === 'expense') ? line.debit - line.credit : line.credit - line.debit)),
            updatedAt: now,
          };
          accounts.set(line.accountCode, updatedAccount);
          const transaction = {
            id: `${entryId}:${index}`, journalEntryId: entryId,
            accountId: line.accountCode, accountName: account.name,
            type: line.debit > 0 ? 'debit' : 'credit',
            amount: payAmount, debit: line.debit, credit: line.credit,
            description: entry.description, orderId, syncStatus, createdAt: now,
          };
          changes.push({ action: 'put', entity: 'transactions', record: transaction, syncState: syncStatus });
          journalRecords.push(transaction);
        }
        for (const account of accounts.values()) {
          changes.push({ action: 'put', entity: 'accounts', record: account, syncState: syncStatus });
          journalRecords.push(account);
        }
      }
    }

    let auditRecord: any = null;
    if (currentDeviceRole === 'standalone') {
      auditRecord = {
        id: generateUUID(), date: now, userName: payload.createdBy || 'System',
        type: 'customer_payment', action: 'تحصيل عميل', operationName: 'سداد ذمم عميل',
        details: 'تحصيل ' + payAmount + ' من العميل ' + String(customer.name || ''),
        quantity: 1, value: payAmount, branchId,
        entityId: String(customer.id), entityName: customer.name, syncStatus,
      };
      changes.push({ action: 'put', entity: 'auditLogs', record: auditRecord, syncState: syncStatus });
    }

    const applied = await nativePosRepository.applyChanges(changes);
    if (applied !== changes.length) {
      throw new Error('لم تؤكد SQLite حفظ جميع سجلات تحصيل العميل');
    }

    await db.transaction('rw', [
      db.customers, db.orders, db.customerPayments, db.accounts,
      db.journalEntries, db.transactions, db.auditLogs,
    ], async () => {
      await db.customers.put(updatedCustomer);
      if (updatedOrder) await db.orders.put(updatedOrder);
      await db.customerPayments.put(payment);
      for (const record of journalRecords) {
        if (record.code) await db.accounts.put(record);
        else if (record.referenceType === 'payment') await db.journalEntries.put(record);
        else if (record.journalEntryId) await db.transactions.put(record);
      }
      if (auditRecord) await db.auditLogs.put(auditRecord);
    });
    await flushNativeDatabaseMirrorWrites();
    return;
  }

  await db.transaction('rw', [db.customers, db.orders, db.customerPayments, db.accounts, db.journalEntries, db.transactions, db.auditLogs], async () => {
    if (await db.customerPayments.get(paymentId)) return;
    const cust = await db.customers.get(Number(payload.customerId));
    if (!cust || payAmount <= 0) throw new Error('بيانات تحصيل العميل غير صالحة');
    await db.customers.update(cust.id!, {
      balance: roundMoney((cust.balance || 0) - payAmount),
      updatedAt: now, syncStatus,
    });
    if (payload.orderId) {
      const ord = await db.orders.get(String(payload.orderId));
      if (ord) await db.orders.update(ord.id!, {
        paidAmount: roundMoney((ord.paidAmount || 0) + payAmount),
        updatedAt: now, syncStatus,
      });
    }
    await db.customerPayments.put({
      id: paymentId, customerId: Number(payload.customerId),
      customerName: cust.name || payload.customerName, orderId: payload.orderId,
      amount: payAmount, paymentMethod: payload.paymentMethod === 'card' ? 'card' : 'cash',
      notes: payload.notes, shiftId: payload.shiftId, branchId: payload.branchId ?? cust.branchId,
      createdBy: payload.createdBy, operationId: payload.operationId,
      syncStatus, createdAt: now,
    });
    if (shouldPostLocalAccounting(syncStatus) && payAmount > 0) await postLocalJournalEntry({
      referenceId: paymentId, referenceType: 'payment',
      entryKey: 'customer-payment-' + String(payload.operationId || paymentId),
      date: now, description: 'تحصيل دفعة من العميل: ' + String(cust.name || payload.customerName || ''),
      lines: [
        { accountCode: payload.paymentMethod === 'card' ? '1020' : '1010', debit: payAmount, credit: 0, orderId: payload.orderId },
        { accountCode: '1100', debit: 0, credit: payAmount, orderId: payload.orderId },
      ], createdBy: payload.createdBy, branchId: payload.branchId ?? cust.branchId,
    });
    if (currentDeviceRole === 'standalone') await db.auditLogs.add({
      date: now, userName: payload.createdBy || 'System', type: 'customer_payment',
      action: 'تحصيل عميل', operationName: 'سداد ذمم عميل',
      details: 'تحصيل ' + payAmount + ' من العميل ' + String(cust.name || ''),
      quantity: 1, value: payAmount, branchId: payload.branchId ?? cust.branchId ?? undefined,
      entityId: String(cust.id), entityName: cust.name, syncStatus,
    });
  });
}

async function applySupplierPaymentLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const now = new Date().toISOString();
  const payAmount = roundMoney(Number(payload.amount || 0));
  const paymentId = String(payload.paymentId || payload.operationId || generateUUID());

  if (isNativeAndroid()) {
    if (await nativePosRepository.get<any>('supplierPayments', paymentId)) return;
    const supplierId = Number(payload.supplierId);
    const supplier = await nativePosRepository.get<any>('suppliers', supplierId);
    if (!supplier || !Number.isFinite(payAmount) || payAmount <= 0) {
      throw new Error('بيانات سداد المورد غير صالحة');
    }
    const purchaseId = payload.purchaseId ? String(payload.purchaseId) : undefined;
    const purchase = purchaseId ? await nativePosRepository.get<any>('purchases', purchaseId) : null;
    const paymentMethod = payload.paymentMethod === 'card' ? 'card' : 'cash';
    const branchId = payload.branchId ?? supplier.branchId;
    const payment = {
      id: paymentId, supplierId, supplierName: supplier.name || payload.supplierName,
      purchaseId, amount: payAmount, paymentMethod, notes: payload.notes,
      shiftId: payload.shiftId, branchId, createdBy: payload.createdBy,
      operationId: payload.operationId, syncStatus, createdAt: now,
    };
    const updatedSupplier = {
      ...supplier, balance: roundMoney(Number(supplier.balance || 0) - payAmount),
      updatedAt: now, syncStatus,
    };
    const changes: any[] = [
      { action: 'put', entity: 'suppliers', record: updatedSupplier, syncState: syncStatus },
      { action: 'put', entity: 'supplierPayments', record: payment, syncState: syncStatus },
    ];
    let updatedPurchase: any = null;
    if (purchase) {
      const paidAmount = roundMoney(Number(purchase.paidAmount || 0) + payAmount);
      const netPayable = Math.max(0, roundMoney(Number(purchase.totalAmount || 0) - Number(purchase.returnedAmount || 0)));
      updatedPurchase = {
        ...purchase, paidAmount,
        paymentStatus: paidAmount >= netPayable ? 'paid' : 'partial',
        syncStatus,
      };
      changes.push({ action: 'put', entity: 'purchases', record: updatedPurchase, syncState: syncStatus });
    }

    const accountingRecords: any[] = [];
    if (shouldPostLocalAccounting(syncStatus)) {
      const cashCode = paymentMethod === 'card' ? '1020' : '1010';
      const definitions = [
        { code: '2100', name: 'ذمم الموردين', type: 'liability' },
        { code: cashCode, name: paymentMethod === 'card' ? 'البنك / الشبكة' : 'الصندوق', type: 'asset' },
      ];
      const accounts = new Map<string, any>();
      for (const definition of definitions) {
        const current = await nativePosRepository.get<any>('accounts', definition.code);
        accounts.set(definition.code, current || {
          ...definition, balance: 0, isSystem: 1, createdAt: now, updatedAt: now,
        });
      }
      const entryId = `local-je:payment:${paymentId}:supplier-payment-${String(payload.operationId || paymentId)}`;
      if (!(await nativePosRepository.get<any>('journalEntries', entryId))) {
        const entry = {
          id: entryId, entryNumber: `LOCAL-supplier-payment-${paymentId.slice(0, 8)}`,
          date: now, referenceId: paymentId, referenceType: 'payment',
          description: 'سداد دفعة للمورد: ' + String(supplier.name || payload.supplierName || ''),
          totalDebit: payAmount, totalCredit: payAmount, status: 'posted',
          createdBy: payload.createdBy || 'System', branchId, syncStatus, createdAt: now,
        };
        changes.push({ action: 'put', entity: 'journalEntries', record: entry, syncState: syncStatus });
        accountingRecords.push(entry);
        const lines = [
          { accountCode: '2100', debit: payAmount, credit: 0 },
          { accountCode: cashCode, debit: 0, credit: payAmount },
        ];
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          const account = accounts.get(line.accountCode);
          const normalDebit = account.type === 'asset' || account.type === 'expense';
          const delta = normalDebit ? line.debit - line.credit : line.credit - line.debit;
          accounts.set(line.accountCode, {
            ...account, balance: roundMoney(Number(account.balance || 0) + delta), updatedAt: now,
          });
          const transaction = {
            id: `${entryId}:${index}`, journalEntryId: entryId,
            accountId: line.accountCode, accountName: account.name,
            type: line.debit > 0 ? 'debit' : 'credit', amount: payAmount,
            debit: line.debit, credit: line.credit,
            description: entry.description, purchaseId, syncStatus, createdAt: now,
          };
          changes.push({ action: 'put', entity: 'transactions', record: transaction, syncState: syncStatus });
          accountingRecords.push(transaction);
        }
        for (const account of accounts.values()) {
          changes.push({ action: 'put', entity: 'accounts', record: account, syncState: syncStatus });
          accountingRecords.push(account);
        }
      }
    }

    let auditRecord: any = null;
    if (currentDeviceRole === 'standalone') {
      auditRecord = {
        id: generateUUID(), date: now, userName: payload.createdBy || 'System',
        type: 'supplier_payment', action: 'سداد مورد', operationName: 'دفع مستحقات مورد',
        details: 'سداد ' + payAmount + ' للمورد ' + String(supplier.name || ''),
        quantity: 1, value: payAmount, branchId,
        entityId: String(supplier.id), entityName: supplier.name, syncStatus,
      };
      changes.push({ action: 'put', entity: 'auditLogs', record: auditRecord, syncState: syncStatus });
    }

    const applied = await nativePosRepository.applyChanges(changes);
    if (applied !== changes.length) throw new Error('لم تؤكد SQLite حفظ جميع سجلات سداد المورد');
    await db.transaction('rw', [
      db.suppliers, db.purchases, db.supplierPayments, db.accounts,
      db.journalEntries, db.transactions, db.auditLogs,
    ], async () => {
      await db.suppliers.put(updatedSupplier);
      if (updatedPurchase) await db.purchases.put(updatedPurchase);
      await db.supplierPayments.put(payment);
      for (const record of accountingRecords) {
        if (record.code) await db.accounts.put(record);
        else if (record.referenceType === 'payment') await db.journalEntries.put(record);
        else if (record.journalEntryId) await db.transactions.put(record);
      }
      if (auditRecord) await db.auditLogs.put(auditRecord);
    });
    await flushNativeDatabaseMirrorWrites();
    return;
  }

  await db.transaction('rw', [db.suppliers, db.purchases, db.supplierPayments, db.accounts, db.journalEntries, db.transactions, db.auditLogs], async () => {
    const paymentId = String(payload.paymentId || payload.operationId || generateUUID());
    if (await db.supplierPayments.get(paymentId)) return;
    const sup = await db.suppliers.get(Number(payload.supplierId));
    if (!sup || payAmount <= 0) throw new Error('بيانات سداد المورد غير صالحة');
    if (sup) {
      await db.suppliers.update(sup.id!, {
        balance: roundMoney((sup.balance || 0) - payAmount),
        updatedAt: now,
        syncStatus,
      });
    }
    if (payload.purchaseId) {
      const p = await db.purchases.get(String(payload.purchaseId));
      if (p) {
        const newPaid = roundMoney((p.paidAmount || 0) + payAmount);
        const netPayable = Math.max(0, roundMoney(p.totalAmount - (p.returnedAmount || 0)));
        await db.purchases.update(p.id!, {
          paidAmount: newPaid,
          paymentStatus: newPaid >= netPayable ? 'paid' : 'partial',
          syncStatus,
        });
      }
    }
    await db.supplierPayments.put({
      id: paymentId,
      supplierId: Number(payload.supplierId),
      supplierName: sup?.name || payload.supplierName,
      purchaseId: payload.purchaseId ? String(payload.purchaseId) : undefined,
      amount: payAmount,
      paymentMethod: payload.paymentMethod === 'card' ? 'card' : 'cash',
      notes: payload.notes,
      shiftId: payload.shiftId,
      branchId: payload.branchId,
      createdBy: payload.createdBy,
      operationId: payload.operationId,
      syncStatus,
      createdAt: now,
    });
    if (shouldPostLocalAccounting(syncStatus) && payAmount > 0) await postLocalJournalEntry({
      referenceId: String(paymentId), referenceType: 'payment', entryKey: 'supplier-payment-' + String(payload.operationId || paymentId),
      date: now, description: 'سداد دفعة للمورد: ' + String(sup?.name || payload.supplierName || ''),
      lines: [
        { accountCode: '2100', debit: payAmount, credit: 0, purchaseId: payload.purchaseId },
        { accountCode: payload.paymentMethod === 'card' ? '1020' : '1010', debit: 0, credit: payAmount, purchaseId: payload.purchaseId },
      ], createdBy: payload.createdBy, branchId: payload.branchId,
    });
    if (currentDeviceRole === 'standalone') await db.auditLogs.add({
      date: now, userName: payload.createdBy || 'System', type: 'supplier_payment',
      action: 'سداد مورد', operationName: 'دفع مستحقات مورد',
      details: 'سداد ' + payAmount + ' للمورد ' + String(sup.name || ''),
      quantity: 1, value: payAmount, branchId: payload.branchId,
      entityId: String(sup.id), entityName: sup.name, syncStatus,
    });
  });
}

async function applyPayrollLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const now = new Date().toISOString();
  const payrollId = Number(payload.id);
  if (!Number.isSafeInteger(payrollId) || payrollId <= 0) throw new Error('معرّف مسير الراتب غير صالح');
  if (isNativeAndroid()) {
    if (await nativePosRepository.get<any>('payroll', payrollId)) return;
    const record = {
      id: payrollId, employeeId: Number(payload.employeeId), employeeName: payload.employeeName,
      periodStart: payload.periodStart, periodEnd: payload.periodEnd,
      salaryType: payload.salaryType === 'hourly' ? 'hourly' : 'monthly',
      totalHours: Number(payload.totalHours || 0), hourlyRate: Number(payload.hourlyRate || 0),
      basicSalary: Number(payload.basicSalary || 0), bonuses: Number(payload.bonuses || 0),
      deductions: Number(payload.deductions || 0), netSalary: Number(payload.netSalary || 0),
      paymentMethod: payload.paymentMethod === 'card' ? 'card' : 'cash', branchId: payload.branchId,
      paymentDate: payload.paymentDate || now, status: payload.status || 'paid', syncStatus,
    };
    if (!Number.isFinite(record.netSalary) || record.netSalary < 0) {
      throw new Error('صافي الراتب غير صالح');
    }
    const changes: any[] = [
      { action: 'put', entity: 'payroll', record, syncState: syncStatus },
    ];
    const accountingRecords: any[] = [];
    if (shouldPostLocalAccounting(syncStatus) && record.netSalary > 0 && record.status === 'paid') {
      const cashCode = record.paymentMethod === 'card' ? '1020' : '1010';
      const definitions = [
        { code: '5300', name: 'مصروف الرواتب', type: 'expense' },
        { code: cashCode, name: record.paymentMethod === 'card' ? 'البنك / الشبكة' : 'الصندوق', type: 'asset' },
      ];
      const accounts = new Map<string, any>();
      for (const definition of definitions) {
        const current = await nativePosRepository.get<any>('accounts', definition.code);
        accounts.set(definition.code, current || {
          ...definition, balance: 0, isSystem: 1, createdAt: now, updatedAt: now,
        });
      }
      const entryId = `local-je:payroll:${payrollId}:payroll-${String(payload.operationId || payrollId)}`;
      if (!(await nativePosRepository.get<any>('journalEntries', entryId))) {
        const entry = {
          id: entryId, entryNumber: `LOCAL-payroll-${payrollId}`,
          date: record.paymentDate, referenceId: String(payrollId), referenceType: 'payroll',
          description: 'صرف راتب الموظف: ' + String(record.employeeName || ''),
          totalDebit: roundMoney(record.netSalary), totalCredit: roundMoney(record.netSalary),
          status: 'posted', createdBy: payload.createdBy || 'System',
          branchId: record.branchId, syncStatus, createdAt: now,
        };
        changes.push({ action: 'put', entity: 'journalEntries', record: entry, syncState: syncStatus });
        accountingRecords.push(entry);
        const lines = [
          { accountCode: '5300', debit: roundMoney(record.netSalary), credit: 0 },
          { accountCode: cashCode, debit: 0, credit: roundMoney(record.netSalary) },
        ];
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          const account = accounts.get(line.accountCode);
          const normalDebit = account.type === 'asset' || account.type === 'expense';
          const delta = normalDebit ? line.debit - line.credit : line.credit - line.debit;
          accounts.set(line.accountCode, {
            ...account, balance: roundMoney(Number(account.balance || 0) + delta), updatedAt: now,
          });
          const transaction = {
            id: `${entryId}:${index}`, journalEntryId: entryId,
            accountId: line.accountCode, accountName: account.name,
            type: line.debit > 0 ? 'debit' : 'credit',
            amount: roundMoney(record.netSalary), debit: line.debit, credit: line.credit,
            description: entry.description, syncStatus, createdAt: now,
          };
          changes.push({ action: 'put', entity: 'transactions', record: transaction, syncState: syncStatus });
          accountingRecords.push(transaction);
        }
        for (const account of accounts.values()) {
          changes.push({ action: 'put', entity: 'accounts', record: account, syncState: syncStatus });
          accountingRecords.push(account);
        }
      }
    }
    let auditRecord: any = null;
    if (currentDeviceRole === 'standalone') {
      auditRecord = {
        id: generateUUID(), date: record.paymentDate, userName: payload.createdBy || 'System',
        type: 'payroll', operationName: 'مسير رواتب', action: 'صرف راتب',
        details: 'صرف راتب ' + String(record.employeeName || '') + ' (' + (record.salaryType === 'hourly' ? 'بالساعة' : 'شهري') + ')',
        quantity: 1, value: record.netSalary, branchId: record.branchId,
        entityId: String(payrollId), entityName: record.employeeName, syncStatus,
      };
      changes.push({ action: 'put', entity: 'auditLogs', record: auditRecord, syncState: syncStatus });
    }
    const applied = await nativePosRepository.applyChanges(changes);
    if (applied !== changes.length) throw new Error('لم تؤكد SQLite حفظ جميع سجلات مسير الراتب');
    await db.transaction('rw', [db.payroll, db.accounts, db.journalEntries, db.transactions, db.auditLogs], async () => {
      await db.payroll.put(record);
      for (const item of accountingRecords) {
        if (item.code) await db.accounts.put(item);
        else if (item.referenceType === 'payroll') await db.journalEntries.put(item);
        else if (item.journalEntryId) await db.transactions.put(item);
      }
      if (auditRecord) await db.auditLogs.put(auditRecord);
    });
    await flushNativeDatabaseMirrorWrites();
    return;
  }
  await db.transaction('rw', [db.payroll, db.accounts, db.journalEntries, db.transactions, db.auditLogs], async () => {
    if (await db.payroll.get(payrollId)) return;
    const record = {
      id: payrollId, employeeId: Number(payload.employeeId), employeeName: payload.employeeName,
      periodStart: payload.periodStart, periodEnd: payload.periodEnd,
      salaryType: payload.salaryType === 'hourly' ? 'hourly' : 'monthly',
      totalHours: Number(payload.totalHours || 0), hourlyRate: Number(payload.hourlyRate || 0),
      basicSalary: Number(payload.basicSalary || 0), bonuses: Number(payload.bonuses || 0),
      deductions: Number(payload.deductions || 0), netSalary: Number(payload.netSalary || 0),
      paymentMethod: payload.paymentMethod === 'card' ? 'card' : 'cash', branchId: payload.branchId,
      paymentDate: payload.paymentDate || now, status: payload.status || 'paid', syncStatus,
    };
    await db.payroll.put(record);
    if (shouldPostLocalAccounting(syncStatus) && record.netSalary > 0 && record.status === 'paid') {
      await postLocalJournalEntry({
        referenceId: String(payrollId), referenceType: 'payroll', entryKey: 'payroll-' + String(payload.operationId || payrollId),
        date: record.paymentDate, description: 'صرف راتب الموظف: ' + String(record.employeeName || ''),
        lines: [
          { accountCode: '5300', debit: roundMoney(record.netSalary), credit: 0 },
          { accountCode: record.paymentMethod === 'card' ? '1020' : '1010', debit: 0, credit: roundMoney(record.netSalary) },
        ], createdBy: payload.createdBy, branchId: record.branchId,
      });
    }
    if (currentDeviceRole === 'standalone') await db.auditLogs.add({
      date: record.paymentDate, userName: payload.createdBy || 'System', type: 'payroll',
      operationName: 'مسير رواتب', action: 'صرف راتب',
      details: 'صرف راتب ' + String(record.employeeName || '') + ' (' + (record.salaryType === 'hourly' ? 'بالساعة' : 'شهري') + ')',
      quantity: 1, value: record.netSalary, branchId: record.branchId,
      entityId: String(payrollId), entityName: record.employeeName, syncStatus,
    });
  });
}
async function applyShiftLocally(
  type: 'shift_open' | 'shift_close' | 'shift_movement',
  payload: any,
  syncStatus: 'synced' | 'pending'
) {
  const now = new Date().toISOString();
  if (type === 'shift_movement') {
    if (isNativeAndroid()) {
      const shiftId = String(payload.shiftId);
      const shiftKey = payload.shiftId !== undefined && payload.shiftId !== null && String(payload.shiftId).trim() !== '' && Number.isFinite(Number(payload.shiftId))
        ? Number(payload.shiftId)
        : shiftId;
      const shift = await nativePosRepository.get<any>('shifts', shiftKey);
      if (!shift || shift.status !== 'open') throw new Error('لا يمكن تسجيل حركة نقدية على وردية غير مفتوحة');
      const movementId = String(payload.id || generateUUID());
      const existingMovement = await nativePosRepository.get<any>('shiftMovements', movementId);
      if (existingMovement) return;
      const amount = roundMoney(Number(payload.amount || 0));
      if (amount <= 0) throw new Error('قيمة حركة الصندوق غير صالحة');
      const movementType = payload.type === 'withdrawal' ? 'withdrawal' : 'deposit';
      const createdAt = payload.createdAt || now;
      const branchId = payload.branchId ?? shift.branchId;
      const movement = {
        id: movementId, shiftId, type: movementType, amount,
        reason: payload.reason || (movementType === 'deposit' ? 'إيداع نقدي بالصندوق' : 'سحب نقدي من الصندوق'),
        createdBy: payload.createdBy, branchId,
        operationId: payload.operationId, createdAt, syncStatus,
      };
      const changes: Array<{ action: 'put'; entity: any; record: Record<string, unknown>; syncState: any }> = [
        { action: 'put', entity: 'shiftMovements', record: movement, syncState: syncStatus },
      ];
      let journalEntry: any = null;
      const journalLines: any[] = [];
      const transactionRecords: any[] = [];
      const accountRecords: any[] = [];
      if (shouldPostLocalAccounting(syncStatus)) {
        const entryKey = 'shift-movement-' + String(payload.operationId || movementId);
        const entryId = `local-je:shift_movement:${movementId}:${entryKey}`;
        journalEntry = await nativePosRepository.get<any>('journalEntries', entryId);
        if (!journalEntry) {
          const cash = await nativePosRepository.get<any>('accounts', '1010') || {
            code: '1010', name: 'الصندوق', type: 'asset', balance: 0, isSystem: 1, createdAt, updatedAt: createdAt,
          };
          const equity = await nativePosRepository.get<any>('accounts', '3100') || {
            code: '3100', name: 'رأس المال والأرصدة الافتتاحية', type: 'equity', balance: 0, isSystem: 1, createdAt, updatedAt: createdAt,
          };
          const lines = movementType === 'deposit'
            ? [{ accountCode: '1010', debit: amount, credit: 0 }, { accountCode: '3100', debit: 0, credit: amount }]
            : [{ accountCode: '3100', debit: amount, credit: 0 }, { accountCode: '1010', debit: 0, credit: amount }];
          journalEntry = {
            id: entryId, entryNumber: `LOCAL-${entryKey}-${movementId.slice(0, 8)}`,
            date: createdAt, referenceId: movementId, referenceType: 'shift_movement',
            description: (movementType === 'deposit' ? 'إيداع نقدي بالوردية: ' : 'سحب نقدي من الوردية: ') + String(payload.reason || ''),
            totalDebit: amount, totalCredit: amount, status: 'posted',
            createdBy: payload.createdBy || 'System', branchId, syncStatus,
            createdAt,
          };
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const account = line.accountCode === '1010' ? cash : equity;
            const normalDebit = account.type === 'asset' || account.type === 'expense';
            const delta = normalDebit ? line.debit - line.credit : line.credit - line.debit;
            accountRecords.push({ ...account, balance: roundMoney(Number(account.balance || 0) + delta), updatedAt: createdAt });
            transactionRecords.push({
              id: `${entryId}:${index}`, journalEntryId: entryId,
              accountId: line.accountCode, accountName: account.name,
              type: line.debit > 0 ? 'debit' : 'credit',
              amount: line.debit > 0 ? line.debit : line.credit,
              debit: line.debit, credit: line.credit,
              description: (movementType === 'deposit' ? 'إيداع نقدي بالوردية: ' : 'سحب نقدي من الوردية: ') + String(payload.reason || ''),
              syncStatus, createdAt,
            });
          }
          changes.push(
            { action: 'put', entity: 'accounts', record: accountRecords[0], syncState: syncStatus },
            { action: 'put', entity: 'accounts', record: accountRecords[1], syncState: syncStatus },
            { action: 'put', entity: 'journalEntries', record: journalEntry, syncState: syncStatus },
            ...transactionRecords.map((record) => ({ action: 'put' as const, entity: 'transactions', record, syncState: syncStatus })),
          );
        }
      }
      let auditRecord: any = null;
      if (currentDeviceRole === 'standalone') {
        auditRecord = {
          id: generateUUID(), date: createdAt, userName: payload.createdBy || 'System', type: 'shift_movement',
          action: movementType === 'deposit' ? 'إيداع نقدي' : 'سحب نقدي',
          operationName: 'حركة صندوق الوردية',
          details: String(payload.reason || (movementType === 'deposit' ? 'إيداع نقدي بالصندوق' : 'سحب نقدي من الصندوق')) + ' (وردية ' + shiftId + ')',
          quantity: 1, value: amount, branchId, entityId: movementId, entityName: shiftId, syncStatus,
        };
        changes.push({ action: 'put', entity: 'auditLogs', record: auditRecord, syncState: syncStatus });
      }
      await nativePosRepository.applyChanges(changes);
      await db.transaction('rw', [db.shiftMovements, db.accounts, db.journalEntries, db.transactions, db.auditLogs], async () => {
        await db.shiftMovements.put(movement as any);
        if (journalEntry && accountRecords.length) {
          await db.accounts.bulkPut(accountRecords as any);
          await db.journalEntries.put(journalEntry);
          await db.transactions.bulkPut(transactionRecords);
        }
        if (auditRecord) await db.auditLogs.put(auditRecord as any);
      });
      await flushNativeDatabaseMirrorWrites();
      return;
    }
    await db.transaction('rw', [db.shifts, db.shiftMovements, db.accounts, db.journalEntries, db.transactions, db.auditLogs], async () => {
      const shift = await db.shifts.get(String(payload.shiftId));
      if (!shift || shift.status !== 'open') throw new Error('لا يمكن تسجيل حركة نقدية على وردية غير مفتوحة');
      const movementId = String(payload.id || generateUUID());
      const amount = roundMoney(Number(payload.amount || 0));
      if (amount <= 0) throw new Error('قيمة حركة الصندوق غير صالحة');
      const movementType = payload.type === 'withdrawal' ? 'withdrawal' : 'deposit';
      await db.shiftMovements.put({
        id: movementId, shiftId: String(payload.shiftId), type: movementType, amount,
        reason: payload.reason || (movementType === 'deposit' ? 'إيداع نقدي بالصندوق' : 'سحب نقدي من الصندوق'),
        createdBy: payload.createdBy, branchId: payload.branchId ?? shift.branchId,
        operationId: payload.operationId, createdAt: payload.createdAt || now, syncStatus,
      });
      if (shouldPostLocalAccounting(syncStatus)) await postLocalJournalEntry({
        referenceId: movementId, referenceType: 'shift_movement', entryKey: 'shift-movement-' + String(payload.operationId || movementId),
        date: payload.createdAt || now, description: (movementType === 'deposit' ? 'إيداع نقدي بالوردية: ' : 'سحب نقدي من الوردية: ') + String(payload.reason || ''),
        lines: movementType === 'deposit'
          ? [{ accountCode: '1010', debit: amount, credit: 0 }, { accountCode: '3100', debit: 0, credit: amount }]
          : [{ accountCode: '3100', debit: amount, credit: 0 }, { accountCode: '1010', debit: 0, credit: amount }],
        createdBy: payload.createdBy, branchId: payload.branchId ?? shift.branchId,
      });
      if (currentDeviceRole === 'standalone') await db.auditLogs.add({
        date: payload.createdAt || now, userName: payload.createdBy || 'System', type: 'shift_movement',
        action: movementType === 'deposit' ? 'إيداع نقدي' : 'سحب نقدي',
        operationName: 'حركة صندوق الوردية',
        details: String(payload.reason || (movementType === 'deposit' ? 'إيداع نقدي بالصندوق' : 'سحب نقدي من الصندوق')) + ' (وردية ' + String(payload.shiftId) + ')',
        quantity: 1, value: amount, branchId: payload.branchId ?? shift.branchId,
        entityId: movementId, entityName: String(payload.shiftId), syncStatus,
      });
    });
    return;
  }
  if (type === 'shift_open') {
    const shiftId = String(payload.id);
    // SQLite is the authoritative Android store. Read it first so an existing
    // shift is never recreated from a stale Dexie cache.
    if (isNativeAndroid()) {
      const existing = await nativePosRepository.get<any>('shifts', payload.id);
      if (existing) return;
      const record = {
        id: payload.id,
        startTime: payload.startTime || now,
        openingCash: Number(payload.openingCash || 0),
        status: 'open',
        branchId: payload.branchId,
        syncStatus,
      };
      await nativePosRepository.put('shifts', record, syncStatus);
      await db.shifts.put(record as any);
      await flushNativeDatabaseMirrorWrites();
      return;
    }
    if (await db.shifts.get(shiftId)) return;
    await db.shifts.put({
      id: payload.id,
      startTime: payload.startTime || now,
      openingCash: Number(payload.openingCash || 0),
      status: 'open',
      branchId: payload.branchId,
      syncStatus,
    });
  } else if (type === 'shift_close') {
    if (isNativeAndroid()) {
      const shiftId = String(payload.id);
      const existing = await nativePosRepository.get<any>('shifts', payload.id);
      if (!existing) return;
      const record = {
        ...existing,
        endTime: payload.endTime || now,
        expectedCash: Number(payload.expectedCash || 0),
        actualCash: Number(payload.actualCash || 0),
        status: 'closed',
        syncStatus,
      };
      await nativePosRepository.put('shifts', record, syncStatus);
      await db.shifts.put(record as any);
      await flushNativeDatabaseMirrorWrites();
      return;
    }
    await db.shifts.update(payload.id, {
      endTime: payload.endTime || now,
      expectedCash: Number(payload.expectedCash || 0),
      actualCash: Number(payload.actualCash || 0),
      status: 'closed',
      syncStatus,
    });
  } else {
    await db.shiftMovements.put({
      id: payload.id || generateUUID(),
      shiftId: String(payload.shiftId),
      type: payload.type === 'withdrawal' ? 'withdrawal' : 'deposit',
      amount: Number(payload.amount || 0),
      reason: payload.reason,
      createdBy: payload.createdBy,
      branchId: payload.branchId,
      operationId: payload.operationId,
      createdAt: payload.createdAt || now,
      syncStatus,
    });
  }
}

async function applyStocktakeApproveLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const now = new Date().toISOString();
  const sessionId = String(payload.sessionId);
  const operationId = String(payload.operationId || sessionId);
  const deviceId = String(payload.deviceId || 'local-device');
  if (isNativeAndroid()) {
    const session = await nativePosRepository.get<any>('stocktakingSessions', sessionId);
    if (!session) throw new Error('جلسة الجرد غير موجودة');
    if (session.status === 'approved') return;
    const entries = await nativePosRepository.whereEquals<any>('stocktakingEntries', 'sessionId', sessionId);
    const [products, batches, movements, accounts, existingJournals] = await Promise.all([
      nativePosRepository.getAll<any>('products'),
      nativePosRepository.getAll<any>('inventoryBatches'),
      nativePosRepository.getAll<any>('inventoryMovements'),
      nativePosRepository.getAll<any>('accounts'),
      nativePosRepository.getAll<any>('journalEntries'),
    ]);
    const productMap = new Map<number, any>(products.map((p: any) => [Number(p.id), p]));
    const batchMap = new Map<string, any>(batches.map((b: any) => [String(b.id), b]));
    const accountMap = new Map<string, any>(accounts.map((a: any) => [String(a.code), a]));
    const movementKeys = new Set(movements.map((m: any) => String(m.movementKey)));
    const valuation = await nativePosRepository.firstWhereEquals<any>('settings', 'key', 'inventoryValuationMethod');
    const weightedAverage = valuation?.value === 'weighted_average';
    const changes = new Map<string, { action: 'put'; entity: any; record: any; syncState: any }>();
    const put = (entity: any, record: any) => {
      const keyField = entity === 'accounts' ? 'code' : 'id';
      changes.set(entity + ':' + String(record[keyField]), { action: 'put', entity, record, syncState: syncStatus });
    };
    const changedProducts = new Map<number, any>();
    const changedBatches = new Map<string, any>();
    const changedMovements: any[] = [];
    const changedAlerts: any[] = [];
    let netAdjustmentValue = 0;
    for (const entry of entries) {
      const productId = Number(entry.productId);
      const product = productMap.get(productId);
      if (!product) continue;
      const currentProduct = changedProducts.get(productId) || { ...product };
      const difference = roundQty(Number(entry.actualQuantity) - Number(currentProduct.stockQuantity || 0));
      if (Math.abs(difference) < 1e-6) continue;
      if (difference > 0) {
        const unitCost = Number(currentProduct.costPrice || 0);
        const batchId = generateUUID();
        const batch = {
          id: batchId, productId, purchaseId: null, quantity: difference, remainingQuantity: difference,
          costPrice: unitCost, purchaseDate: now, branchId: session.branchId, syncStatus,
          createdAt: now, updatedAt: now,
        };
        changedBatches.set(batchId, batch);
        currentProduct.stockQuantity = roundQty(Number(currentProduct.stockQuantity || 0) + difference);
        const movementKey = 'stocktake:' + sessionId + ':in:' + String(productId);
        if (!movementKeys.has(movementKey)) {
          const movement = {
            id: generateUUID(), movementKey, productId, movementType: 'stocktake_increase',
            sourceType: 'stocktake', sourceId: sessionId, quantityDeltaBase: difference,
            baseUnitCode: currentProduct.baseUnitCode || currentProduct.unit || 'piece',
            unitCost: Math.round(unitCost * 10000) / 10000, totalCost: roundMoney(difference * unitCost),
            branchId: session.branchId ?? currentProduct.branchId, operationId,
            reason: 'زيادة جرد #' + sessionId, createdBy: payload.createdBy || 'System',
            syncStatus, createdAt: now,
          };
          changedMovements.push(movement);
          movementKeys.add(movementKey);
        }
        netAdjustmentValue = roundMoney(netAdjustmentValue + difference * unitCost);
      } else {
        const qtyNeeded = Math.abs(difference);
        const previousQty = roundQty(Number(currentProduct.stockQuantity || 0));
        const nextQty = roundQty(previousQty - qtyNeeded);
        const effectiveBatches = new Map<string, any>(batchMap);
        for (const [batchId, changedBatch] of changedBatches) effectiveBatches.set(batchId, changedBatch);
        const activeBatches = [...effectiveBatches.values()]
          .filter((b: any) => Number(b.productId) === productId && Number(b.remainingQuantity || 0) > 0)
          .sort((a: any, b: any) => String(a.purchaseDate || '').localeCompare(String(b.purchaseDate || '')) ||
            String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
        let weightedUnitCost = Number(currentProduct.costPrice || 0);
        if (weightedAverage && activeBatches.length) {
          const activeQty = activeBatches.reduce((sum: number, b: any) => sum + Number(b.remainingQuantity || 0), 0);
          const activeValue = activeBatches.reduce((sum: number, b: any) => sum + Number(b.remainingQuantity || 0) * Number(b.costPrice || 0), 0);
          if (activeQty > 0) weightedUnitCost = activeValue / activeQty;
        }
        let remaining = qtyNeeded;
        let totalCost = 0;
        for (const batch of activeBatches) {
          if (remaining <= 1e-6) break;
          const available = Number(batch.remainingQuantity || 0);
          const take = roundQty(Math.min(remaining, available));
          if (take <= 0) continue;
          const updatedBatch = { ...batch, remainingQuantity: roundQty(Math.max(0, available - take)), updatedAt: now, syncStatus };
          changedBatches.set(String(batch.id), updatedBatch);
          const unitCost = weightedAverage ? weightedUnitCost : Number(batch.costPrice || 0);
          totalCost += take * unitCost;
          remaining = roundQty(remaining - take);
        }
        if (remaining > 1e-6) totalCost += remaining * (weightedAverage ? weightedUnitCost : Number(currentProduct.costPrice || 0));
        currentProduct.stockQuantity = nextQty;
        if (nextQty < -1e-6) {
          const alert = {
            id: `offline-oversell:${operationId}:${productId}:${productId}`, productId,
            productName: currentProduct.name, previousQty, changeQty: -qtyNeeded,
            resultingQty: nextQty, operationId, deviceId, reason: 'offline_oversell', resolved: 0, createdAt: now,
          };
          changedAlerts.push(alert);
        }
        const movementKey = `stocktake:${sessionId}:out:${productId}:${productId}`;
        if (!movementKeys.has(movementKey)) {
          changedMovements.push({
            id: generateUUID(), movementKey, productId, movementType: 'stocktake_decrease',
            sourceType: 'stocktake', sourceId: sessionId, quantityDeltaBase: -qtyNeeded,
            baseUnitCode: currentProduct.baseUnitCode || currentProduct.unit || 'piece',
            unitCost: qtyNeeded > 0 ? totalCost / qtyNeeded : 0, totalCost: roundMoney(totalCost),
            branchId: session.branchId ?? currentProduct.branchId, operationId,
            reason: 'عجز جرد #' + sessionId, createdBy: payload.createdBy || 'System',
            syncStatus, createdAt: now,
          });
          movementKeys.add(movementKey);
        }
        netAdjustmentValue = roundMoney(netAdjustmentValue - totalCost);
      }
      currentProduct.updatedAt = now;
      currentProduct.syncStatus = syncStatus;
      changedProducts.set(productId, currentProduct);
    }
    const updatedSession = { ...session, status: 'approved', syncStatus };
    put('stocktakingSessions', updatedSession);
    for (const product of changedProducts.values()) put('products', product);
    for (const batch of changedBatches.values()) put('inventoryBatches', batch);
    for (const movement of changedMovements) put('inventoryMovements', movement);
    for (const alert of changedAlerts) put('inventoryAlerts', alert);
    if (shouldPostLocalAccounting(syncStatus) && Math.abs(netAdjustmentValue) > 0.001) {
      const entryId = `local-je:stocktake:${sessionId}:stocktake-${operationId}`;
      if (!existingJournals.some((entry: any) => String(entry.id) === entryId)) {
        const amount = Math.abs(netAdjustmentValue);
        const lines = netAdjustmentValue > 0
          ? [{ accountCode: '1200', debit: amount, credit: 0 }, { accountCode: '5400', debit: 0, credit: amount }]
          : [{ accountCode: '5400', debit: amount, credit: 0 }, { accountCode: '1200', debit: 0, credit: amount }];
        const systemAccounts: Record<string, any> = {
          '1200': { code: '1200', name: 'المخزون', type: 'asset' },
          '5400': { code: '5400', name: 'تسويات الجرد', type: 'expense' },
        };
        for (const line of lines) {
          const account = accountMap.get(line.accountCode) || {
            ...systemAccounts[line.accountCode], balance: 0, isSystem: 1, createdAt: now, updatedAt: now,
          };
          const normalDebit = account.type === 'asset' || account.type === 'expense';
          const delta = normalDebit ? line.debit - line.credit : line.credit - line.debit;
          const updatedAccount = { ...account, balance: roundMoney(Number(account.balance || 0) + delta), updatedAt: now };
          accountMap.set(line.accountCode, updatedAccount);
          put('accounts', updatedAccount);
        }
        const total = roundMoney(lines.reduce((sum, line) => sum + line.debit, 0));
        const journal = {
          id: entryId, entryNumber: `LOCAL-stocktake-${sessionId.slice(0, 8)}`, date: now,
          referenceId: sessionId, referenceType: 'stocktake', description: 'تسوية جرد مخزون #' + sessionId,
          totalDebit: total, totalCredit: total, status: 'posted', createdBy: payload.createdBy || 'System',
          branchId: session.branchId, syncStatus: currentDeviceRole === 'standalone' ? 'synced' : 'pending', createdAt: now,
        };
        put('journalEntries', journal);
        lines.forEach((line, index) => put('transactions', {
          id: `${entryId}:${index}`, journalEntryId: entryId, accountId: line.accountCode,
          accountName: accountMap.get(line.accountCode)?.name || line.accountCode,
          type: line.debit > 0 ? 'debit' : 'credit', amount: line.debit || line.credit,
          debit: line.debit, credit: line.credit, description: journal.description,
          syncStatus: journal.syncStatus, createdAt: now,
        }));
      }
    }
    let audit: any;
    if (currentDeviceRole === 'standalone') {
      audit = {
        id: generateUUID(), date: now, userName: payload.createdBy || 'System', type: 'stocktake_approve',
        action: 'اعتماد جرد', operationName: 'تسوية جرد مخزون',
        details: 'اعتماد جلسة جرد #' + sessionId, quantity: entries.length,
        value: Math.abs(netAdjustmentValue), branchId: session.branchId,
        entityId: sessionId, entityName: sessionId, syncStatus,
      };
      put('auditLogs', audit);
    }
    await nativePosRepository.applyChanges([...changes.values()]);
    await db.transaction('rw', [
      db.products, db.stocktakingSessions, db.inventoryBatches, db.inventoryMovements,
      db.inventoryAlerts, db.accounts, db.journalEntries, db.transactions, db.auditLogs,
    ], async () => {
      await db.stocktakingSessions.put(updatedSession);
      if (changedProducts.size) await db.products.bulkPut([...changedProducts.values()]);
      if (changedBatches.size) await db.inventoryBatches.bulkPut([...changedBatches.values()]);
      if (changedMovements.length) await db.inventoryMovements.bulkPut(changedMovements);
      if (changedAlerts.length) await db.inventoryAlerts.bulkPut(changedAlerts);
      const accountWrites = [...accountMap.values()].filter((account: any) => changes.has('accounts:' + String(account.code)));
      if (accountWrites.length) await db.accounts.bulkPut(accountWrites);
      const journalWrites = [...changes.values()].filter((change) => change.entity === 'journalEntries').map((change) => change.record);
      const transactionWrites = [...changes.values()].filter((change) => change.entity === 'transactions').map((change) => change.record);
      if (journalWrites.length) await db.journalEntries.bulkPut(journalWrites);
      if (transactionWrites.length) await db.transactions.bulkPut(transactionWrites);
      if (audit) await db.auditLogs.put(audit);
    });
    await flushNativeDatabaseMirrorWrites();
    return;
  }
  await db.transaction('rw', [
    db.products, db.stocktakingSessions, db.stocktakingEntries, db.inventoryBatches, db.inventoryMovements,
    db.inventoryAlerts, db.accounts, db.journalEntries, db.transactions,
  ], async () => {
    const session = await db.stocktakingSessions.get(sessionId);
    if (!session) throw new Error('جلسة الجرد غير موجودة');
    if (session.status === 'approved') return;
    const entries = await db.stocktakingEntries.where('sessionId').equals(sessionId).toArray();
    let netAdjustmentValue = 0;
    for (const entry of entries) {
      const product = await db.products.get(Number(entry.productId));
      if (!product) continue;
      const difference = roundQty(Number(entry.actualQuantity) - Number(product.stockQuantity || 0));
      if (Math.abs(difference) < 1e-6) continue;
      if (difference > 0) {
        const unitCost = Number(product.costPrice || 0);
        const batchId = generateUUID();
        await db.inventoryBatches.put({
          id: batchId, productId: Number(product.id), purchaseId: null, quantity: difference, remainingQuantity: difference,
          costPrice: unitCost, purchaseDate: now, branchId: session.branchId, syncStatus, createdAt: now, updatedAt: now,
        });
        await db.products.update(product.id!, { stockQuantity: Number(entry.actualQuantity), updatedAt: now, syncStatus });
        await recordLocalInventoryMovement({
          movementKey: 'stocktake:' + sessionId + ':in:' + String(product.id), productId: Number(product.id),
          movementType: 'stocktake_increase', sourceType: 'stocktake', sourceId: sessionId, quantityDeltaBase: difference,
          unitCost, totalCost: roundMoney(difference * unitCost), branchId: session.branchId, operationId,
          reason: 'زيادة جرد #' + sessionId, createdBy: payload.createdBy, createdAt: now, syncStatus,
        });
        netAdjustmentValue = roundMoney(netAdjustmentValue + difference * unitCost);
      } else {
        const consumed = await consumeLocalInventoryFIFO({
          productId: Number(product.id), quantityInBaseUnits: Math.abs(difference), operationId, deviceId,
          sourceId: sessionId, movementKeySuffix: String(product.id), movementType: 'stocktake_decrease',
          sourceType: 'stocktake', branchId: session.branchId, reason: 'عجز جرد #' + sessionId,
          createdBy: payload.createdBy, createdAt: now, allowNegative: true, syncStatus,
        });
        netAdjustmentValue = roundMoney(netAdjustmentValue - consumed.totalCost);
      }
    }
    await db.stocktakingSessions.update(sessionId, { status: 'approved', syncStatus });
    if (shouldPostLocalAccounting(syncStatus) && Math.abs(netAdjustmentValue) > 0.001) {
      const amount = Math.abs(netAdjustmentValue);
      await postLocalJournalEntry({
        referenceId: sessionId, referenceType: 'stocktake', entryKey: 'stocktake-' + operationId, date: now,
        description: 'تسوية جرد مخزون #' + sessionId,
        lines: netAdjustmentValue > 0
          ? [{ accountCode: '1200', debit: amount, credit: 0 }, { accountCode: '5400', debit: 0, credit: amount }]
          : [{ accountCode: '5400', debit: amount, credit: 0 }, { accountCode: '1200', debit: 0, credit: amount }],
        createdBy: payload.createdBy, branchId: session.branchId,
      });
    }
    if (currentDeviceRole === 'standalone') await db.auditLogs.add({
      date: now, userName: payload.createdBy || 'System', type: 'stocktake_approve',
      action: 'اعتماد جرد', operationName: 'تسوية جرد مخزون',
      details: 'اعتماد جلسة جرد #' + sessionId,
      quantity: entries.length, value: Math.abs(netAdjustmentValue), branchId: session.branchId,
      entityId: sessionId, entityName: sessionId, syncStatus,
    });
  });
}
async function applyEntityLocally(type: 'entity_upsert' | 'entity_delete', payload: any, syncStatus: 'synced' | 'pending', serverResult?: any) {
  const tableName = payload?.table as keyof typeof db;
  const table = (db as any)[tableName];
  if (!table) return;
  if (type === 'entity_delete') {
    if (isNativeAndroid() && (NATIVE_POS_ENTITIES as readonly string[]).includes(String(tableName))) {
      await nativePosRepository.delete(tableName as any, payload.id);
      await table.delete(payload.id);
      await flushNativeDatabaseMirrorWrites();
      return;
    }
    await table.delete(payload.id);
    return;
  }
  if (!payload?.record) return;
  const finalRecord = serverResult && typeof serverResult === 'object' ? { ...payload.record, ...serverResult } : payload.record;
  const previousId = payload.record.id;
  const hasChangedPrimaryKey = previousId !== undefined && finalRecord.id !== undefined && previousId !== finalRecord.id;
  if (hasChangedPrimaryKey && !isNativeAndroid()) {
    await table.delete(previousId).catch(() => {});
  }
  if (tableName !== 'products') {
    if (isNativeAndroid() && (NATIVE_POS_ENTITIES as readonly string[]).includes(String(tableName))) {
      const nativeChanges: any[] = [];
      if (hasChangedPrimaryKey) nativeChanges.push({ action: 'delete', entity: tableName, key: previousId });
      nativeChanges.push({ action: 'put', entity: tableName, record: { ...finalRecord, syncStatus }, syncState: syncStatus });
      const applied = await nativePosRepository.applyChanges(nativeChanges);
      if (applied !== nativeChanges.length) throw new Error('لم تؤكد SQLite تحديث السجل');
      await db.transaction('rw', [table], async () => {
        if (hasChangedPrimaryKey) await table.delete(previousId);
        await table.put({ ...finalRecord, syncStatus });
      });
      await flushNativeDatabaseMirrorWrites();
      return;
    }
    await table.put({ ...finalRecord, syncStatus });
    return;
  }
  const now = new Date().toISOString();
  const productId = Number(finalRecord.id);
  if (isNativeAndroid()) {
    if (!Number.isSafeInteger(productId) || productId <= 0) throw new Error('معرّف الصنف غير صالح');
    const productRecord = { ...finalRecord, syncStatus };
    const changes: any[] = [];
    if (hasChangedPrimaryKey) changes.push({ action: 'delete', entity: 'products', key: previousId });
    changes.push({ action: 'put', entity: 'products', record: productRecord, syncState: syncStatus });
    const cacheRecords: Record<string, any[]> = { inventoryBatches: [], inventoryMovements: [], accounts: [], journalEntries: [], transactions: [] };
    if (Number(finalRecord.stockQuantity || 0) > 0 && (!finalRecord.itemType || finalRecord.itemType === 'stock')) {
      const existingBatches = await nativePosRepository.whereEquals<any>('inventoryBatches', 'productId', productId);
      if (existingBatches.length === 0) {
        const quantity = roundQty(Number(finalRecord.stockQuantity || 0));
        const unitCost = Number(finalRecord.costPrice || 0);
        const batchId = generateUUID();
        const batch = {
          id: batchId, productId, purchaseId: null, quantity, remainingQuantity: quantity,
          costPrice: unitCost, purchaseDate: now, branchId: finalRecord.branchId,
          syncStatus, createdAt: now, updatedAt: now,
        };
        const openingValue = roundMoney(quantity * unitCost);
        const movement = {
          id: generateUUID(), movementKey: 'opening:' + String(productId), productId,
          movementType: 'opening_balance', sourceType: 'product', sourceId: String(productId),
          quantityDeltaBase: quantity, unitCost, totalCost: openingValue, branchId: finalRecord.branchId,
          operationId: String(payload.operationId || productId), reason: 'رصيد افتتاحي للصنف',
          createdBy: payload.createdBy || 'System', createdAt: now, syncStatus,
        };
        changes.push(
          { action: 'put', entity: 'inventoryBatches', record: batch, syncState: syncStatus },
          { action: 'put', entity: 'inventoryMovements', record: movement, syncState: syncStatus },
        );
        cacheRecords.inventoryBatches.push(batch);
        cacheRecords.inventoryMovements.push(movement);
        if (shouldPostLocalAccounting(syncStatus) && openingValue > 0) {
          const definitions: any = {
            '1200': { name: 'المخزون', type: 'asset' },
            '3100': { name: 'رأس المال والأرصدة الافتتاحية', type: 'equity' },
          };
          const entryKey = 'opening-' + String(payload.operationId || productId);
          const referenceId = 'opening:' + String(productId);
          const entryId = 'local-je:opening:' + referenceId + ':' + entryKey;
          if (!(await nativePosRepository.get<any>('journalEntries', entryId))) {
            const lines = [
              { accountCode: '1200', debit: openingValue, credit: 0 },
              { accountCode: '3100', debit: 0, credit: openingValue },
            ];
            const accountMap = new Map<string, any>();
            for (const line of lines) {
              if (accountMap.has(line.accountCode)) continue;
              const account = await nativePosRepository.get<any>('accounts', line.accountCode);
              accountMap.set(line.accountCode, account || {
                code: line.accountCode, ...definitions[line.accountCode], balance: 0,
                isSystem: 1, createdAt: now, updatedAt: now,
              });
            }
            const journalSyncStatus = currentDeviceRole === 'standalone' ? 'synced' : 'pending';
            const entry = {
              id: entryId, entryNumber: 'LOCAL-' + entryKey + '-' + referenceId.slice(0, 8),
              date: now, referenceId, referenceType: 'opening',
              description: 'رصيد افتتاحي للمخزون: ' + String(finalRecord.name || productId),
              totalDebit: openingValue, totalCredit: openingValue, status: 'posted',
              createdBy: payload.createdBy || 'System', branchId: finalRecord.branchId,
              syncStatus: journalSyncStatus, createdAt: now,
            };
            changes.push({ action: 'put', entity: 'journalEntries', record: entry, syncState: journalSyncStatus });
            cacheRecords.journalEntries.push(entry);
            for (let index = 0; index < lines.length; index++) {
              const line = lines[index];
              const account = accountMap.get(line.accountCode);
              const updatedAccount = {
                ...account,
                balance: roundMoney(Number(account.balance || 0) + ((account.type === 'asset' || account.type === 'expense') ? line.debit - line.credit : line.credit - line.debit)),
                updatedAt: now,
              };
              accountMap.set(line.accountCode, updatedAccount);
              const transaction = {
                id: entryId + ':' + String(index), journalEntryId: entryId,
                accountId: line.accountCode, accountName: account.name,
                type: line.debit > 0 ? 'debit' : 'credit',
                amount: openingValue, debit: line.debit, credit: line.credit,
                description: entry.description, syncStatus: journalSyncStatus, createdAt: now,
              };
              changes.push(
                { action: 'put', entity: 'transactions', record: transaction, syncState: journalSyncStatus },
              );
              cacheRecords.transactions.push(transaction);
            }
            for (const account of accountMap.values()) {
              changes.push({ action: 'put', entity: 'accounts', record: account, syncState: journalSyncStatus });
              cacheRecords.accounts.push(account);
            }
          }
        }
      }
    }
    const applied = await nativePosRepository.applyChanges(changes);
    if (applied !== changes.length) throw new Error('لم تؤكد SQLite حفظ جميع سجلات الصنف');
    await db.transaction('rw', [
      db.products, db.inventoryBatches, db.inventoryMovements, db.accounts, db.journalEntries, db.transactions,
    ], async () => {
      if (hasChangedPrimaryKey) await db.products.delete(previousId);
      await db.products.put(productRecord as any);
      for (const entity of Object.keys(cacheRecords)) {
        for (const record of cacheRecords[entity]) await (db as any)[entity].put(record);
      }
    });
    await flushNativeDatabaseMirrorWrites();
    return;
  }
  await db.transaction('rw', [db.products, db.inventoryBatches, db.inventoryMovements, db.accounts, db.journalEntries, db.transactions], async () => {
    await db.products.put({ ...finalRecord, syncStatus });
    if (Number(finalRecord.stockQuantity || 0) <= 0 || (finalRecord.itemType && finalRecord.itemType !== 'stock')) return;
    const existingBatchCount = await db.inventoryBatches.where('productId').equals(productId).count();
    if (existingBatchCount > 0) return;
    const quantity = roundQty(Number(finalRecord.stockQuantity || 0));
    const unitCost = Number(finalRecord.costPrice || 0);
    const batchId = generateUUID();
    await db.inventoryBatches.put({
      id: batchId, productId, purchaseId: null, quantity, remainingQuantity: quantity, costPrice: unitCost,
      purchaseDate: now, branchId: finalRecord.branchId, syncStatus, createdAt: now, updatedAt: now,
    });
    const openingValue = roundMoney(quantity * unitCost);
    await recordLocalInventoryMovement({
      movementKey: 'opening:' + String(productId), productId, movementType: 'opening_balance',
      sourceType: 'product', sourceId: String(productId), quantityDeltaBase: quantity, unitCost, totalCost: openingValue,
      branchId: finalRecord.branchId, operationId: String(payload.operationId || productId), reason: 'رصيد افتتاحي للصنف',
      createdBy: payload.createdBy || 'System', createdAt: now, syncStatus,
    });
    if (shouldPostLocalAccounting(syncStatus) && openingValue > 0) await postLocalJournalEntry({
      referenceId: 'opening:' + String(productId), referenceType: 'opening', entryKey: 'opening-' + String(payload.operationId || productId),
      date: now, description: 'رصيد افتتاحي للمخزون: ' + String(finalRecord.name || productId),
      lines: [
        { accountCode: '1200', debit: openingValue, credit: 0 },
        { accountCode: '3100', debit: 0, credit: openingValue },
      ], createdBy: payload.createdBy || 'System', branchId: finalRecord.branchId,
    });
  });
}
async function validateLocalOperationFiscalPeriod(type: SyncOperation['type'], payload: any) {
  const now = new Date().toISOString();
  let postingDates: Array<string | undefined> = [now];
  if (type === 'sale') postingDates = [payload?.order?.createdAt || now];
  else if (type === 'return') postingDates = [payload?.returnDate || now];
  else if (type === 'order_void') {
    const order = await getLocalRecord<any>('orders', String(payload?.orderId || payload?.id || ''));
    if (!order) return;
    postingDates = [order.createdAt || now];
  } else if (type === 'purchase') postingDates = [payload?.purchase?.date || now];
  else if (type === 'purchase_update') {
    const oldPurchase = await getLocalRecord<any>('purchases', String(payload?.purchase?.id || ''));
    if (!oldPurchase) throw new Error('فاتورة الشراء غير موجودة');
    postingDates = [oldPurchase.date || now, payload?.purchase?.date || now];
  } else if (type === 'purchase_delete') {
    const oldPurchase = await getLocalRecord<any>('purchases', String(payload?.id || ''));
    if (!oldPurchase) return;
    postingDates = [oldPurchase.date || now];
  } else if (type === 'expense') postingDates = [payload?.date || now];
  else if (type === 'expense_delete') {
    const expense = await getLocalRecord<any>('expenses', Number(payload?.id));
    if (!expense) return;
    postingDates = [expense.date || now];
  } else if (type === 'payroll') postingDates = [payload?.paymentDate || now];
  if (['sale', 'return', 'order_void', 'purchase', 'purchase_update', 'purchase_delete', 'purchase_return', 'expense', 'expense_delete', 'customer_payment', 'supplier_payment', 'payroll', 'shift_movement', 'stocktake_approve'].includes(type)) {
    await assertLocalOpenFiscalPeriod(postingDates, payload);
  }
}
async function applyOperationLocally(
  type: SyncOperation['type'],
  payload: any,
  syncStatus: 'synced' | 'pending',
  serverResult?: any
) {
  (globalThis as any).__posApplyingOperation = true;
  try {
    if (syncStatus === 'pending') await validateLocalOperationFiscalPeriod(type, payload);
    switch (type) {
      case 'sale':
        return await applySaleLocally(payload, syncStatus);
      case 'return':
        return await applyReturnLocally(payload, syncStatus);
      case 'order_void':
        return await applyOrderVoidLocally(payload, syncStatus);
      case 'purchase':
      case 'purchase_update':
      case 'purchase_delete':
        return await applyPurchaseLocally(type, payload, syncStatus);
      case 'purchase_return':
        return await applyPurchaseReturnLocally(payload, syncStatus);
      case 'expense':
      case 'expense_delete':
        return await applyExpenseLocally(type, payload, syncStatus);
      case 'customer_payment':
        return await applyCustomerPaymentLocally(payload, syncStatus);
      case 'supplier_payment':
        return await applySupplierPaymentLocally(payload, syncStatus);
      case 'payroll':
        return await applyPayrollLocally(payload, syncStatus);
      case 'shift_open':
      case 'shift_close':
      case 'shift_movement':
        return await applyShiftLocally(type, payload, syncStatus);
      case 'stocktake_approve':
        return await applyStocktakeApproveLocally(payload, syncStatus);
      case 'entity_upsert':
      case 'entity_delete':
        return await applyEntityLocally(type, payload, syncStatus, serverResult);
    }
  } finally {
    (globalThis as any).__posApplyingOperation = false;
  }
}

function enrichPayloadWithStableIds(type: SyncOperation['type'], payload: any) {
  if (type === 'entity_upsert' && ['products', 'categories', 'customers', 'suppliers', 'expenses'].includes(String(payload?.table)) && payload?.record && !payload.record.id) {
    return { ...payload, record: { ...payload.record, id: Date.now() } };
  }
  if (type === 'payroll' && !payload?.id) {
    return { ...payload, id: Date.now() };
  }
  if (type === 'expense' && !payload?.id) {
    return { ...payload, id: Date.now() };
  }
  if (type === 'return' && !payload?.id) {
    return { ...payload, id: generateUUID() };
  }
  if ((type === 'purchase' || type === 'purchase_update') && Array.isArray(payload?.items)) {
    return {
      ...payload,
      items: payload.items.map((item: any) => ({
        ...item,
        batchId: item.batchId || generateUUID(),
      })),
    };
  }
  if ((type === 'customer_payment' || type === 'supplier_payment') && !payload?.paymentId) {
    return { ...payload, paymentId: generateUUID() };
  }
  if (type === 'shift_movement' && !payload?.id) {
    return { ...payload, id: generateUUID() };
  }
  if (type === 'purchase_return' && !payload?.id) {
    return { ...payload, id: generateUUID() };
  }
  return payload;
}

function mergeServerResultIntoPayload(type: SyncOperation['type'], payload: any, result: any) {
  if (!result) return payload;
  if (type === 'sale' && result.order) {
    return { ...payload, order: result.order, _serverItems: result.items };
  }
  if ((type === 'purchase' || type === 'purchase_update') && result.purchase) {
    return { ...payload, purchase: result.purchase, _serverItems: result.items };
  }
  if ((type === 'expense' || type === 'payroll' || type === 'shift_movement') && result.id) {
    return { ...payload, id: result.id };
  }
  if (type === 'customer_payment' && result.payment?.id) {
    return { ...payload, paymentId: result.payment.id };
  }
  if (type === 'supplier_payment' && result.payment?.id) {
    return { ...payload, paymentId: result.payment.id };
  }
  return payload;
}

async function assertLocalOpenFiscalPeriod(dateValues: Array<string | undefined>, payload: any): Promise<void> {
  const periods = await getLocalRecords<any>('fiscalPeriods');
  if (!periods.length) return;
  let userRole = String(payload?.userRole || payload?.actor?.role || payload?.role || '').toLowerCase();
  if (!userRole) {
    try { userRole = String(JSON.parse(localStorage.getItem('user') || 'null')?.role || '').toLowerCase(); } catch {}
  }
  const adminOverride = Boolean(payload?.allowClosedPeriodOverride) && (userRole === 'admin' || userRole === 'manager');
  for (const value of dateValues) {
    const targetDay = String(value || new Date().toISOString()).slice(0, 10);
    const closed = periods.find((period) =>
      period.status === 'closed' &&
      String(period.startDate || '').slice(0, 10) <= targetDay &&
      String(period.endDate || '').slice(0, 10) >= targetDay
    );
    if (closed && !adminOverride) {
      throw new Error(`الفترة المالية (${closed.name}) مغلقة ولا يمكن ترحيل عمليات بتاريخ ${targetDay}`);
    }
  }
}

async function validateStandaloneFiscalPeriod(type: SyncOperation['type'], payload: any): Promise<void> {
  const now = new Date().toISOString();
  const dates: Array<string | undefined> = [];
  switch (type) {
    case 'sale':
      dates.push(payload?.order?.createdAt || now);
      break;
    case 'return':
      dates.push(payload?.returnDate || now);
      break;
    case 'order_void': {
      const order = await getLocalRecord<any>('orders', String(payload?.orderId || payload?.id || ''));
      dates.push(order?.createdAt || now);
      break;
    }
    case 'purchase':
      dates.push(payload?.purchase?.date || now);
      break;
    case 'purchase_update': {
      const oldPurchase = await getLocalRecord<any>('purchases', String(payload?.purchase?.id || ''));
      dates.push(oldPurchase?.date || now, payload?.purchase?.date || now);
      break;
    }
    case 'purchase_delete': {
      const oldPurchase = await getLocalRecord<any>('purchases', String(payload?.id || ''));
      if (oldPurchase) dates.push(oldPurchase.date || now);
      break;
    }
    case 'purchase_return':
    case 'customer_payment':
    case 'supplier_payment':
    case 'shift_movement':
    case 'stocktake_approve':
      dates.push(now);
      break;
    case 'expense':
      dates.push(payload?.date || now);
      break;
    case 'payroll':
      dates.push(payload?.paymentDate || now);
      break;
  }
  if (dates.length) await assertLocalOpenFiscalPeriod(dates, payload);
}

export async function dispatchOperation(
  type: SyncOperation['type'],
  rawPayload: any,
  branchId?: number
): Promise<{ synced: boolean; operationId: string; result?: any }> {
  let payload = { ...enrichPayloadWithStableIds(type, rawPayload) };
  try {
    const localUser = JSON.parse(localStorage.getItem('user') || 'null');
    if (localUser?.role) payload.userRole = payload.userRole || localUser.role;
    if (!payload.actor && localUser?.role) payload.actor = { role: localUser.role, name: localUser.name };
    if (!payload.createdBy && localUser?.name) payload.createdBy = localUser.name;
  } catch {}
  if (type === 'purchase_update' || type === 'purchase_delete') {
    const purchaseId = String(type === 'purchase_delete' ? payload.id : payload.purchase?.id);
    const [oldPurchase, oldItems] = isNativeAndroid()
      ? await Promise.all([
          nativePosRepository.get<any>('purchases', purchaseId),
          nativePosRepository.whereEquals<any>('purchaseItems', 'purchaseId', purchaseId),
        ])
      : await Promise.all([
          getLocalRecord<any>('purchases', purchaseId),
          getLocalRecordsByIndex<any>('purchaseItems', 'purchaseId', purchaseId),
        ]);
    payload = {
      ...payload,
      _localAffectedProductIds: oldItems.map((item) => Number(item.productId)),
      _localAffectedSupplierId: oldPurchase?.supplierId,
    };
  }
  const operationId = payload?.operationId || generateUUID();
  const deviceId = getDeviceId();
  const role = await getDeviceRole();
  // Do not let Android submit a purchase update to the server until its full
  // reversal-and-replacement transaction is implemented atomically in SQLite.
  // The previous guard ran only during local application, after a server could
  // already have committed the update and left the device cache stale.
  if (isNativeAndroid() && type === 'purchase_update') {
    throw new Error('تعديل فاتورة الشراء على Android متوقف مؤقتًا لحماية تطابق الخادم وSQLite حتى اكتمال الترحيل الذري');
  }
  // Validate Android purchase deletion against the authoritative local SQLite state
  // before any server request can delete the invoice remotely.
  if (isNativeAndroid() && type === 'purchase_delete') {
    const purchaseId = String(payload?.id || '');
    if (!purchaseId) throw new Error('معرّف فاتورة الشراء غير صالح');
    const oldPurchase = await nativePosRepository.get<any>('purchases', purchaseId);
    if (!oldPurchase) throw new Error('فاتورة الشراء غير موجودة');
    const [returns, batches] = await Promise.all([
      nativePosRepository.whereEquals<any>('purchaseReturns', 'originalPurchaseId', purchaseId),
      nativePosRepository.whereEquals<any>('inventoryBatches', 'purchaseId', purchaseId),
    ]);
    if (returns.length) throw new Error('لا يمكن حذف فاتورة شراء لها مرتجعات مسجلة');
    if (batches.some((batch: any) => Number(batch.remainingQuantity || 0) < Number(batch.quantity || 0))) {
      throw new Error('لا يمكن حذف فاتورة شراء تم بيع جزء من مخزونها؛ استخدم مرتجع المشتريات');
    }
  }
  setLocalAccountingStandaloneMode(role === 'standalone');
  const now = new Date().toISOString();
  const token = getAuthToken();

  const opRecord: SyncOperation = {
    id: operationId,
    type,
    payload: { ...payload, operationId, deviceId },
    deviceId,
    branchId,
    status: 'pending',
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  if (role === 'standalone') {
    // Apply the same closed-period posting restriction used by the server.
    await validateStandaloneFiscalPeriod(type, opRecord.payload);
    // Standalone transactions are committed locally and are not placed in a
    // server synchronization queue.
    await applyOperationLocally(type, opRecord.payload, 'synced');
    if (isNativeAndroid()) {
      await flushNativeDatabaseMirrorWrites();
    }
    return { synced: true, operationId };
  }

  if (role === 'server' && token) {
    try {
      const response = await apiService.executeOperation(type, opRecord.payload, operationId, deviceId);
      const localPayload = mergeServerResultIntoPayload(type, opRecord.payload, response.result);
      await applyOperationLocally(type, localPayload, 'synced', response.result);
      if (isNativeAndroid()) {
        try {
          await flushNativeDatabaseMirrorWrites();
        } catch (mirrorError) {
          throw Object.assign(
            new Error('تم قبول العملية على الخادم لكن تعذر تثبيت نسختها المحلية في SQLite؛ يلزم إصلاح النسخة المحلية قبل متابعة العمل'),
            { nativeSqliteMirrorFailure: true, cause: mirrorError },
          );
        }
      }
      import('./syncService').then(({ syncService }) => syncService.pullAll().catch(() => {}));
      return { synced: true, operationId, result: response.result };
    } catch (err: any) {
      if (err?.nativeSqliteMirrorFailure) throw err;
      if (
        err?.response &&
        err.response.status >= 400 &&
        err.response.status < 500 &&
        err.response.status !== 401
      ) {
        throw new Error(err.response?.data?.error || err.message);
      }
    }
  }

  // Enforce local stock policy before queueing offline sale when offlineStockPolicy is 'block'
  if (type === 'sale' && !payload?.allowNegativeOverride && !payload?.managerOverride) {
    try {
      const policyRow = await getLocalSettingByKey('offlineStockPolicy');
      const allowNegRow = await getLocalSettingByKey('allowNegativeStock');
      const policy = policyRow?.value || (allowNegRow?.value === 'false' || allowNegRow?.value === false ? 'block' : 'allow_with_alert');
      if (policy === 'block') {
        for (const item of payload?.items || []) {
          const prod = await getLocalRecord<any>('products', Number(item.productId));
          if (!prod) continue;
          const itemType = String(item.itemType || prod.itemType || 'stock');
          if (itemType === 'service') continue;
          const factor = resolveLocalUnitFactor(prod, item);
          const baseQty = roundQty(Number(item.quantity || 0) * factor);
          if (itemType === 'service_with_materials' || itemType === 'bundle') {
            const recipes = await getLocalRecordsByIndex<any>('serviceRecipes', 'parentProductId', Number(prod.id));
            if (recipes.length > 0) {
              for (const rec of recipes) {
                const ing = await getLocalRecord<any>('products', Number(rec.ingredientProductId));
                const needed = roundQty(baseQty * Number(rec.quantity || 0));
                if (ing && ing.stockQuantity < needed) {
                  throw new Error(`الرصيد غير كافٍ للمادة الخام: ${ing.name} (المتاح: ${ing.stockQuantity})`);
                }
              }
              continue;
            }
          }
          if (itemType === 'stock' && prod.stockQuantity < baseQty) {
            throw new Error(`الرصيد غير كافٍ للصنف: ${prod.name} (المتاح: ${prod.stockQuantity})`);
          }
        }
      }
    } catch (policyErr: any) {
      throw policyErr;
    }
  }

  await db.syncOperations.put(opRecord);
  // Persist the Android outbox before mutating the local business tables. If the
  // WebView closes during the mutation, the durable operation can still replay.
  if (isNativeAndroid()) {
    try {
      const queued = await enqueueNativePosOperation({
        operationId, type, payload: opRecord.payload, deviceId,
        branchId: branchId === undefined ? undefined : String(branchId), schemaVersion: 1,
      });
      if (!queued) {
        throw new Error('تعذر حفظ العملية في طابور SQLite المحلي؛ أُوقِف تنفيذ العملية لحماية البيانات');
      }
    } catch (error) {
      console.error('Android SQLite outbox write failed; operation was not applied:', error);
      throw error instanceof Error
        ? error
        : new Error('تعذر حفظ العملية في طابور SQLite المحلي؛ أُوقِف تنفيذ العملية لحماية البيانات');
    }
  }
  await applyOperationLocally(type, opRecord.payload, 'pending');
  if (type === 'purchase_update' || type === 'purchase_delete') {
    await db.syncOperations.update(operationId, { payload: opRecord.payload });
  }

  if (isNativeAndroid()) {
    // Every committed Dexie business transaction is mirrored as one atomic
    // SQLite batch before the operation can be reported as accepted locally.
    await flushNativeDatabaseMirrorWrites();
  }

  if (token) {
    const reachable = await apiService.checkServerReachability(2000);
    if (reachable) {
      try {
        const response = await apiService.executeOperation(type, opRecord.payload, operationId, deviceId);
        await db.syncOperations.update(operationId, {
          status: 'synced', lastError: undefined, updatedAt: new Date().toISOString(),
        });
        if (isNativeAndroid()) {
          await acknowledgeNativePosOperation(operationId).catch((error) =>
            console.error('Could not acknowledge Android SQLite outbox item:', error)
          );
        }
        await reconcileLocalOperationAfterAck(type, opRecord.payload, operationId, response.result);
        // The local mutation is not replayed after acknowledgement; pullAll applies
        // the authoritative server records without duplicating stock or balances.
        useSyncStore.getState().setLastSynced(new Date());
        import('./syncService').then(({ syncService }) => {
          syncService.updatePendingCount();
          syncService.pullAll().catch(() => {});
        });
        return { synced: true, operationId, result: response.result };
      } catch (err: any) {
        if (
          err?.response &&
          err.response.status >= 400 &&
          err.response.status < 500 &&
          err.response.status !== 401
        ) {
          const message = err.response?.data?.error || err.message;
          await db.syncOperations.update(operationId, {
            status: 'conflict',
            lastError: message,
            updatedAt: new Date().toISOString(),
          });
          if (isNativeAndroid()) {
            await markNativePosOperationConflict(operationId, message).catch(() => {});
          }
          throw new Error(message);
        }
      }
    }
  }

  import('./syncService').then(({ syncService }) => syncService.updatePendingCount());
  return { synced: false, operationId };
}
