import { useState, useMemo } from 'react';
import { Search, RotateCcw, AlertCircle, FileText } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, Order, OrderItem, ReturnItem } from '../db/db';
import { useAuth } from '../context/AuthContext';
import { dispatchOperation } from '../services/operationService';
import { generateUUID } from '../utils/uuid';
import { format } from 'date-fns';
import { useSettings } from '../hooks/useSettings';
import { formatMoney, formatNumber, formatQty, roundQty } from '../utils/format';

type ReturnableItem = OrderItem & {
  previouslyReturned: number;
  maxReturnable: number;
};

export default function Returns() {
  const storeSettings = useSettings();
  const decimals = storeSettings.currencyDecimals ?? 2;
  const qtyDecimals = storeSettings.quantityDecimals ?? 3;
  const [searchQuery, setSearchQuery] = useState('');
  const [order, setOrder] = useState<(Order & { items: ReturnableItem[] }) | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [returnQuantities, setReturnQuantities] = useState<Record<number, number>>({});
  const [returnConditions, setReturnConditions] = useState<Record<number, 'resalable' | 'damaged'>>({});
  const [refundMethod, setRefundMethod] = useState<'cash' | 'card' | 'credit_adjustment'>('cash');
  const [reason, setReason] = useState('');
  const { user } = useAuth();

  const returnsHistory = useLiveQuery(() => db.returns.toArray()) || [];
  const sortedReturns = useMemo(
    () => [...returnsHistory].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [returnsHistory]
  );

  const hasPermission = (permission: string) => {
    return user?.role === 'admin' || user?.permissions?.includes(permission);
  };

  const searchOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;

    setIsLoading(true);
    try {
      const orders = await db.orders.toArray();
      const foundOrder = orders.find(
        (o) => o.id?.toString() === q || o.receiptNumber?.toLowerCase() === q.toLowerCase()
      );

      if (!foundOrder) {
        toast.error('لم يتم العثور على الفاتورة');
        setOrder(null);
        return;
      }

      if (foundOrder.status === 'void') {
        toast.error('هذه الفاتورة ملغاة بالكامل ولا يمكن إصدار مرتجع لها');
        setOrder(null);
        return;
      }

      const origItems = await db.orderItems.where('orderId').equals(foundOrder.id!).toArray();
      const existingReturns = await db.returns.where('originalOrderId').equals(foundOrder.id!).toArray();
      const existingReturnIds = existingReturns.map((r) => r.id);
      let pastReturnItems: ReturnItem[] = [];
      if (existingReturnIds.length > 0) {
        const allRetItems = await db.returnItems.toArray();
        pastReturnItems = allRetItems.filter((ri) => existingReturnIds.includes(ri.returnId));
      }

      const itemsWithRemaining: ReturnableItem[] = origItems.map((item) => {
        const fromPastDocs = pastReturnItems
          .filter((ri) => (ri.orderItemId ? ri.orderItemId === item.id : ri.productId === item.productId))
          .reduce((sum, ri) => sum + Number(ri.quantity || 0), 0);
        const previouslyReturned = Math.max(Number(item.returnedQuantity || 0), fromPastDocs);
        const maxReturnable = Math.max(0, roundQty(Number(item.quantity) - previouslyReturned));
        return {
          ...item,
          previouslyReturned,
          maxReturnable,
        };
      });

      setOrder({ ...foundOrder, items: itemsWithRemaining });
      setRefundMethod(
        foundOrder.paymentMethod === 'credit'
          ? 'credit_adjustment'
          : foundOrder.paymentMethod === 'card'
          ? 'card'
          : 'cash'
      );

      const initialQuantities: Record<number, number> = {};
      const initialConditions: Record<number, 'resalable' | 'damaged'> = {};
      itemsWithRemaining.forEach((_, index) => {
        initialQuantities[index] = 0;
        initialConditions[index] = 'resalable';
      });
      setReturnQuantities(initialQuantities);
      setReturnConditions(initialConditions);
    } catch (error) {
      console.error(error);
      toast.error('حدث خطأ أثناء البحث عن الفاتورة');
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuantityChange = (index: number, value: number, max: number) => {
    const clean = isNaN(value) ? 0 : Math.max(0, Math.min(max, roundQty(value)));
    setReturnQuantities((prev) => ({ ...prev, [index]: clean }));
  };

  const estimatedRefund = useMemo(() => {
    if (!order) return 0;
    return order.items.reduce((sum, item, idx) => {
      const qty = returnQuantities[idx] || 0;
      if (qty <= 0 || item.quantity <= 0) return sum;
      return sum + Number(item.total) * (qty / Number(item.quantity));
    }, 0);
  }, [order, returnQuantities]);

  const handleReturn = async () => {
    if (!order || isSubmitting) return;
    if (order.status === 'void') {
      toast.error('لا يمكن إرجاع فاتورة ملغاة');
      return;
    }

    const selectedItems = order.items
      .map((item, idx) => ({
        item,
        qty: returnQuantities[idx] || 0,
        condition: returnConditions[idx] || 'resalable',
      }))
      .filter((entry) => entry.qty > 0);

    if (selectedItems.length === 0) {
      toast.error('يرجى تحديد كمية للإرجاع');
      return;
    }

    for (const { item, qty } of selectedItems) {
      if (qty > item.maxReturnable) {
        toast.error(
          `الكمية المطلوبة للمنتج "${item.productName}" تتجاوز الكمية المتبقية القابلة للإرجاع (${formatQty(item.maxReturnable, qtyDecimals)})`
        );
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const returnId = generateUUID();
      const returnNumber = `RET-${Date.now()}`;
      const currentShift = await db.shifts.where('status').equals('open').first();

      const payload = {
        id: returnId,
        returnNumber,
        originalOrderId: order.id!,
        refundMethod,
        reason: reason.trim() || 'مرتجع مبيعات',
        branchId: user?.branchId,
        shiftId: currentShift?.id,
        createdBy: user?.name || 'مستخدم',
        items: selectedItems.map(({ item, qty, condition }) => ({
          orderItemId: item.id,
          productId: item.productId,
          quantity: qty,
          condition,
        })),
      };

      const res = await dispatchOperation('return', payload, user?.branchId);

      toast.success(
        res.synced
          ? `تم إصدار مستند المرتجع بنجاح: ${returnNumber}`
          : `تم تسجيل مستند المرتجع محلياً (${returnNumber}) وسيُزامَن تلقائياً`
      );
      setOrder(null);
      setSearchQuery('');
      setReason('');
    } catch (error: any) {
      console.error(error);
      toast.error(error?.message || 'حدث خطأ أثناء معالجة المرتجع');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-6 h-full flex flex-col bg-[var(--app-bg)] overflow-y-auto custom-scrollbar" dir="rtl">
      <div className="flex justify-between items-center mb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">مرتجعات المبيعات</h1>
          <p className="text-slate-500 text-sm mt-1">
            إنشاء مستند مرتجع مستقل مرتبط بالفاتورة الأصلية مع عكس القيود والمخزون
          </p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-6 shrink-0">
        <form onSubmit={searchOrder} className="flex gap-3 max-w-2xl">
          <div className="relative flex-1">
            <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
            <input
              type="text"
              placeholder="أدخل رقم الفاتورة (مثل INV-...) للبحث..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-4 pr-12 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={isLoading || !searchQuery}
            className="bg-indigo-600 text-white px-6 py-2.5 rounded-xl font-bold text-sm hover:bg-indigo-700 transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {isLoading ? 'جاري البحث...' : 'بحث'}
          </button>
        </form>
      </div>

      {order && (
        <div className="bg-white rounded-2xl border border-slate-200 mb-6 overflow-hidden flex flex-col shrink-0">
          <div className="p-5 border-b border-slate-200 flex flex-wrap justify-between items-center gap-4 bg-slate-50">
            <div>
              <h2 className="text-lg font-bold text-slate-900">تفاصيل الفاتورة {order.receiptNumber}</h2>
              <p className="text-xs text-slate-500 mt-1">
                التاريخ: {new Date(order.createdAt).toLocaleString('ar-SA')} | العميل: {order.customerName || 'عميل نقدي'}
              </p>
            </div>
            <div className="text-left tabular-nums">
              <p className="text-xs text-slate-500">صافي الفاتورة شامل الضريبة</p>
              <p className="text-xl font-black text-indigo-600">
                {formatMoney(order.netAmount, storeSettings.currency, decimals)}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto p-5">
            <table className="w-full text-right">
              <thead>
                <tr className="text-slate-500 text-xs font-bold border-b border-slate-200">
                  <th className="pb-3">المنتج</th>
                  <th className="pb-3">السعر</th>
                  <th className="pb-3">الكمية المباعة</th>
                  <th className="pb-3">تم إرجاعه سابقاً</th>
                  <th className="pb-3">المتبقي للإرجاع</th>
                  <th className="pb-3">حالة المرتجع</th>
                  <th className="pb-3 w-44">كمية الإرجاع</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {order.items.map((item, index) => (
                  <tr key={item.id ?? index}>
                    <td className="py-3.5 font-bold text-slate-900">
                      {item.productName}
                      {item.unit && item.unit !== 'piece' ? (
                        <span className="text-xs text-slate-400 font-normal mr-1.5">({item.unit})</span>
                      ) : null}
                    </td>
                    <td className="py-3.5 text-slate-600 tabular-nums">{formatNumber(item.unitPrice, decimals)}</td>
                    <td className="py-3.5 text-slate-600 tabular-nums">{formatQty(item.quantity, qtyDecimals)}</td>
                    <td className="py-3.5 text-amber-600 font-bold tabular-nums">{formatQty(item.previouslyReturned, qtyDecimals)}</td>
                    <td className="py-3.5 text-emerald-700 font-bold tabular-nums">{formatQty(item.maxReturnable, qtyDecimals)}</td>
                    <td className="py-3.5">
                      {item.maxReturnable <= 0 ? (
                        <span className="text-xs text-slate-400">-</span>
                      ) : (
                        <select
                          value={returnConditions[index] || 'resalable'}
                          onChange={(e) =>
                            setReturnConditions((prev) => ({
                              ...prev,
                              [index]: e.target.value as 'resalable' | 'damaged',
                            }))
                          }
                          className={`text-xs font-bold px-2.5 py-1.5 rounded-lg border outline-none ${
                            (returnConditions[index] || 'resalable') === 'damaged'
                              ? 'bg-rose-50 text-rose-700 border-rose-200'
                              : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          }`}
                        >
                          <option value="resalable">صالح لإعادة البيع</option>
                          <option value="damaged">تالف / هالك (خسارة)</option>
                        </select>
                      )}
                    </td>
                    <td className="py-3.5">
                      {item.maxReturnable <= 0 ? (
                        <span className="text-xs font-bold text-slate-400">مُرجع بالكامل</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              handleQuantityChange(index, (returnQuantities[index] || 0) - 1, item.maxReturnable)
                            }
                            className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center hover:bg-slate-200"
                          >
                            -
                          </button>
                          <input
                            type="number"
                            step="any"
                            min="0"
                            max={item.maxReturnable}
                            value={returnQuantities[index] || 0}
                            onChange={(e) =>
                              handleQuantityChange(index, parseFloat(e.target.value) || 0, item.maxReturnable)
                            }
                            className="w-20 text-center border border-slate-200 rounded-lg py-1 tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              handleQuantityChange(index, (returnQuantities[index] || 0) + 1, item.maxReturnable)
                            }
                            className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center hover:bg-slate-200"
                          >
                            +
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5 pt-5 border-t border-slate-200">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">طريقة رد المبلغ</label>
                <select
                  value={refundMethod}
                  onChange={(e) => setRefundMethod(e.target.value as any)}
                  className="w-full p-2.5 border border-slate-200 rounded-xl bg-slate-50 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="cash">نقدي من الصندوق</option>
                  <option value="card">تحويل / شبكة</option>
                  {order.customerId && <option value="credit_adjustment">خصم من رصيد العميل (آجل)</option>}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">سبب الإرجاع</label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="مثال: تالف، عدم مطابقة المواصفات..."
                  className="w-full p-2.5 border border-slate-200 rounded-xl bg-slate-50 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>
          </div>

          <div className="p-5 border-t border-slate-200 bg-slate-50 flex flex-wrap justify-between items-center gap-4">
            <div className="flex items-center gap-2 text-amber-800 bg-amber-50 border border-amber-200 px-4 py-2 rounded-xl tabular-nums">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span className="text-xs font-bold">
                المبلغ المسترد المتوقع: {formatMoney(estimatedRefund, storeSettings.currency, decimals)} — سيتم عكس الضريبة، وإعادة الأصناف الصالحة للمخزون وتسجيل التالف كخسارة (5400).
              </span>
            </div>
            {hasPermission('process_returns') && (
              <button
                onClick={handleReturn}
                disabled={isSubmitting || Object.values(returnQuantities).every((q) => q === 0)}
                className="bg-rose-600 text-white px-6 py-2.5 rounded-xl font-bold text-sm hover:bg-rose-700 transition-colors disabled:opacity-50 flex items-center gap-2 whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-4 h-4" />
                <span>{isSubmitting ? 'جاري التنفيذ...' : 'اعتماد مستند المرتجع'}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Returns History */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <h3 className="font-bold text-slate-900 flex items-center gap-2">
            <FileText className="w-5 h-5 text-indigo-600" />
            سجل مستندات المرتجعات
          </h3>
          <span className="text-xs text-slate-500 font-bold tabular-nums">
            إجمالي المستندات: {sortedReturns.length}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs font-bold border-b border-slate-200">
                <th className="px-5 py-3">رقم المرتجع</th>
                <th className="px-5 py-3">الفاتورة الأصلية</th>
                <th className="px-5 py-3">التاريخ</th>
                <th className="px-5 py-3">العميل</th>
                <th className="px-5 py-3">طريقة الاسترداد</th>
                <th className="px-5 py-3">السبب</th>
                <th className="px-5 py-3">قيمة الاسترداد</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {sortedReturns.map((ret) => (
                <tr key={ret.id} className="hover:bg-slate-50">
                  <td className="px-5 py-3 font-mono font-bold text-rose-600">{ret.returnNumber}</td>
                  <td className="px-5 py-3 font-mono text-slate-700">{ret.originalReceiptNumber || ret.originalOrderId}</td>
                  <td className="px-5 py-3 text-slate-500 tabular-nums">
                    {format(new Date(ret.createdAt), 'yyyy-MM-dd HH:mm')}
                  </td>
                  <td className="px-5 py-3 font-medium">{ret.customerName || 'عميل نقدي'}</td>
                  <td className="px-5 py-3">
                    {ret.refundMethod === 'cash' ? 'نقدي' : ret.refundMethod === 'card' ? 'شبكة' : 'تسوية رصيد'}
                  </td>
                  <td className="px-5 py-3 text-slate-500">{ret.reason || '-'}</td>
                  <td className="px-5 py-3 font-black text-slate-900 tabular-nums">
                    {formatMoney(Number(ret.totalRefund), storeSettings.currency, decimals)}
                  </td>
                </tr>
              ))}
              {sortedReturns.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-slate-400">
                    لا توجد مستندات مرتجعات مسجلة حتى الآن
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
