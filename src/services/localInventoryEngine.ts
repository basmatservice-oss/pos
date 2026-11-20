import { generateUUID } from '../utils/uuid';
import { applyNativePosRecordChangesIfFieldAbsent, isNativeAndroid } from '../native/posLocalDatabase';
import { isElectronDesktop } from '../native/electronPosRepository';
const isLocalSqlite = (): boolean => isNativeAndroid() || isElectronDesktop();
import { getNativePosRecordId, nativePosRepository } from '../native/nativePosRepository';
import { roundQty } from '../utils/format';
// Dexie is loaded only for desktop inventory operations; Android writes are transactional in SQLite.
let db = {} as typeof import('../db/db').db;
let desktopDatabaseLoaded = false;

async function ensureDesktopDatabase(): Promise<void> {
  if (isLocalSqlite() || desktopDatabaseLoaded) return;
  db = (await import('../db/db')).db;
  desktopDatabaseLoaded = true;
}


export interface LocalBatchAllocation {
  batchId: string | null;
  quantity: number;
  costPrice: number;
}

export interface ConsumeLocalInventoryParams {
  productId: number;
  quantityInBaseUnits: number;
  operationId: string;
  deviceId: string;
  sourceId: string;
  movementKeySuffix: string;
  movementType?: string;
  sourceType?: string;
  branchId?: number;
  reason?: string;
  createdBy?: string;
  createdAt: string;
  allowNegative: boolean;
  syncStatus?: 'synced' | 'pending';
}

export interface ConsumeLocalInventoryResult {
  totalCost: number;
  averageUnitCost: number;
  allocations: LocalBatchAllocation[];
}

function roundMoney(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function commitNativeInventoryChanges(
  changes: any[],
  compare?: { entity: string; recordId: string; field: string; expectedValue: string },
  additionalCompareGuards: Array<{ entity: string; recordId: string; field: string; expectedValue: string }> = [],
): Promise<void> {
  const unique = new Map<string, any>();
  for (const change of changes) {
    const key = change.action === 'delete' ? change.key : (change.record.id ?? change.record.code ?? change.record.key);
    unique.set(change.entity + ':' + String(key), change);
  }
  const batch = Array.from(unique.values());
  if (!batch.length) return;
  const movement = batch.find((change) =>
    change.action === 'put' && change.entity === 'inventoryMovements' && change.record?.movementKey,
  );
  if (movement) {
    const nativeChanges = batch.map((change) => change.action === 'delete'
      ? { action: 'delete' as const, entity: change.entity, recordId: JSON.stringify(change.key) }
      : {
          action: 'put' as const,
          entity: change.entity,
          recordId: getNativePosRecordId(change.entity, change.record),
          record: change.record,
          syncState: change.syncState || 'local',
        });
    const result = await applyNativePosRecordChangesIfFieldAbsent(
      nativeChanges,
      'inventoryMovements',
      'movementKey',
      String(movement.record.movementKey),
      compare,
      additionalCompareGuards,
    );
    if (result.skipped) {
      throw new Error(compare
        ? 'تغير رصيد الصنف أو كمية/تكلفة إحدى دفعات المخزون أثناء التنفيذ؛ أعد تحميل البيانات ثم أعد المحاولة'
        : 'حركة المخزون مسجلة بالتزامن؛ أوقف العملية لمنع حفظها دون أثر مخزني');
    }
    if (result.applied !== batch.length) throw new Error('SQLite لم تؤكد حفظ جميع تغييرات المخزون');
    return;
  }
  const applied = await nativePosRepository.applyChanges(batch);
  if (applied !== batch.length) throw new Error('SQLite لم تؤكد حفظ جميع تغييرات المخزون');
}

export async function recordLocalInventoryMovement(input: {
  movementKey: string;
  productId: number;
  movementType: string;
  sourceType: string;
  sourceId: string;
  quantityDeltaBase: number;
  unitCost: number;
  totalCost: number;
  branchId?: number;
  operationId: string;
  reason?: string;
  createdBy?: string;
  createdAt: string;
  syncStatus?: 'synced' | 'pending';
}) {
  if (isLocalSqlite()) {
    const existing = await nativePosRepository.firstWhereEquals<any>('inventoryMovements', 'movementKey', input.movementKey);
    if (existing) return;
    const product = await nativePosRepository.get<any>('products', input.productId);
    const movement = {
      id: generateUUID(), movementKey: input.movementKey, productId: input.productId,
      movementType: input.movementType, sourceType: input.sourceType, sourceId: input.sourceId,
      quantityDeltaBase: roundQty(input.quantityDeltaBase),
      baseUnitCode: product?.baseUnitCode || product?.unit || 'piece',
      unitCost: Math.round((Number(input.unitCost) || 0) * 10000) / 10000,
      totalCost: roundMoney(input.totalCost), branchId: input.branchId ?? product?.branchId,
      operationId: input.operationId, reason: input.reason, createdBy: input.createdBy || 'System',
      syncStatus: input.syncStatus || 'pending', createdAt: input.createdAt,
    };
    await commitNativeInventoryChanges([{ action: 'put', entity: 'inventoryMovements', record: movement, syncState: input.syncStatus || 'local' }]);
    return;
  }

  await ensureDesktopDatabase();
  const existing = await db.inventoryMovements.where('movementKey').equals(input.movementKey).first();
  if (existing) return;
  const product = await db.products.get(input.productId);
  await db.inventoryMovements.add({
    id: generateUUID(),
    movementKey: input.movementKey,
    productId: input.productId,
    movementType: input.movementType,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    quantityDeltaBase: roundQty(input.quantityDeltaBase),
    baseUnitCode: product?.baseUnitCode || product?.unit || 'piece',
    unitCost: Math.round((Number(input.unitCost) || 0) * 10000) / 10000,
    totalCost: roundMoney(input.totalCost),
    branchId: input.branchId ?? product?.branchId,
    operationId: input.operationId,
    reason: input.reason,
    createdBy: input.createdBy || 'System',
    syncStatus: input.syncStatus || 'pending',
    createdAt: input.createdAt,
  });
}

export async function consumeLocalInventoryFIFO(
  params: ConsumeLocalInventoryParams
): Promise<ConsumeLocalInventoryResult> {
  if (isLocalSqlite()) {
    const productRow = (await nativePosRepository.getAllWithSyncState('products')).find((row) => Number(row.record.id) === params.productId);
    const product = productRow?.record as any;
    if (!product) throw new Error('الصنف غير موجود (ID: ' + params.productId + ')');
    const qtyNeeded = roundQty(params.quantityInBaseUnits);
  // Match the server accounting engine: negative stock is allowed unless explicitly disabled.
  const allowNegative = params.allowNegative ?? true;
    if (!Number.isFinite(qtyNeeded) || qtyNeeded < 0) throw new Error('كمية الصرف غير صالحة');
    if (qtyNeeded <= 0) return { totalCost: 0, averageUnitCost: 0, allocations: [] };
    const productStock = Number(product.stockQuantity);
    const productCost = Number(product.costPrice ?? 0);
    if (!Number.isFinite(productStock) || !Number.isFinite(productCost) || productCost < 0) {
      throw new Error('رصيد أو تكلفة الصنف غير صالحة؛ أُوقف خصم المخزون لحماية تكلفة البضاعة المباعة');
    }
    const movementKey = (params.sourceType || 'order') + ':' + params.sourceId + ':out:' + params.productId + ':' + params.movementKeySuffix;
    const existingMovement = await nativePosRepository.firstWhereEquals<any>('inventoryMovements', 'movementKey', movementKey);
    if (existingMovement) throw new Error('حركة استهلاك المخزون مسجلة مسبقًا؛ أُوقف التكرار لمنع خصم الكمية مرتين');
    const previousQty = roundQty(Number(product.stockQuantity || 0));
    const nextQty = roundQty(previousQty - qtyNeeded);
    if (!allowNegative && nextQty < -1e-6) throw new Error('الكمية المتاحة لا تكفي للمنتج ' + product.name);
    const [batchRows, valuation] = await Promise.all([
      nativePosRepository.getAllWithSyncState('inventoryBatches'),
      nativePosRepository.firstWhereEquals<any>('settings', 'key', 'inventoryValuationMethod'),
    ]);
    const batches = batchRows.filter((row) => Number(row.record.productId) === params.productId && Number(row.record.remainingQuantity || 0) > 0)
      .sort((a, b) => {
        const dateOrder = String(a.record.purchaseDate || '').localeCompare(String(b.record.purchaseDate || ''));
        if (dateOrder !== 0) return dateOrder;
        const createdOrder = String(a.record.createdAt || '').localeCompare(String(b.record.createdAt || ''));
        return createdOrder || String(a.record.id || '').localeCompare(String(b.record.id || ''));
      });
    for (const row of batches) {
      const quantity = Number(row.record.remainingQuantity);
      const cost = Number(row.record.costPrice);
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(cost) || cost < 0) {
        throw new Error('توجد دفعة مخزون بكمية أو تكلفة غير صالحة؛ أُوقف الصرف قبل تغيير FIFO');
      }
    }
    const weightedAverage = valuation?.value === 'weighted_average';
    let weightedUnitCost = Number(product.costPrice || 0);
    if (weightedAverage && batches.length) {
      const activeQty = batches.reduce((sum, row) => sum + Number(row.record.remainingQuantity || 0), 0);
      const activeValue = batches.reduce((sum, row) => sum + Number(row.record.remainingQuantity || 0) * Number(row.record.costPrice || 0), 0);
      if (activeQty > 0) weightedUnitCost = Math.round((activeValue / activeQty) * 10000) / 10000;
    }
    let remaining = qtyNeeded, totalCost = 0;
    const allocations: LocalBatchAllocation[] = [];
    const changes: any[] = [];
    if (weightedAverage) {
      for (const row of batches) {
        const batch: any = row.record;
        changes.push({
          action: 'put', entity: 'inventoryBatches',
          record: { ...batch, costPrice: weightedUnitCost, updatedAt: params.createdAt, syncStatus: params.syncStatus || 'pending' },
          syncState: params.syncStatus || row.syncState,
        });
      }
    }
    for (const row of batches) {
      if (remaining <= 1e-6) break;
      const batch: any = row.record;
      const available = Number(batch.remainingQuantity || 0);
      const take = roundQty(Math.min(remaining, available));
      if (take <= 0) continue;
      const costPrice = weightedAverage ? weightedUnitCost : Number(batch.costPrice || 0);
      changes.push({
        action: 'put', entity: 'inventoryBatches',
        record: { ...batch, ...(weightedAverage ? { costPrice: weightedUnitCost } : {}),
          remainingQuantity: roundQty(Math.max(0, available - take)), updatedAt: params.createdAt,
          syncStatus: params.syncStatus || 'pending' },
        syncState: params.syncStatus || row.syncState,
      });
      totalCost += take * costPrice;
      allocations.push({ batchId: String(batch.id), quantity: take, costPrice });
      remaining = roundQty(remaining - take);
    }
    if (remaining > 1e-6) {
      const fallbackCost = weightedAverage ? weightedUnitCost : Number(product.costPrice || 0);
      totalCost += remaining * fallbackCost;
      allocations.push({ batchId: null, quantity: remaining, costPrice: fallbackCost });
    }
    changes.push({
      action: 'put', entity: 'products',
      record: { ...product, ...(weightedAverage ? { costPrice: roundMoney(weightedUnitCost) } : {}), stockQuantity: nextQty, updatedAt: params.createdAt, syncStatus: params.syncStatus || 'pending' },
      syncState: params.syncStatus || productRow!.syncState,
    });
    if (nextQty < -1e-6) changes.push({
      action: 'put', entity: 'inventoryAlerts',
      record: {
        id: 'offline-oversell:' + params.operationId + ':' + params.productId + ':' + params.movementKeySuffix,
        productId: params.productId, productName: product.name, previousQty, changeQty: -qtyNeeded,
        resultingQty: nextQty, operationId: params.operationId, deviceId: params.deviceId,
        reason: 'offline_oversell', resolved: 0, createdAt: params.createdAt,
      },
      syncState: params.syncStatus || 'local',
    });
    const averageUnitCost = totalCost / qtyNeeded;
    changes.push({
      action: 'put', entity: 'inventoryMovements',
      record: {
        id: generateUUID(), movementKey, productId: params.productId,
        movementType: params.movementType || 'sale', sourceType: params.sourceType || 'order', sourceId: params.sourceId,
        quantityDeltaBase: -qtyNeeded, baseUnitCode: product.baseUnitCode || product.unit || 'piece',
        unitCost: Math.round((Number(averageUnitCost) || 0) * 10000) / 10000,
        totalCost: roundMoney(totalCost), branchId: params.branchId ?? product.branchId,
        operationId: params.operationId, reason: params.reason, createdBy: params.createdBy || 'System',
        syncStatus: params.syncStatus || 'pending', createdAt: params.createdAt,
      },
      syncState: params.syncStatus || 'local',
    });
    const batchCompareGuards: Array<{ entity: string; recordId: string; field: string; expectedValue: string }> = [];
    for (const row of batches) {
      const original: any = row.record;
      if (original.remainingQuantity === undefined || original.remainingQuantity === null ||
          !Number.isFinite(Number(original.remainingQuantity))) {
        throw new Error('كمية دفعة المخزون غير صالحة؛ أُوقف الخصم لحماية رصيد المخزون');
      }
      batchCompareGuards.push({
        entity: 'inventoryBatches', recordId: JSON.stringify(original.id),
        field: 'remainingQuantity', expectedValue: String(original.remainingQuantity),
      });
      if (weightedAverage) {
        if (original.costPrice === undefined || original.costPrice === null || !Number.isFinite(Number(original.costPrice))) {
          throw new Error('تكلفة دفعة المخزون غير صالحة؛ أُوقف الخصم لحماية تكلفة FIFO');
        }
        batchCompareGuards.push({
          entity: 'inventoryBatches', recordId: JSON.stringify(original.id),
          field: 'costPrice', expectedValue: String(original.costPrice),
        });
      }
    }
    await commitNativeInventoryChanges(changes, {
      entity: 'products',
      recordId: JSON.stringify(params.productId),
      field: 'stockQuantity',
      expectedValue: String(product.stockQuantity ?? 0),
    }, batchCompareGuards);
    return { totalCost: roundMoney(totalCost), averageUnitCost, allocations };
  }
  await ensureDesktopDatabase();
  const product = await db.products.get(params.productId);
  if (!product) throw new Error(`الصنف غير موجود (ID: ${params.productId})`);

  const qtyNeeded = roundQty(params.quantityInBaseUnits);
  if (qtyNeeded <= 0) return { totalCost: 0, averageUnitCost: 0, allocations: [] };

  const previousQty = roundQty(Number(product.stockQuantity || 0));
  const nextQty = roundQty(previousQty - qtyNeeded);
  if (!allowNegative && nextQty < -1e-6) {
    throw new Error(`الكمية المتاحة لا تكفي للمنتج ${product.name}`);
  }

  const batches = (await db.inventoryBatches.toArray())
    .filter((batch) => Number(batch.productId) === params.productId && Number(batch.remainingQuantity || 0) > 0)
    .sort((a, b) => {
      const dateOrder = String(a.purchaseDate || '').localeCompare(String(b.purchaseDate || ''));
      if (dateOrder !== 0) return dateOrder;
      const createdOrder = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      return createdOrder || String(a.id || '').localeCompare(String(b.id || ''));
    });

  const valuation = await db.settings.where('key').equals('inventoryValuationMethod').first();
  const weightedAverage = valuation?.value === 'weighted_average';
  let weightedUnitCost = Number(product.costPrice || 0);
  if (weightedAverage && batches.length > 0) {
    const activeQty = batches.reduce((sum, batch) => sum + Number(batch.remainingQuantity || 0), 0);
    const activeValue = batches.reduce((sum, batch) => sum + Number(batch.remainingQuantity || 0) * Number(batch.costPrice || 0), 0);
    if (activeQty > 0) weightedUnitCost = Math.round((activeValue / activeQty) * 10000) / 10000;
  }

  if (weightedAverage) {
    for (const batch of batches) {
      await db.inventoryBatches.update(batch.id!, {
        costPrice: weightedUnitCost,
        updatedAt: params.createdAt,
        syncStatus: params.syncStatus || 'pending',
      });
    }
  }

  let remaining = qtyNeeded;
  let totalCost = 0;
  const allocations: LocalBatchAllocation[] = [];
  for (const batch of batches) {
    if (remaining <= 1e-6) break;
    const available = Number(batch.remainingQuantity || 0);
    const take = roundQty(Math.min(remaining, available));
    if (take <= 0) continue;
    const batchId = String(batch.id);
    await db.inventoryBatches.update(batch.id!, {
      remainingQuantity: roundQty(Math.max(0, available - take)),
      updatedAt: params.createdAt,
      syncStatus: params.syncStatus || 'pending',
    });
    const costPrice = weightedAverage ? weightedUnitCost : Number(batch.costPrice || 0);
    totalCost += take * costPrice;
    allocations.push({ batchId, quantity: take, costPrice });
    remaining = roundQty(remaining - take);
  }

  if (remaining > 1e-6) {
    const fallbackCost = weightedAverage ? weightedUnitCost : Number(product.costPrice || 0);
    totalCost += remaining * fallbackCost;
    allocations.push({ batchId: null, quantity: remaining, costPrice: fallbackCost });
  }

  await db.products.update(product.id!, {
    ...(weightedAverage ? { costPrice: roundMoney(weightedUnitCost) } : {}),
    stockQuantity: nextQty,
    updatedAt: params.createdAt,
    syncStatus: params.syncStatus || 'pending',
  });

  if (nextQty < -1e-6) {
    await db.inventoryAlerts.put({
      id: `offline-oversell:${params.operationId}:${params.productId}:${params.movementKeySuffix}`,
      productId: params.productId,
      productName: product.name,
      previousQty,
      changeQty: -qtyNeeded,
      resultingQty: nextQty,
      operationId: params.operationId,
      deviceId: params.deviceId,
      reason: 'offline_oversell',
      resolved: 0,
      createdAt: params.createdAt,
    });
  }

  const averageUnitCost = totalCost / qtyNeeded;
  await recordLocalInventoryMovement({
    movementKey: `${params.sourceType || 'order'}:${params.sourceId}:out:${params.productId}:${params.movementKeySuffix}`,
    productId: params.productId,
    movementType: params.movementType || 'sale',
    sourceType: params.sourceType || 'order',
    sourceId: params.sourceId,
    quantityDeltaBase: -qtyNeeded,
    unitCost: averageUnitCost,
    totalCost,
    branchId: params.branchId,
    operationId: params.operationId,
    reason: params.reason,
    createdBy: params.createdBy,
    createdAt: params.createdAt,
    syncStatus: params.syncStatus,
  });

  return {
    totalCost: roundMoney(totalCost),
    averageUnitCost,
    allocations,
  };
}

export async function restoreLocalInventoryFIFO(params: {
  productId: number;
  quantityInBaseUnits: number;
  allocations: LocalBatchAllocation[];
  fallbackCost: number;
  operationId: string;
  deviceId: string;
  sourceId: string;
  movementKeySuffix: string;
  movementType?: string;
  sourceType?: string;
  branchId?: number;
  reason?: string;
  createdBy?: string;
  createdAt: string;
  syncStatus?: 'synced' | 'pending';
}): Promise<number> {
  if (isLocalSqlite()) {
    const qtyToRestore = roundQty(params.quantityInBaseUnits);
    if (!Number.isFinite(qtyToRestore) || qtyToRestore < 0) throw new Error('كمية إعادة المخزون غير صالحة');
    if (qtyToRestore <= 0) return 0;
    const movementKey = (params.sourceType || 'return') + ':' + params.sourceId + ':in:' + params.productId + ':' + params.movementKeySuffix;
    const existingMovement = await nativePosRepository.firstWhereEquals<any>('inventoryMovements', 'movementKey', movementKey);
    if (existingMovement) {
      const existingQuantity = Number(existingMovement.quantityDeltaBase);
      const existingCost = Number(existingMovement.totalCost);
      if (Number(existingMovement.productId) !== params.productId ||
          Math.abs(existingQuantity - qtyToRestore) > 0.000001 ||
          !Number.isFinite(existingCost) || existingCost < 0 ||
          String(existingMovement.sourceId) !== String(params.sourceId) ||
          String(existingMovement.sourceType || 'return') !== String(params.sourceType || 'return')) {
        throw new Error('مفتاح حركة المرتجع مستخدم سابقًا بكمية أو صنف أو مصدر مختلف؛ أوقف الترحيل للمراجعة');
      }
      return roundMoney(existingCost);
    }
    const [batchRows, productRow, valuation] = await Promise.all([
      nativePosRepository.getAllWithSyncState('inventoryBatches'),
      (async () => (await nativePosRepository.getAllWithSyncState('products')).find((row) => Number(row.record.id) === params.productId))(),
      nativePosRepository.firstWhereEquals<any>('settings', 'key', 'inventoryValuationMethod'),
    ]);
    if (!productRow) throw new Error('الصنف غير موجود؛ أُوقف ترحيل المرتجع لمنع إنشاء حركة مخزون يتيمة');
    const originalProductStock = Number(productRow.record.stockQuantity);
    if (!Number.isFinite(originalProductStock)) throw new Error('رصيد الصنف غير صالح؛ أُوقف إعادة المخزون لحماية الدفتر المخزني');
    if (!Number.isFinite(Number(params.fallbackCost)) || Number(params.fallbackCost) < 0 ||
        params.allocations.some((allocation) =>
          !allocation || !Number.isFinite(Number(allocation.quantity)) || Number(allocation.quantity) < 0 ||
          !Number.isFinite(Number(allocation.costPrice ?? params.fallbackCost)) ||
          Number(allocation.costPrice ?? params.fallbackCost) < 0
        )) {
      throw new Error('بيانات تكلفة أو كميات المرتجع غير صالحة');
    }
    let remaining = qtyToRestore, totalCost = 0;
    const changes: any[] = [];
    const stagedBatches = new Map<string, any>();
    for (let i = params.allocations.length - 1; i >= 0 && remaining > 1e-6; i--) {
      const allocation = params.allocations[i];
      if (!allocation || allocation.quantity <= 0) continue;
      let putBack = roundQty(Math.min(remaining, allocation.quantity));
      const allocationCost = Number(allocation.costPrice ?? params.fallbackCost);
      let restoredBatchId: string | null = allocation.batchId;
      if (allocation.batchId) {
        const row = batchRows.find((item) => String(item.record.id) === String(allocation.batchId));
        if (row && Number(row.record.productId) === params.productId) {
          const batch: any = stagedBatches.get(String(allocation.batchId)) || row.record;
          const current = Number(batch.remainingQuantity || 0);
          const originalQuantity = Number(batch.quantity);
          if (!Number.isFinite(current) || current < 0 || !Number.isFinite(originalQuantity) ||
              originalQuantity <= 0 || current > originalQuantity + 0.0001) {
            throw new Error('بيانات دفعة المخزون الأصلية غير صالحة؛ أُوقف المرتجع');
          }
          const room = roundQty(Math.max(0, originalQuantity - current));
          putBack = roundQty(Math.min(putBack, room));
          if (putBack <= 1e-6) continue;
          const updatedBatch = { ...batch, remainingQuantity: roundQty(current + putBack), updatedAt: params.createdAt, syncStatus: params.syncStatus || 'pending' };
          stagedBatches.set(String(allocation.batchId), updatedBatch);
          changes.push({
            action: 'put', entity: 'inventoryBatches',
            record: updatedBatch,
            syncState: params.syncStatus || row.syncState,
          });
        } else {
          restoredBatchId = generateUUID();
          changes.push({
            action: 'put', entity: 'inventoryBatches',
            record: { id: restoredBatchId, productId: params.productId, purchaseId: null, quantity: putBack, remainingQuantity: putBack, costPrice: allocationCost, purchaseDate: params.createdAt, branchId: params.branchId, syncStatus: params.syncStatus || 'pending', createdAt: params.createdAt, updatedAt: params.createdAt },
            syncState: params.syncStatus || 'local',
          });
        }
      } else {
        restoredBatchId = generateUUID();
        changes.push({
          action: 'put', entity: 'inventoryBatches',
          record: { id: restoredBatchId, productId: params.productId, purchaseId: null, quantity: putBack, remainingQuantity: putBack, costPrice: allocationCost, purchaseDate: params.createdAt, branchId: params.branchId, syncStatus: params.syncStatus || 'pending', createdAt: params.createdAt, updatedAt: params.createdAt },
          syncState: params.syncStatus || 'local',
        });
      }
      totalCost += putBack * allocationCost;
      remaining = roundQty(remaining - putBack);
    }
    if (remaining > 1e-6) {
      const batchId = generateUUID();
      changes.push({
        action: 'put', entity: 'inventoryBatches',
        record: { id: batchId, productId: params.productId, purchaseId: null, quantity: remaining, remainingQuantity: remaining, costPrice: params.fallbackCost, purchaseDate: params.createdAt, branchId: params.branchId, syncStatus: params.syncStatus || 'pending', createdAt: params.createdAt, updatedAt: params.createdAt },
        syncState: params.syncStatus || 'local',
      });
      totalCost += remaining * params.fallbackCost;
    }
    {
      const product: any = productRow.record;
      const valuationBatches = new Map<string, any>(batchRows.map((row) => [String(row.record.id),
        stagedBatches.get(String(row.record.id)) || row.record]));
      for (const change of changes) {
        if (change.action === 'put' && change.entity === 'inventoryBatches') {
          valuationBatches.set(String(change.record.id), change.record);
        }
      }
      const activeBatches = [...valuationBatches.values()].filter((batch: any) =>
        Number(batch.productId) === params.productId && Number(batch.remainingQuantity || 0) > 0,
      );
      for (const batch of activeBatches) {
        if (!Number.isFinite(Number(batch.remainingQuantity)) || Number(batch.remainingQuantity) <= 0 ||
            !Number.isFinite(Number(batch.costPrice)) || Number(batch.costPrice) < 0) {
          throw new Error('توجد دفعة مخزون بكمية أو تكلفة غير صالحة؛ أُوقف المرتجع لحماية متوسط التكلفة');
        }
      }
      const activeQty = activeBatches.reduce((sum: number, batch: any) => sum + Number(batch.remainingQuantity || 0), 0);
      const activeValue = activeBatches.reduce((sum: number, batch: any) =>
        sum + Number(batch.remainingQuantity || 0) * Number(batch.costPrice || 0), 0);
      const weightedCost = valuation?.value === 'weighted_average' && activeQty > 0
        ? Math.round((activeValue / activeQty) * 10000) / 10000
        : undefined;
      changes.push({
        action: 'put', entity: 'products',
        record: { ...product, ...(weightedCost !== undefined ? { costPrice: roundMoney(weightedCost) } : {}),
          stockQuantity: roundQty(Number(product.stockQuantity || 0) + qtyToRestore),
          updatedAt: params.createdAt, syncStatus: params.syncStatus || 'pending' },
        syncState: params.syncStatus || productRow.syncState,
      });
    }
    changes.push({
      action: 'put', entity: 'inventoryMovements',
      record: {
        id: generateUUID(), movementKey, productId: params.productId,
        movementType: params.movementType || 'sale_return', sourceType: params.sourceType || 'return', sourceId: params.sourceId,
        quantityDeltaBase: qtyToRestore, baseUnitCode: (productRow?.record as any)?.baseUnitCode || (productRow?.record as any)?.unit || 'piece',
        unitCost: Math.round((Number(qtyToRestore > 0 ? totalCost / qtyToRestore : params.fallbackCost) || 0) * 10000) / 10000,
        totalCost: roundMoney(totalCost), branchId: params.branchId ?? (productRow?.record as any)?.branchId,
        operationId: params.operationId, reason: params.reason, createdBy: params.createdBy || 'System',
        syncStatus: params.syncStatus || 'pending', createdAt: params.createdAt,
      },
      syncState: params.syncStatus || 'local',
    });
    const restoreBatchGuards: Array<{ entity: string; recordId: string; field: string; expectedValue: string }> = [];
    for (const [batchId, updatedBatch] of stagedBatches) {
      const original = batchRows.find((row) => String(row.record.id) === batchId)?.record as any;
      if (!original || original.remainingQuantity === undefined || original.remainingQuantity === null ||
          !Number.isFinite(Number(original.remainingQuantity))) {
        throw new Error('كمية دفعة المخزون الأصلية غير صالحة؛ أُوقف إعادة الكمية لمنع تعارض المرتجعات');
      }
      restoreBatchGuards.push({
        entity: 'inventoryBatches', recordId: JSON.stringify(original.id),
        field: 'remainingQuantity', expectedValue: String(original.remainingQuantity),
      });
    }
    await commitNativeInventoryChanges(changes, {
      entity: 'products',
      recordId: JSON.stringify(params.productId),
      field: 'stockQuantity',
      expectedValue: String(productRow.record.stockQuantity ?? 0),
    }, restoreBatchGuards);
    return roundMoney(totalCost);
  }
  await ensureDesktopDatabase();
  const qtyToRestore = roundQty(params.quantityInBaseUnits);
  if (qtyToRestore <= 0) return 0;
  let remaining = qtyToRestore;
  let totalCost = 0;

  for (let i = params.allocations.length - 1; i >= 0 && remaining > 1e-6; i--) {
    const allocation = params.allocations[i];
    if (!allocation || allocation.quantity <= 0) continue;
    let putBack = roundQty(Math.min(remaining, allocation.quantity));
    const allocationCost = Number(allocation.costPrice ?? params.fallbackCost);
    let restoredBatchId: string | null = allocation.batchId;
    if (allocation.batchId) {
      const batch = await db.inventoryBatches.get(allocation.batchId);
      if (batch && Number(batch.productId) === Number(params.productId)) {
        const current = Number(batch.remainingQuantity || 0);
        const originalQuantity = Number(batch.quantity);
        if (!Number.isFinite(current) || current < 0 || !Number.isFinite(originalQuantity) ||
            originalQuantity <= 0 || current > originalQuantity + 0.0001) {
          throw new Error('بيانات دفعة المخزون الأصلية غير صالحة؛ أُوقف المرتجع');
        }
        const room = roundQty(Math.max(0, originalQuantity - current));
        putBack = roundQty(Math.min(putBack, room));
        if (putBack <= 1e-6) continue;
        await db.inventoryBatches.update(batch.id!, {
          remainingQuantity: roundQty(current + putBack), updatedAt: params.createdAt, syncStatus: params.syncStatus || 'pending',
        });
      } else {
        restoredBatchId = generateUUID();
        await db.inventoryBatches.put({
          id: restoredBatchId, productId: params.productId, purchaseId: null, quantity: putBack, remainingQuantity: putBack,
          costPrice: allocationCost, purchaseDate: params.createdAt, branchId: params.branchId,
          syncStatus: params.syncStatus || 'pending', createdAt: params.createdAt, updatedAt: params.createdAt,
        });
      }
    } else {
      restoredBatchId = generateUUID();
      await db.inventoryBatches.put({
        id: restoredBatchId, productId: params.productId, purchaseId: null, quantity: putBack, remainingQuantity: putBack,
        costPrice: allocationCost, purchaseDate: params.createdAt, branchId: params.branchId,
        syncStatus: params.syncStatus || 'pending', createdAt: params.createdAt, updatedAt: params.createdAt,
      });
    }
    totalCost += putBack * allocationCost;
    remaining = roundQty(remaining - putBack);
  }

  if (remaining > 1e-6) {
    const batchId = generateUUID();
    await db.inventoryBatches.put({
      id: batchId,
      productId: params.productId,
      purchaseId: null,
      quantity: remaining,
      remainingQuantity: remaining,
      costPrice: params.fallbackCost,
      purchaseDate: params.createdAt,
      branchId: params.branchId,
      syncStatus: params.syncStatus || 'pending',
      createdAt: params.createdAt,
      updatedAt: params.createdAt,
    });
    totalCost += remaining * params.fallbackCost;
  }

  const product = await db.products.get(params.productId);
  if (!product) throw new Error('الصنف غير موجود؛ أُوقف ترحيل المرتجع لمنع إنشاء حركة مخزون يتيمة');
  const valuation = await db.settings.where('key').equals('inventoryValuationMethod').first();
  let weightedCost: number | undefined;
  if (valuation?.value === 'weighted_average') {
    const activeBatches = (await db.inventoryBatches.where('productId').equals(params.productId).toArray())
      .filter((batch) => Number(batch.remainingQuantity || 0) > 0);
    const activeQty = activeBatches.reduce((sum, batch) => sum + Number(batch.remainingQuantity || 0), 0);
    if (activeQty > 0) {
      const activeValue = activeBatches.reduce((sum, batch) =>
        sum + Number(batch.remainingQuantity || 0) * Number(batch.costPrice || 0), 0);
      weightedCost = Math.round((activeValue / activeQty) * 10000) / 10000;
    }
  }
  await db.products.update(product.id!, {
    ...(weightedCost !== undefined ? { costPrice: roundMoney(weightedCost) } : {}),
    stockQuantity: roundQty(Number(product.stockQuantity || 0) + qtyToRestore),
    updatedAt: params.createdAt,
    syncStatus: params.syncStatus || 'pending',
  });

  await recordLocalInventoryMovement({
    movementKey: `${params.sourceType || 'return'}:${params.sourceId}:in:${params.productId}:${params.movementKeySuffix}`,
    productId: params.productId,
    movementType: params.movementType || 'sale_return',
    sourceType: params.sourceType || 'return',
    sourceId: params.sourceId,
    quantityDeltaBase: qtyToRestore,
    unitCost: qtyToRestore > 0 ? totalCost / qtyToRestore : params.fallbackCost,
    totalCost,
    branchId: params.branchId,
    operationId: params.operationId,
    reason: params.reason,
    createdBy: params.createdBy,
    createdAt: params.createdAt,
    syncStatus: params.syncStatus,
  });
  return roundMoney(totalCost);
}

export async function removeLocalInventoryArtifactsForOperation(operationId: string): Promise<void> {
  if (isLocalSqlite()) {
    const [movements, alerts] = await Promise.all([
      nativePosRepository.whereEquals<any>('inventoryMovements', 'operationId', operationId),
      nativePosRepository.whereEquals<any>('inventoryAlerts', 'operationId', operationId),
    ]);
    const changes = [
      ...movements.map((movement: any) => ({ action: 'delete' as const, entity: 'inventoryMovements' as const, key: movement.id })),
      ...alerts.map((alert: any) => ({ action: 'delete' as const, entity: 'inventoryAlerts' as const, key: alert.id })),
    ];
    if (changes.length) {
      const applied = await nativePosRepository.applyChanges(changes);
      if (applied !== changes.length) throw new Error('SQLite لم تؤكد حذف جميع آثار المخزون');
    }
    return;
  }
  await ensureDesktopDatabase();
  const movements = await db.inventoryMovements.filter((movement) => movement.operationId === operationId).toArray();
  if (movements.length) await db.inventoryMovements.bulkDelete(movements.map((movement) => movement.id));
  const alerts = await db.inventoryAlerts.filter((alert) => alert.operationId === operationId).toArray();
  if (alerts.length) await db.inventoryAlerts.bulkDelete(alerts.map((alert) => alert.id));
}
