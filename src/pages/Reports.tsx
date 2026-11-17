import { useState, useRef, useMemo } from 'react';
import { formatAmount } from '../utils/numberFormat.js';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, Order, OrderItem, Purchase, PurchaseItem } from '../db/db';
import { PurchaseReceipt } from '../components/PurchaseReceipt';
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
} from 'recharts';
import {
  TrendingUp,
  ShoppingBag,
  CreditCard,
  Banknote,
  Receipt,
  Printer,
  X,
  Users,
  RotateCcw,
  Calendar,
  Package,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
  Download,
  DollarSign,
  PieChart as PieChartIcon,
  Activity,
  Ban,
} from 'lucide-react';
import { format, subDays, startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth, isWithinInterval } from 'date-fns';
import { arSA } from 'date-fns/locale';
import { useReactToPrint } from 'react-to-print';
import { toast } from 'react-hot-toast';
import { Receipt as ReceiptComponent } from '../components/Receipt';
import { useSettings } from '../hooks/useSettings';
import FinancialReport from '../components/FinancialReport';
import { useInventoryStore } from '../store/useInventoryStore';
import { dispatchOperation } from '../services/operationService';
import { generateUUID } from '../utils/uuid';
import { useAuth } from '../context/AuthContext';
import ConfirmationModal from '../components/ConfirmationModal';

export default function Reports() {
  const { user } = useAuth();
  const [activeMainTab, setActiveMainTab] = useState<'overview' | 'financial'>('overview');
  const orders = useLiveQuery(() => db.orders.toArray()) || [];
  const orderItems = useLiveQuery(() => db.orderItems.toArray()) || [];
  const returns = useLiveQuery(() => db.returns.toArray()) || [];
  const inventoryBatches = useLiveQuery(() => db.inventoryBatches.toArray()) || [];
  const products = useLiveQuery(() => db.products.toArray()) || [];
  const expenses = useLiveQuery(() => db.expenses.toArray()) || [];
  const payrolls = useLiveQuery(() => db.payroll.toArray()) || [];
  const journalEntries = useLiveQuery(() => db.journalEntries.toArray()) || [];
  const transactions = useLiveQuery(() => db.transactions.toArray()) || [];
  const customers = useLiveQuery(() => db.customers.toArray()) || [];
  const suppliers = useLiveQuery(() => db.suppliers.toArray()) || [];
  const purchases = useLiveQuery(() => db.purchases.toArray()) || [];
  const loyaltyTransactions = useLiveQuery(() => db.loyaltyTransactions.toArray()) || [];

  const [dateFilter, setDateFilter] = useState<'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'custom'>('today');
  const [customStartDate, setCustomStartDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [customEndDate, setCustomEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  const storeSettings = useSettings();

  const [selectedOrder, setSelectedOrder] = useState<{ order: Order; items: OrderItem[] } | null>(null);
  const [selectedPurchase, setSelectedPurchase] = useState<{ purchase: Purchase; items: PurchaseItem[] } | null>(null);
  const [returnTarget, setReturnTarget] = useState<{ order: Order; items: OrderItem[] } | null>(null);
  const [voidTarget, setVoidTarget] = useState<Order | null>(null);
  const receiptRef = useRef<HTMLDivElement>(null);

  const hasPermission = (permission: string) => {
    return user?.role === 'admin' || user?.permissions?.includes(permission);
  };

  const handlePrint = useReactToPrint({
    contentRef: receiptRef,
    documentTitle: selectedOrder
      ? `Receipt-${selectedOrder.order.receiptNumber}`
      : selectedPurchase
      ? `Purchase-${selectedPurchase.purchase.id}`
      : 'Receipt',
  });

  const handleViewReceipt = async (order: Order) => {
    const items = await db.orderItems.where('orderId').equals(order.id!).toArray();
    setSelectedOrder({ order, items });
  };

  const handleViewPurchase = async (purchase: Purchase) => {
    const items = await db.purchaseItems.where('purchaseId').equals(purchase.id!).toArray();
    setSelectedPurchase({ purchase, items });
  };

  const handleReturnOrderClick = (order: Order, items: OrderItem[]) => {
    if (order.status === 'void') {
      toast.error('الفاتورة ملغاة بالكامل ولا يمكن إرجاعها');
      return;
    }
    if (order.netAmount < 0 || order.status === 'returned') {
      toast.error('تم إرجاع هذه الفاتورة بالكامل مسبقاً');
      return;
    }

    const returnableItems = items.filter((item) => Math.max(0, Number(item.quantity) - Number(item.returnedQuantity || 0)) > 0);
    if (returnableItems.length === 0) {
      toast.error('لا توجد كميات متبقية قابلة للإرجاع في هذه الفاتورة');
      return;
    }
    setReturnTarget({ order, items });
  };

  const confirmReturnOrder = async () => {
    if (!returnTarget) return;
    const { order, items } = returnTarget;
    const returnableItems = items
      .map((item) => ({
        item,
        remainingQty: Math.max(0, Number(item.quantity) - Number(item.returnedQuantity || 0)),
      }))
      .filter((entry) => entry.remainingQty > 0);

    try {
      const returnId = generateUUID();
      const returnNumber = `RET-${Date.now()}`;
      const currentShift = await db.shifts.where('status').equals('open').first();

      await dispatchOperation(
        'return',
        {
          id: returnId,
          returnNumber,
          originalOrderId: order.id!,
          refundMethod: order.paymentMethod === 'credit' ? 'credit_adjustment' : order.paymentMethod === 'card' ? 'card' : 'cash',
          reason: 'إرجاع كامل من شاشة التقارير',
          branchId: user?.branchId,
          shiftId: currentShift?.id,
          createdBy: user?.name || 'مستخدم',
          items: returnableItems.map(({ item, remainingQty }) => ({
            orderItemId: item.id,
            productId: item.productId,
            quantity: remainingQty,
          })),
        },
        user?.branchId
      );

      toast.success(`تم إصدار مستند المرتجع بنجاح: ${returnNumber}`);
      setSelectedOrder(null);
    } catch (error: any) {
      console.error('Error returning order:', error);
      toast.error(error?.message || 'حدث خطأ أثناء إرجاع الفاتورة');
    } finally {
      setReturnTarget(null);
    }
  };

  const confirmVoidOrder = async (reason?: string) => {
    if (!voidTarget) return;
    try {
      const currentShift = await db.shifts.where('status').equals('open').first();
      await dispatchOperation(
        'order_void',
        {
          orderId: voidTarget.id!,
          reason: reason || 'إلغاء فاتورة من شاشة التقارير',
          shiftId: currentShift?.id,
          branchId: user?.branchId,
          createdBy: user?.name || 'مستخدم',
        },
        user?.branchId
      );
      toast.success(`تم إلغاء الفاتورة ${voidTarget.receiptNumber} وعكس القيود والمخزون`);
      setSelectedOrder(null);
    } catch (error: any) {
      console.error('Error voiding order:', error);
      toast.error(error?.message || 'تعذر إلغاء الفاتورة');
    } finally {
      setVoidTarget(null);
    }
  };

  const stats = useMemo(() => {
    const { idMap: productIdMap } = useInventoryStore.getState();
    const today = new Date();
    let startDate = startOfDay(today);
    let endDate = endOfDay(today);

    switch (dateFilter) {
      case 'yesterday': {
        const yesterday = subDays(today, 1);
        startDate = startOfDay(yesterday);
        endDate = endOfDay(yesterday);
        break;
      }
      case 'thisWeek':
        startDate = startOfWeek(today, { weekStartsOn: 6 });
        endDate = endOfWeek(today, { weekStartsOn: 6 });
        break;
      case 'thisMonth':
        startDate = startOfMonth(today);
        endDate = endOfMonth(today);
        break;
      case 'custom':
        startDate = startOfDay(new Date(customStartDate));
        endDate = endOfDay(new Date(customEndDate));
        break;
      case 'today':
      default:
        startDate = startOfDay(today);
        endDate = endOfDay(today);
        break;
    }

    const filteredOrders = orders.filter((o) => {
      if (o.status === 'void') return false;
      const d = new Date(o.createdAt);
      return d >= startDate && d <= endDate;
    });

    const filteredReturns = returns.filter((r) => {
      const d = new Date(r.createdAt);
      return d >= startDate && d <= endDate;
    });

    const filteredExpenses = expenses.filter((e) => {
      const d = new Date(e.date);
      return d >= startDate && d <= endDate;
    });

    const filteredPayrolls = payrolls.filter((p) => {
      const d = new Date(p.paymentDate);
      return d >= startDate && d <= endDate;
    });

    const stocktakeJournalIds = new Set(
      journalEntries
        .filter((je) => {
          if (je.referenceType !== 'stocktake') return false;
          const d = new Date(je.date);
          return d >= startDate && d <= endDate;
        })
        .map((je) => je.id)
    );
    const stocktakeAdjustments = transactions
      .filter((t) => t.accountId === '5400' && stocktakeJournalIds.has(t.journalEntryId))
      .reduce((s, t) => s + Number(t.debit || 0) - Number(t.credit || 0), 0);

    // VAT-Inclusive separation: netRevenueExclTax excludes VAT payable (Account 2200)
    const grossSalesInclVat = filteredOrders.reduce((sum, o) => sum + Number(o.netAmount || 0), 0);
    const salesVat = filteredOrders.reduce((sum, o) => sum + Number(o.taxAmount || 0), 0);
    const totalReturnsInclVat = filteredReturns.reduce((sum, r) => sum + Number(r.totalRefund || 0), 0);
    const returnsVat = filteredReturns.reduce((sum, r) => sum + Number(r.taxAmount || 0), 0);

    const netCollectedInclVat = grossSalesInclVat - totalReturnsInclVat;
    const netVatPayable = salesVat - returnsVat;
    const totalRevenueExclVat = netCollectedInclVat - netVatPayable;

    const totalExpenses = filteredExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const totalPayrolls = filteredPayrolls.reduce((sum, p) => sum + Number(p.netSalary || 0), 0);

    const cashReturns = filteredReturns.filter((r) => r.refundMethod === 'cash').reduce((sum, r) => sum + Number(r.totalRefund || 0), 0);
    const cardReturns = filteredReturns.filter((r) => r.refundMethod === 'card').reduce((sum, r) => sum + Number(r.totalRefund || 0), 0);
    const creditReturns = filteredReturns
      .filter((r) => r.refundMethod === 'credit_adjustment')
      .reduce((sum, r) => sum + Number(r.totalRefund || 0), 0);

    const cashRevenue =
      filteredOrders.reduce((sum, o) => {
        if (o.paymentMethod === 'cash') return sum + Number(o.netAmount || 0);
        if (o.paymentMethod === 'mixed') return sum + Number(o.cashAmount || 0);
        return sum;
      }, 0) - cashReturns;

    const cardRevenue =
      filteredOrders.reduce((sum, o) => {
        if (o.paymentMethod === 'card') return sum + Number(o.netAmount || 0);
        if (o.paymentMethod === 'mixed') return sum + Number(o.cardAmount || 0);
        return sum;
      }, 0) - cardReturns;

    const creditRevenue =
      filteredOrders
        .filter((o) => o.paymentMethod === 'credit')
        .reduce((sum, o) => sum + Number(o.netAmount || 0), 0) - creditReturns;

    const filteredOrderIds = new Set(filteredOrders.map((o) => o.id));
    const filteredOrderItems = orderItems.filter((item) => filteredOrderIds.has(item.orderId));

    let grossCost = 0;
    filteredOrderItems.forEach((item) => {
      const unitCost =
        item.costPriceAtTimeOfSale !== undefined && item.costPriceAtTimeOfSale !== null
          ? Number(item.costPriceAtTimeOfSale)
          : Number(productIdMap.get(item.productId)?.costPrice || 0);
      grossCost += unitCost * Number(item.quantity || 0);
    });

    const returnedCost = filteredReturns.reduce((sum, r) => sum + Number(r.totalCostReversed || 0), 0);
    const totalCost = Math.max(0, grossCost - returnedCost);

    const grossProfit = totalRevenueExclVat - totalCost;
    const netProfit = grossProfit - totalExpenses - totalPayrolls - stocktakeAdjustments;

    // Last 7 days chart excluding voided orders & separating VAT
    const chartData = Array.from({ length: 7 }).map((_, i) => {
      const date = subDays(today, 6 - i);
      const dayStart = startOfDay(date);
      const dayEnd = endOfDay(date);

      const dayOrders = orders.filter((o) => {
        if (o.status === 'void') return false;
        const d = new Date(o.createdAt);
        return d >= dayStart && d <= dayEnd;
      });
      const dayReturns = returns.filter((r) => {
        const d = new Date(r.createdAt);
        return d >= dayStart && d <= dayEnd;
      });
      const dayExpenses = expenses.filter((e) => {
        const d = new Date(e.date);
        return d >= dayStart && d <= dayEnd;
      });

      const dayNetSales =
        dayOrders.reduce((s, o) => s + (Number(o.netAmount || 0) - Number(o.taxAmount || 0)), 0) -
        dayReturns.reduce((s, r) => s + (Number(r.totalRefund || 0) - Number(r.taxAmount || 0)), 0);

      return {
        name: format(date, 'EEEE', { locale: arSA }),
        total: Math.round(dayNetSales * 100) / 100,
        expenses: Math.round(dayExpenses.reduce((s, e) => s + Number(e.amount || 0), 0) * 100) / 100,
      };
    });

    const productSales: Record<string, { name: string; quantity: number; revenue: number }> = {};
    filteredOrderItems.forEach((item) => {
      if (!productSales[item.productId]) {
        productSales[item.productId] = { name: item.productName, quantity: 0, revenue: 0 };
      }
      productSales[item.productId].quantity += Number(item.quantity || 0);
      productSales[item.productId].revenue += Number(item.total || 0) - Number(item.taxAmount || 0);
    });

    const topProducts = Object.values(productSales)
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);

    const expenseCategories: Record<string, number> = {};
    filteredExpenses.forEach((e) => {
      expenseCategories[e.category] = (expenseCategories[e.category] || 0) + Number(e.amount || 0);
    });

    const COLORS = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];
    const expenseData = Object.entries(expenseCategories).map(([name, value], index) => ({
      name,
      value,
      color: COLORS[index % COLORS.length],
    }));

    const batchValue = inventoryBatches.reduce(
      (sum, b) => sum + Math.max(0, Number(b.remainingQuantity || 0)) * Number(b.costPrice || 0),
      0
    );
    const productsFallbackValue = products.reduce(
      (sum, p) => sum + Math.max(0, Number(p.stockQuantity || 0)) * Number(p.costPrice || 0),
      0
    );
    const totalInventoryValue = inventoryBatches.length > 0 ? batchValue : productsFallbackValue;
    const totalRetailValue = products.reduce((sum, p) => sum + Math.max(0, p.stockQuantity) * p.sellingPrice, 0);
    const totalReceivables = customers.reduce((sum, c) => sum + Number(c.balance || 0), 0);
    const totalPayables = suppliers.reduce((sum, s) => sum + Number(s.balance || 0), 0);
    const lowStockItems = products.filter((p) => p.stockQuantity <= (p.minStockLevel || 10));

    const totalPurchases = purchases
      .filter((p) => isWithinInterval(new Date(p.date), { start: startDate, end: endDate }))
      .reduce((sum, p) => sum + Number(p.totalAmount || 0), 0);

    const filteredLoyalty = loyaltyTransactions.filter((t) => {
      const d = new Date(t.date);
      return d >= startDate && d <= endDate;
    });

    const totalPointsEarned = filteredLoyalty.filter((t) => t.type === 'earn').reduce((sum, t) => sum + t.points, 0);
    const totalPointsRedeemed = filteredLoyalty.filter((t) => t.type === 'redeem').reduce((sum, t) => sum + Math.abs(t.points), 0);
    const pointsValueRedeemed = totalPointsRedeemed * 0.1;

    const recentOrders = [...filteredOrders]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10);

    return {
      totalRevenueExclVat,
      netCollectedInclVat,
      netVatPayable,
      totalExpenses,
      totalPayrolls,
      stocktakeAdjustments,
      totalCost,
      totalPurchases,
      totalPointsEarned,
      totalPointsRedeemed,
      pointsValueRedeemed,
      grossProfit,
      netProfit,
      totalOrders: filteredOrders.length,
      cashRevenue,
      cardRevenue,
      creditRevenue,
      chartData,
      topProducts,
      expenseData,
      totalInventoryValue,
      totalRetailValue,
      totalReceivables,
      totalPayables,
      lowStockItems,
      recentOrders,
      filteredOrders: [...filteredOrders].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
      startDate,
      endDate,
    };
  }, [
    orders,
    orderItems,
    returns,
    inventoryBatches,
    products,
    expenses,
    payrolls,
    journalEntries,
    transactions,
    customers,
    suppliers,
    purchases,
    loyaltyTransactions,
    dateFilter,
    customStartDate,
    customEndDate,
  ]);

  const handleExportCSV = () => {
    const headers = ['رقم الفاتورة', 'التاريخ', 'الصافي بدون ضريبة', 'الضريبة', 'الإجمالي شامل الضريبة', 'طريقة الدفع', 'الحالة'];
    const rows = stats.filteredOrders.map((order) => [
      order.receiptNumber,
      format(new Date(order.createdAt), 'yyyy-MM-dd HH:mm'),
      (Number(order.netAmount || 0) - Number(order.taxAmount || 0)).toFixed(2),
      Number(order.taxAmount || 0).toFixed(2),
      Number(order.netAmount || 0).toFixed(2),
      order.paymentMethod,
      order.status,
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `sales_report_${format(new Date(), 'yyyyMMdd')}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="p-6 h-full flex flex-col bg-[var(--app-bg)] overflow-y-auto custom-scrollbar" dir="rtl">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6 shrink-0">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Activity className="w-6 h-6 text-indigo-600" />
            <span>التقارير والمبيعات</span>
          </h2>
          <p className="text-slate-500 text-sm mt-1">
            تحليل صافي الإيرادات (بعد فصل ضريبة القيمة المضافة) والتكاليف والقوائم المالية
          </p>
          <div className="mt-4 flex bg-slate-200/70 p-1 rounded-xl w-fit border border-slate-200">
            <button
              onClick={() => setActiveMainTab('overview')}
              className={`px-5 py-2 rounded-lg text-sm font-bold transition-colors whitespace-nowrap ${
                activeMainTab === 'overview' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-600 hover:bg-slate-200/50'
              }`}
            >
              نظرة عامة
            </button>
            <button
              onClick={() => setActiveMainTab('financial')}
              className={`px-5 py-2 rounded-lg text-sm font-bold transition-colors whitespace-nowrap ${
                activeMainTab === 'financial' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-600 hover:bg-slate-200/50'
              }`}
            >
              التقرير المالي الشامل
            </button>
          </div>
        </div>

        {activeMainTab === 'overview' && (
          <div className="flex flex-wrap items-center gap-1.5 bg-white p-1.5 rounded-xl border border-slate-200">
            {(['today', 'yesterday', 'thisWeek', 'thisMonth', 'custom'] as const).map((period) => (
              <button
                key={period}
                onClick={() => setDateFilter(period)}
                className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${
                  dateFilter === period ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                {period === 'today'
                  ? 'اليوم'
                  : period === 'yesterday'
                  ? 'الأمس'
                  : period === 'thisWeek'
                  ? 'هذا الأسبوع'
                  : period === 'thisMonth'
                  ? 'هذا الشهر'
                  : 'مخصص'}
              </button>
            ))}

            <div className="h-6 w-px bg-slate-200 mx-1" />

            <button
              onClick={handleExportCSV}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold text-indigo-600 hover:bg-indigo-50 transition-colors whitespace-nowrap"
            >
              <Download className="w-4 h-4" />
              <span>تصدير CSV</span>
            </button>
          </div>
        )}
      </div>

      {activeMainTab === 'overview' && (
        <>
          {dateFilter === 'custom' && (
            <div className="bg-white p-4 rounded-2xl border border-slate-200 mb-6 flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-xs font-bold text-slate-500">من:</label>
                <input
                  type="date"
                  value={customStartDate}
                  onChange={(e) => setCustomStartDate(e.target.value)}
                  className="px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs font-bold text-slate-500">إلى:</label>
                <input
                  type="date"
                  value={customEndDate}
                  onChange={(e) => setCustomEndDate(e.target.value)}
                  className="px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>
          )}

          {/* KPI Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6 shrink-0 tabular-nums">
            <div className="bg-white rounded-2xl p-5 border border-slate-200 flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-indigo-50 border border-indigo-200 flex items-center justify-center text-indigo-600 shrink-0">
                <TrendingUp className="w-6 h-6" />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-500 mb-1">صافي المبيعات (بدون ضريبة)</p>
                <h3 className="text-xl font-black text-slate-900">
                  {formatAmount(stats.totalRevenueExclVat)}{' '}
                  <span className="text-xs font-bold text-slate-400">{storeSettings.currency}</span>
                </h3>
                <div className="flex items-center gap-1 mt-1 text-emerald-600">
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  <span className="text-xs font-bold">صافي الربح: {formatAmount(stats.netProfit)}</span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-5 border border-slate-200 flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600 shrink-0">
                <DollarSign className="w-6 h-6" />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-500 mb-1">صافي ضريبة القيمة المضافة (2200)</p>
                <h3 className="text-xl font-black text-slate-900">
                  {formatAmount(stats.netVatPayable)}{' '}
                  <span className="text-xs font-bold text-slate-400">{storeSettings.currency}</span>
                </h3>
                <p className="text-xs text-slate-500 mt-1">المحصل شاملاً: {formatAmount(stats.netCollectedInclVat)}</p>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-5 border border-slate-200 flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-600 shrink-0">
                <ArrowDownRight className="w-6 h-6" />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-500 mb-1">المصروفات والرواتب</p>
                <h3 className="text-xl font-black text-slate-900">
                  {formatAmount(stats.totalExpenses + stats.totalPayrolls)}{' '}
                  <span className="text-xs font-bold text-slate-400">{storeSettings.currency}</span>
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  تشغيلية: {formatAmount(stats.totalExpenses)} | رواتب: {formatAmount(stats.totalPayrolls)}
                </p>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-5 border border-slate-200 flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600 shrink-0">
                <Package className="w-6 h-6" />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-500 mb-1">قيمة المخزون (تكلفة FIFO)</p>
                <h3 className="text-xl font-black text-slate-900">
                  {formatAmount(stats.totalInventoryValue)}{' '}
                  <span className="text-xs font-bold text-slate-400">{storeSettings.currency}</span>
                </h3>
                <p className="text-xs text-slate-500 mt-1">القيمة البيعية: {formatAmount(stats.totalRetailValue)}</p>
              </div>
            </div>
          </div>

          {/* Payment Distribution Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6 shrink-0 tabular-nums">
            <div className="bg-white rounded-2xl p-5 border border-slate-200 flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600">
                <Banknote className="w-6 h-6" />
              </div>
              <div className="flex-1">
                <p className="text-xs font-bold text-slate-500 mb-1">التحصيل النقدي (شامل الضريبة)</p>
                <div className="flex items-end justify-between">
                  <h3 className="text-xl font-black text-slate-900">
                    {formatAmount(stats.cashRevenue)} <span className="text-xs text-slate-400">{storeSettings.currency}</span>
                  </h3>
                  <span className="text-xs font-bold text-slate-500">
                    {stats.netCollectedInclVat > 0 ? ((stats.cashRevenue / stats.netCollectedInclVat) * 100).toFixed(0) : 0}%
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-5 border border-slate-200 flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
                <CreditCard className="w-6 h-6" />
              </div>
              <div className="flex-1">
                <p className="text-xs font-bold text-slate-500 mb-1">مبيعات الشبكة (شامل الضريبة)</p>
                <div className="flex items-end justify-between">
                  <h3 className="text-xl font-black text-slate-900">
                    {formatAmount(stats.cardRevenue)} <span className="text-xs text-slate-400">{storeSettings.currency}</span>
                  </h3>
                  <span className="text-xs font-bold text-slate-500">
                    {stats.netCollectedInclVat > 0 ? ((stats.cardRevenue / stats.netCollectedInclVat) * 100).toFixed(0) : 0}%
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-5 border border-slate-200 flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600">
                <Users className="w-6 h-6" />
              </div>
              <div className="flex-1">
                <p className="text-xs font-bold text-slate-500 mb-1">مبيعات الآجل (ذمم)</p>
                <div className="flex items-end justify-between">
                  <h3 className="text-xl font-black text-slate-900">
                    {formatAmount(stats.creditRevenue)} <span className="text-xs text-slate-400">{storeSettings.currency}</span>
                  </h3>
                  <span className="text-xs font-bold text-slate-500">
                    {stats.netCollectedInclVat > 0 ? ((stats.creditRevenue / stats.netCollectedInclVat) * 100).toFixed(0) : 0}%
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div className="bg-white rounded-2xl border border-slate-200 p-6 flex flex-col min-h-[360px]">
              <div className="flex justify-between items-center mb-5">
                <h3 className="text-base font-bold text-slate-900">تحليل صافي المبيعات والمصروفات (آخر 7 أيام)</h3>
              </div>
              <div className="flex-1 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={stats.chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} />
                    <Tooltip />
                    <Area type="monotone" dataKey="total" stroke="#4f46e5" strokeWidth={2.5} fill="#4f46e5" fillOpacity={0.08} name="صافي المبيعات" />
                    <Area type="monotone" dataKey="expenses" stroke="#f43f5e" strokeWidth={2.5} fill="#f43f5e" fillOpacity={0.08} name="المصروفات" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-6 flex flex-col min-h-[360px]">
              <div className="flex justify-between items-center mb-5">
                <h3 className="text-base font-bold text-slate-900">توزيع المصروفات حسب الفئة</h3>
                <PieChartIcon className="w-5 h-5 text-slate-400" />
              </div>
              <div className="flex-1 flex flex-col md:flex-row items-center justify-center gap-6">
                <div className="w-full h-60 md:w-1/2">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={stats.expenseData.length > 0 ? stats.expenseData : [{ name: 'لا يوجد', value: 1, color: '#f1f5f9' }]}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={78}
                        paddingAngle={4}
                        dataKey="value"
                      >
                        {stats.expenseData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                        {stats.expenseData.length === 0 && <Cell fill="#f1f5f9" />}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="w-full md:w-1/2 space-y-2.5">
                  {stats.expenseData.map((item, index) => (
                    <div key={index} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: item.color }} />
                        <span className="text-slate-600">{item.name}</span>
                      </div>
                      <span className="font-bold text-slate-900 tabular-nums">{formatAmount(item.value)}</span>
                    </div>
                  ))}
                  {stats.expenseData.length === 0 && (
                    <p className="text-sm text-slate-400 text-center">لا توجد مصروفات في هذه الفترة</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Financial Statement Summary Table */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-6">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="text-base font-bold text-slate-900">ملخص قائمة الدخل والمركز المالي</h3>
                <p className="text-xs text-slate-500 mt-0.5">فصل ضريبة القيمة المضافة عن صافي الإيرادات والأرباح المحاسبية</p>
              </div>
              <div className="flex items-center gap-2 text-xs font-bold text-slate-500 tabular-nums">
                <Calendar className="w-4 h-4" />
                <span>
                  {format(stats.startDate, 'yyyy/MM/dd')} - {format(stats.endDate, 'yyyy/MM/dd')}
                </span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse tabular-nums">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 text-xs border-b border-slate-200">
                    <th className="px-6 py-3 font-bold">البند المحاسبي</th>
                    <th className="px-6 py-3 font-bold">التفاصيل</th>
                    <th className="px-6 py-3 font-bold text-left">المبلغ ({storeSettings.currency})</th>
                  </tr>
                </thead>
                <tbody className="text-sm divide-y divide-slate-100">
                  <tr className="bg-indigo-50/40">
                    <td className="px-6 py-3.5 font-black text-indigo-950" colSpan={2}>
                      صافي إيرادات المبيعات (بدون ضريبة القيمة المضافة)
                    </td>
                    <td className="px-6 py-3.5 font-black text-indigo-950 text-left">
                      {formatAmount(stats.totalRevenueExclVat)}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-6 py-3 text-slate-500 pr-10">ضريبة القيمة المضافة المستحقة للهيئة (حساب 2200)</td>
                    <td className="px-6 py-3 text-slate-500">صافي الضريبة المحصلة بعد المرتجعات</td>
                    <td className="px-6 py-3 text-amber-700 font-bold text-left">{formatAmount(stats.netVatPayable)}</td>
                  </tr>
                  <tr className="bg-rose-50/30">
                    <td className="px-6 py-3.5 font-black text-rose-900" colSpan={2}>
                      تكلفة البضاعة المباعة (COGS التاريخية FIFO)
                    </td>
                    <td className="px-6 py-3.5 font-black text-rose-900 text-left">({formatAmount(stats.totalCost)})</td>
                  </tr>
                  <tr className="bg-emerald-50/40">
                    <td className="px-6 py-3.5 font-black text-emerald-900" colSpan={2}>
                      مجمل الربح (Gross Profit)
                    </td>
                    <td className="px-6 py-3.5 font-black text-emerald-900 text-left">{formatAmount(stats.grossProfit)}</td>
                  </tr>
                  <tr>
                    <td className="px-6 py-3 text-slate-600 pr-10">المصروفات التشغيلية</td>
                    <td className="px-6 py-3 text-slate-500">مصروفات الفترة</td>
                    <td className="px-6 py-3 text-rose-600 font-bold text-left">({formatAmount(stats.totalExpenses)})</td>
                  </tr>
                  <tr>
                    <td className="px-6 py-3 text-slate-600 pr-10">الرواتب والأجور</td>
                    <td className="px-6 py-3 text-slate-500">مسير الرواتب المنصرف</td>
                    <td className="px-6 py-3 text-rose-600 font-bold text-left">({formatAmount(stats.totalPayrolls)})</td>
                  </tr>
                  <tr>
                    <td className="px-6 py-3 text-slate-600 pr-10">فروقات وتسويات الجرد (5400)</td>
                    <td className="px-6 py-3 text-slate-500">عجز / فائض المخزون المعتمد</td>
                    <td className="px-6 py-3 text-slate-900 font-bold text-left">
                      {stats.stocktakeAdjustments >= 0
                        ? `(${formatAmount(stats.stocktakeAdjustments)})`
                        : `+${formatAmount(Math.abs(stats.stocktakeAdjustments))}`}
                    </td>
                  </tr>
                  <tr className="bg-emerald-600 text-white">
                    <td className="px-6 py-4 font-black text-base" colSpan={2}>
                      صافي الربح المحاسبي النهائي (Net Profit)
                    </td>
                    <td className="px-6 py-4 font-black text-lg text-left">{formatAmount(stats.netProfit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Bottom Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col min-h-[340px]">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-slate-900">الأكثر مبيعاً</h3>
                <ShoppingBag className="w-5 h-5 text-indigo-600" />
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto custom-scrollbar">
                {stats.topProducts.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-slate-400 text-sm">لا توجد بيانات</div>
                ) : (
                  stats.topProducts.map((product, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 rounded-xl border border-slate-100 bg-slate-50"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center font-bold text-sm text-indigo-600 tabular-nums">
                          {index + 1}
                        </div>
                        <div>
                          <p className="text-sm font-bold text-slate-900">{product.name}</p>
                          <p className="text-xs text-slate-500 tabular-nums">{product.quantity} وحدة مباعة</p>
                        </div>
                      </div>
                      <p className="text-sm font-black text-emerald-600 tabular-nums">
                        {formatAmount(product.revenue)} {storeSettings.currency}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col min-h-[340px]">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-slate-900">تنبيهات المخزون</h3>
                <AlertTriangle className="w-5 h-5 text-rose-500" />
              </div>
              <div className="flex-1 space-y-2.5 overflow-y-auto custom-scrollbar">
                {stats.lowStockItems.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-emerald-600 text-sm font-bold">
                    المخزون متوفر بكميات كافية
                  </div>
                ) : (
                  stats.lowStockItems.map((product, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 rounded-xl border border-rose-200 bg-rose-50/40"
                    >
                      <div>
                        <p className="text-sm font-bold text-slate-900">{product.name}</p>
                        <p className="text-xs text-rose-600 font-bold tabular-nums">
                          المتبقي: {product.stockQuantity} {product.unit || 'حبة'}
                        </p>
                      </div>
                      <span className="px-2 py-0.5 rounded-lg border border-rose-200 bg-white text-rose-700 text-xs font-bold whitespace-nowrap">
                        منخفض
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col min-h-[340px]">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-slate-900">أحدث الفواتير</h3>
                <Receipt className="w-5 h-5 text-indigo-600" />
              </div>
              <div className="flex-1 space-y-2.5 overflow-y-auto custom-scrollbar">
                {stats.recentOrders.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-slate-400 text-sm">لا توجد مبيعات</div>
                ) : (
                  stats.recentOrders.map((order) => (
                    <button
                      key={order.id}
                      onClick={() => handleViewReceipt(order)}
                      className="w-full flex items-center justify-between p-3 rounded-xl border border-slate-200 hover:bg-slate-50 transition-colors text-right"
                    >
                      <div>
                        <p className="text-sm font-bold font-mono text-slate-900">{order.receiptNumber}</p>
                        <p className="text-xs text-slate-400 tabular-nums">
                          {format(new Date(order.createdAt), 'yyyy/MM/dd HH:mm')}
                        </p>
                      </div>
                      <div className="text-left tabular-nums">
                        <p className="text-sm font-black text-indigo-600">{formatAmount(order.netAmount)}</p>
                        <p className="text-xs font-bold text-slate-500">
                          {order.paymentMethod === 'cash'
                            ? 'نقدي'
                            : order.paymentMethod === 'card'
                            ? 'شبكة'
                            : order.paymentMethod === 'mixed'
                            ? 'مختلط'
                            : 'آجل'}
                        </p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {activeMainTab === 'financial' && (
        <div className="flex-1 overflow-hidden">
          <FinancialReport onViewReceipt={handleViewReceipt} onViewPurchase={handleViewPurchase} />
        </div>
      )}

      {/* Receipt Modal */}
      {selectedOrder && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Receipt className="w-5 h-5 text-indigo-600" />
                <span>تفاصيل الفاتورة {selectedOrder.order.status === 'void' ? '(ملغاة)' : ''}</span>
              </h3>
              <button onClick={() => setSelectedOrder(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 bg-slate-100 flex justify-center custom-scrollbar">
              <div className="bg-white border border-slate-200">
                <ReceiptComponent
                  ref={receiptRef}
                  order={selectedOrder.order}
                  items={selectedOrder.items}
                  settings={storeSettings}
                />
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 bg-white flex flex-wrap gap-2">
              <button
                onClick={() => setSelectedOrder(null)}
                className="flex-1 py-2.5 rounded-xl font-bold text-sm text-slate-700 bg-slate-100 hover:bg-slate-200 whitespace-nowrap"
              >
                إغلاق
              </button>
              {hasPermission('void_items') &&
                selectedOrder.order.status === 'completed' &&
                Number(selectedOrder.order.returnedAmount || 0) === 0 && (
                  <button
                    onClick={() => setVoidTarget(selectedOrder.order)}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-bold text-sm text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 whitespace-nowrap"
                  >
                    <Ban className="w-4 h-4" />
                    <span>إلغاء</span>
                  </button>
                )}
              {hasPermission('process_returns') && selectedOrder.order.status !== 'void' && (
                <button
                  onClick={() => handleReturnOrderClick(selectedOrder.order, selectedOrder.items)}
                  disabled={selectedOrder.order.netAmount < 0 || selectedOrder.order.status === 'returned'}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-bold text-sm text-rose-600 bg-rose-50 border border-rose-200 hover:bg-rose-100 disabled:opacity-50 whitespace-nowrap"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>إرجاع</span>
                </button>
              )}
              <button
                onClick={() => handlePrint()}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-bold text-sm text-white bg-indigo-600 hover:bg-indigo-700 whitespace-nowrap"
              >
                <Printer className="w-4 h-4" />
                <span>طباعة</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Purchase Receipt Modal */}
      {selectedPurchase && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Receipt className="w-5 h-5 text-blue-600" />
                <span>تفاصيل فاتورة الشراء</span>
              </h3>
              <button onClick={() => setSelectedPurchase(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 bg-slate-100 flex justify-center custom-scrollbar">
              <div className="bg-white border border-slate-200">
                <PurchaseReceipt
                  ref={receiptRef}
                  purchase={selectedPurchase.purchase}
                  items={selectedPurchase.items}
                  settings={storeSettings}
                />
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 bg-white flex justify-end gap-3">
              <button
                onClick={() => setSelectedPurchase(null)}
                className="py-2.5 px-5 rounded-xl font-bold text-sm text-slate-700 bg-slate-100 hover:bg-slate-200"
              >
                إغلاق
              </button>
              <button
                onClick={() => handlePrint()}
                className="flex items-center justify-center gap-2 py-2.5 px-5 rounded-xl font-bold text-sm text-white bg-blue-600 hover:bg-blue-700"
              >
                <Printer className="w-4 h-4" />
                <span>طباعة</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Order Return */}
      <ConfirmationModal
        isOpen={Boolean(returnTarget)}
        title="تأكيد إرجاع الفاتورة"
        message={`هل أنت متأكد من إرجاع الكميات المتبقية من الفاتورة "${returnTarget?.order.receiptNumber || ''}"؟ سيتم إصدار مستند مرتجع وإعادة المخزون وعكس القيود المحاسبية.`}
        confirmLabel="اعتماد المرتجع"
        variant="danger"
        onConfirm={confirmReturnOrder}
        onCancel={() => setReturnTarget(null)}
      />

      {/* Confirm Order Void */}
      <ConfirmationModal
        isOpen={Boolean(voidTarget)}
        title="إلغاء الفاتورة بالكامل (Void)"
        message={`هل تريد إلغاء الفاتورة "${voidTarget?.receiptNumber || ''}"؟ سيتم استرجاع المخزون وإلغاء ذمة العميل ونقاط الولاء وعكس القيد المحاسبي.`}
        confirmLabel="إلغاء الفاتورة"
        variant="danger"
        promptLabel="سبب الإلغاء"
        promptPlaceholder="مثال: خطأ في الإدخال أو إلغاء الطلب قبل التسليم"
        promptRequired={true}
        onConfirm={confirmVoidOrder}
        onCancel={() => setVoidTarget(null)}
      />
    </div>
  );
}
