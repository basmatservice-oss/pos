import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Search } from 'lucide-react';
import { db } from '../db/db';
import { apiService } from '../services/apiService';

type Props = { currency: string };

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
  service_consumption: 'استهلاك خدمة',
  assembly_in: 'تجميع',
  assembly_out: 'تفكيك',
};

const quantity = (value: number) =>
  Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 6 });

const amount = (value: number) =>
  Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function InventoryMovementLedger({ currency }: Props) {
  const [search, setSearch] = useState('');
  const [movementType, setMovementType] = useState('all');
  const [sourceType, setSourceType] = useState('all');
  const [branchId, setBranchId] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [serverMovements, setServerMovements] = useState<any[] | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const localMovements = useLiveQuery(
    () => db.inventoryMovements.orderBy('createdAt').reverse().limit(500).toArray(),
    []
  ) || [];
  const movements = serverMovements ?? localMovements;
  const products = useLiveQuery(() => db.products.toArray(), []) || [];
  const units = useLiveQuery(() => db.unitDefinitions.toArray(), []) || [];
  const branches = useLiveQuery(() => db.branches.toArray(), []) || [];

  useEffect(() => {
    let cancelled = false;
    const loadLatest = async () => {
      setServerMovements(null);
      setNextOffset(null);
      try {
        const response = await apiService.getInventoryMovements({
          latest: true,
          offset: 0,
          limit: 500,
          branchId: branchId === 'all' ? undefined : Number(branchId),
          sourceType: sourceType === 'all' ? undefined : sourceType,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
        });
        if (cancelled || !Array.isArray(response?.items)) return;
        setServerMovements(response.items);
        setNextOffset(typeof response.nextOffset === 'number' ? response.nextOffset : null);
        if (response.items.length === 0) return;
        await db.transaction('rw', db.inventoryMovements, async () => {
          const keys = response.items.map((movement: any) => movement.movementKey);
          const localRows = await db.inventoryMovements.where('movementKey').anyOf(keys).toArray();
          const serverIds = new Set(response.items.map((movement: any) => movement.id));
          const staleIds = localRows
            .filter((movement) => !serverIds.has(movement.id))
            .map((movement) => movement.id);
          if (staleIds.length) await db.inventoryMovements.bulkDelete(staleIds);
          await db.inventoryMovements.bulkPut(
            response.items.map((movement: any) => ({ ...movement, syncStatus: 'synced' }))
          );
        });
      } catch {
        // Keep cached local history available when the server is offline.
      }
    };
    loadLatest();
    return () => { cancelled = true; };
  }, [branchId, sourceType, startDate, endDate]);

  const handleLoadMore = async () => {
    if (nextOffset === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await apiService.getInventoryMovements({
        latest: true,
        offset: nextOffset,
        limit: 500,
        branchId: branchId === 'all' ? undefined : Number(branchId),
        sourceType: sourceType === 'all' ? undefined : sourceType,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
      if (!Array.isArray(response?.items)) return;
      setServerMovements((previous) => [...(previous || []), ...response.items]);
      setNextOffset(typeof response.nextOffset === 'number' ? response.nextOffset : null);
      if (response.items.length > 0) {
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
      }
    } catch {
      // Keep already loaded pages visible if the network drops.
    } finally {
      setLoadingMore(false);
    }
  };

  const productMap = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const movementTypes = useMemo(
    () => [...new Set(movements.map((movement) => movement.movementType))].sort(),
    [movements]
  );
  const sourceTypes = useMemo(
    () => [...new Set(movements.map((movement) => movement.sourceType))].sort(),
    [movements]
  );
  const exportCsv = () => {
    const textCell = (value: unknown) => {
      const raw = String(value ?? '');
      const safe = /^[=+@-]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const rows = [
      ['التاريخ', 'الصنف', 'نوع الحركة', 'المصدر', 'معرف المصدر', 'الفرع', 'الكمية بوحدة الأساس', 'رمز وحدة الأساس', 'تكلفة الوحدة', 'قيمة التكلفة', 'حالة المزامنة'],
      ...filtered.map((movement) => [
        movement.createdAt,
        productMap.get(movement.productId)?.name || `#${movement.productId}`,
        MOVEMENT_LABELS[movement.movementType] || movement.movementType,
        movement.sourceType,
        movement.sourceId,
        branches.find((row) => row.id === movement.branchId)?.name || movement.branchId || '',
        Number(movement.quantityDeltaBase || 0),
        movement.baseUnitCode || '',
        Number(movement.unitCost || 0),
        Number(movement.totalCost || 0),
        movement.syncStatus,
      ]),
    ];
    const csv = '\uFEFF' + rows.map((row) => row.map((value, index) =>
      typeof value === 'number' ? String(value) : textCell(value)
    ).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `inventory-movements-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return movements.filter((movement) => {
      if (movementType !== 'all' && movement.movementType !== movementType) return false;
      if (sourceType !== 'all' && movement.sourceType !== sourceType) return false;
      if (branchId !== 'all' && String(movement.branchId ?? '') !== branchId) return false;
      const movementDate = String(movement.createdAt || '').slice(0, 10);
      if (startDate && movementDate < startDate) return false;
      if (endDate && movementDate > endDate) return false;
      if (!query) return true;
      const productName = productMap.get(movement.productId)?.name || '';
      return [
        productName,
        movement.sourceId,
        movement.sourceType,
        movement.movementType,
        movement.reason || '',
      ].some((value) => String(value).toLowerCase().includes(query));
    });
  }, [movements, movementType, sourceType, branchId, startDate, endDate, productMap, search]);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm flex flex-col min-h-0">
      <div className="p-4 border-b border-gray-100 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="flex-1">
            <h3 className="font-bold text-gray-900">سجل حركة المخزون</h3>
            <p className="text-xs text-gray-500 mt-1">أحدث الحركات المتاحة محلياً ومن الخادم</p>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="px-3 py-2 border border-gray-200 rounded-xl text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            تصدير CSV
          </button>
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="بحث بالصنف أو المرجع..."
              className="w-full md:w-64 pr-9 pl-3 py-2 border border-gray-200 rounded-xl text-sm"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <input
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            aria-label="من تاريخ"
            className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
          />
          <input
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            aria-label="إلى تاريخ"
            className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
          />
          <select
            value={branchId}
            onChange={(event) => setBranchId(event.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
          >
            <option value="all">كل الفروع</option>
            {branches.map((branch) => (
              <option key={branch.id} value={String(branch.id)}>{branch.name}</option>
            ))}
          </select>
          <select
            value={sourceType}
            onChange={(event) => setSourceType(event.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
          >
            <option value="all">كل المصادر</option>
            {sourceTypes.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <select
            value={movementType}
            onChange={(event) => setMovementType(event.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
          >
            <option value="all">كل أنواع الحركات</option>
            {movementTypes.map((type) => (
              <option key={type} value={type}>{MOVEMENT_LABELS[type] || type}</option>
            ))}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="p-12 text-center text-sm text-gray-500">لا توجد حركات مطابقة</div>
      ) : (
        <div className="overflow-auto max-h-[68vh]">
          <table className="w-full min-w-[980px] text-xs text-right">
            <thead className="sticky top-0 bg-gray-50 text-gray-600 z-10">
              <tr>
                <th className="p-3 font-semibold">التاريخ</th>
                <th className="p-3 font-semibold">الصنف</th>
                <th className="p-3 font-semibold">نوع الحركة</th>
                <th className="p-3 font-semibold">المصدر</th>
                <th className="p-3 font-semibold">الفرع</th>
                <th className="p-3 font-semibold">الكمية بوحدة الأساس</th>
                <th className="p-3 font-semibold">تكلفة الوحدة</th>
                <th className="p-3 font-semibold">قيمة التكلفة</th>
                <th className="p-3 font-semibold">المزامنة</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((movement) => {
                const delta = Number(movement.quantityDeltaBase || 0);
                const unit = units.find((row) => row.code === movement.baseUnitCode);
                const branch = branches.find((row) => row.id === movement.branchId);
                return (
                  <tr key={movement.id} className="border-t border-gray-100 hover:bg-gray-50/70">
                    <td className="p-3 whitespace-nowrap text-gray-600">{new Date(movement.createdAt).toLocaleString()}</td>
                    <td className="p-3 font-semibold text-gray-900">{productMap.get(movement.productId)?.name || `#${movement.productId}`}</td>
                    <td className="p-3">{MOVEMENT_LABELS[movement.movementType] || movement.movementType}</td>
                    <td className="p-3 text-gray-600">{movement.sourceType} / {movement.sourceId}</td>
                    <td className="p-3 text-gray-600">{branch?.name || movement.branchId || '—'}</td>
                    <td className={`p-3 font-bold tabular-nums ${delta >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {delta > 0 ? '+' : ''}{quantity(delta)} {unit?.symbol || movement.baseUnitCode || ''}
                    </td>
                    <td className="p-3 tabular-nums">{amount(movement.unitCost)} {currency}</td>
                    <td className="p-3 tabular-nums">{amount(movement.totalCost)} {currency}</td>
                    <td className="p-3">
                      {movement.syncStatus === 'pending' ? 'بانتظار المزامنة'
                        : movement.syncStatus === 'error' || movement.syncStatus === 'conflict' ? 'تحتاج مراجعة'
                        : 'متزامنة'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {nextOffset !== null && (
        <div className="p-4 border-t border-gray-100 flex justify-center">
          <button
            type="button"
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="px-5 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-sm font-semibold text-gray-700"
          >
            {loadingMore ? 'جارٍ تحميل المزيد...' : 'تحميل 500 حركة إضافية'}
          </button>
        </div>
      )}
    </div>
  );
}
