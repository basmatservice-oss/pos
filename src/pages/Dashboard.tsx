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
  RotateCcw,
  ClipboardCheck,
  Truck,
  UserCircle,
  UserCheck,
  DollarSign,
  Tag,
  Building2,
  Smartphone,
  Settings,
  RefreshCw,
  FileText,
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
  const moduleItems = [
    { to: '/', label: 'لوحة التحكم', icon: LayoutDashboard, permissionId: 'view_dashboard', tone: 'bg-indigo-50 text-indigo-700' },
    { to: '/pos', label: 'نقطة البيع', icon: ShoppingBag, permissionId: 'view_pos', tone: 'bg-emerald-50 text-emerald-700' },
    { to: '/returns', label: 'المرتجعات', icon: RotateCcw, permissionId: 'view_returns', tone: 'bg-rose-50 text-rose-700' },
    { to: '/inventory', label: 'المخزون', icon: Package, permissionId: 'view_inventory', tone: 'bg-amber-50 text-amber-700' },
    { to: '/stocktaking', label: 'الجرد', icon: ClipboardCheck, permissionId: 'view_stocktaking', tone: 'bg-cyan-50 text-cyan-700' },
    { to: '/purchases', label: 'المشتريات', icon: ShoppingCart, permissionId: 'view_purchases', tone: 'bg-orange-50 text-orange-700' },
    { to: '/customers', label: 'العملاء', icon: Users, permissionId: 'view_customers', tone: 'bg-sky-50 text-sky-700' },
    { to: '/suppliers', label: 'الموردون', icon: Truck, permissionId: 'view_suppliers', tone: 'bg-violet-50 text-violet-700' },
    { to: '/employees', label: 'الموظفون', icon: UserCircle, permissionId: 'view_employees', tone: 'bg-fuchsia-50 text-fuchsia-700' },
    { to: '/attendance', label: 'الحضور', icon: UserCheck, permissionId: 'view_attendance', tone: 'bg-teal-50 text-teal-700' },
    { to: '/payroll', label: 'الرواتب', icon: DollarSign, permissionId: 'view_payroll', tone: 'bg-lime-50 text-lime-700' },
    { to: '/offers', label: 'العروض', icon: Tag, permissionId: 'view_offers', tone: 'bg-pink-50 text-pink-700' },
    { to: '/branches', label: 'الفروع', icon: Building2, permissionId: 'view_branches', tone: 'bg-blue-50 text-blue-700' },
    { to: '/mobile-sales', label: 'المبيعات الميدانية', icon: Smartphone, permissionId: 'view_mobile_sales', tone: 'bg-purple-50 text-purple-700' },
    { to: '/shifts', label: 'الورديات', icon: Clock, permissionId: 'view_shifts', tone: 'bg-slate-100 text-slate-700' },
    { to: '/expenses', label: 'المصروفات', icon: Wallet, permissionId: 'view_expenses', tone: 'bg-red-50 text-red-700' },
    { to: '/reports', label: 'التقارير', icon: FileText, permissionId: 'view_reports', tone: 'bg-indigo-50 text-indigo-700' },
    { to: '/sync-status', label: 'حالة المزامنة', icon: RefreshCw, permissionId: 'manage_settings', tone: 'bg-slate-100 text-slate-700' },
    { to: '/settings', label: 'الإعدادات', icon: Settings, permissionId: 'manage_settings', tone: 'bg-gray-100 text-gray-700' },
  ].filter((item) => user?.role === 'admin' || user?.permissions?.includes(item.permissionId));

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
    <div className={`${isAndroidStandalone ? "p-3 sm:p-5" : "p-6"} h-full overflow-y-auto bg-[var(--app-bg)] custom-scrollbar`} dir="rtl">
      <div className="flex flex-wrap justify-between items-center gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <LayoutDashboard className="w-6 h-6 text-indigo-600" />
            <span>لوحة التحكم</span>
          </h1>
          <p className="text-slate-500 text-sm mt-1 tabular-nums">نظرة عامة على أداء اليوم: {format(today, 'yyyy/MM/dd')}</p>
        </div>
        <div className="flex flex-wrap gap-2.5">
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

      {isAndroidStandalone && (
        <section className="mb-5">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-base font-black text-slate-900">أقسام النظام</h2>
              <p className="mt-0.5 text-[11px] text-slate-500">اختر القسم المطلوب للمتابعة</p>
            </div>
            <span className="rounded-full bg-white px-3 py-1 text-[10px] font-bold text-slate-500 shadow-sm">{moduleItems.length} قسم</span>
          </div>
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 sm:gap-3">
            {moduleItems.map((item) => (
              <Link key={item.to} to={item.to} className="flex min-h-[94px] flex-col items-center justify-center gap-2 rounded-2xl border border-slate-200/80 bg-white px-2 py-3 text-center shadow-sm transition active:scale-[0.98]">
                <span className={`flex h-11 w-11 items-center justify-center rounded-2xl ${item.tone}`}>
                  <item.icon className="h-5 w-5" />
                </span>
                <span className="text-[11px] font-extrabold leading-tight text-slate-700">{item.label}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Main Stats Grid */}
      <div className={`grid ${isAndroidStandalone ? "grid-cols-2 gap-2.5" : "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"} mb-6`}>
        {quickStats.map((stat, idx) => (
          <div key={idx} className={`bg-white ${isAndroidStandalone ? "p-3 gap-2.5" : "p-5 gap-4"} rounded-2xl border border-slate-200 flex items-center`}>
            <div className={`p-3 rounded-xl border ${stat.bg} ${stat.color} shrink-0`}>
              <stat.icon className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-500 font-bold">{stat.label}</p>
              <p className={`${isAndroidStandalone ? "text-base" : "text-xl"} font-black text-slate-900 mt-0.5 tabular-nums break-words`}>
                {typeof stat.value === 'number' && stat.label !== 'عدد الطلبات' && stat.label !== 'نقاط الولاء'
                  ? `${stat.value.toFixed(2)} ${storeSettings.currency}`
                  : stat.value}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Sales by Payment Method */}
        <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-slate-200">
          <h3 className="text-base font-bold text-slate-900 mb-5 flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-indigo-600" />
            <span>توزيع تحصيلات اليوم (شامل الضريبة)</span>
          </h3>
          <div className="h-64">
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
          <div className="bg-white p-5 rounded-2xl border border-slate-200">
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
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
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
