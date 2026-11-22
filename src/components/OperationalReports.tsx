import { useMemo } from 'react';
import { usePosEntityRecords } from '../hooks/usePosEntityRecords';
import { buildOperationalReports } from '../utils/operationalReports.js';
import { formatNumber, formatQty } from '../utils/format';

type Props = { startDate: Date; endDate: Date; currency: string; decimals: number; quantityDecimals: number };

export default function OperationalReports({ startDate, endDate, currency, decimals, quantityDecimals }: Props) {
  const orders = usePosEntityRecords<any>('orders');
  const returns = usePosEntityRecords<any>('returns');
  const purchases = usePosEntityRecords<any>('purchases');
  const purchaseReturns = usePosEntityRecords<any>('purchaseReturns');
  const expenses = usePosEntityRecords<any>('expenses');
  const payrolls = usePosEntityRecords<any>('payroll');
  const employees = usePosEntityRecords<any>('employees');
  const customers = usePosEntityRecords<any>('customers');
  const suppliers = usePosEntityRecords<any>('suppliers');
  const customerPayments = usePosEntityRecords<any>('customerPayments');
  const supplierPayments = usePosEntityRecords<any>('supplierPayments');
  const inventoryMovements = usePosEntityRecords<any>('inventoryMovements');

  const report = useMemo(() => buildOperationalReports({
    startDate, endDate, orders, returns, purchases, purchaseReturns, expenses, payrolls,
    employees, customers, suppliers, customerPayments, supplierPayments, inventoryMovements,
  }), [startDate, endDate, orders, returns, purchases, purchaseReturns, expenses, payrolls,
    employees, customers, suppliers, customerPayments, supplierPayments, inventoryMovements]);

  const money = (value: number) => formatNumber(value, decimals) + ' ' + currency;
  const section = 'rounded-xl border border-slate-200 p-3 min-w-0';
  const table = 'w-full min-w-[420px] text-right text-sm';
  const empty = (columns: number) => <tr><td colSpan={columns} className="p-4 text-center text-slate-400">لا توجد بيانات في الفترة المحددة</td></tr>;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <div>
        <h3 className="text-lg font-black text-slate-900">التقارير التشغيلية والإدارية</h3>
        <p className="mt-1 text-sm text-slate-500">المشتريات والتحصيلات ووسائل الدفع وأداء الموظفين والعملاء والموردين والمصروفات وحركة المخزون.</p>
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">فواتير المبيعات</p><p className="mt-1 text-xl font-black">{report.sales.count}</p><p className="text-xs text-slate-500">{money(report.sales.netExTax)} بدون الضريبة</p></div>
        <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">المشتريات</p><p className="mt-1 text-xl font-black">{money(report.purchases.gross)}</p><p className="text-xs text-slate-500">{report.purchases.count} فاتورة</p></div>
        <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">مرتجعات المبيعات</p><p className="mt-1 text-xl font-black">{money(report.sales.returns)}</p></div>
        <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">مرتجعات المشتريات</p><p className="mt-1 text-xl font-black">{money(report.purchases.returns)}</p></div>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className={section}>
          <h4 className="mb-3 font-bold text-slate-800">صافي المبيعات حسب وسيلة الدفع</h4>
          {([['نقدي', report.payments.cashNet], ['بطاقة', report.payments.cardNet], ['آجل', report.payments.creditNet]] as const).map(([label, value]) => <div key={label} className="flex justify-between border-b border-slate-100 py-2 text-sm"><span>{label}</span><strong>{money(value)}</strong></div>)}
          <div className="mt-3 space-y-1 text-xs text-slate-500"><p>تحصيلات حسابات العملاء: {money(report.customerCollections)}</p><p>مدفوعات الموردين: {money(report.supplierPayments)}</p></div>
        </div>
        <div className={section}>
          <h4 className="mb-3 font-bold text-slate-800">المصروفات حسب التصنيف</h4>
          {report.expenses.length ? report.expenses.map((row) => <div key={row.category} className="flex justify-between border-b border-slate-100 py-2 text-sm"><span>{row.category}</span><strong>{money(row.total)}</strong></div>) : <p className="py-4 text-center text-sm text-slate-400">لا توجد مصروفات</p>}
          <p className="mt-3 text-xs text-slate-500">الرواتب المدفوعة: {money(report.payroll.total)} ({report.payroll.count} عملية)</p>
        </div>
        <div className={section}>
          <h4 className="mb-3 font-bold text-slate-800">أداء الموظفين حسب منفذ الفاتورة</h4>
          <div className="overflow-x-auto"><table className={table}><thead className="bg-slate-50 text-xs"><tr><th className="p-2">الموظف</th><th className="p-2">الفواتير</th><th className="p-2">صافي المبيعات</th></tr></thead><tbody>{report.staff.map((row) => <tr key={row.name} className="border-t"><td className="p-2">{row.name}</td><td className="p-2">{row.count}</td><td className="p-2 font-bold">{money(row.netSales)}</td></tr>)}{!report.staff.length && empty(3)}</tbody></table></div>
        </div>
        <div className={section}>
          <h4 className="mb-3 font-bold text-slate-800">العملاء الأكثر شراءً</h4>
          <div className="overflow-x-auto"><table className={table}><thead className="bg-slate-50 text-xs"><tr><th className="p-2">العميل</th><th className="p-2">الفواتير</th><th className="p-2">المبيعات</th><th className="p-2">المتبقي التقريبي</th></tr></thead><tbody>{report.customers.slice(0, 30).map((row) => <tr key={row.id} className="border-t"><td className="p-2">{row.name}</td><td className="p-2">{row.orders}</td><td className="p-2">{money(row.sales)}</td><td className="p-2">{money(Math.max(0, row.sales - row.paid))}</td></tr>)}{!report.customers.length && empty(4)}</tbody></table></div>
        </div>
        <div className={section}>
          <h4 className="mb-3 font-bold text-slate-800">الموردون والمشتريات</h4>
          <div className="overflow-x-auto"><table className={table}><thead className="bg-slate-50 text-xs"><tr><th className="p-2">المورد</th><th className="p-2">الفواتير</th><th className="p-2">صافي المشتريات</th><th className="p-2">المدفوع</th></tr></thead><tbody>{report.suppliers.slice(0, 30).map((row) => <tr key={row.id || row.name} className="border-t"><td className="p-2">{row.name}</td><td className="p-2">{row.invoices}</td><td className="p-2">{money(row.netPurchases)}</td><td className="p-2">{money(row.paid)}</td></tr>)}{!report.suppliers.length && empty(4)}</tbody></table></div>
        </div>
        <div className={section}>
          <h4 className="mb-3 font-bold text-slate-800">حركة المخزون بالوحدة الأساسية</h4>
          <div className="overflow-x-auto"><table className={table}><thead className="bg-slate-50 text-xs"><tr><th className="p-2">نوع الحركة</th><th className="p-2">عددها</th><th className="p-2">وارد</th><th className="p-2">صادر</th><th className="p-2">الصافي</th></tr></thead><tbody>{report.inventory.map((row) => <tr key={row.type} className="border-t"><td className="p-2">{row.type}</td><td className="p-2">{row.count}</td><td className="p-2">{formatQty(row.quantityIn, quantityDecimals)}</td><td className="p-2">{formatQty(row.quantityOut, quantityDecimals)}</td><td className="p-2">{formatQty(row.netQuantity, quantityDecimals)}</td></tr>)}{!report.inventory.length && empty(5)}</tbody></table></div>
        </div>
      </div>
      <p className="text-xs leading-6 text-slate-500">تحصيلات العملاء ومدفوعات الموردين تعرض كحركة مستقلة ولا تضاف مرة أخرى إلى المبيعات أو المشتريات. أداء الموظف يعتمد على منفذ الفاتورة المحفوظ. المتبقي التقريبي للعميل محسوب من فواتيره خلال الفترة فقط ولا يمثل رصيد حسابه الكامل. هذه التقارير تشغيلية ولا تحل محل القوائم المالية أو دفتر الأستاذ.</p>
    </section>
  );
}
