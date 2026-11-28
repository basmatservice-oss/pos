import { useMemo, useState } from 'react';
import { dispatchOperation } from '../services/operationService';
import { calculateAdjustedSellingPrice, buildManualSellingPriceUpdate } from '../utils/productPriceAdjustments.js';

type Props = {
  products: any[];
  branchId?: number;
  actorName?: string;
  currency: string;
  onClose: () => void;
};

type Mode = 'set' | 'percent_increase' | 'percent_decrease' | 'amount_increase' | 'amount_decrease';

const modeLabels: Record<Mode, string> = {
  set: 'تحديد سعر جديد',
  percent_increase: 'زيادة بنسبة مئوية',
  percent_decrease: 'تخفيض بنسبة مئوية',
  amount_increase: 'إضافة مبلغ ثابت',
  amount_decrease: 'خصم مبلغ ثابت',
};

export default function ProductPriceManager({ products, branchId, actorName, currency, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [mode, setMode] = useState<Mode>('percent_increase');
  const [value, setValue] = useState('0');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const visibleProducts = useMemo(() => products.filter((product) =>
    String(product.name || '').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ||
    String(product.barcode || '').includes(query.trim())
  ), [products, query]);
  const selectedProducts = useMemo(() => products.filter((product) => selectedIds.includes(Number(product.id))), [products, selectedIds]);
  const preview = useMemo(() => {
    try {
      return selectedProducts.map((product) => ({
        product,
        nextPrice: calculateAdjustedSellingPrice(product.sellingPrice, mode, value),
      }));
    } catch {
      return [];
    }
  }, [selectedProducts, mode, value]);
  const invalidPreview = preview.length !== selectedProducts.length;

  const toggleProduct = (id: number, checked: boolean) => {
    setSelectedIds((current) => checked ? [...new Set([...current, id])] : current.filter((value) => value !== id));
  };

  const apply = async () => {
    if (busy || selectedProducts.length === 0 || invalidPreview) return;
    const confirmed = window.confirm(`سيتم تحديث سعر الوحدة الأساسية لـ ${preview.length} صنف. سيتم فصل الأسعار الجديدة عن سعر الصرف، ولن تتغير أسعار وحدات البيع الإضافية أو الفواتير السابقة. هل تريد المتابعة؟`);
    if (!confirmed) return;
    setBusy(true);
    setResult('');
    try {
      const records = preview.map(({ product, nextPrice }) => ({
        ...buildManualSellingPriceUpdate(product, nextPrice),
        updatedBy: actorName || 'System',
        previousSellingPrice: Number(product.sellingPrice || 0),
      }));
      await dispatchOperation('entity_upsert', {
        table: 'products',
        allowProductPriceUpdate: true,
        records,
      }, branchId);
      setResult(`تم اعتماد تحديث أسعار ${records.length} صنف كعملية واحدة دون تحديث جزئي.`);
      setSelectedIds([]);
    } catch (error) {
      setResult(`لم يعتمد التحديث الجماعي ولم يُسجل كتحديث ناجح: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lineage-dialog-backdrop fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-3" dir="rtl">
      <div className="lineage-dialog-panel flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 p-4">
          <div>
            <h2 className="text-lg font-black text-slate-900">إدارة أسعار البيع</h2>
            <p className="mt-1 text-xs text-slate-500">تعديل سعر الوحدة الأساسية يدويًا لصنف واحد أو مجموعة أصناف.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100">إغلاق</button>
        </div>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-2">
          <section className="flex min-h-64 flex-col gap-3">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث باسم الصنف أو الباركود"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>الأصناف المحددة: {selectedIds.length}</span>
              <button type="button" onClick={() => setSelectedIds(visibleProducts.map((product) => Number(product.id)).filter(Number.isFinite))}
                className="font-bold text-indigo-600">تحديد النتائج الظاهرة</button>
              <button type="button" onClick={() => setSelectedIds([])} className="font-bold text-slate-600">إلغاء التحديد</button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-200">
              {visibleProducts.map((product) => (
                <label key={product.id} className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-sm last:border-0 hover:bg-slate-50">
                  <input type="checkbox" checked={selectedIds.includes(Number(product.id))}
                    onChange={(event) => toggleProduct(Number(product.id), event.target.checked)} />
                  <span className="min-w-0 flex-1 truncate font-semibold text-slate-800">{product.name}</span>
                  <span className="text-xs tabular-nums text-slate-500">{Number(product.sellingPrice || 0).toLocaleString()} {currency}</span>
                </label>
              ))}
              {visibleProducts.length === 0 && <p className="p-5 text-center text-sm text-slate-400">لا توجد أصناف مطابقة.</p>}
            </div>
          </section>
          <section className="flex flex-col gap-3">
            <label className="text-sm font-bold text-slate-700">طريقة التعديل</label>
            <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm">
              {(Object.keys(modeLabels) as Mode[]).map((key) => <option key={key} value={key}>{modeLabels[key]}</option>)}
            </select>
            <label className="text-sm font-bold text-slate-700">{mode.startsWith('percent') ? 'النسبة المئوية' : 'القيمة'} </label>
            <input type="number" min="0" step={mode.startsWith('percent') ? '0.01' : '0.01'} value={value}
              onChange={(event) => setValue(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm tabular-nums" />
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-900">
              سيُلغى ربط سعر البيع المحدد بسعر الصرف حتى لا يعيد تحديث الصرف تغيير السعر اليدوي. التعديل يخص الوحدة الأساسية فقط؛ أسعار الكرتونة والوحدات الإضافية تبقى كما هي. لا تتغير الفواتير أو التكاليف أو المرتجعات التاريخية.
            </div>
            <div className="min-h-0 overflow-hidden rounded-xl border border-slate-200">
              <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">معاينة قبل الاعتماد ({preview.length})</div>
              <div className="max-h-64 overflow-y-auto">
                {preview.map(({ product, nextPrice }) => (
                  <div key={product.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-0">
                    <span className="truncate font-semibold">{product.name}</span>
                    <span className="tabular-nums text-slate-500">{Number(product.sellingPrice || 0).toLocaleString()}</span>
                    <span className="font-black tabular-nums text-indigo-700">{nextPrice.toLocaleString()} {currency}</span>
                  </div>
                ))}
                {selectedProducts.length === 0 && <p className="p-4 text-center text-xs text-slate-400">حدد الأصناف لعرض الأسعار الجديدة.</p>}
                {invalidPreview && <p className="p-3 text-xs text-rose-700">قيمة التعديل غير صالحة أو تنتج سعرًا سالبًا.</p>}
              </div>
            </div>
          </section>
        </div>
        {result && <div className="mx-4 mb-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-6 text-slate-700">{result}</div>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 p-4">
          <span className="text-xs text-slate-500">تُرسل جميع الأصناف في عملية واحدة؛ إما أن تُحفظ كلها معًا أو تُرفض العملية كاملة.</span>
          <button type="button" onClick={apply} disabled={busy || selectedProducts.length === 0 || invalidPreview}
            className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? 'جارٍ التحديث...' : 'اعتماد تحديث الأسعار'}
          </button>
        </div>
      </div>
    </div>
  );
}
