import { forwardRef } from 'react';
import { formatAmount } from '../utils/numberFormat.js';
import { Purchase, PurchaseItem } from '../db/db';
import { format } from 'date-fns';

interface PurchaseReceiptProps {
  purchase: Purchase;
  items: PurchaseItem[];
  settings: {
    businessName: string;
    currency: string;
  };
}

export const PurchaseReceipt = forwardRef<HTMLDivElement, PurchaseReceiptProps>(
  ({ purchase, items, settings }, ref) => {
    const returnedAmount = Number(purchase.returnedAmount || 0);
    const netTotal = Math.max(0, Number(purchase.totalAmount || 0) - returnedAmount);
    const remaining = Math.max(0, netTotal - Number(purchase.paidAmount || 0));

    return (
      <div ref={ref} className="bg-white p-6 text-slate-900 w-full max-w-sm mx-auto" dir="rtl">
        <div className="text-center mb-5 pb-4 border-b border-dashed border-slate-300">
          <h2 className="text-xl font-black text-slate-900">{settings.businessName}</h2>
          <p className="text-xs font-bold text-slate-500 mt-1">فاتورة توريد ومشتريات</p>
        </div>

        <div className="border-b border-dashed border-slate-300 pb-3 mb-4 text-xs space-y-1.5">
          <div className="flex justify-between">
            <span className="text-slate-500">رقم الفاتورة:</span>
            <span className="font-mono font-bold">{purchase.id?.slice(0, 12)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">التاريخ:</span>
            <span className="tabular-nums">{format(new Date(purchase.date), 'yyyy/MM/dd HH:mm')}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">المورد:</span>
            <span className="font-bold">{purchase.supplierName}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">طريقة السداد:</span>
            <span className="font-bold">{purchase.paymentMethod === 'card' ? 'شبكة / تحويل' : 'نقدي'}</span>
          </div>
        </div>

        <div className="mb-4">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="text-right py-2">الصنف</th>
                <th className="text-center py-2">الكمية</th>
                <th className="text-left py-2">الإجمالي</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((item, idx) => (
                <tr key={idx}>
                  <td className="py-2 font-medium">{item.productName}</td>
                  <td className="text-center py-2 tabular-nums">{item.quantity}</td>
                  <td className="text-left py-2 tabular-nums font-bold">{formatAmount(item.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t border-dashed border-slate-300 pt-3 text-xs space-y-1.5 tabular-nums">
          <div className="flex justify-between font-bold text-sm">
            <span>إجمالي الفاتورة:</span>
            <span>
              {formatAmount(purchase.totalAmount)} {settings.currency}
            </span>
          </div>
          {returnedAmount > 0 && (
            <div className="flex justify-between text-amber-700 font-bold">
              <span>مرتجعات المشتريات:</span>
              <span>
                -{formatAmount(returnedAmount)} {settings.currency}
              </span>
            </div>
          )}
          <div className="flex justify-between text-emerald-700 font-bold">
            <span>المدفوع:</span>
            <span>
              {formatAmount(purchase.paidAmount)} {settings.currency}
            </span>
          </div>
          <div className="flex justify-between font-black text-rose-700 pt-1 border-t border-slate-100">
            <span>المتبقي للمورد:</span>
            <span>
              {formatAmount(remaining)} {settings.currency}
            </span>
          </div>
        </div>
      </div>
    );
  }
);

PurchaseReceipt.displayName = 'PurchaseReceipt';
export default PurchaseReceipt;
