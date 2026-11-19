import React, { useMemo } from 'react';
import { usePosEntityRecords } from '../hooks/usePosEntityRecords';
import { usePosRecordsWhereEquals } from '../hooks/usePosRecordsWhereEquals';
import { X, Package, ArrowDownLeft, ArrowUpRight, RefreshCw, History, Layers } from 'lucide-react';
import type { Product } from '../db/db';
import { formatMoney, formatQty, roundQty } from '../utils/format';
import { useSettings } from '../hooks/useSettings';

interface ItemCardModalProps {
  product: Product | null;
  onClose: () => void;
}

interface LedgerRow {
  id: string;
  date: string;
  kind: 'purchase' | 'sale' | 'return' | 'purchase_return' | 'stocktake' | 'price_change';
  label: string;
  reference: string;
  qtyDelta: number;
  unitPriceOrCost: number;
  notes?: string;
}

export const ItemCardModal: React.FC<ItemCardModalProps> = ({ product, onClose }) => {
  const settings = useSettings();
  const productId = product?.id;

  const batches = usePosRecordsWhereEquals<any>('inventoryBatches', 'productId', productId);

  const orderItems = usePosRecordsWhereEquals<any>('orderItems', 'productId', productId);

  const orders = usePosEntityRecords<any>('orders');

  const returnItems = usePosRecordsWhereEquals<any>('returnItems', 'productId', productId);

  const returns = usePosEntityRecords<any>('returns');

  const purchaseItems = usePosRecordsWhereEquals<any>('purchaseItems', 'productId', productId);

  const purchases = usePosEntityRecords<any>('purchases');

  const purchaseReturnItems = usePosRecordsWhereEquals<any>('purchaseReturnItems', 'productId', productId);

  const purchaseReturns = usePosEntityRecords<any>('purchaseReturns');

  const stocktakeEntries = usePosRecordsWhereEquals<any>('stocktakingEntries', 'productId', productId);

  const auditLogs = usePosEntityRecords<any>('auditLogs');

  const ledger = useMemo<LedgerRow[]>(() => {
    if (!product || !productId) return [];
    const orderMap = new Map(orders.map((o) => [o.id, o]));
    const returnMap = new Map(returns.map((r) => [r.id, r]));
    const purchaseMap = new Map(purchases.map((p) => [p.id, p]));
    const prMap = new Map(purchaseReturns.map((pr) => [pr.id, pr]));

    const rows: LedgerRow[] = [];

    for (const pi of purchaseItems) {
      const p = purchaseMap.get(pi.purchaseId);
      const factor = Number(pi.conversionFactor || 1);
      const baseQty = roundQty(Number(pi.quantity || 0) * factor);
      rows.push({
        id: `pur-${pi.id || Math.random()}`,
        date: p?.date || p?.createdAt || '',
        kind: 'purchase',
        label: 'فاتورة مشتريات',
        reference: p?.supplierName ? `${p.supplierName}` : pi.purchaseId.slice(0, 8),
        qtyDelta: baseQty,
        unitPriceOrCost: Number(pi.landedCostPerBaseUnit ?? pi.costPrice ?? 0),
        notes: pi.batchNumber ? `تشغيلة: ${pi.batchNumber}` : undefined,
      });
    }

    for (const oi of orderItems) {
      const ord = orderMap.get(oi.orderId);
      if (ord?.status === 'void') continue;
      const factor = Number(oi.conversionFactor || 1);
      const baseQty = roundQty(Number(oi.quantity || 0) * factor);
      rows.push({
        id: `ord-${oi.id || Math.random()}`,
        date: ord?.createdAt || '',
        kind: 'sale',
        label: 'فاتورة مبيعات',
        reference: ord?.receiptNumber || oi.orderId.slice(0, 8),
        qtyDelta: -baseQty,
        unitPriceOrCost: Number(oi.unitPrice || 0),
        notes: oi.unit && oi.unit !== 'piece' ? `${oi.unit} (x${factor})` : undefined,
      });
    }

    for (const ri of returnItems) {
      const ret = returnMap.get(ri.returnId);
      const isDamaged = ri.condition === 'damaged';
      rows.push({
        id: `ret-${ri.id}`,
        date: ret?.createdAt || ri.createdAt || '',
        kind: 'return',
        label: isDamaged ? 'مرتجع مبيعات (تالف)' : 'مرتجع مبيعات',
        reference: ret?.returnNumber || ri.returnId.slice(0, 8),
        qtyDelta: isDamaged ? 0 : roundQty(Number(ri.quantity || 0)),
        unitPriceOrCost: Number(ri.unitPrice || 0),
        notes: isDamaged ? 'لم يُعد للمخزون الصالح' : undefined,
      });
    }

    for (const pri of purchaseReturnItems) {
      const pr = prMap.get(pri.purchaseReturnId);
      rows.push({
        id: `pr-${pri.id}`,
        date: pr?.createdAt || pri.createdAt || '',
        kind: 'purchase_return',
        label: 'مرتجع مشتريات',
        reference: pr?.returnNumber || pri.purchaseReturnId.slice(0, 8),
        qtyDelta: -roundQty(Number(pri.quantity || 0)),
        unitPriceOrCost: Number(pri.costPrice || 0),
      });
    }

    for (const st of stocktakeEntries) {
      const diff = roundQty(Number(st.actualQuantity || 0) - Number(st.systemQuantity || 0));
      rows.push({
        id: `st-${st.id || Math.random()}`,
        date: st.scannedAt || '',
        kind: 'stocktake',
        label: 'تسوية جرد',
        reference: st.sessionId.slice(0, 8),
        qtyDelta: diff,
        unitPriceOrCost: Number(product.costPrice || 0),
        notes: `النظام: ${formatQty(st.systemQuantity)} -> الفعلي: ${formatQty(st.actualQuantity)}`,
      });
    }

    for (const log of auditLogs) {
      const matchesProduct =
        log.entityId === String(productId) ||
        (log.productName && log.productName === product.name);
      if (!matchesProduct) continue;
      if (log.type === 'price_change' || log.action === 'تعديل سعر') {
        rows.push({
          id: `aud-${log.id}`,
          date: log.date,
          kind: 'price_change',
          label: 'تعديل سعر / تكلفة',
          reference: log.userName,
          qtyDelta: 0,
          unitPriceOrCost: Number(log.value || 0),
          notes: log.details,
        });
      }
    }

    return rows.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
  }, [product, productId, orders, orderItems, returns, returnItems, purchases, purchaseItems, purchaseReturns, purchaseReturnItems, stocktakeEntries, auditLogs]);

  if (!product) return null;

  const totalRemainingBatchQty = roundQty(
    batches.reduce((s, b) => s + Number(b.remainingQuantity ?? b.quantity ?? 0), 0)
  );
  const totalBatchValue = batches.reduce(
    (s, b) => s + Number(b.remainingQuantity ?? b.quantity ?? 0) * Number(b.costPrice || 0),
    0
  );
  const weightedAvgCost =
    totalRemainingBatchQty > 0 ? totalBatchValue / totalRemainingBatchQty : Number(product.costPrice || 0);

  return (
    <div className="fixed inset-0 z-[90] bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div
        className="bg-white w-full max-w-4xl max-h-[90vh] rounded-3xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-gray-50/70">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100 flex items-center justify-center">
              <Package className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-lg font-black text-gray-900">بطاقة الصنف: {product.name}</h3>
              <p className="text-xs text-gray-500 font-mono">الباركود: {product.barcode || '-'}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl text-gray-400 hover:bg-gray-200 hover:text-gray-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6">
          {/* Summary Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <p className="text-xs text-slate-500">الرصيد الحالي</p>
              <p className="text-xl font-black text-slate-900 mt-1 tabular-nums">
                {product.itemType === 'service' ? 'خدمة' : formatQty(product.stockQuantity)}
              </p>
            </div>
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <p className="text-xs text-slate-500">متوسط التكلفة المرجح</p>
              <p className="text-xl font-black text-indigo-700 mt-1 tabular-nums">
                {formatMoney(weightedAvgCost, settings.currency, settings.currencyDecimals)}
              </p>
            </div>
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <p className="text-xs text-slate-500">سعر البيع</p>
              <p className="text-xl font-black text-emerald-700 mt-1 tabular-nums">
                {formatMoney(product.sellingPrice, settings.currency, settings.currencyDecimals)}
              </p>
            </div>
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <p className="text-xs text-slate-500">الدفعات النشطة (FIFO)</p>
              <p className="text-xl font-black text-slate-900 mt-1 tabular-nums">
                {batches.filter((b) => Number(b.remainingQuantity ?? b.quantity ?? 0) > 0).length} دفعة
              </p>
            </div>
          </div>

          {/* Batches Table */}
          <div>
            <h4 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
              <Layers className="w-4 h-4 text-indigo-600" />
              دفعات المخزون وتكلفتها الفعلية
            </h4>
            {batches.length === 0 ? (
              <p className="text-xs text-gray-400 bg-gray-50 p-4 rounded-xl text-center">لا توجد دفعات مسجلة لهذا الصنف</p>
            ) : (
              <div className="border border-gray-200 rounded-2xl overflow-hidden max-h-48 overflow-y-auto">
                <table className="w-full text-xs text-right">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="p-3">تاريخ الشراء</th>
                      <th className="p-3">رقم التشغيلة</th>
                      <th className="p-3">تاريخ الانتهاء</th>
                      <th className="p-3">الكمية الأولية</th>
                      <th className="p-3">المتبقي</th>
                      <th className="p-3">التكلفة الشاملة للوحدة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {batches.map((b) => (
                      <tr key={String(b.id)}>
                        <td className="p-3 text-gray-600">{b.purchaseDate ? new Date(b.purchaseDate).toLocaleDateString('ar-SA') : '-'}</td>
                        <td className="p-3 font-mono">{b.batchNumber || '-'}</td>
                        <td className="p-3">{b.expiryDate ? new Date(b.expiryDate).toLocaleDateString('ar-SA') : '-'}</td>
                        <td className="p-3 font-bold tabular-nums">{formatQty(b.quantity)}</td>
                        <td className="p-3 font-bold text-indigo-700 tabular-nums">{formatQty(b.remainingQuantity ?? b.quantity)}</td>
                        <td className="p-3 font-bold tabular-nums">{formatMoney(b.costPrice, settings.currency, settings.currencyDecimals)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Ledger Table */}
          <div>
            <h4 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
              <History className="w-4 h-4 text-indigo-600" />
              سجل حركات الصنف وتغييرات الأسعار
            </h4>
            {ledger.length === 0 ? (
              <p className="text-xs text-gray-400 bg-gray-50 p-4 rounded-xl text-center">لا توجد حركات مسجلة لهذا الصنف حتى الآن</p>
            ) : (
              <div className="border border-gray-200 rounded-2xl overflow-hidden max-h-64 overflow-y-auto">
                <table className="w-full text-xs text-right">
                  <thead className="bg-gray-50 text-gray-600 sticky top-0">
                    <tr>
                      <th className="p-3">التاريخ</th>
                      <th className="p-3">نوع الحركة</th>
                      <th className="p-3">المرجع</th>
                      <th className="p-3">التغير بالكمية</th>
                      <th className="p-3">السعر / التكلفة</th>
                      <th className="p-3">تفاصيل</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {ledger.map((row) => (
                      <tr key={row.id} className="hover:bg-gray-50">
                        <td className="p-3 text-gray-500 whitespace-nowrap">
                          {row.date ? new Date(row.date).toLocaleString('ar-SA') : '-'}
                        </td>
                        <td className="p-3 font-bold text-gray-800 flex items-center gap-1.5">
                          {row.qtyDelta > 0 ? (
                            <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-600" />
                          ) : row.qtyDelta < 0 ? (
                            <ArrowUpRight className="w-3.5 h-3.5 text-rose-600" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5 text-indigo-500" />
                          )}
                          {row.label}
                        </td>
                        <td className="p-3 font-mono text-gray-600">{row.reference}</td>
                        <td
                          className={`p-3 font-black tabular-nums ${
                            row.qtyDelta > 0 ? 'text-emerald-700' : row.qtyDelta < 0 ? 'text-rose-700' : 'text-gray-400'
                          }`}
                        >
                          {row.qtyDelta > 0 ? `+${formatQty(row.qtyDelta)}` : row.qtyDelta < 0 ? formatQty(row.qtyDelta) : '-'}
                        </td>
                        <td className="p-3 font-bold tabular-nums">
                          {formatMoney(row.unitPriceOrCost, settings.currency, settings.currencyDecimals)}
                        </td>
                        <td className="p-3 text-gray-500">{row.notes || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
