import { usePosEntityRecords } from '../hooks/usePosEntityRecords';
import {
  TrendingUp,
  ShoppingBag,
  CreditCard,
  Banknote,
  Package,
  AlertTriangle,
  Users,
  Wallet,
  Plus,
  Clock,
  ChevronLeft,
  LayoutDashboard,
  ShoppingCart,
} from 'lucide-react';
import { format, startOfDay, endOfDay } from 'date-fns';
import { Link } from 'react-router-dom';
import { useSettings } from '../hooks/useSettings';
import { useAuth } from '../context/AuthContext';
import { usePosRecordsWhereEquals } from '../hooks/usePosRecordsWhereEquals';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';

export default function Dashboard() {
  const storeSettings = useSettings();
  const { user } = useAuth();
  const deviceRoleRecords = usePosRecordsWhereEquals<any>('settings', 'key', 'deviceRole');
  const isAndroidStandalone = isNativeAndroid() && deviceRoleRecords[0]?.value !== 'client';
  const today = new Date();
  const startOfToday = startOfDay(today).toISOString();
  const endOfToday = endOfDay(today).toISOString();

  const allOrders = usePosEntityRecords<any>('orders');
  const orderItems = usePosEntityRecords<any>('orderItems');
  const allReturns = usePosEntityRecords<any>('returns');
  const allExpenses = usePosEntityRecords<any>('expenses');
  const allPurchases = usePosEntityRecords<any>('purchases');
  const products = usePosEntityRecords<any>('products');
  const customers = usePosEntityRecords<any>('customers');
  const allAttendance = usePosEntityRecords<any>('attendance');
  const allLoyaltyTransactions = usePosEntityRecords<any>('loyaltyTransactions');
  const todayStart = startOfDay(today).getTime();
  const todayEnd = endOfDay(today).getTime();
  const isToday = (value: unknown) => {
    const timestamp = value ? new Date(String(value)).getTime() : Number.NaN;
    return Number.isFinite(timestamp) && timestamp >= todayStart && timestamp <= todayEnd;
  };
  const orders = allOrders.filter((record) => isToday(record.createdAt));
  const returns = allReturns.filter((record) => isToday(record.createdAt));
  const expenses = allExpenses.filter((record) => isToday(record.date));
  const purchases = allPurchases.filter((record) => isToday(record.date));
  const attendance = allAttendance.filter((record) => record.date === format(today, 'yyyy-MM-dd'));
  const loyaltyTransactions = allLoyaltyTransactions.filter((record) => isToday(record.date));

  const validOrders = orders.filter((o) => o.status !== 'void');
  const validOrderIds = new Set(validOrders.map((o) => o.id));
  const productMap = new Map(products.map((p) => [p.id, p]));

  const lowStockItems = products.filter((p) => p.stockQuantity <= (p.minStockLevel || 10));

  const salesNetExclTax = validOrders.reduce(
    (sum, o) => sum + (Number(o.netAmount || 0) - Number(o.taxAmount || 0)),
    0
  );
  const returnsNetExclTax = returns.reduce(
    (sum, r) => sum + (Number(r.totalRefund || 0) - Number(r.taxAmount || 0)),
    0
  );
  const netRevenueExclTax = salesNetExclTax - returnsNetExclTax;

  const grossCogs = orderItems
    .filter((item) => validOrderIds.has(item.orderId))
    .reduce((sum, item) => {
      const unitCost =
        item.costPriceAtTimeOfSale !== undefined && item.costPriceAtTimeOfSale !== null
          ? Number(item.costPriceAtTimeOfSale)
          : Number(productMap.get(item.productId)?.costPrice || 0);
      return sum + unitCost * Number(item.quantity || 0);
    }, 0);
  const returnedCogs = returns.reduce((sum, r) => sum + Number(r.totalCostReversed || 0), 0);
  const totalCogs = Math.max(0, grossCogs - returnedCogs);

  const cashReturns = returns.filter((r) => r.refundMethod === 'cash').reduce((s, r) => s + Number(r.totalRefund || 0), 0);
  const cardReturns = returns.filter((r) => r.refundMethod === 'card').reduce((s, r) => s + Number(r.totalRefund || 0), 0);
  const creditReturns = returns
    .filter((r) => r.refundMethod === 'credit_adjustment')
    .reduce((s, r) => s + Number(r.totalRefund || 0), 0);

  const cashCollected =
    validOrders.reduce((sum, o) => {
      if (o.paymentMethod === 'cash') return sum + Number(o.netAmount || 0);
      if (o.paymentMethod === 'mixed') return sum + Number(o.cashAmount || 0);
      return sum;
    }, 0) - cashReturns;

  const cardCollected =
    validOrders.reduce((sum, o) => {
      if (o.paymentMethod === 'card') return sum + Number(o.netAmount || 0);
      if (o.paymentMethod === 'mixed') return sum + Number(o.cardAmount || 0);
      return sum;
    }, 0) - cardReturns;

  const creditCollected =
    validOrders
      .filter((o) => o.paymentMethod === 'credit')
      .reduce((sum, o) => sum + Number(o.netAmount || 0), 0) - creditReturns;

  const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const totalPurchases = purchases.reduce((sum, p) => sum + Number(p.totalAmount || 0), 0);
  const netProfit = netRevenueExclTax - totalCogs - totalExpenses;

  const recentOrders = [...orders]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 6);

  const quickStats = [
    { label: 'صافي المبيعات (بدون ضريبة)', value: netRevenueExclTax, icon: TrendingUp, color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200' },
    { label: 'عدد الطلبات', value: validOrders.length, icon: ShoppingBag, color: 'text-indigo-600', bg: 'bg-indigo-50 border-indigo-200' },
    { label: 'المصروفات', value: totalExpenses, icon: Wallet, color: 'text-rose-600', bg: 'bg-rose-50 border-rose-200' },
    { label: 'المشتريات', value: totalPurchases, icon: ShoppingCart, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200' },
    {
      label: 'نقاط الولاء',
      value: loyaltyTransactions.filter((t) => t.type === 'earn').reduce((sum, t) => sum + t.points, 0),
      icon: Users,
      color: 'text-purple-600',
      bg: 'bg-purple-50 border-purple-200',
    },
    { label: 'صافي الربح (بعد COGS)', value: netProfit, icon: Banknote, color: 'text-blue-600', bg: 'bg-blue-50 border-blue-200' },
  ];

  return (
    <div className={`lineage-page lineage-dashboard-page ${isAndroidStandalone ? "px-4 pb-6 pt-4 sm:px-6" : "p-6"} h-full overflow-y-auto bg-[#f4f6fb] custom-scrollbar`} dir="rtl">
      <div className="lineage-page-heading mb-5 flex items-center justify-between gap-3 rounded-[22px] border border-slate-200/80 bg-white px-4 py-4 shadow-[0_3px_14px_rgba(15,23,42,0.035)] sm:mb-6 sm:px-6">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black tracking-tight text-slate-900 sm:text-2xl">
            <LayoutDashboard className="w-6 h-6 text-indigo-600" />
            <span>لوحة التحكم</span>
          </h1>
          <p className="text-slate-500 text-sm mt-1 tabular-nums">نظرة عامة على أداء اليوم: {format(today, 'yyyy/MM/dd')}</p>
        </div>
        <div className={isAndroidStandalone ? "flex shrink-0 items-center gap-2" : "flex flex-wrap gap-2.5"}>
          <Link to="/attendance" className="flex items-center gap-2 px-3.5 py-2 bg-white border border-slate-200 text-slate-700 rounded-xl text-sm font-bold hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0">
            <Clock className="w-4 h-4" />
            <span>التحضير</span>
          </Link>
          <Link to="/expenses" className="flex items-center gap-2 px-3.5 py-2 bg-white border border-slate-200 text-slate-700 rounded-xl text-sm font-bold hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0">
            <Wallet className="w-4 h-4" />
            <span>إضافة مصروف</span>
          </Link>
          <Link to="/inventory" className="flex items-center gap-2 px-3.5 py-2 bg-white border border-slate-200 text-slate-700 rounded-xl text-sm font-bold hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0">
            <Package className="w-4 h-4" />
            <span>إضافة منتج</span>
          </Link>
          <Link to="/purchases" className="flex items-center gap-2 px-3.5 py-2 bg-white border border-slate-200 text-slate-700 rounded-xl text-sm font-bold hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0">
            <ShoppingCart className="w-4 h-4" />
            <span>توريد مخزون</span>
          </Link>
          <Link to="/pos" className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 transition-colors whitespace-nowrap shrink-0">
            <Plus className="w-4 h-4" />
            <span>بيع جديد</span>
          </Link>
        </div>
      </div>

      {/* Main Stats Grid */}
      <div className={`mb-5 grid ${isAndroidStandalone ? "grid-cols-2 gap-3" : "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"} sm:mb-6`}>
        {quickStats.map((stat, idx) => (
          <div key={idx} className={`lineage-metric-card flex min-w-0 items-center rounded-[18px] border ${isAndroidStandalone && idx === 0 ? "col-span-2 border-indigo-700 bg-gradient-to-l from-[#243b70] to-[#4267b2] p-4 text-white shadow-[0_10px_24px_rgba(37,69,135,0.18)]" : `border-slate-200/90 bg-white ${isAndroidStandalone ? "gap-2.5 p-3.5" : "gap-4 p-5"} shadow-[0_2px_10px_rgba(15,23,42,0.025)]`}`}>
            <div className={`${isAndroidStandalone ? "rounded-xl p-2.5" : "rounded-xl p-3"} shrink-0 ${isAndroidStandalone && idx === 0 ? "border border-white/15 bg-white/10 text-white" : `border ${stat.bg} ${stat.color}`}`}>
              <stat.icon className="w-5 h-5" />
            </div>
            <div>
              <p className={`text-[10px] font-bold leading-4 sm:text-xs ${isAndroidStandalone && idx === 0 ? "text-indigo-100" : "text-slate-500"}`}>{stat.label}</p>
              <p className={`${isAndroidStandalone ? (idx === 0 ? "text-2xl sm:text-3xl" : "text-sm sm:text-base") : "text-xl"} mt-1 break-words font-black leading-tight ${isAndroidStandalone && idx === 0 ? "text-white" : "text-slate-900"} tabular-nums`}>
                {typeof stat.value === 'number' && stat.label !== 'عدد الطلبات' && stat.label !== 'نقاط الولاء'
                  ? `${stat.value.toFixed(2)} ${storeSettings.currency}`
                  : stat.value}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="mb-5 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-5 sm:mb-6">
        {/* Sales by Payment Method */}
        <div className="lineage-surface min-w-0 rounded-[20px] border border-slate-200/90 bg-white p-4 shadow-[0_2px_10px_rgba(15,23,42,0.025)] sm:p-6 lg:col-span-2">
          <h3 className="text-base font-bold text-slate-900 mb-5 flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-indigo-600" />
            <span>توزيع تحصيلات اليوم (شامل الضريبة)</span>
          </h3>
          <div className={isAndroidStandalone ? "h-52 sm:h-60" : "h-64"}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={[
                  { name: 'نقدي', value: cashCollected },
                  { name: 'شبكة', value: cardCollected },
                  { name: 'آجل', value: creditCollected },
                ]}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} />
                <Tooltip cursor={{ fill: '#f8fafc' }} />
                <Bar dataKey="value" radius={[6, 6, 0, 0]} barSize={56}>
                  <Cell fill="#10b981" />
                  <Cell fill="#6366f1" />
                  <Cell fill="#f59e0b" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Alerts & Summary */}
        <div className="space-y-4">
          <div className="lineage-surface bg-white p-5 rounded-2xl border border-slate-200">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                <span>تنبيهات المخزون</span>
              </h3>
              <span className="px-2 py-0.5 bg-amber-50 border border-amber-200 text-amber-700 text-xs font-bold rounded-lg tabular-nums">
                {lowStockItems.length} منتجات
              </span>
            </div>
            <div className="space-y-2">
              {lowStockItems.slice(0, 3).map((item, idx) => (
                <div key={idx} className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-100 rounded-xl">
                  <span className="text-xs font-bold text-slate-700 truncate">{item.name}</span>
                  <span className="text-xs font-bold text-rose-600 tabular-nums whitespace-nowrap">
                    {item.stockQuantity} {item.unit || 'حبة'}
                  </span>
                </div>
              ))}
              {lowStockItems.length === 0 && (
                <p className="text-xs text-slate-400 text-center py-3">المخزون بحالة جيدة</p>
              )}
              {lowStockItems.length > 3 && (
                <Link to="/inventory" className="block text-center text-xs text-indigo-600 font-bold hover:underline pt-1">
                  عرض الكل
                </Link>
              )}
            </div>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-500" />
                <span>الموظفون المتواجدون</span>
              </h3>
              <span className="px-2 py-0.5 bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs font-bold rounded-lg tabular-nums">
                {attendance.filter((a) => !a.checkOut).length} نشط
              </span>
            </div>
            <div className="space-y-2">
              {attendance
                .filter((a) => !a.checkOut)
                .slice(0, 3)
                .map((a, idx) => (
                  <div key={idx} className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-100 rounded-xl">
                    <span className="text-xs font-bold text-slate-700">{a.employeeName}</span>
                    <span className="text-xs font-bold text-emerald-600">حاضر</span>
                  </div>
                ))}
              {attendance.filter((a) => !a.checkOut).length === 0 && (
                <p className="text-xs text-slate-400 text-center py-3">لا يوجد موظفون مسجلون حالياً</p>
              )}
            </div>
          </div>

          <div className="bg-indigo-600 p-5 rounded-2xl text-white">
            <h3 className="font-bold text-sm mb-3 flex items-center gap-2">
              <Users className="w-4 h-4" />
              <span>قاعدة العملاء</span>
            </h3>
            <div className="flex items-end justify-between">
              <div>
                <p className="text-3xl font-black tabular-nums">{customers.length}</p>
                <p className="text-indigo-100 text-xs">إجمالي العملاء المسجلين</p>
              </div>
              <Link to="/customers" className="p-2 bg-white/15 rounded-xl hover:bg-white/25 transition-colors">
                <ChevronLeft className="w-5 h-5" />
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Orders Table */}
      <div className="overflow-hidden rounded-[20px] border border-slate-200/90 bg-white shadow-[0_2px_10px_rgba(15,23,42,0.025)]">
        <div className="p-5 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-bold text-slate-900 flex items-center gap-2">
            <Clock className="w-5 h-5 text-indigo-500" />
            <span>آخر العمليات اليوم</span>
          </h3>
          <Link to="/reports" className="text-xs text-indigo-600 font-bold hover:underline">
            عرض كافة التقارير
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs font-bold border-b border-slate-200">
                <th className="px-5 py-3">رقم الفاتورة</th>
                <th className="px-5 py-3">الوقت</th>
                <th className="px-5 py-3">طريقة الدفع</th>
                <th className="px-5 py-3">المبلغ</th>
                <th className="px-5 py-3">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {recentOrders.map((order, idx) => (
                <tr key={order.id ?? idx} className="hover:bg-slate-50">
                  <td className="px-5 py-3 font-mono font-bold text-slate-900">{order.receiptNumber}</td>
                  <td className="px-5 py-3 text-slate-500 tabular-nums">{format(new Date(order.createdAt), 'HH:mm')}</td>
                  <td className="px-5 py-3">
                    <span className="px-2.5 py-1 rounded-lg border border-slate-200 bg-slate-50 text-xs font-bold text-slate-700 whitespace-nowrap">
                      {order.paymentMethod === 'cash'
                        ? 'نقدي'
                        : order.paymentMethod === 'card'
                        ? 'شبكة'
                        : order.paymentMethod === 'mixed'
                        ? 'مختلط'
                        : 'آجل'}
                    </span>
                  </td>
                  <td className="px-5 py-3 font-bold text-slate-900 tabular-nums">
                    {order.netAmount.toFixed(2)} {storeSettings.currency}
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={`px-2.5 py-1 rounded-lg border text-xs font-bold whitespace-nowrap ${
                        order.status === 'void'
                          ? 'bg-rose-50 border-rose-200 text-rose-700'
                          : order.status === 'returned' || order.status === 'partially_returned'
                          ? 'bg-amber-50 border-amber-200 text-amber-700'
                          : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                      }`}
                    >
                      {order.status === 'void'
                        ? 'ملغاة'
                        : order.status === 'returned'
                        ? 'مرتجع'
                        : order.status === 'partially_returned'
                        ? 'مرتجع جزئي'
                        : 'مكتمل'}
                    </span>
                  </td>
                </tr>
              ))}
              {recentOrders.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-slate-400">
                    لا توجد عمليات مسجلة اليوم بعد
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
