import { useState, useMemo, useEffect } from 'react';
import { formatAmount } from '../utils/numberFormat.js';
import { getHistoricalCostAmount } from '../utils/inventoryUnits.js';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, Order, Purchase } from '../db/db';
import {
  format,
  isWithinInterval,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
} from 'date-fns';
import { FileText, Activity, BookOpen, Calendar, Receipt, Scale, Download } from 'lucide-react';
import { apiService } from '../services/apiService';

interface FinancialReportProps {
  onViewReceipt?: (order: Order) => void;
  onViewPurchase?: (purchase: Purchase) => void;
}

export default function FinancialReport({ onViewReceipt, onViewPurchase }: FinancialReportProps) {
  const [activeSubTab, setActiveSubTab] = useState<'trialBalance' | 'balanceSheet' | 'invoices' | 'ledger' | 'audit'>(
    'trialBalance'
  );
  const [dateFilter, setDateFilter] = useState<'today' | 'thisWeek' | 'thisMonth' | 'all' | 'custom'>('thisMonth');
  const [customStartDate, setCustomStartDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [customEndDate, setCustomEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [serverReport, setServerReport] = useState<any | null>(null);

  const orders = useLiveQuery(() => db.orders.toArray()) || [];
  const orderItems = useLiveQuery(() => db.orderItems.toArray()) || [];
  const returns = useLiveQuery(() => db.returns.toArray()) || [];
  const purchases = useLiveQuery(() => db.purchases.toArray()) || [];
  const purchaseReturns = useLiveQuery(() => db.purchaseReturns.toArray()) || [];
  const auditLogs = useLiveQuery(() => db.auditLogs.toArray()) || [];
  const expenses = useLiveQuery(() => db.expenses.toArray()) || [];
  const products = useLiveQuery(() => db.products.toArray()) || [];
  const inventoryBatches = useLiveQuery(() => db.inventoryBatches.toArray()) || [];
  const payrolls = useLiveQuery(() => db.payroll.toArray()) || [];
  const journalEntries = useLiveQuery(() => db.journalEntries.toArray()) || [];
  const transactions = useLiveQuery(() => db.transactions.toArray()) || [];
  const accounts = useLiveQuery(() => db.accounts.toArray()) || [];

  const getDateRange = () => {
    const now = new Date();
    let start = new Date(0);
    let end = new Date(8640000000000000);

    if (dateFilter === 'today') {
      start = startOfDay(now);
      end = endOfDay(now);
    } else if (dateFilter === 'thisWeek') {
      start = startOfWeek(now, { weekStartsOn: 6 });
      end = endOfWeek(now, { weekStartsOn: 6 });
    } else if (dateFilter === 'thisMonth') {
      start = startOfMonth(now);
      end = endOfMonth(now);
    } else if (dateFilter === 'custom') {
      start = startOfDay(new Date(customStartDate));
      end = endOfDay(new Date(customEndDate));
    }
    return { start, end };
  };

  useEffect(() => {
    let active = true;
    const { start, end } = getDateRange();
    const params: Record<string, string> = {};
    if (dateFilter !== 'all') {
      params.startDate = start.toISOString();
      params.endDate = end.toISOString();
    }
    apiService
      .getFinancialReport(params)
      .then((data) => {
        if (active && data && data.balanceSheet) {
          setServerReport(data);
        }
      })
      .catch(() => {
        if (active) setServerReport(null);
      });
    return () => {
      active = false;
    };
  }, [dateFilter, customStartDate, customEndDate]);

  const getFilteredData = (data: any[], dateField: string) => {
    if (dateFilter === 'all') return data;
    const { start, end } = getDateRange();
    return data.filter((item) => {
      const date = new Date(item[dateField]);
      return isWithinInterval(date, { start, end });
    });
  };

  const filteredOrders = useMemo(() => getFilteredData(orders, 'createdAt'), [orders, dateFilter, customStartDate, customEndDate]);
  const filteredReturns = useMemo(() => getFilteredData(returns, 'createdAt'), [returns, dateFilter, customStartDate, customEndDate]);
  const filteredPurchases = useMemo(() => getFilteredData(purchases, 'date'), [purchases, dateFilter, customStartDate, customEndDate]);
  const filteredPurchaseReturns = useMemo(
    () => getFilteredData(purchaseReturns, 'createdAt'),
    [purchaseReturns, dateFilter, customStartDate, customEndDate]
  );
  const filteredExpenses = useMemo(() => getFilteredData(expenses, 'date'), [expenses, dateFilter, customStartDate, customEndDate]);
  const filteredPayrolls = useMemo(() => getFilteredData(payrolls, 'paymentDate'), [payrolls, dateFilter, customStartDate, customEndDate]);
  const filteredJournals = useMemo(() => getFilteredData(journalEntries, 'date'), [journalEntries, dateFilter, customStartDate, customEndDate]);

  const combinedLogs = useMemo(() => {
    const logs = [
      ...filteredOrders.map((o) => ({
        id: o.id!,
        type: 'sale' as const,
        receiptNumber: o.receiptNumber,
        date: o.createdAt,
        partyName: o.customerName || 'عميل نقدي',
        paymentMethod: o.paymentMethod,
        status: o.status,
        amount: o.netAmount,
        original: o,
      })),
      ...filteredPurchases.map((p) => ({
        id: p.id!,
        type: 'purchase' as const,
        receiptNumber: `PUR-${String(p.id).slice(0, 8)}`,
        date: p.date,
        partyName: p.supplierName,
        paymentMethod: p.paymentMethod || 'نقدي',
        status: p.paymentStatus,
        amount: p.totalAmount,
        original: p,
      })),
      ...filteredPurchaseReturns.map((pr) => ({
        id: pr.id!,
        type: 'purchase_return' as const,
        receiptNumber: pr.returnNumber,
        date: pr.createdAt,
        partyName: pr.supplierName || 'مورد',
        paymentMethod: pr.refundMethod,
        status: 'returned',
        amount: pr.totalReturn,
        original: pr,
      })),
    ];
    return logs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [filteredOrders, filteredPurchases, filteredPurchaseReturns]);

  // Local offline fallback metrics (VAT-exclusive revenue & historical COGS)
  const validOrders = filteredOrders.filter((o) => o.status !== 'void');
  const netSalesInclVat = validOrders.reduce((sum, o) => sum + Number(o.netAmount || 0), 0);
  const salesVat = validOrders.reduce((sum, o) => sum + Number(o.taxAmount || 0), 0);
  const totalReturnsInclVat = filteredReturns.reduce((sum, r) => sum + Number(r.totalRefund || 0), 0);
  const returnsVat = filteredReturns.reduce((sum, r) => sum + Number(r.taxAmount || 0), 0);
  const netSalesExclTax = serverReport ? Number(serverReport.netSalesExclTax) : netSalesInclVat - salesVat - (totalReturnsInclVat - returnsVat);
  const netVatPayable = serverReport ? Number(serverReport.netVatPayable) : salesVat - returnsVat;

  const validOrderIds = new Set(validOrders.map((o) => o.id));
  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const grossCOGS = orderItems
    .filter((item) => validOrderIds.has(item.orderId))
    .reduce((sum, item) => sum + getHistoricalCostAmount(item, productMap.get(item.productId)), 0);

  const returnedCOGS = filteredReturns.reduce((sum, r) => sum + Number(r.totalCostReversed || 0), 0);
  const totalCOGS = serverReport ? Number(serverReport.netCogs) : Math.max(0, grossCOGS - returnedCOGS);
  const totalExpenses = serverReport ? Number(serverReport.operatingExpenses) : filteredExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const totalSalaries = serverReport ? Number(serverReport.payrollExpenses) : filteredPayrolls.reduce((sum, p) => sum + Number(p.netSalary || 0), 0);

  const stocktakeIds = useMemo(
    () => new Set(filteredJournals.filter((je) => je.referenceType === 'stocktake').map((je) => je.id)),
    [filteredJournals]
  );
  const stocktakeAdjustments = serverReport
    ? Number(serverReport.stocktakeAdjustments || 0)
    : transactions
        .filter((t) => t.accountId === '5400' && stocktakeIds.has(t.journalEntryId))
        .reduce((s, t) => s + Number(t.debit || 0) - Number(t.credit || 0), 0);

  const inventoryBatchValue = inventoryBatches.reduce(
    (sum, b) => sum + Math.max(0, Number(b.remainingQuantity || 0)) * Number(b.costPrice || 0),
    0
  );
  const inventoryCostValue = serverReport
    ? Number(serverReport.inventoryCostValue)
    : inventoryBatches.length > 0
    ? inventoryBatchValue
    : products.reduce((sum, p) => sum + Math.max(0, p.stockQuantity) * p.costPrice, 0);

  const netProfit = serverReport
    ? Number(serverReport.netProfit)
    : netSalesExclTax - totalCOGS - totalExpenses - totalSalaries - stocktakeAdjustments;

  // Double-entry General Ledger lines
  const filteredJournalIds = useMemo(() => new Set(filteredJournals.map((j) => j.id)), [filteredJournals]);
  const journalMap = useMemo(() => new Map(filteredJournals.map((j) => [j.id, j])), [filteredJournals]);

  const ledgerLines = useMemo(() => {
    return transactions
      .filter((t) => filteredJournalIds.has(t.journalEntryId) && t.accountId)
      .map((t) => {
        const j = journalMap.get(t.journalEntryId);
        return {
          id: t.id,
          date: j?.date || t.createdAt || new Date().toISOString(),
          description: t.description || j?.description || '',
          referenceType: j?.referenceType || '-',
          referenceId: j?.referenceId || '-',
          accountId: t.accountId,
          accountName: t.accountName || t.accountId,
          debit: Number(t.debit || 0),
          credit: Number(t.credit || 0),
        };
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [transactions, filteredJournalIds, journalMap]);

  const totalDebit = ledgerLines.reduce((sum, l) => sum + l.debit, 0);
  const totalCredit = ledgerLines.reduce((sum, l) => sum + l.credit, 0);

  // Offline/Online Balance Sheet computation
  const balanceSheetData = useMemo(() => {
    if (serverReport?.balanceSheet) return serverReport.balanceSheet;
    const assets = accounts.filter((a) => a.type === 'asset').map((a) => ({ code: a.code, name: a.name, balance: Number(a.balance || 0) }));
    const liabilities = accounts.filter((a) => a.type === 'liability').map((a) => ({ code: a.code, name: a.name, balance: Number(a.balance || 0) }));
    const equity = accounts.filter((a) => a.type === 'equity').map((a) => ({ code: a.code, name: a.name, balance: Number(a.balance || 0) }));
    const cumulativeNetIncome =
      accounts.filter((a) => a.type === 'revenue').reduce((s, a) => s + Number(a.balance || 0), 0) -
      accounts.filter((a) => a.type === 'expense').reduce((s, a) => s + Number(a.balance || 0), 0);
    const totalAssets = assets.reduce((s, a) => s + a.balance, 0);
    const totalLiabilities = liabilities.reduce((s, l) => s + l.balance, 0);
    const totalEquity = equity.reduce((s, e) => s + e.balance, 0);
    const totalLiabilitiesAndEquity = totalLiabilities + totalEquity + cumulativeNetIncome;
    return {
      assets,
      liabilities,
      equity,
      netIncome: cumulativeNetIncome,
      totalAssets,
      totalLiabilities,
      totalEquity,
      totalLiabilitiesAndEquity,
      balanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) <= 0.05,
    };
  }, [serverReport, accounts]);

  const trialBalanceRows = useMemo(() => {
    if (serverReport?.trialBalance) return serverReport.trialBalance;
    const map = new Map<string, any>();
    for (const acc of accounts) {
      map.set(acc.code, {
        code: acc.code,
        name: acc.name,
        type: acc.type,
        openingDebit: 0,
        openingCredit: 0,
        periodDebit: 0,
        periodCredit: 0,
        closingDebit: 0,
        closingCredit: 0,
      });
    }
    for (const line of ledgerLines) {
      const key = line.accountId || 'unknown';
      const existing = map.get(key) || {
        code: key,
        name: line.accountName || key,
        type: 'account',
        openingDebit: 0,
        openingCredit: 0,
        periodDebit: 0,
        periodCredit: 0,
        closingDebit: 0,
        closingCredit: 0,
      };
      existing.periodDebit += line.debit;
      existing.periodCredit += line.credit;
      const net = existing.periodDebit - existing.periodCredit;
      existing.closingDebit = net > 0 ? net : 0;
      existing.closingCredit = net < 0 ? Math.abs(net) : 0;
      map.set(key, existing);
    }
    return Array.from(map.values()).filter(
      (a) => a.periodDebit > 0 || a.periodCredit > 0 || a.openingDebit > 0 || a.openingCredit > 0
    );
  }, [serverReport, accounts, ledgerLines]);

  const exportTrialBalanceCSV = () => {
    const headers = ['رقم الحساب', 'اسم الحساب', 'رصيد أول مدين', 'رصيد أول دائن', 'حركة مدين', 'حركة دائن', 'ختامي مدين', 'ختامي دائن'];
    const rows = trialBalanceRows.map((r: any) => [
      r.code,
      `"${r.name}"`,
      Number(r.openingDebit || 0).toFixed(2),
      Number(r.openingCredit || 0).toFixed(2),
      Number(r.periodDebit || 0).toFixed(2),
      Number(r.periodCredit || 0).toFixed(2),
      Number(r.closingDebit || 0).toFixed(2),
      Number(r.closingCredit || 0).toFixed(2),
    ]);
    const csv = '\uFEFF' + [headers.join(','), ...rows.map((r: any[]) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `trial_balance_${format(new Date(), 'yyyyMMdd')}.csv`;
    link.click();
  };

  return (
    <div className="flex flex-col h-full bg-white rounded-2xl border border-slate-200 overflow-hidden" dir="rtl">
      {/* Header & Tabs */}
      <div className="p-4 border-b border-slate-200 bg-slate-50 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-3">
        <div className="flex bg-slate-200/70 p-1 rounded-xl overflow-x-auto w-full lg:w-auto border border-slate-200">
          <button
            onClick={() => setActiveSubTab('trialBalance')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition-colors ${
              activeSubTab === 'trialBalance' ? 'bg-white text-indigo-600' : 'text-slate-600 hover:bg-slate-200'
            }`}
          >
            <Activity className="w-4 h-4 inline-block ml-1.5" />
            ميزان المراجعة
          </button>
          <button
            onClick={() => setActiveSubTab('balanceSheet')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition-colors ${
              activeSubTab === 'balanceSheet' ? 'bg-white text-indigo-600' : 'text-slate-600 hover:bg-slate-200'
            }`}
          >
            <Scale className="w-4 h-4 inline-block ml-1.5" />
            الميزانية العمومية
          </button>
          <button
            onClick={() => setActiveSubTab('invoices')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition-colors ${
              activeSubTab === 'invoices' ? 'bg-white text-indigo-600' : 'text-slate-600 hover:bg-slate-200'
            }`}
          >
            <FileText className="w-4 h-4 inline-block ml-1.5" />
            سجل الفواتير
          </button>
          <button
            onClick={() => setActiveSubTab('ledger')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition-colors ${
              activeSubTab === 'ledger' ? 'bg-white text-indigo-600' : 'text-slate-600 hover:bg-slate-200'
            }`}
          >
            <BookOpen className="w-4 h-4 inline-block ml-1.5" />
            دفتر الأستاذ
          </button>
          <button
            onClick={() => setActiveSubTab('audit')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition-colors ${
              activeSubTab === 'audit' ? 'bg-white text-indigo-600' : 'text-slate-600 hover:bg-slate-200'
            }`}
          >
            <Calendar className="w-4 h-4 inline-block ml-1.5" />
            سجل التدقيق
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 bg-white p-1 rounded-xl border border-slate-200">
          {(['today', 'thisWeek', 'thisMonth', 'all', 'custom'] as const).map((period) => (
            <button
              key={period}
              onClick={() => setDateFilter(period)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap ${
                dateFilter === period ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              {period === 'today'
                ? 'اليوم'
                : period === 'thisWeek'
                ? 'الأسبوع'
                : period === 'thisMonth'
                ? 'الشهر'
                : period === 'all'
                ? 'الكل'
                : 'مخصص'}
            </button>
          ))}
        </div>
        {dateFilter === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customStartDate}
              onChange={(e) => setCustomStartDate(e.target.value)}
              className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs"
            />
            <input
              type="date"
              value={customEndDate}
              onChange={(e) => setCustomEndDate(e.target.value)}
              className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs"
            />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 bg-slate-50">
        {activeSubTab === 'trialBalance' && (
          <div className="space-y-6 tabular-nums">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold text-slate-900">ميزان المراجعة وقائمة الدخل (مفصول الضريبة)</h3>
              <button
                onClick={exportTrialBalanceCSV}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-200 bg-white text-indigo-600 text-xs font-bold hover:bg-indigo-50"
              >
                <Download className="w-4 h-4" />
                <span>تصدير CSV</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
              <div className="bg-white p-4 rounded-2xl border border-slate-200">
                <p className="text-slate-500 text-xs font-bold mb-1">صافي المبيعات (بدون ضريبة)</p>
                <p className="text-2xl font-black text-emerald-600">{formatAmount(netSalesExclTax)}</p>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-slate-200">
                <p className="text-slate-500 text-xs font-bold mb-1">صافي ضريبة القيمة المضافة</p>
                <p className="text-2xl font-black text-amber-600">{formatAmount(netVatPayable)}</p>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-slate-200">
                <p className="text-slate-500 text-xs font-bold mb-1">تكلفة المبيعات (COGS)</p>
                <p className="text-2xl font-black text-slate-900">{formatAmount(totalCOGS)}</p>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-slate-200">
                <p className="text-slate-500 text-xs font-bold mb-1">المصروفات + تسوية الجرد</p>
                <p className="text-2xl font-black text-rose-600">{formatAmount(totalExpenses + stocktakeAdjustments)}</p>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-slate-200">
                <p className="text-slate-500 text-xs font-bold mb-1">الرواتب والأجور</p>
                <p className="text-2xl font-black text-rose-600">{formatAmount(totalSalaries)}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-indigo-600 p-5 rounded-2xl text-white">
                <p className="text-indigo-100 text-xs font-bold mb-1">صافي الربح المحاسبي (بدون ضريبة)</p>
                <p className="text-3xl font-black">{formatAmount(netProfit)}</p>
              </div>
              <div className="bg-white p-5 rounded-2xl border border-slate-200">
                <p className="text-slate-500 text-xs font-bold mb-1">قيمة المخزون الحالية (FIFO)</p>
                <p className="text-3xl font-black text-slate-900">{formatAmount(inventoryCostValue)}</p>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
                <h4 className="font-bold text-slate-900 text-sm">ميزان المراجعة التفصيلي</h4>
                <span
                  className={`text-xs font-bold px-3 py-1 rounded-lg border ${
                    Math.abs(totalDebit - totalCredit) < 0.05
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                      : 'bg-rose-50 border-rose-200 text-rose-700'
                  }`}
                >
                  المدين: {formatAmount(totalDebit)} | الدائن: {formatAmount(totalCredit)}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3 font-bold">رقم الحساب</th>
                      <th className="px-4 py-3 font-bold">اسم الحساب</th>
                      <th className="px-4 py-3 font-bold">افتتاحي مدين</th>
                      <th className="px-4 py-3 font-bold">افتتاحي دائن</th>
                      <th className="px-4 py-3 font-bold text-emerald-700">حركة مدين</th>
                      <th className="px-4 py-3 font-bold text-rose-700">حركة دائن</th>
                      <th className="px-4 py-3 font-bold text-indigo-700">ختامي مدين</th>
                      <th className="px-4 py-3 font-bold text-indigo-700">ختامي دائن</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {trialBalanceRows.map((acc: any) => (
                      <tr key={acc.code} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5 font-mono text-slate-500">{acc.code}</td>
                        <td className="px-4 py-2.5 font-bold text-slate-900">{acc.name}</td>
                        <td className="px-4 py-2.5 text-slate-600">{formatAmount(Number(acc.openingDebit || 0))}</td>
                        <td className="px-4 py-2.5 text-slate-600">{formatAmount(Number(acc.openingCredit || 0))}</td>
                        <td className="px-4 py-2.5 font-bold text-emerald-600">{formatAmount(Number(acc.periodDebit || 0))}</td>
                        <td className="px-4 py-2.5 font-bold text-rose-600">{formatAmount(Number(acc.periodCredit || 0))}</td>
                        <td className="px-4 py-2.5 font-black text-indigo-700">{formatAmount(Number(acc.closingDebit || 0))}</td>
                        <td className="px-4 py-2.5 font-black text-indigo-700">{formatAmount(Number(acc.closingCredit || 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeSubTab === 'balanceSheet' && (
          <div className="space-y-6 tabular-nums">
            <div className="flex flex-wrap justify-between items-center gap-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900">الميزانية العمومية (Balance Sheet)</h3>
                <p className="text-xs text-slate-500">الأصول = الخصوم + حقوق الملكية + صافي الدخل التراكمي</p>
              </div>
              <span
                className={`px-3 py-1.5 rounded-xl border text-xs font-bold ${
                  balanceSheetData.balanced
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                    : 'bg-rose-50 border-rose-200 text-rose-700'
                }`}
              >
                {balanceSheetData.balanced ? 'الميزانية متوازنة' : 'يوجد فرق في الميزانية'}
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Assets */}
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="p-4 bg-emerald-50 border-b border-emerald-200 flex justify-between items-center">
                  <h4 className="font-bold text-emerald-950">الأصول (Assets)</h4>
                  <span className="font-black text-emerald-800">{formatAmount(Number(balanceSheetData.totalAssets))}</span>
                </div>
                <div className="divide-y divide-slate-100">
                  {balanceSheetData.assets.map((a: any) => (
                    <div key={a.code} className="px-4 py-3 flex justify-between items-center text-sm">
                      <span>
                        <span className="font-mono text-xs text-slate-400 ml-2">[{a.code}]</span>
                        <span className="font-bold text-slate-800">{a.name}</span>
                      </span>
                      <span className="font-bold text-slate-900">{formatAmount(Number(a.balance))}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Liabilities & Equity */}
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="p-4 bg-indigo-50 border-b border-indigo-200 flex justify-between items-center">
                  <h4 className="font-bold text-indigo-950">الخصوم وحقوق الملكية</h4>
                  <span className="font-black text-indigo-800">
                    {formatAmount(Number(balanceSheetData.totalLiabilitiesAndEquity))}
                  </span>
                </div>
                <div className="divide-y divide-slate-100">
                  {balanceSheetData.liabilities.map((l: any) => (
                    <div key={l.code} className="px-4 py-3 flex justify-between items-center text-sm">
                      <span>
                        <span className="font-mono text-xs text-slate-400 ml-2">[{l.code}]</span>
                        <span className="font-bold text-slate-800">{l.name}</span>
                      </span>
                      <span className="font-bold text-slate-900">{formatAmount(Number(l.balance))}</span>
                    </div>
                  ))}
                  {balanceSheetData.equity.map((eqItem: any) => (
                    <div key={eqItem.code} className="px-4 py-3 flex justify-between items-center text-sm">
                      <span>
                        <span className="font-mono text-xs text-slate-400 ml-2">[{eqItem.code}]</span>
                        <span className="font-bold text-slate-800">{eqItem.name}</span>
                      </span>
                      <span className="font-bold text-slate-900">{formatAmount(Number(eqItem.balance))}</span>
                    </div>
                  ))}
                  <div className="px-4 py-3 flex justify-between items-center text-sm bg-slate-50">
                    <span className="font-bold text-indigo-700">صافي الدخل التراكمي للفترة الجارية</span>
                    <span className="font-black text-indigo-700">{formatAmount(Number(balanceSheetData.netIncome))}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Invoices Tab */}
        {activeSubTab === 'invoices' && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-right">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3 text-xs font-bold text-slate-600">الرقم</th>
                    <th className="px-4 py-3 text-xs font-bold text-slate-600">التاريخ</th>
                    <th className="px-4 py-3 text-xs font-bold text-slate-600">الطرف</th>
                    <th className="px-4 py-3 text-xs font-bold text-slate-600">الدفع</th>
                    <th className="px-4 py-3 text-xs font-bold text-slate-600">الحالة</th>
                    <th className="px-4 py-3 text-xs font-bold text-slate-600">الإجمالي</th>
                    <th className="px-4 py-3 text-xs font-bold text-slate-600">معاينة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {combinedLogs.map((log) => (
                    <tr
                      key={`${log.type}-${log.id}`}
                      className={`hover:bg-slate-50 ${(log.type === 'sale' && onViewReceipt) || (log.type === 'purchase' && onViewPurchase) ? 'cursor-pointer' : ''}`}
                      onClick={() => {
                        if (log.type === 'sale' && onViewReceipt) onViewReceipt(log.original as Order);
                        else if (log.type === 'purchase' && onViewPurchase) onViewPurchase(log.original as Purchase);
                      }}
                    >
                      <td className="px-4 py-3 font-mono text-xs font-bold">{log.receiptNumber}</td>
                      <td className="px-4 py-3 text-xs text-slate-500 tabular-nums">
                        {format(new Date(log.date), 'yyyy-MM-dd HH:mm')}
                      </td>
                      <td className="px-4 py-3 font-bold">{log.partyName}</td>
                      <td className="px-4 py-3 text-xs font-bold">
                        {log.paymentMethod === 'cash'
                          ? 'نقدي'
                          : log.paymentMethod === 'card'
                          ? 'شبكة'
                          : log.paymentMethod === 'mixed'
                          ? 'مختلط'
                          : log.paymentMethod === 'credit'
                          ? 'آجل'
                          : log.paymentMethod}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-0.5 rounded-lg border text-xs font-bold whitespace-nowrap ${
                            log.status === 'void' || log.status === 'returned' || log.status === 'unpaid'
                              ? 'bg-rose-50 border-rose-200 text-rose-700'
                              : log.status === 'completed' || log.status === 'paid'
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                              : 'bg-amber-50 border-amber-200 text-amber-700'
                          }`}
                        >
                          {log.status === 'completed'
                            ? 'مكتمل'
                            : log.status === 'void'
                            ? 'ملغاة'
                            : log.status === 'returned'
                            ? 'مرتجع'
                            : log.status === 'partially_returned'
                            ? 'مرتجع جزئي'
                            : log.status === 'paid'
                            ? 'مسدد'
                            : log.status === 'unpaid'
                            ? 'غير مسدد'
                            : log.status === 'partial'
                            ? 'جزئي'
                            : log.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-bold text-slate-900 tabular-nums">{formatAmount(Number(log.amount))}</td>
                      <td className="px-4 py-3">
                        {(log.type === 'sale' || log.type === 'purchase') && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (log.type === 'sale' && onViewReceipt) onViewReceipt(log.original as Order);
                              else if (log.type === 'purchase' && onViewPurchase) onViewPurchase(log.original as Purchase);
                            }}
                            className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded-lg"
                          >
                            <Receipt className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {combinedLogs.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                        لا توجد فواتير في هذه الفترة
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Double-Entry General Ledger Tab */}
        {activeSubTab === 'ledger' && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden p-5">
            <div className="flex flex-wrap justify-between items-center gap-4 mb-5">
              <div>
                <h3 className="text-lg font-bold text-slate-900">دفتر الأستاذ العام (قيود القيد المزدوج)</h3>
                <p className="text-slate-500 text-xs">سطور القيود المحاسبية المتوازنة المسجلة في النظام</p>
              </div>
              <div className="flex gap-3 text-xs font-bold tabular-nums">
                <span className="px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700">
                  إجمالي المدين: {formatAmount(totalDebit)}
                </span>
                <span className="px-3 py-1.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700">
                  إجمالي الدائن: {formatAmount(totalCredit)}
                </span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse tabular-nums">
                <thead className="bg-slate-50 border-b border-slate-200 text-xs">
                  <tr>
                    <th className="px-4 py-3 font-bold text-slate-600">التاريخ</th>
                    <th className="px-4 py-3 font-bold text-slate-600">الحساب</th>
                    <th className="px-4 py-3 font-bold text-slate-600">البيان</th>
                    <th className="px-4 py-3 font-bold text-slate-600">المرجع</th>
                    <th className="px-4 py-3 font-bold text-emerald-700">مدين</th>
                    <th className="px-4 py-3 font-bold text-rose-700">دائن</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {ledgerLines.map((line, idx) => (
                    <tr key={line.id ?? idx} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 text-slate-600">{format(new Date(line.date), 'yyyy-MM-dd HH:mm')}</td>
                      <td className="px-4 py-2.5 font-bold text-slate-900">
                        <span className="font-mono text-slate-400 ml-1">[{line.accountId}]</span>
                        {line.accountName}
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">{line.description}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-500">
                        {line.referenceType}:{String(line.referenceId).slice(0, 8)}
                      </td>
                      <td className="px-4 py-2.5 font-bold text-emerald-600">
                        {line.debit > 0 ? formatAmount(line.debit) : '-'}
                      </td>
                      <td className="px-4 py-2.5 font-bold text-rose-600">
                        {line.credit > 0 ? formatAmount(line.credit) : '-'}
                      </td>
                    </tr>
                  ))}
                  {ledgerLines.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                        لا توجد قيود محاسبية مسجلة في هذه الفترة
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Audit Log Tab */}
        {activeSubTab === 'audit' && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden p-5">
            <h3 className="text-lg font-bold text-slate-900 mb-1">سجل التدقيق (Audit Log)</h3>
            <p className="text-slate-500 text-xs mb-5">تتبع دقيق لجميع العمليات التي تمت على النظام</p>

            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3 font-bold text-slate-600">التاريخ والوقت</th>
                    <th className="px-4 py-3 font-bold text-slate-600">المستخدم</th>
                    <th className="px-4 py-3 font-bold text-slate-600">المعاملة</th>
                    <th className="px-4 py-3 font-bold text-slate-600">التفاصيل</th>
                    <th className="px-4 py-3 font-bold text-slate-600">الفرع</th>
                    <th className="px-4 py-3 font-bold text-slate-600">القيمة / الكمية</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {[...auditLogs]
                    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                    .map((log, idx) => (
                      <tr key={idx} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5 text-slate-600">
                          {format(new Date(log.date), 'yyyy-MM-dd HH:mm:ss')}
                        </td>
                        <td className="px-4 py-2.5 font-bold text-slate-900">{log.userName}</td>
                        <td className="px-4 py-2.5">
                          <span className="px-2 py-0.5 rounded-md border border-slate-200 bg-slate-50 font-bold text-slate-700">
                            {log.operationName}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{log.details}</td>
                        <td className="px-4 py-2.5 text-slate-600">{log.branchId || '-'}</td>
                        <td className="px-4 py-2.5 font-bold" dir="ltr">
                          {formatAmount(Number(log.value || 0))} / {log.quantity || 0}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
