import { useState, useRef, useMemo } from 'react';
import { usePosRecordsWhereEquals } from '../hooks/usePosRecordsWhereEquals';
import { usePosEntityRecords } from '../hooks/usePosEntityRecords';
import { usePosFirstRecordWhereEquals } from '../hooks/usePosFirstRecordWhereEquals';
import { generateUUID } from '../utils/uuid';
import {
  Clock,
  Play,
  Square,
  DollarSign,
  AlertCircle,
  FileText,
  Printer,
  ArrowDownLeft,
  ArrowUpRight,
  X,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { format } from 'date-fns';
import { arSA } from 'date-fns/locale';
import { useReactToPrint } from 'react-to-print';

import { useSettings } from '../hooks/useSettings';
import { dispatchOperation } from '../services/operationService';
import { useAuth } from '../context/AuthContext';

export default function Shifts() {
  const { user } = useAuth();
  const [openingCash, setOpeningCash] = useState<string>('');
  const [actualCash, setActualCash] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const shiftReportRef = useRef<HTMLDivElement>(null);

  // Cash Movement Modal
  const [movementModalType, setMovementModalType] = useState<'deposit' | 'withdrawal' | null>(null);
  const [movementAmount, setMovementAmount] = useState('');
  const [movementReason, setMovementReason] = useState('');
  const [isSavingMovement, setIsSavingMovement] = useState(false);

  const storeSettings = useSettings();

  const handlePrintShift = useReactToPrint({
    contentRef: shiftReportRef,
    documentTitle: 'Shift-Report',
  });

  // Get current open shift
  const currentShift = usePosFirstRecordWhereEquals<any>('shifts', 'status', 'open');

  // All shift calculations read from the platform's authoritative local store.
  const shiftOrders = usePosRecordsWhereEquals<any>('orders', 'shiftId', currentShift?.id);
  const shiftReturns = usePosRecordsWhereEquals<any>('returns', 'shiftId', currentShift?.id);
  const shiftExpenses = usePosRecordsWhereEquals<any>('expenses', 'shiftId', currentShift?.id);
  const shiftMovements = usePosRecordsWhereEquals<any>('shiftMovements', 'shiftId', currentShift?.id).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const shiftCustomerPayments = usePosRecordsWhereEquals<any>('customerPayments', 'shiftId', currentShift?.id);
  const shiftSupplierPayments = usePosRecordsWhereEquals<any>('supplierPayments', 'shiftId', currentShift?.id);
  const shiftPurchaseReturns = usePosRecordsWhereEquals<any>('purchaseReturns', 'shiftId', currentShift?.id);
  const allPurchases = usePosEntityRecords<any>('purchases');
  const allPayroll = usePosEntityRecords<any>('payroll');
  const allShifts = usePosEntityRecords<any>('shifts');


  const shiftCashPurchases = useMemo(() => currentShift
    ? allPurchases.filter((record) => record.createdAt >= currentShift.startTime &&
        record.paymentMethod !== 'card' && Number(record.paidAmount || 0) > 0) : [],
    [allPurchases, currentShift?.id, currentShift?.startTime]);
  const shiftCashPayrolls = useMemo(() => currentShift
    ? allPayroll.filter((record) => record.paymentDate >= currentShift.startTime &&
        record.paymentMethod !== 'card' && record.status === 'paid') : [],
    [allPayroll, currentShift?.id, currentShift?.startTime]);

  // Past shifts
  const pastShifts = useMemo(() => allShifts.filter((record) => record.status === 'closed')
    .sort((a, b) => String(b.startTime || '').localeCompare(String(a.startTime || ''))), [allShifts]);

  // Exact shift cash math
  const metrics = useMemo(() => {
    const validOrders = shiftOrders.filter((o) => o.status !== 'void');

    const cashSales = validOrders.reduce((sum, o) => {
      if (o.paymentMethod === 'cash') return sum + Number(o.netAmount || 0);
      if (o.paymentMethod === 'mixed') return sum + Number(o.cashAmount || 0);
      return sum;
    }, 0);

    const cardSales = validOrders.reduce((sum, o) => {
      if (o.paymentMethod === 'card') return sum + Number(o.netAmount || 0);
      if (o.paymentMethod === 'mixed') return sum + Number(o.cardAmount || 0);
      return sum;
    }, 0);

    const creditSales = validOrders
      .filter((o) => o.paymentMethod === 'credit')
      .reduce((sum, o) => sum + Number(o.netAmount || 0), 0);

    const totalSales = validOrders.reduce((sum, o) => sum + Number(o.netAmount || 0), 0);

    const cashCustomerPayments = shiftCustomerPayments
      .filter((p) => p.paymentMethod !== 'card')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);

    const cashDeposits = shiftMovements
      .filter((m) => m.type === 'deposit')
      .reduce((sum, m) => sum + Number(m.amount || 0), 0);

    const cashPurchaseReturns = shiftPurchaseReturns
      .filter((r) => r.refundMethod === 'cash')
      .reduce((sum, r) => sum + Number(r.totalReturn || 0), 0);

    const cashReturns = shiftReturns
      .filter((r) => r.refundMethod === 'cash')
      .reduce((sum, r) => sum + Number(r.totalRefund || 0), 0);

    const cashExpenses = shiftExpenses
      .filter((e) => e.paymentMethod !== 'card')
      .reduce((sum, e) => sum + Number(e.amount || 0), 0);

    const cashSupplierPayments = shiftSupplierPayments
      .filter((p) => p.paymentMethod !== 'card')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);

    const cashPurchasesOut = shiftCashPurchases.reduce(
      (sum, p) => sum + Number(p.paidAmount || 0),
      0
    );

    const cashPayrollsOut = shiftCashPayrolls.reduce(
      (sum, p) => sum + Number(p.netSalary || 0),
      0
    );

    const cashWithdrawals = shiftMovements
      .filter((m) => m.type === 'withdrawal')
      .reduce((sum, m) => sum + Number(m.amount || 0), 0);

    const opening = currentShift ? Number(currentShift.openingCash || 0) : 0;
    const totalInflows = cashSales + cashCustomerPayments + cashDeposits + cashPurchaseReturns;
    const totalOutflows =
      cashReturns +
      cashExpenses +
      cashSupplierPayments +
      cashPurchasesOut +
      cashPayrollsOut +
      cashWithdrawals;

    const expectedCash = Math.round((opening + totalInflows - totalOutflows) * 100) / 100;

    return {
      validOrdersCount: validOrders.length,
      cashSales,
      cardSales,
      creditSales,
      totalSales,
      cashCustomerPayments,
      cashDeposits,
      cashPurchaseReturns,
      cashReturns,
      cashExpenses,
      cashSupplierPayments: cashSupplierPayments + cashPurchasesOut,
      cashPayrollsOut,
      cashWithdrawals,
      expectedCash,
    };
  }, [
    currentShift,
    shiftOrders,
    shiftReturns,
    shiftExpenses,
    shiftMovements,
    shiftCustomerPayments,
    shiftSupplierPayments,
    shiftPurchaseReturns,
    shiftCashPurchases,
    shiftCashPayrolls,
  ]);

  const handleOpenShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (currentShift) {
      toast.error('يوجد وردية مفتوحة بالفعل');
      return;
    }

    const cash = parseFloat(openingCash);
    if (isNaN(cash) || cash < 0) {
      toast.error('الرجاء إدخال مبلغ صحيح للعهدة الافتتاحية');
      return;
    }

    setIsProcessing(true);
    try {
      await dispatchOperation(
        'shift_open',
        {
          id: generateUUID(),
          startTime: new Date().toISOString(),
          openingCash: cash,
          status: 'open',
          branchId: user?.branchId,
        },
        user?.branchId
      );
      toast.success('تم فتح الوردية بنجاح');
      setOpeningCash('');
    } catch (error: any) {
      console.error('Error opening shift:', error);
      toast.error(error?.message || 'حدث خطأ أثناء فتح الوردية');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCloseShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentShift) return;

    const cash = parseFloat(actualCash);
    if (isNaN(cash) || cash < 0) {
      toast.error('الرجاء إدخال مبلغ صحيح للنقد الفعلي');
      return;
    }

    setIsProcessing(true);
    try {
      await dispatchOperation(
        'shift_close',
        {
          id: currentShift.id!,
          endTime: new Date().toISOString(),
          expectedCash: metrics.expectedCash,
          actualCash: cash,
        },
        user?.branchId
      );

      toast.success('تم إغلاق الوردية بنجاح');
      setActualCash('');
    } catch (error: any) {
      console.error('Error closing shift:', error);
      toast.error(error?.message || 'حدث خطأ أثناء إغلاق الوردية');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSaveMovement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentShift?.id || !movementModalType) return;

    const amt = parseFloat(movementAmount);
    if (isNaN(amt) || amt <= 0) {
      toast.error('الرجاء إدخال مبلغ صحيح أكبر من الصفر');
      return;
    }
    if (!movementReason.trim()) {
      toast.error('الرجاء إدخال سبب الحركة النقدية');
      return;
    }

    setIsSavingMovement(true);
    try {
      await dispatchOperation(
        'shift_movement',
        {
          id: generateUUID(),
          shiftId: currentShift.id,
          type: movementModalType,
          amount: amt,
          reason: movementReason.trim(),
          createdBy: user?.name || 'System',
          branchId: user?.branchId ?? currentShift.branchId,
        },
        user?.branchId
      );
      toast.success(
        movementModalType === 'deposit'
          ? 'تم تسجيل الإيداع النقدي بالوردية'
          : 'تم تسجيل السحب النقدي من الوردية'
      );
      setMovementModalType(null);
      setMovementAmount('');
      setMovementReason('');
    } catch (err: any) {
      toast.error(err?.message || 'حدث خطأ أثناء تسجيل الحركة النقدية');
    } finally {
      setIsSavingMovement(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-[var(--app-bg)] p-3 custom-scrollbar sm:p-6" dir="rtl">
      <div className="mb-6 shrink-0">
        <h2 className="text-2xl font-bold text-slate-900">إدارة الورديات وحركة الصندوق</h2>
        <p className="text-slate-500 text-sm mt-1">
          فتح وإغلاق الورديات ومتابعة الإيداعات والسحوبات والمطابقة النقدية
        </p>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:gap-6 lg:mb-8 lg:grid-cols-3">
        {/* Current Shift Status */}
        <div className="lg:col-span-1">
          {currentShift ? (
            <div className="bg-white rounded-2xl p-6 border border-emerald-200">
              <div className="flex items-center justify-between gap-3 mb-5">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600">
                    <Clock className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900">الوردية الحالية مفتوحة</h3>
                    <p className="text-xs text-slate-500 tabular-nums">
                      {format(new Date(currentShift.startTime), 'hh:mm a - yyyy/MM/dd', {
                        locale: arSA,
                      })}
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-2.5 mb-5 text-sm tabular-nums">
                <div className="flex justify-between items-center p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                  <span className="text-slate-600">العهدة الافتتاحية</span>
                  <span className="font-bold text-slate-900">
                    {currentShift.openingCash.toFixed(2)} {storeSettings.currency}
                  </span>
                </div>
                <div className="flex justify-between items-center p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                  <span className="text-slate-600">المبيعات النقدية + التحصيل</span>
                  <span className="font-bold text-emerald-600">
                    +{(metrics.cashSales + metrics.cashCustomerPayments).toFixed(2)}{' '}
                    {storeSettings.currency}
                  </span>
                </div>
                <div className="flex justify-between items-center p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                  <span className="text-slate-600">إيداعات / سحوبات الدرج</span>
                  <span className="font-bold text-slate-800">
                    +{metrics.cashDeposits.toFixed(2)} / -{metrics.cashWithdrawals.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between items-center p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                  <span className="text-slate-600">المرتجعات والمصروفات والرواتب النقدية</span>
                  <span className="font-bold text-rose-600">
                    -
                    {(
                      metrics.cashReturns +
                      metrics.cashExpenses +
                      metrics.cashSupplierPayments +
                      metrics.cashPayrollsOut
                    ).toFixed(2)}{' '}
                    {storeSettings.currency}
                  </span>
                </div>
                <div className="flex justify-between items-center p-3 bg-indigo-50 rounded-xl border border-indigo-200">
                  <span className="font-bold text-indigo-900">النقد المتوقع بالدرج</span>
                  <span className="font-black text-indigo-700 text-base">
                    {metrics.expectedCash.toFixed(2)} {storeSettings.currency}
                  </span>
                </div>
              </div>

              {/* Drawer Movements Quick Actions */}
              <div className="grid grid-cols-2 gap-2.5 mb-5">
                <button
                  type="button"
                  onClick={() => setMovementModalType('deposit')}
                  className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 text-xs font-bold transition-colors whitespace-nowrap"
                >
                  <ArrowDownLeft className="w-4 h-4" />
                  إيداع نقدي
                </button>
                <button
                  type="button"
                  onClick={() => setMovementModalType('withdrawal')}
                  className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 text-xs font-bold transition-colors whitespace-nowrap"
                >
                  <ArrowUpRight className="w-4 h-4" />
                  سحب نقدي
                </button>
              </div>

              <form onSubmit={handleCloseShift} className="space-y-3 border-t border-slate-200 pt-5">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    الجرد الفعلي للنقد بالدرج
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                      <DollarSign className="h-4 w-4 text-slate-400" />
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      value={actualCash}
                      onChange={(e) => setActualCash(e.target.value)}
                      className="block w-full pl-3 pr-9 py-2.5 border border-slate-200 rounded-xl text-sm tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none"
                      placeholder="0.00"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={isProcessing || !actualCash}
                  className="w-full flex items-center justify-center gap-2 bg-rose-600 hover:bg-rose-700 text-white py-2.5 rounded-xl text-sm font-bold transition-colors disabled:opacity-50"
                >
                  <Square className="w-4 h-4" />
                  إغلاق الوردية
                </button>
              </form>
            </div>
          ) : (
            <div className="bg-white rounded-2xl p-6 border border-slate-200">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-11 h-11 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-500">
                  <Square className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">لا توجد وردية مفتوحة</h3>
                  <p className="text-xs text-slate-500">يجب فتح وردية للبدء في البيع وحركات الصندوق</p>
                </div>
              </div>

              <form onSubmit={handleOpenShift} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    العهدة الافتتاحية (النقد بالدرج)
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                      <DollarSign className="h-4 w-4 text-slate-400" />
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      value={openingCash}
                      onChange={(e) => setOpeningCash(e.target.value)}
                      className="block w-full pl-3 pr-9 py-2.5 border border-slate-200 rounded-xl text-sm tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none"
                      placeholder="0.00"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={isProcessing || !openingCash}
                  className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-xl text-sm font-bold transition-colors disabled:opacity-50"
                >
                  <Play className="w-4 h-4" />
                  فتح وردية جديدة
                </button>
              </form>
            </div>
          )}
        </div>

        {/* Current Shift Summary & Drawer Movements */}
        <div className="lg:col-span-2 bg-white rounded-2xl p-6 border border-slate-200 flex flex-col">
          <div className="flex justify-between items-center mb-5">
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <FileText className="w-5 h-5 text-indigo-600" />
              ملخص الوردية الحالية
            </h3>
            {currentShift && (
              <button
                onClick={() => handlePrintShift()}
                className="text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 px-3 py-1.5 rounded-lg flex items-center gap-2 text-xs font-bold transition-colors whitespace-nowrap shrink-0"
              >
                <Printer className="w-4 h-4" />
                طباعة الملخص
              </button>
            )}
          </div>

          {currentShift ? (
            <div className="flex-1 flex flex-col gap-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 tabular-nums">
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500 mb-1">إجمالي المبيعات</p>
                  <p className="text-lg font-black text-slate-900">{metrics.totalSales.toFixed(2)}</p>
                </div>
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500 mb-1">مبيعات نقدية</p>
                  <p className="text-lg font-black text-emerald-600">{metrics.cashSales.toFixed(2)}</p>
                </div>
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500 mb-1">مبيعات شبكة</p>
                  <p className="text-lg font-black text-blue-600">{metrics.cardSales.toFixed(2)}</p>
                </div>
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500 mb-1">مبيعات آجل</p>
                  <p className="text-lg font-black text-amber-600">{metrics.creditSales.toFixed(2)}</p>
                </div>
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500 mb-1">الفواتير السليمة</p>
                  <p className="text-lg font-black text-slate-900">{metrics.validOrdersCount}</p>
                </div>
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500 mb-1">مرتجعات نقدية</p>
                  <p className="text-lg font-black text-rose-600">{metrics.cashReturns.toFixed(2)}</p>
                </div>
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500 mb-1">تحصيل عملاء نقدي</p>
                  <p className="text-lg font-black text-emerald-700">
                    {metrics.cashCustomerPayments.toFixed(2)}
                  </p>
                </div>
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500 mb-1">مصروفات نقدية</p>
                  <p className="text-lg font-black text-rose-600">{metrics.cashExpenses.toFixed(2)}</p>
                </div>
              </div>

              {/* Shift Cash Movements Table */}
              <div className="border border-slate-200 rounded-xl overflow-hidden flex-1">
                <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
                  <span className="text-xs font-bold text-slate-700">
                    حركات السحب والإيداع النقدي خلال الوردية ({shiftMovements.length})
                  </span>
                </div>
                {shiftMovements.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-400">
                    لا توجد حركات إيداع أو سحب مسجلة لهذه الوردية
                  </div>
                ) : (
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-50/70 text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="px-4 py-2.5">النوع</th>
                        <th className="px-4 py-2.5">المبلغ</th>
                        <th className="px-4 py-2.5">البيان / السبب</th>
                        <th className="px-4 py-2.5">الوقت</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 tabular-nums">
                      {shiftMovements.map((m) => (
                        <tr key={m.id}>
                          <td className="px-4 py-2.5">
                            <span
                              className={`px-2 py-0.5 rounded-md border text-[11px] font-bold ${
                                m.type === 'deposit'
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                  : 'bg-amber-50 text-amber-800 border-amber-200'
                              }`}
                            >
                              {m.type === 'deposit' ? 'إيداع' : 'سحب'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 font-bold text-slate-900">
                            {m.amount.toFixed(2)} {storeSettings.currency}
                          </td>
                          <td className="px-4 py-2.5 text-slate-700">{m.reason}</td>
                          <td className="px-4 py-2.5 text-slate-500">
                            {format(new Date(m.createdAt), 'HH:mm')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-slate-400">
              <AlertCircle className="w-10 h-10 mb-2 opacity-50" />
              <p className="text-sm">لا توجد بيانات لعرضها. افتح وردية للبدء.</p>
            </div>
          )}
        </div>
      </div>

      {/* Shift History */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden flex-1">
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/70">
          <h3 className="text-base font-bold text-slate-900">سجل الورديات السابقة</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right">
            <thead className="bg-slate-50 text-slate-500 text-xs font-bold border-b border-slate-200">
              <tr>
                <th className="px-6 py-3.5">وقت البدء</th>
                <th className="px-6 py-3.5">وقت الإغلاق</th>
                <th className="px-6 py-3.5">العهدة</th>
                <th className="px-6 py-3.5">المتوقع</th>
                <th className="px-6 py-3.5">الفعلي</th>
                <th className="px-6 py-3.5">العجز/الزيادة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm tabular-nums">
              {pastShifts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-400">
                    لا يوجد سجل للورديات السابقة
                  </td>
                </tr>
              ) : (
                pastShifts.map((shift) => {
                  const diff = (shift.actualCash || 0) - (shift.expectedCash || 0);
                  return (
                    <tr key={shift.id} className="hover:bg-slate-50/60 transition-colors">
                      <td className="px-6 py-3.5 text-slate-900">
                        {format(new Date(shift.startTime), 'yyyy/MM/dd hh:mm a', { locale: arSA })}
                      </td>
                      <td className="px-6 py-3.5 text-slate-900">
                        {shift.endTime
                          ? format(new Date(shift.endTime), 'yyyy/MM/dd hh:mm a', { locale: arSA })
                          : '-'}
                      </td>
                      <td className="px-6 py-3.5 text-slate-600">{shift.openingCash.toFixed(2)}</td>
                      <td className="px-6 py-3.5 text-slate-600">
                        {shift.expectedCash?.toFixed(2) || '-'}
                      </td>
                      <td className="px-6 py-3.5 font-bold text-slate-900">
                        {shift.actualCash?.toFixed(2) || '-'}
                      </td>
                      <td className="px-6 py-3.5 font-bold">
                        {Math.abs(diff) < 0.01 ? (
                          <span className="text-slate-500">مطابق</span>
                        ) : diff > 0 ? (
                          <span className="text-emerald-600">+{diff.toFixed(2)}</span>
                        ) : (
                          <span className="text-rose-600">{diff.toFixed(2)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Shift Movement Modal */}
      {movementModalType && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-base font-bold text-slate-900">
                {movementModalType === 'deposit'
                  ? 'إيداع نقدي إلى صندوق الوردية'
                  : 'سحب نقدي من صندوق الوردية'}
              </h3>
              <button
                onClick={() => setMovementModalType(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveMovement} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  المبلغ ({storeSettings.currency}) *
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  autoFocus
                  value={movementAmount}
                  onChange={(e) => setMovementAmount(e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-sm tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="0.00"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">البيان / السبب *</label>
                <input
                  type="text"
                  required
                  value={movementReason}
                  onChange={(e) => setMovementReason(e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder={
                    movementModalType === 'deposit'
                      ? 'مثال: تعزيز عهدة الصندوق بفكة'
                      : 'مثال: ترحيل نقدية للخزينة الرئيسية'
                  }
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setMovementModalType(null)}
                  className="px-4 py-2 border border-slate-200 rounded-xl text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isSavingMovement}
                  className={`px-5 py-2 rounded-xl text-white text-sm font-bold disabled:opacity-50 ${
                    movementModalType === 'deposit'
                      ? 'bg-emerald-600 hover:bg-emerald-700'
                      : 'bg-amber-600 hover:bg-amber-700'
                  }`}
                >
                  {isSavingMovement ? 'جاري الحفظ...' : 'حفظ الحركة'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Hidden Printable Shift Report */}
      <div className="hidden">
        <div ref={shiftReportRef} className="p-8 bg-white tabular-nums" dir="rtl">
          <div className="text-center mb-6 border-b pb-4">
            <h2 className="text-2xl font-bold mb-1">{storeSettings.businessName}</h2>
            <p className="text-base font-bold text-slate-700">تقرير مطابقة الوردية</p>
            <p className="text-xs text-slate-500 mt-1">
              {currentShift
                ? format(new Date(currentShift.startTime), 'dd MMMM yyyy - hh:mm a', {
                    locale: arSA,
                  })
                : ''}
            </p>
          </div>

          <div className="space-y-5 text-sm">
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                <p className="text-xs text-slate-500 mb-1">العهدة الافتتاحية</p>
                <p className="text-lg font-bold">
                  {currentShift?.openingCash.toFixed(2)} {storeSettings.currency}
                </p>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                <p className="text-xs text-slate-500 mb-1">النقد المتوقع بالدرج</p>
                <p className="text-lg font-bold">
                  {metrics.expectedCash.toFixed(2)} {storeSettings.currency}
                </p>
              </div>
            </div>

            <div className="border-t pt-4 space-y-2">
              <h3 className="font-bold text-base mb-2">ملخص المبيعات والتحصيلات</h3>
              <div className="flex justify-between">
                <span>إجمالي المبيعات (شامل الضريبة):</span>
                <span className="font-bold">{metrics.totalSales.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>مبيعات نقدية (شاملة الجزء النقدي للمختلط):</span>
                <span className="font-bold">{metrics.cashSales.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>مبيعات شبكة:</span>
                <span className="font-bold">{metrics.cardSales.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>مبيعات آجل:</span>
                <span className="font-bold">{metrics.creditSales.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>تحصيل عملاء نقدي:</span>
                <span className="font-bold">{metrics.cashCustomerPayments.toFixed(2)}</span>
              </div>
            </div>

            <div className="border-t pt-4 space-y-2">
              <h3 className="font-bold text-base mb-2">حركات الصندوق والمصروفات</h3>
              <div className="flex justify-between">
                <span>إيداعات نقدية للدرج:</span>
                <span className="font-bold">+{metrics.cashDeposits.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>سحوبات نقدية من الدرج:</span>
                <span className="font-bold">-{metrics.cashWithdrawals.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>مرتجعات مبيعات نقدية:</span>
                <span className="font-bold">-{metrics.cashReturns.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>مصروفات ومشتريات ورواتب نقدية:</span>
                <span className="font-bold">
                  -
                  {(
                    metrics.cashExpenses +
                    metrics.cashSupplierPayments +
                    metrics.cashPayrollsOut
                  ).toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
