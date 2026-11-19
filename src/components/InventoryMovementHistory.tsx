import { useEffect } from 'react';
import { usePosEntityRecords } from '../hooks/usePosEntityRecords';
import { useLiveQuery } from 'dexie-react-hooks';
import { apiService } from '../services/apiService';
import { db } from '../db/db';

type Props = {
  productId: number;
  currency: string;
};

const MOVEMENT_LABELS: Record<string, string> = {
  opening_balance: 'رصيد افتتاحي',
  purchase_receipt: 'استلام مشتريات',
  purchase_reversal: 'عكس مشتريات',
  sale: 'بيع',
  sale_return: 'مرتجع مبيعات',
  sale_void: 'إلغاء بيع',
  purchase_return: 'مرتجع مشتريات',
  stocktake_increase: 'زيادة جرد',
  stocktake_decrease: 'نقص جرد',
  legacy_batch_adjustment: 'تسوية دفعة قديمة',
  adjustment: 'تسوية مخزون',
};

function quantity(value: number) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function amount(value: number) {
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function InventoryMovementHistory({ productId, currency }: Props) {
  const movements = useLiveQuery(async () => {
    const rows = await db.inventoryMovements.where('productId').equals(productId).toArray();
    return rows.sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    );
  }, [productId]) || [];
  const unitDefinitions = usePosEntityRecords<any>('unitDefinitions');

  useEffect(() => {
    let cancelled = false;
    const loadLatest = async () => {
      try {
        const response = await apiService.getInventoryMovements({ productId, latest: true, limit: 500 });
        if (cancelled || !Array.isArray(response?.items) || response.items.length === 0) return;
        await db.transaction('rw', db.inventoryMovements, async () => {
          const keys = response.items.map((movement: any) => movement.movementKey);
          const localRows = await db.inventoryMovements.where('movementKey').anyOf(keys).toArray();
          const serverIds = new Set(response.items.map((movement: any) => movement.id));
          const staleIds = localRows.filter((movement) => !serverIds.has(movement.id)).map((movement) => movement.id);
          if (staleIds.length) await db.inventoryMovements.bulkDelete(staleIds);
          await db.inventoryMovements.bulkPut(
            response.items.map((movement: any) => ({ ...movement, syncStatus: 'synced' }))
          );
        });
      } catch {
        // The locally cached ledger remains available while the POS is offline.
      }
    };
    loadLatest();
    return () => { cancelled = true; };
  }, [productId]);

  return (
    <section className="mt-6 border-t border-gray-200 pt-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h4 className="font-bold text-gray-900">سجل حركة المخزون</h4>
          <p className="text-xs text-gray-500 mt-1">الكميات والتكاليف محفوظة بوحدة الأساس وقت حدوث الحركة</p>
        </div>
        <span className="text-xs rounded-full bg-gray-100 text-gray-600 px-3 py-1">
          {movements.length} حركة
        </span>
      </div>

      {movements.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-5 text-center text-sm text-gray-500">
          لا توجد حركات مسجلة لهذا الصنف حتى الآن
        </div>
      ) : (
        <div className="max-h-72 overflow-auto rounded-xl border border-gray-200">
          <table className="w-full text-xs text-right min-w-[760px]">
            <thead className="sticky top-0 bg-gray-50 text-gray-600">
              <tr>
                <th className="p-3 font-semibold">التاريخ</th>
                <th className="p-3 font-semibold">الحركة</th>
                <th className="p-3 font-semibold">المرجع</th>
                <th className="p-3 font-semibold">الكمية بوحدة الأساس</th>
                <th className="p-3 font-semibold">تكلفة الوحدة</th>
                <th className="p-3 font-semibold">قيمة التكلفة</th>
                <th className="p-3 font-semibold">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((movement) => {
                const delta = Number(movement.quantityDeltaBase || 0);
                return (
                  <tr key={movement.id} className="border-t border-gray-100">
                    <td className="p-3 whitespace-nowrap text-gray-600">
                      {new Date(movement.createdAt).toLocaleString()}
                    </td>
                    <td className="p-3 font-medium text-gray-800">
                      {MOVEMENT_LABELS[movement.movementType] || movement.movementType}
                    </td>
                    <td className="p-3 text-gray-600">
                      {movement.sourceType} / {movement.sourceId}
                    </td>
                    <td className={`p-3 font-semibold tabular-nums ${delta >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {delta > 0 ? '+' : ''}{quantity(delta)} {unitDefinitions.find((unit) => unit.code === movement.baseUnitCode)?.symbol || movement.baseUnitCode || ''}
                    </td>
                    <td className="p-3 tabular-nums">{amount(movement.unitCost)} {currency}</td>
                    <td className="p-3 tabular-nums">{amount(movement.totalCost)} {currency}</td>
                    <td className="p-3">
                      {movement.syncStatus === 'pending' ? (
                        <span className="rounded-full bg-amber-50 text-amber-700 px-2 py-1">بانتظار المزامنة</span>
                      ) : movement.syncStatus === 'error' || movement.syncStatus === 'conflict' ? (
                        <span className="rounded-full bg-rose-50 text-rose-700 px-2 py-1">تحتاج مراجعة</span>
                      ) : (
                        <span className="rounded-full bg-emerald-50 text-emerald-700 px-2 py-1">متزامنة</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
