import { db } from '../db/db';
import { generateUUID } from '../utils/uuid';
import { roundQty } from '../utils/format';

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
}

export interface ConsumeLocalInventoryResult {
  totalCost: number;
  averageUnitCost: number;
  allocations: LocalBatchAllocation[];
}

function roundMoney(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function recordLocalMovement(input: {
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
}) {
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
    syncStatus: 'pending',
    createdAt: input.createdAt,
  });
}

export async function consumeLocalInventoryFIFO(
  params: ConsumeLocalInventoryParams
): Promise<ConsumeLocalInventoryResult> {
  const product = await db.products.get(params.productId);
  if (!product) throw new Error(`الصنف غير موجود (ID: ${params.productId})`);

  const qtyNeeded = roundQty(params.quantityInBaseUnits);
  if (qtyNeeded <= 0) return { totalCost: 0, averageUnitCost: 0, allocations: [] };

  const previousQty = roundQty(Number(product.stockQuantity || 0));
  const nextQty = roundQty(previousQty - qtyNeeded);
  if (!params.allowNegative && nextQty < -1e-6) {
    throw new Error(`الكمية المتاحة لا تكفي للمنتج ${product.name}`);
  }

  const batches = (await db.inventoryBatches.toArray())
    .filter((batch) => Number(batch.productId) === params.productId && Number(batch.remainingQuantity ?? batch.quantity) > 0)
    .sort((a, b) => {
      const dateOrder = String(a.purchaseDate || '').localeCompare(String(b.purchaseDate || ''));
      if (dateOrder !== 0) return dateOrder;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });

  const valuation = await db.settings.where('key').equals('inventoryValuationMethod').first();
  const weightedAverage = valuation?.value === 'weighted_average';
  let weightedUnitCost = Number(product.costPrice || 0);
  if (weightedAverage && batches.length > 0) {
    const activeQty = batches.reduce((sum, batch) => sum + Number(batch.remainingQuantity ?? batch.quantity), 0);
    const activeValue = batches.reduce((sum, batch) => sum + Number(batch.remainingQuantity ?? batch.quantity) * Number(batch.costPrice || 0), 0);
    if (activeQty > 0) weightedUnitCost = activeValue / activeQty;
  }

  let remaining = qtyNeeded;
  let totalCost = 0;
  const allocations: LocalBatchAllocation[] = [];
  for (const batch of batches) {
    if (remaining <= 1e-6) break;
    const available = Number(batch.remainingQuantity ?? batch.quantity);
    const take = roundQty(Math.min(remaining, available));
    if (take <= 0) continue;
    const batchId = String(batch.id);
    await db.inventoryBatches.update(batch.id!, {
      remainingQuantity: roundQty(Math.max(0, available - take)),
      updatedAt: params.createdAt,
      syncStatus: 'pending',
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
    stockQuantity: nextQty,
    updatedAt: params.createdAt,
    syncStatus: 'pending',
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
  await recordLocalMovement({
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
  branchId?: number;
  reason?: string;
  createdBy?: string;
  createdAt: string;
}): Promise<number> {
  const qtyToRestore = roundQty(params.quantityInBaseUnits);
  if (qtyToRestore <= 0) return 0;
  let remaining = qtyToRestore;
  let totalCost = 0;

  for (let i = params.allocations.length - 1; i >= 0 && remaining > 1e-6; i--) {
    const allocation = params.allocations[i];
    if (!allocation || allocation.quantity <= 0) continue;
    let putBack = roundQty(Math.min(remaining, allocation.quantity));
    if (allocation.batchId) {
      const batch = await db.inventoryBatches.get(allocation.batchId);
      if (!batch) continue;
      const current = Number(batch.remainingQuantity ?? batch.quantity);
      const room = roundQty(Math.max(0, Number(batch.quantity) - current));
      putBack = roundQty(Math.min(putBack, room));
      if (putBack <= 1e-6) continue;
      await db.inventoryBatches.update(batch.id!, {
        remainingQuantity: roundQty(current + putBack),
        updatedAt: params.createdAt,
        syncStatus: 'pending',
      });
    } else {
      const batchId = generateUUID();
      await db.inventoryBatches.put({
        id: batchId,
        productId: params.productId,
        purchaseId: null,
        quantity: putBack,
        remainingQuantity: putBack,
        costPrice: Number(allocation.costPrice ?? params.fallbackCost),
        purchaseDate: params.createdAt,
        branchId: params.branchId,
        syncStatus: 'pending',
        createdAt: params.createdAt,
        updatedAt: params.createdAt,
      });
    }
    totalCost += putBack * Number(allocation.costPrice ?? params.fallbackCost);
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
      syncStatus: 'pending',
      createdAt: params.createdAt,
      updatedAt: params.createdAt,
    });
    totalCost += remaining * params.fallbackCost;
  }

  const product = await db.products.get(params.productId);
  if (product) {
    await db.products.update(product.id!, {
      stockQuantity: roundQty(Number(product.stockQuantity || 0) + qtyToRestore),
      updatedAt: params.createdAt,
      syncStatus: 'pending',
    });
  }

  await recordLocalMovement({
    movementKey: `${'return'}:${params.sourceId}:in:${params.productId}:${params.movementKeySuffix}`,
    productId: params.productId,
    movementType: 'sale_return',
    sourceType: 'return',
    sourceId: params.sourceId,
    quantityDeltaBase: qtyToRestore,
    unitCost: qtyToRestore > 0 ? totalCost / qtyToRestore : params.fallbackCost,
    totalCost,
    branchId: params.branchId,
    operationId: params.operationId,
    reason: params.reason,
    createdBy: params.createdBy,
    createdAt: params.createdAt,
  });
  return roundMoney(totalCost);
}
