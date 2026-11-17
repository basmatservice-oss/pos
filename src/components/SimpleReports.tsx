import { useMemo, useState, ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  Banknote,
  Calendar,
  Clock,
  CreditCard,
  Lightbulb,
  Package,
  PiggyBank,
  Receipt,
  ShoppingBag,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';
import {
  addDays,
  differenceInCalendarDays,
  endOfDay,
  endOfMonth,
  format,
  startOfDay,
  startOfMonth,
  subDays,
  subMonths,
} from 'date-fns';
import { db } from '../db/db';
import { useSettings } from '../hooks/useSettings';
import { formatNumber, formatQty } from '../utils/format';

type PeriodKey = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'lastMonth' | 'custom';
type SubTab = 'summary' | 'sales' | 'profit' | 'stock' | 'debts' | 'expenses';

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'اليوم' },
  { key: 'yesterday', label: 'أمس' },
  { key: 'last7', label: 'آخر 7 أيام' },
  { key: 'thisMonth', label: 'هذا الشهر' },
  { key: 'lastMonth', label: 'الشهر الماضي' },
  { key: 'custom', label: 'فترة محددة' },
];

const SUB_TABS: { key: SubTab; label: string; icon: ReactNode }[] = [
  { key: 'summary', label: 'الموقف المالي', icon: <Wallet className="w-4 h-4" /> },
  { key: 'sales', label: 'المبيعات', icon: <ShoppingBag className="w-4 h-4" /> },
  { key: 'profit', label: 'الأرباح', icon: <TrendingUp className="w-4 h-4" /> },
  { key: 'stock', label: 'المخزون', icon: <Package className="w-4 h-4" /> },
  { key: 'debts', label: 'الديون', icon: <Users className="w-4 h-4" /> },
  { key: 'expenses', label: 'المصروفات', icon: <Receipt className="w-4 h-4" /> },
];

const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const PAYMENT_LABELS: Record<string, string> = {
  cash: 'نقداً',
  card: 'شبكة / بطاقة',
  credit: 'آجل (دين)',
  mixed: 'نقد + شبكة',
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

function Card({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-2xl border border-slate-200 p-5 ${className}`}>
      {title && <h3 className="text-base font-bold text-slate-900 mb-4">{title}</h3>}
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-slate-400 text-center py-8">{text}</p>;
}

function BarList({
  rows,
  format: fmt,
  color = 'bg-indigo-500',
}: {
  rows: { label: string; value: number; hint?: string }[];
  format: (n: number) => string;
  color?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <div className="space-y-3">
      {rows.map((r, i) => (
        <div key={`${r.label}-${i}`}>
          <div className="flex justify-between gap-3 text-sm mb-1">
            <span className="font-bold text-slate-700 truncate">{r.label}</span>
            <span className="font-black text-slate-900 tabular-nums shrink-0">{fmt(r.value)}</span>
          </div>
          <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${r.value < 0 ? 'bg-rose-500' : color}`}
              style={{ width: `${Math.max(2, (Math.abs(r.value) / max) * 100)}%` }}
            />
          </div>
          {r.hint && <p className="text-xs text-slate-400 mt-1">{r.hint}</p>}
        </div>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone = 'slate',
  icon,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  tone?: 'slate' | 'green' | 'red' | 'amber' | 'indigo';
  icon?: ReactNode;
}) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-50 text-slate-600 border-slate-200',
    green: 'bg-emerald-50 text-emerald-600 border-emerald-200',
    red: 'bg-rose-50 text-rose-600 border-rose-200',
    amber: 'bg-amber-50 text-amber-600 border-amber-200',
    indigo: 'bg-indigo-50 text-indigo-600 border-indigo-200',
  };
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 flex items-start gap-4">
      {icon && (
        <div className={`w-11 h-11 rounded-xl border flex items-center justify-center shrink-0 ${tones[tone]}`}>
          {icon}
        </div>
      )}
      <div className="min-w-0">
        <p className="text-xs font-bold text-slate-500 mb-1">{label}</p>
        <p className="text-xl font-black text-slate-900 tabular-nums">{value}</p>
        {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
      </div>
    </div>
  );
}

function Change({ now, before }: { now: number; before: number }) {
  if (!before) return <span className="text-slate-400">لا توجد فترة سابقة للمقارنة</span>;
  const pct = ((now - before) / Math.abs(before)) * 100;
  const up = pct >= 0;
  return (
    <span className={`inline-flex items-center gap-1 font-bold ${up ? 'text-emerald-600' : 'text-rose-600'}`}>
      {up ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
      {Math.abs(pct).toFixed(0)}% {up ? 'أعلى' : 'أقل'} من الفترة السابقة
    </span>
  );
}

export default function SimpleReports() {
  const settings = useSettings();
  const decimals = settings.currencyDecimals ?? 2;
  const currency = settings.currency || '';
  const money = (n: number) => `${formatNumber(n, decimals)} ${currency}`.trim();

  const orders = useLiveQuery(() => db.orders.toArray()) || [];
  const orderItems = useLiveQuery(() => db.orderItems.toArray()) || [];
  const returns = useLiveQuery(() => db.returns.toArray()) || [];
  const returnItems = useLiveQuery(() => db.returnItems.toArray()) || [];
  const expenses = useLiveQuery(() => db.expenses.toArray()) || [];
  const payrolls = useLiveQuery(() => db.payroll.toArray()) || [];
  const products = useLiveQuery(() => db.products.toArray()) || [];
  const categories = useLiveQuery(() => db.categories.toArray()) || [];
  const batches = useLiveQuery(() => db.inventoryBatches.toArray()) || [];
  const customers = useLiveQuery(() => db.customers.toArray()) || [];
  const suppliers = useLiveQuery(() => db.suppliers.toArray()) || [];
  const accounts = useLiveQuery(() => db.accounts.toArray()) || [];
  const journalEntries = useLiveQuery(() => db.journalEntries.toArray()) || [];
  const transactions = useLiveQuery(() => db.transactions.toArray()) || [];

  const [period, setPeriod] = useState<PeriodKey>('today');
  const [subTab, setSubTab] = useState<SubTab>('summary');
  const [from, setFrom] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [to, setTo] = useState(format(new Date(), 'yyyy-MM-dd'));

  const data = useMemo(() => {
    const now = new Date();
    let start = startOfDay(now);
    let end = endOfDay(now);
    if (period === 'yesterday') {
      start = startOfDay(subDays(now, 1));
      end = endOfDay(subDays(now, 1));
    } else if (period === 'last7') {
      start = startOfDay(subDays(now, 6));
    } else if (period === 'thisMonth') {
      start = startOfMonth(now);
      end = endOfDay(endOfMonth(now));
    } else if (period === 'lastMonth') {
      const lm = subMonths(now, 1);
      start = startOfMonth(lm);
      end = endOfDay(endOfMonth(lm));
    } else if (period === 'custom') {
      start = startOfDay(new Date(from));
      end = endOfDay(new Date(to));
    }
    if (end < start) end = endOfDay(start);

    const days = Math.max(1, differenceInCalendarDays(end, start) + 1);
    const prevEnd = endOfDay(subDays(start, 1));
    const prevStart = startOfDay(subDays(start, days));

    const productById = new Map(products.map((p) => [p.id as number, p]));
    const categoryName = new Map(categories.map((c) => [c.id as number, c.name]));
    const validOrders = orders.filter((o) => o.status !== 'void');
    const orderById = new Map(validOrders.map((o) => [o.id as string, o]));

    // Cost of damaged returned goods is a loss, not a cost reversal.
    const damagedCostByReturn = new Map<string, number>();
    for (const ri of returnItems) {
      if (ri.condition === 'damaged') {
        damagedCostByReturn.set(
          ri.returnId,
          (damagedCostByReturn.get(ri.returnId) || 0) + num(ri.costPrice) * num(ri.quantity)
        );
      }
    }

    const compute = (s: Date, e: Date) => {
      const inR = (iso?: string | null) => {
        if (!iso) return false;
        const t = new Date(iso).getTime();
        return t >= s.getTime() && t <= e.getTime();
      };
      const ords = validOrders.filter((o) => inR(o.createdAt));
      const ids = new Set(ords.map((o) => o.id));
      const items = orderItems.filter((i) => ids.has(i.orderId));
      const rets = returns.filter((r) => inR(r.createdAt));

      const salesExcl = ords.reduce((t, o) => t + num(o.netAmount) - num(o.taxAmount), 0);
      const returnsExcl = rets.reduce((t, r) => t + num(r.totalRefund) - num(r.taxAmount), 0);
      const returnsTotal = rets.reduce((t, r) => t + num(r.totalRefund), 0);
      const sales = salesExcl - returnsExcl;

      const grossCost = items.reduce((t, i) => t + num(i.costPriceAtTimeOfSale) * num(i.quantity), 0);
      const returnedCost = rets.reduce(
        (t, r) => t + Math.max(0, num(r.totalCostReversed) - (damagedCostByReturn.get(r.id) || 0)),
        0
      );
      const cost = Math.max(0, grossCost - returnedCost);

      const exp = expenses.filter((x) => inR(x.date)).reduce((t, x) => t + num(x.amount), 0);
      const pay = payrolls.filter((x) => inR(x.paymentDate)).reduce((t, x) => t + num(x.netSalary), 0);

      const stocktakeIds = new Set(
        journalEntries.filter((j) => j.referenceType === 'stocktake' && inR(j.date)).map((j) => j.id)
      );
      const stocktakeLoss = transactions
        .filter((t) => t.accountId === '5400' && stocktakeIds.has(t.journalEntryId))
        .reduce((t, x) => t + num(x.debit) - num(x.credit), 0);
      const damagedLoss = rets.reduce((t, r) => t + (damagedCostByReturn.get(r.id) || 0), 0);
      const otherLosses = stocktakeLoss + damagedLoss;

      const gross = sales - cost;
      const net = gross - exp - pay - otherLosses;
      return {
        ords,
        items,
        rets,
        sales,
        returnsTotal,
        cost,
        gross,
        exp,
        pay,
        otherLosses,
        net,
        discounts: ords.reduce((t, o) => t + num(o.discountAmount), 0),
      };
    };

    const cur = compute(start, end);
    const prev = compute(prevStart, prevEnd);

    // ---- Sales breakdowns ----
    const daily: { name: string; sales: number }[] = [];
    const dayCount = Math.min(days, 62);
    for (let i = 0; i < dayCount; i++) {
      const d = addDays(start, i);
      const ds = startOfDay(d).getTime();
      const de = endOfDay(d).getTime();
      const v = cur.ords
        .filter((o) => {
          const t = new Date(o.createdAt).getTime();
          return t >= ds && t <= de;
        })
        .reduce((t, o) => t + num(o.netAmount) - num(o.taxAmount), 0);
      daily.push({ name: dayCount > 10 ? format(d, 'd/M') : WEEKDAYS[d.getDay()], sales: round2(v) });
    }

    const byPayment: Record<string, number> = {};
    cur.ords.forEach((o) => {
      if (o.paymentMethod === 'mixed') {
        byPayment.cash = (byPayment.cash || 0) + num(o.cashAmount);
        byPayment.card = (byPayment.card || 0) + num(o.cardAmount);
      } else {
        byPayment[o.paymentMethod] = (byPayment[o.paymentMethod] || 0) + num(o.netAmount);
      }
    });

    const byWeekday = new Array(7).fill(0);
    const byHour = new Array(24).fill(0);
    const byCashier: Record<string, { total: number; count: number }> = {};
    cur.ords.forEach((o) => {
      const d = new Date(o.createdAt);
      byWeekday[d.getDay()] += num(o.netAmount);
      byHour[d.getHours()] += num(o.netAmount);
      const who = o.createdBy || 'غير معروف';
      byCashier[who] = byCashier[who] || { total: 0, count: 0 };
      byCashier[who].total += num(o.netAmount);
      byCashier[who].count += 1;
    });

    // ---- Product profit ----
    const perProduct = new Map<number, { name: string; qty: number; revenue: number; cost: number; categoryId?: number }>();
    cur.items.forEach((i) => {
      const qty = num(i.quantity);
      if (qty <= 0) return;
      const keep = Math.max(0, qty - num(i.returnedQuantity)) / qty;
      const row = perProduct.get(i.productId) || {
        name: i.productName,
        qty: 0,
        revenue: 0,
        cost: 0,
        categoryId: productById.get(i.productId)?.categoryId,
      };
      row.qty += qty * keep;
      row.revenue += (num(i.total) - num(i.taxAmount)) * keep;
      row.cost += num(i.costPriceAtTimeOfSale) * qty * keep;
      perProduct.set(i.productId, row);
    });
    const productRows = Array.from(perProduct.values()).map((r) => ({ ...r, profit: r.revenue - r.cost }));
    const byQty = [...productRows].sort((a, b) => b.qty - a.qty).slice(0, 10);
    const byProfit = [...productRows].sort((a, b) => b.profit - a.profit).slice(0, 10);
    const losing = productRows.filter((r) => r.profit < -0.005).sort((a, b) => a.profit - b.profit);
    const lowMargin = productRows
      .filter((r) => r.revenue > 0 && r.profit >= 0 && r.profit / r.revenue < 0.1)
      .sort((a, b) => a.profit / a.revenue - b.profit / b.revenue)
      .slice(0, 8);

    const perCategory: Record<string, number> = {};
    productRows.forEach((r) => {
      const name = (r.categoryId !== undefined && categoryName.get(r.categoryId)) || 'بدون تصنيف';
      perCategory[name] = (perCategory[name] || 0) + r.profit;
    });

    // ---- Stock ----
    const stockProducts = products.filter(
      (p) => (!p.itemType || p.itemType === 'stock') && p.isActive !== 0
    );
    const batchValue = batches.reduce((t, b) => t + Math.max(0, num(b.remainingQuantity)) * num(b.costPrice), 0);
    const fallbackValue = stockProducts.reduce(
      (t, p) => t + Math.max(0, num(p.stockQuantity)) * num(p.costPrice),
      0
    );
    const stockCost = batches.length > 0 ? batchValue : fallbackValue;
    const stockRetail = stockProducts.reduce(
      (t, p) => t + Math.max(0, num(p.stockQuantity)) * num(p.sellingPrice),
      0
    );
    const outOfStock = stockProducts.filter((p) => num(p.stockQuantity) <= 0);
    const lowStock = stockProducts.filter(
      (p) => num(p.stockQuantity) > 0 && num(p.stockQuantity) <= num(p.minStockLevel ?? 10)
    );

    const lastSold = new Map<number, number>();
    const itemsByOrder = orderItems;
    itemsByOrder.forEach((i) => {
      const o = orderById.get(i.orderId);
      if (!o) return;
      const t = new Date(o.createdAt).getTime();
      if (t > (lastSold.get(i.productId) || 0)) lastSold.set(i.productId, t);
    });
    const cutoff = subDays(now, 30).getTime();
    const slow = stockProducts
      .filter((p) => num(p.stockQuantity) > 0 && (lastSold.get(p.id as number) || 0) < cutoff)
      .map((p) => ({
        name: p.name,
        value: num(p.stockQuantity) * num(p.costPrice),
        qty: num(p.stockQuantity),
        last: lastSold.get(p.id as number),
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    const soon = addDays(now, 30).getTime();
    const expiring = batches
      .filter((b) => b.expiryDate && num(b.remainingQuantity) > 0 && new Date(b.expiryDate).getTime() <= soon)
      .map((b) => ({
        name: productById.get(b.productId)?.name || `صنف ${b.productId}`,
        qty: num(b.remainingQuantity),
        date: new Date(b.expiryDate as string),
      }))
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .slice(0, 12);

    // ---- Debts ----
    const owedToMe = customers
      .filter((c) => num(c.balance) > 0.005)
      .sort((a, b) => num(b.balance) - num(a.balance));
    const iOwe = suppliers
      .filter((s) => num(s.balance) > 0.005)
      .sort((a, b) => num(b.balance) - num(a.balance));
    const totalOwedToMe = owedToMe.reduce((t, c) => t + num(c.balance), 0);
    const totalIOwe = iOwe.reduce((t, s) => t + num(s.balance), 0);

    // ---- Expenses ----
    const curExpenses = expenses.filter((x) => {
      const t = new Date(x.date).getTime();
      return t >= start.getTime() && t <= end.getTime();
    });
    const expByCategory: Record<string, number> = {};
    curExpenses.forEach((x) => {
      const k = x.category || 'أخرى';
      expByCategory[k] = (expByCategory[k] || 0) + num(x.amount);
    });
    const curPayrolls = payrolls
      .filter((x) => {
        const t = new Date(x.paymentDate).getTime();
        return t >= start.getTime() && t <= end.getTime();
      })
      .reduce((t, x) => t + num(x.netSalary), 0);
    if (curPayrolls > 0) expByCategory['الرواتب'] = (expByCategory['الرواتب'] || 0) + curPayrolls;

    // ---- Money position (from ledger balances when available) ----
    const acc = (code: string) => accounts.find((a) => a.code === code);
    const cashBal = acc('1010') ? num(acc('1010')!.balance) : null;
    const bankBal = acc('1020') ? num(acc('1020')!.balance) : null;
    const vatBal = acc('2200') ? num(acc('2200')!.balance) : 0;

    return {
      start,
      end,
      days,
      cur,
      prev,
      daily,
      byPayment,
      byWeekday,
      byHour,
      byCashier,
      byQty,
      byProfit,
      losing,
      lowMargin,
      perCategory,
      stockCost,
      stockRetail,
      outOfStock,
      lowStock,
      slow,
      expiring,
      owedToMe,
      iOwe,
      totalOwedToMe,
      totalIOwe,
      expByCategory,
      expCurrentList: [...curExpenses].sort((a, b) => num(b.amount) - num(a.amount)).slice(0, 10),
      cashBal,
      bankBal,
      vatBal,
    };
  }, [
    period,
    from,
    to,
    orders,
    orderItems,
    returns,
    returnItems,
    expenses,
    payrolls,
    products,
    categories,
    batches,
    customers,
    suppliers,
    accounts,
    journalEntries,
    transactions,
  ]);

  const d = data;
  const c = d.cur;
  const hasData = c.ords.length > 0 || c.rets.length > 0 || c.exp > 0;

  // ---- Plain-language tips ----
  const tips: { tone: 'red' | 'amber' | 'green'; text: string }[] = [];
  if (hasData) {
    if (c.net < 0) tips.push({ tone: 'red', text: `أنت تخسر في هذه الفترة: المصروفات والتكاليف أكبر من المبيعات بمقدار ${money(Math.abs(c.net))}.` });
    else if (c.sales > 0) tips.push({ tone: 'green', text: `ربحك الصافي في هذه الفترة ${money(c.net)}، أي حوالي ${((c.net / c.sales) * 100).toFixed(0)}% من المبيعات.` });
    if (c.sales > 0 && (c.exp + c.pay) / c.sales > 0.4)
      tips.push({ tone: 'amber', text: 'المصروفات والرواتب تستهلك أكثر من 40% من مبيعاتك، راجع تبويب «المصروفات».' });
    if (c.discounts > 0 && c.sales > 0 && c.discounts / (c.sales + c.discounts) > 0.1)
      tips.push({ tone: 'amber', text: `الخصومات التي منحتها ${money(c.discounts)} وهي مرتفعة نسبياً.` });
  }
  if (d.losing.length > 0)
    tips.push({ tone: 'red', text: `${d.losing.length} صنف تم بيعه بأقل من تكلفته في هذه الفترة، راجع تبويب «الأرباح».` });
  if (d.outOfStock.length > 0)
    tips.push({ tone: 'amber', text: `${d.outOfStock.length} صنف نفدت كميته من المخزون.` });
  if (d.lowStock.length > 0)
    tips.push({ tone: 'amber', text: `${d.lowStock.length} صنف على وشك النفاد.` });
  if (d.expiring.length > 0)
    tips.push({ tone: 'red', text: `${d.expiring.length} دفعة منتهية أو ستنتهي صلاحيتها خلال 30 يوماً.` });
  if (d.totalOwedToMe > 0)
    tips.push({ tone: 'amber', text: `العملاء مدينون لك بمبلغ ${money(d.totalOwedToMe)}.` });

  const toneBox: Record<string, string> = {
    red: 'bg-rose-50 border-rose-200 text-rose-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    green: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  };

  const rangeLabel =
    d.days === 1
      ? format(d.start, 'yyyy/MM/dd')
      : `${format(d.start, 'yyyy/MM/dd')} - ${format(d.end, 'yyyy/MM/dd')}`;

  const totalAssets =
    (d.cashBal ?? 0) + (d.bankBal ?? 0) + d.totalOwedToMe + d.stockCost;
  const totalLiabilities = d.totalIOwe + Math.max(0, d.vatBal);

  return (
    <div className="space-y-5 tabular-nums">
      {/* Period filter */}
      <div className="flex flex-wrap items-center gap-2 bg-white p-2 rounded-2xl border border-slate-200">
        <Calendar className="w-4 h-4 text-slate-400 mx-2" />
        {PERIODS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-colors ${
              period === p.key ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            {p.label}
          </button>
        ))}
        <span className="text-xs text-slate-400 mr-auto px-2">{rangeLabel}</span>
      </div>

      {period === 'custom' && (
        <div className="flex flex-wrap items-center gap-4 bg-white p-4 rounded-2xl border border-slate-200">
          <label className="text-xs font-bold text-slate-500 flex items-center gap-2">
            من
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-xl text-sm" />
          </label>
          <label className="text-xs font-bold text-slate-500 flex items-center gap-2">
            إلى
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-xl text-sm" />
          </label>
        </div>
      )}

      {/* Sub tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {SUB_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setSubTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold whitespace-nowrap border transition-colors ${
              subTab === t.key
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* ================= SUMMARY ================= */}
      {subTab === 'summary' && (
        <>
          <div
            className={`rounded-3xl p-6 border ${
              c.net >= 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'
            }`}
          >
            <p className="text-sm font-bold text-slate-600 mb-1">
              {c.net >= 0 ? 'كم ربحت في هذه الفترة؟' : 'كم خسرت في هذه الفترة؟'}
            </p>
            <p className={`text-4xl font-black ${c.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
              {money(Math.abs(c.net))}
            </p>
            <p className="text-xs mt-2 text-slate-500">
              <Change now={c.net} before={d.prev.net} />
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Stat label="كم بعت؟" value={money(c.sales)} tone="indigo" icon={<ShoppingBag className="w-5 h-5" />}
              sub={<><Change now={c.sales} before={d.prev.sales} /><br />{c.ords.length} فاتورة</>} />
            <Stat label="كم كلفتني البضاعة؟" value={money(c.cost)} tone="amber" icon={<Package className="w-5 h-5" />}
              sub="سعر شراء ما بعته" />
            <Stat label="ربح البيع" value={money(c.gross)} tone="green" icon={<TrendingUp className="w-5 h-5" />}
              sub="المبيعات − تكلفة البضاعة" />
            <Stat label="المصروفات والرواتب" value={money(c.exp + c.pay + c.otherLosses)} tone="red" icon={<Receipt className="w-5 h-5" />}
              sub={c.otherLosses > 0 ? `منها خسائر جرد/تالف ${money(c.otherLosses)}` : 'إيجار، كهرباء، رواتب...'} />
          </div>

          {c.sales > 0 && (
            <Card title="كل 100 من المبيعات، أين تذهب؟">
              {(() => {
                const costPct = Math.max(0, (c.cost / c.sales) * 100);
                const expPct = Math.max(0, ((c.exp + c.pay + c.otherLosses) / c.sales) * 100);
                const profitPct = (c.net / c.sales) * 100;
                return (
                  <>
                    <div className="flex h-6 rounded-full overflow-hidden bg-slate-100">
                      <div className="bg-amber-400" style={{ width: `${Math.min(100, costPct)}%` }} />
                      <div className="bg-rose-400" style={{ width: `${Math.min(100 - Math.min(100, costPct), expPct)}%` }} />
                      {profitPct > 0 && <div className="bg-emerald-500" style={{ width: `${Math.min(100, profitPct)}%` }} />}
                    </div>
                    <div className="flex flex-wrap gap-4 mt-3 text-xs font-bold">
                      <span className="text-amber-600">● بضاعة {costPct.toFixed(0)}</span>
                      <span className="text-rose-600">● مصروفات {expPct.toFixed(0)}</span>
                      <span className="text-emerald-600">● ربح {profitPct.toFixed(0)}</span>
                    </div>
                  </>
                );
              })()}
            </Card>
          )}

          <Card title="ما لك وما عليك (الوضع الحالي)">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <p className="text-sm font-black text-emerald-700 mb-3">لك</p>
                <div className="space-y-2 text-sm">
                  {d.cashBal !== null && <Row label="نقد في الصندوق" value={money(d.cashBal)} />}
                  {d.bankBal !== null && <Row label="في البنك / الشبكة" value={money(d.bankBal)} />}
                  <Row label="ديون العملاء عليك تحصيلها" value={money(d.totalOwedToMe)} />
                  <Row label="بضاعة في المخزن (بسعر الشراء)" value={money(d.stockCost)} />
                  <Row label="الإجمالي" value={money(totalAssets)} bold />
                </div>
              </div>
              <div>
                <p className="text-sm font-black text-rose-700 mb-3">عليك</p>
                <div className="space-y-2 text-sm">
                  <Row label="مستحق للموردين" value={money(d.totalIOwe)} />
                  {d.vatBal > 0 && <Row label="ضريبة مستحقة للدولة" value={money(d.vatBal)} />}
                  <Row label="الإجمالي" value={money(totalLiabilities)} bold />
                </div>
                <div className="mt-5 p-4 rounded-xl bg-slate-50 border border-slate-200">
                  <p className="text-xs font-bold text-slate-500">صافي ما تملكه تقريباً</p>
                  <p className="text-xl font-black text-slate-900">{money(totalAssets - totalLiabilities)}</p>
                </div>
              </div>
            </div>
            <p className="text-xs text-slate-400 mt-4">
              هذه صورة تقريبية مبنية على الأرصدة المسجلة، وهي لا تشمل المعدات أو الأصول الثابتة.
            </p>
          </Card>

          {tips.length > 0 && (
            <Card title="ملاحظات تهمك">
              <div className="space-y-2">
                {tips.map((t, i) => (
                  <div key={i} className={`flex items-start gap-3 p-3 rounded-xl border text-sm font-bold ${toneBox[t.tone]}`}>
                    {t.tone === 'green' ? <Lightbulb className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
                    <span>{t.text}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
          {!hasData && <Empty text="لا توجد عمليات في هذه الفترة. جرّب اختيار فترة أخرى." />}
        </>
      )}

      {/* ================= SALES ================= */}
      {subTab === 'sales' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Stat label="إجمالي المبيعات (بعد المرتجعات)" value={money(c.sales)} tone="indigo" icon={<ShoppingBag className="w-5 h-5" />} sub={<Change now={c.sales} before={d.prev.sales} />} />
            <Stat label="عدد الفواتير" value={String(c.ords.length)} tone="slate" icon={<Receipt className="w-5 h-5" />}
              sub={c.ords.length > 0 ? `متوسط الفاتورة ${money(c.sales / c.ords.length)}` : undefined} />
            <Stat label="المرتجعات" value={money(c.returnsTotal)} tone="red" icon={<TrendingDown className="w-5 h-5" />} sub={`${c.rets.length} عملية إرجاع`} />
          </div>

          <Card title="المبيعات يوماً بيوم">
            {d.daily.every((x) => x.sales === 0) ? (
              <Empty text="لا توجد مبيعات في هذه الفترة" />
            ) : (
              <div className="h-64" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.daily} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} width={55} />
                    <Tooltip formatter={(v: any) => [money(Number(v)), 'المبيعات']} />
                    <Bar dataKey="sales" fill="#4f46e5" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Card title="كيف دفع العملاء؟">
              {Object.keys(d.byPayment).length === 0 ? (
                <Empty text="لا توجد بيانات" />
              ) : (
                <BarList
                  format={money}
                  rows={Object.entries(d.byPayment).map(([k, v]) => ({
                    label: `${k === 'cash' ? '💵 ' : k === 'card' ? '💳 ' : '📒 '}${PAYMENT_LABELS[k] || k}`,
                    value: round2(v),
                  }))}
                />
              )}
            </Card>
            <Card title="أفضل أيام الأسبوع">
              {d.byWeekday.every((v: number) => v === 0) ? (
                <Empty text="لا توجد بيانات" />
              ) : (
                <BarList
                  format={money}
                  color="bg-emerald-500"
                  rows={d.byWeekday
                    .map((v: number, i: number) => ({ label: WEEKDAYS[i], value: round2(v) }))
                    .sort((a: any, b: any) => b.value - a.value)}
                />
              )}
            </Card>
            <Card title="أوقات الذروة في اليوم">
              {d.byHour.every((v: number) => v === 0) ? (
                <Empty text="لا توجد بيانات" />
              ) : (
                <BarList
                  format={money}
                  color="bg-amber-500"
                  rows={d.byHour
                    .map((v: number, h: number) => ({
                      label: `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'صباحاً' : 'مساءً'}`,
                      value: round2(v),
                    }))
                    .filter((r: any) => r.value > 0)
                    .sort((a: any, b: any) => b.value - a.value)
                    .slice(0, 6)}
                />
              )}
            </Card>
            <Card title="المبيعات حسب الموظف">
              {Object.keys(d.byCashier).length === 0 ? (
                <Empty text="لا توجد بيانات" />
              ) : (
                <BarList
                  format={money}
                  color="bg-sky-500"
                  rows={Object.entries(d.byCashier)
                    .map(([name, v]) => ({ label: name, value: round2(v.total), hint: `${v.count} فاتورة` }))
                    .sort((a, b) => b.value - a.value)}
                />
              )}
            </Card>
          </div>

          <Card title="الأصناف الأكثر مبيعاً (بالكمية)">
            {d.byQty.length === 0 ? (
              <Empty text="لا توجد مبيعات في هذه الفترة" />
            ) : (
              <BarList
                format={(n) => formatQty(n, 2)}
                color="bg-indigo-500"
                rows={d.byQty.map((r) => ({ label: r.name, value: r.qty }))}
              />
            )}
          </Card>
        </>
      )}

      {/* ================= PROFIT ================= */}
      {subTab === 'profit' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Stat label="ربح البيع" value={money(c.gross)} tone="green" icon={<TrendingUp className="w-5 h-5" />} sub={<Change now={c.gross} before={d.prev.gross} />} />
            <Stat label="هامش الربح" value={c.sales > 0 ? `${((c.gross / c.sales) * 100).toFixed(1)}%` : '—'} tone="indigo" icon={<PiggyBank className="w-5 h-5" />}
              sub="من كل 100 تبيعها كم تبقى بعد ثمن البضاعة" />
            <Stat label="الربح الصافي" value={money(c.net)} tone={c.net >= 0 ? 'green' : 'red'} icon={<Wallet className="w-5 h-5" />} sub="بعد المصروفات والرواتب" />
          </div>

          {d.losing.length > 0 && (
            <Card title="⚠ أصناف بعتها بخسارة" className="border-rose-200">
              <p className="text-xs text-slate-500 mb-3">سعر بيعها أقل من سعر شرائها. راجع الأسعار أو الخصومات.</p>
              <BarList format={money} rows={d.losing.slice(0, 10).map((r) => ({ label: r.name, value: round2(r.profit) }))} />
            </Card>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Card title="الأصناف الأكثر ربحاً">
              {d.byProfit.length === 0 ? (
                <Empty text="لا توجد مبيعات" />
              ) : (
                <BarList format={money} color="bg-emerald-500" rows={d.byProfit.map((r) => ({ label: r.name, value: round2(r.profit) }))} />
              )}
            </Card>
            <Card title="الربح حسب التصنيف">
              {Object.keys(d.perCategory).length === 0 ? (
                <Empty text="لا توجد بيانات" />
              ) : (
                <BarList
                  format={money}
                  color="bg-teal-500"
                  rows={Object.entries(d.perCategory)
                    .map(([label, v]) => ({ label, value: round2(v) }))
                    .sort((a, b) => b.value - a.value)}
                />
              )}
            </Card>
          </div>

          {d.lowMargin.length > 0 && (
            <Card title="أصناف ربحها ضعيف (أقل من 10%)">
              <BarList
                format={(n) => `${n.toFixed(1)}%`}
                color="bg-amber-500"
                rows={d.lowMargin.map((r) => ({ label: r.name, value: (r.profit / r.revenue) * 100 }))}
              />
            </Card>
          )}
        </>
      )}

      {/* ================= STOCK ================= */}
      {subTab === 'stock' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Stat label="قيمة البضاعة بسعر الشراء" value={money(d.stockCost)} tone="amber" icon={<Package className="w-5 h-5" />} />
            <Stat label="قيمتها لو بعتها كلها" value={money(d.stockRetail)} tone="indigo" icon={<Banknote className="w-5 h-5" />} sub="بأسعار البيع الحالية (شامل الضريبة)" />
            <Stat label="أصناف تحتاج انتباه" value={String(d.outOfStock.length + d.lowStock.length)} tone="red" icon={<AlertTriangle className="w-5 h-5" />}
              sub={`${d.outOfStock.length} نافدة · ${d.lowStock.length} قاربت النفاد`} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Card title="نافدة أو قاربت على النفاد">
              {d.outOfStock.length + d.lowStock.length === 0 ? (
                <Empty text="كل الأصناف متوفرة بكميات جيدة 👍" />
              ) : (
                <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                  {[...d.outOfStock.slice(0, 15), ...d.lowStock.slice(0, 15)].map((p) => (
                    <div key={p.id} className="flex justify-between py-2 text-sm">
                      <span className="font-bold text-slate-700">{p.name}</span>
                      <span className={`font-black ${num(p.stockQuantity) <= 0 ? 'text-rose-600' : 'text-amber-600'}`}>
                        {num(p.stockQuantity) <= 0 ? 'نفدت' : `متبقي ${formatQty(num(p.stockQuantity), 2)}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="بضاعة راكدة (لم تُبع منذ 30 يوماً)">
              {d.slow.length === 0 ? (
                <Empty text="لا توجد بضاعة راكدة" />
              ) : (
                <>
                  <p className="text-xs text-slate-500 mb-3">أموالك المحبوسة في هذه الأصناف، فكّر في عرض أو تخفيض.</p>
                  <BarList
                    format={money}
                    color="bg-slate-500"
                    rows={d.slow.map((r) => ({
                      label: r.name,
                      value: round2(r.value),
                      hint: `${formatQty(r.qty, 2)} قطعة · ${r.last ? `آخر بيع ${format(new Date(r.last), 'yyyy/MM/dd')}` : 'لم يُبع من قبل'}`,
                    }))}
                  />
                </>
              )}
            </Card>
          </div>

          <Card title="قاربت صلاحيتها على الانتهاء (30 يوماً)">
            {d.expiring.length === 0 ? (
              <Empty text="لا توجد بضاعة قريبة من الانتهاء" />
            ) : (
              <div className="divide-y divide-slate-100">
                {d.expiring.map((e, i) => {
                  const left = differenceInCalendarDays(e.date, new Date());
                  return (
                    <div key={i} className="flex justify-between items-center py-2 text-sm">
                      <span className="font-bold text-slate-700">{e.name}</span>
                      <span className="text-slate-500">{formatQty(e.qty, 2)} قطعة</span>
                      <span className={`font-black ${left < 0 ? 'text-rose-600' : 'text-amber-600'}`}>
                        {left < 0 ? `منتهية منذ ${Math.abs(left)} يوم` : `تنتهي بعد ${left} يوم`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}

      {/* ================= DEBTS ================= */}
      {subTab === 'debts' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Stat label="العملاء مدينون لك" value={money(d.totalOwedToMe)} tone="amber" icon={<Users className="w-5 h-5" />} sub={`${d.owedToMe.length} عميل`} />
            <Stat label="أنت مدين للموردين" value={money(d.totalIOwe)} tone="red" icon={<CreditCard className="w-5 h-5" />} sub={`${d.iOwe.length} مورد`} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Card title="من يجب أن يدفع لك؟">
              {d.owedToMe.length === 0 ? (
                <Empty text="لا توجد ديون على العملاء" />
              ) : (
                <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
                  {d.owedToMe.slice(0, 30).map((x) => (
                    <div key={x.id} className="flex justify-between items-center py-2.5 text-sm">
                      <div>
                        <p className="font-bold text-slate-700">{x.name}</p>
                        {x.phone && <p className="text-xs text-slate-400" dir="ltr">{x.phone}</p>}
                      </div>
                      <span className="font-black text-amber-600">{money(num(x.balance))}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="لمن يجب أن تدفع؟">
              {d.iOwe.length === 0 ? (
                <Empty text="لا توجد مستحقات للموردين" />
              ) : (
                <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
                  {d.iOwe.slice(0, 30).map((x) => (
                    <div key={x.id} className="flex justify-between items-center py-2.5 text-sm">
                      <div>
                        <p className="font-bold text-slate-700">{x.name}</p>
                        {x.phone && <p className="text-xs text-slate-400" dir="ltr">{x.phone}</p>}
                      </div>
                      <span className="font-black text-rose-600">{money(num(x.balance))}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      )}

      {/* ================= EXPENSES ================= */}
      {subTab === 'expenses' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Stat label="إجمالي المصروفات والرواتب" value={money(c.exp + c.pay)} tone="red" icon={<Receipt className="w-5 h-5" />} sub={<Change now={c.exp + c.pay} before={d.prev.exp + d.prev.pay} />} />
            <Stat label="نسبتها من المبيعات" value={c.sales > 0 ? `${(((c.exp + c.pay) / c.sales) * 100).toFixed(1)}%` : '—'} tone="amber" icon={<Clock className="w-5 h-5" />} />
            <Stat label="متوسط المصروف اليومي" value={money((c.exp + c.pay) / d.days)} tone="slate" icon={<Calendar className="w-5 h-5" />} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Card title="أين ذهبت المصروفات؟">
              {Object.keys(d.expByCategory).length === 0 ? (
                <Empty text="لا توجد مصروفات في هذه الفترة" />
              ) : (
                <BarList
                  format={money}
                  color="bg-rose-500"
                  rows={Object.entries(d.expByCategory)
                    .map(([label, v]) => ({ label, value: round2(v) }))
                    .sort((a, b) => b.value - a.value)}
                />
              )}
            </Card>
            <Card title="أكبر المصروفات">
              {d.expCurrentList.length === 0 ? (
                <Empty text="لا توجد مصروفات" />
              ) : (
                <div className="divide-y divide-slate-100">
                  {d.expCurrentList.map((x, i) => (
                    <div key={x.id ?? i} className="flex justify-between py-2.5 text-sm">
                      <div>
                        <p className="font-bold text-slate-700">{x.description || x.category}</p>
                        <p className="text-xs text-slate-400">{format(new Date(x.date), 'yyyy/MM/dd')} · {x.category}</p>
                      </div>
                      <span className="font-black text-rose-600">{money(num(x.amount))}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${bold ? 'pt-2 border-t border-slate-200 font-black text-slate-900' : 'text-slate-600'}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
