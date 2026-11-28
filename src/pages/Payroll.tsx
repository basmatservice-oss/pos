import React, { useState, useMemo } from 'react';
import { usePosFirstRecordWhereEquals } from '../hooks/usePosFirstRecordWhereEquals';
import { usePosEntityRecords } from '../hooks/usePosEntityRecords';
import {
  Users,
  DollarSign,
  Download,
  Plus,
  CheckCircle,
  Clock,
  AlertCircle,
  X,
} from 'lucide-react';
import { format, startOfMonth, endOfMonth, isWithinInterval, parseISO } from 'date-fns';
import type { Employee } from '../db/db';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../hooks/useSettings';
import { dispatchOperation } from '../services/operationService';

interface SalaryPreview {
  employee: Employee;
  salaryType: 'monthly' | 'hourly';
  totalHours: number;
  hourlyRate: number;
  basicSalary: number;
  bonuses: number;
  deductions: number;
  netSalary: number;
  periodStart: string;
  periodEnd: string;
}

const Payroll: React.FC = () => {
  const [selectedMonth, setSelectedMonth] = useState(format(new Date(), 'yyyy-MM'));
  const { user } = useAuth();
  const storeSettings = useSettings();

  // Per-employee editable bonuses & deductions before payout
  const [adjustments, setAdjustments] = useState<
    Record<number, { bonuses: string; deductions: string }>
  >({});

  // Payout confirmation modal state
  const [payoutModalData, setPayoutModalData] = useState<SalaryPreview | null>(null);
  const [payoutMethod, setPayoutMethod] = useState<'cash' | 'card'>('cash');
  const [isProcessing, setIsProcessing] = useState(false);

  // Data State using Dexie Live Query
  const employees = usePosEntityRecords<any>('employees');
  const attendance = usePosEntityRecords<any>('attendance');
  const payrollRecords = usePosEntityRecords<any>('payroll');
  const openShift = usePosFirstRecordWhereEquals<any>('shifts', 'status', 'open');

  const monthStart = useMemo(() => startOfMonth(parseISO(`${selectedMonth}-01`)), [selectedMonth]);
  const monthEnd = useMemo(() => endOfMonth(monthStart), [monthStart]);

  const calculateSalary = (employee: Employee): SalaryPreview => {
    const empId = employee.id!;
    const monthAttendance = attendance.filter((a) => {
      if (a.employeeId !== empId) return false;
      try {
        return isWithinInterval(parseISO(a.date), { start: monthStart, end: monthEnd });
      } catch {
        return a.date.startsWith(selectedMonth);
      }
    });

    const totalHours = monthAttendance.reduce((sum, a) => sum + (a.totalHours || 0), 0);
    const salaryType: 'monthly' | 'hourly' =
      employee.salaryType === 'hourly' ? 'hourly' : 'monthly';
    const rate = Number(employee.salary || 0);
    const basicSalary =
      salaryType === 'hourly'
        ? Math.round(totalHours * rate * 100) / 100
        : Math.round(rate * 100) / 100;

    const adj = adjustments[empId] || { bonuses: '0', deductions: '0' };
    const bonuses = Math.max(0, parseFloat(adj.bonuses || '0') || 0);
    const deductions = Math.max(0, parseFloat(adj.deductions || '0') || 0);
    const netSalary = Math.max(0, Math.round((basicSalary + bonuses - deductions) * 100) / 100);

    return {
      employee,
      salaryType,
      totalHours,
      hourlyRate: rate,
      basicSalary,
      bonuses,
      deductions,
      netSalary,
      periodStart: format(monthStart, 'yyyy-MM-dd'),
      periodEnd: format(monthEnd, 'yyyy-MM-dd'),
    };
  };

  const handleConfirmPayout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payoutModalData) return;

    setIsProcessing(true);
    try {
      const payrollId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      const targetBranchId = payoutModalData.employee.branchId ?? user?.branchId;

      await dispatchOperation(
        'payroll',
        {
          id: payrollId,
          employeeId: payoutModalData.employee.id!,
          employeeName: payoutModalData.employee.name,
          periodStart: payoutModalData.periodStart,
          periodEnd: payoutModalData.periodEnd,
          salaryType: payoutModalData.salaryType,
          totalHours: payoutModalData.totalHours,
          hourlyRate: payoutModalData.hourlyRate,
          basicSalary: payoutModalData.basicSalary,
          bonuses: payoutModalData.bonuses,
          deductions: payoutModalData.deductions,
          netSalary: payoutModalData.netSalary,
          paymentMethod: payoutMethod,
          shiftId: payoutMethod === 'cash' ? openShift?.id : undefined,
          branchId: targetBranchId,
          paymentDate: new Date().toISOString(),
          status: 'paid',
        },
        targetBranchId
      );

      toast.success(`تم صرف راتب ${payoutModalData.employee.name} بنجاح`);
      setPayoutModalData(null);
    } catch (error: any) {
      console.error('Error processing payroll:', error);
      toast.error(error?.message || 'خطأ في معالجة الراتب');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExportCSV = () => {
    const headers = [
      'الموظف',
      'نظام الراتب',
      'ساعات العمل',
      'الأجر/الأساسي',
      'الراتب المحتسب',
      'الحوافز',
      'الخصومات',
      'الصافي',
      'الحالة',
      'طريقة الصرف',
    ];

    const rows = employees.map((emp) => {
      const paidRecord = payrollRecords.find(
        (r) => r.employeeId === emp.id && r.periodStart.startsWith(selectedMonth)
      );
      const preview = calculateSalary(emp);
      const sType = (paidRecord?.salaryType || preview.salaryType) === 'hourly' ? 'بالساعة' : 'شهري';
      const hours = paidRecord ? paidRecord.totalHours : preview.totalHours;
      const basic = paidRecord ? paidRecord.basicSalary : preview.basicSalary;
      const bonuses = paidRecord ? paidRecord.bonuses : preview.bonuses;
      const deductions = paidRecord ? paidRecord.deductions : preview.deductions;
      const net = paidRecord ? paidRecord.netSalary : preview.netSalary;
      const statusText = paidRecord ? 'تم الصرف' : 'قيد الانتظار';
      const methodText = paidRecord
        ? paidRecord.paymentMethod === 'card'
          ? 'شبكة/تحويل'
          : 'نقدي'
        : '-';

      return [
        `"${emp.name}"`,
        `"${sType}"`,
        hours.toFixed(1),
        emp.salary.toFixed(2),
        basic.toFixed(2),
        bonuses.toFixed(2),
        deductions.toFixed(2),
        net.toFixed(2),
        `"${statusText}"`,
        `"${methodText}"`,
      ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `payroll_${selectedMonth}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const totalPaidThisMonth = payrollRecords
    .filter((r) => r.periodStart.startsWith(selectedMonth))
    .reduce((sum, r) => sum + Number(r.netSalary || 0), 0);

  const totalMonthHours = attendance
    .filter((a) => a.date.startsWith(selectedMonth))
    .reduce((sum, a) => sum + Number(a.totalHours || 0), 0);

  return (
    <div className="lineage-page lineage-payroll-page min-h-full min-w-0 space-y-4 overflow-y-auto bg-[var(--app-bg)] p-3 custom-scrollbar sm:space-y-6 sm:p-6" dir="rtl">
      <div className="flex flex-wrap justify-between items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">إدارة الرواتب</h1>
          <p className="text-slate-500 text-sm mt-1">
            حساب وصرف الرواتب الشهرية وبالساعة مع الحوافز والخصومات
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="month"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="px-3.5 py-2 bg-white border border-slate-200 rounded-xl text-sm tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none"
          />
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 transition-colors whitespace-nowrap"
          >
            <Download className="w-4 h-4" />
            تصدير CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-white p-5 rounded-2xl border border-slate-200 flex items-center gap-4">
          <div className="p-3 bg-indigo-50 border border-indigo-200 text-indigo-600 rounded-xl">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs text-slate-500 font-bold">إجمالي الموظفين</p>
            <p className="text-2xl font-black text-slate-900 tabular-nums">{employees.length}</p>
          </div>
        </div>
        <div className="bg-white p-5 rounded-2xl border border-slate-200 flex items-center gap-4">
          <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-600 rounded-xl">
            <DollarSign className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs text-slate-500 font-bold">إجمالي الرواتب المصروفة</p>
            <p className="text-2xl font-black text-slate-900 tabular-nums">
              {totalPaidThisMonth.toFixed(2)} {storeSettings.currency}
            </p>
          </div>
        </div>
        <div className="bg-white p-5 rounded-2xl border border-slate-200 flex items-center gap-4">
          <div className="p-3 bg-amber-50 border border-amber-200 text-amber-600 rounded-xl">
            <Clock className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs text-slate-500 font-bold">ساعات العمل المسجلة</p>
            <p className="text-2xl font-black text-slate-900 tabular-nums">
              {totalMonthHours.toFixed(1)} ساعة
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/70">
          <h2 className="text-base font-bold text-slate-900 tabular-nums">
            كشف الرواتب لشهر {selectedMonth}
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right">
            <thead className="bg-slate-50 text-slate-500 text-xs font-bold border-b border-slate-200">
              <tr>
                <th className="px-5 py-3.5">الموظف</th>
                <th className="px-5 py-3.5">النظام</th>
                <th className="px-5 py-3.5">الساعات / الأساسي</th>
                <th className="px-5 py-3.5">المكافآت (+)</th>
                <th className="px-5 py-3.5">الخصومات (-)</th>
                <th className="px-5 py-3.5">الصافي المستحق</th>
                <th className="px-5 py-3.5">الحالة</th>
                <th className="px-5 py-3.5 text-center">الإجراء</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm tabular-nums">
              {employees.map((employee) => {
                const salaryData = calculateSalary(employee);
                const paidRecord = payrollRecords.find(
                  (r) => r.employeeId === employee.id && r.periodStart.startsWith(selectedMonth)
                );
                const adj = adjustments[employee.id!] || { bonuses: '0', deductions: '0' };

                return (
                  <tr key={employee.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="px-5 py-3.5 font-bold text-slate-900">{employee.name}</td>
                    <td className="px-5 py-3.5">
                      <span className="px-2 py-0.5 rounded-md border border-slate-200 bg-slate-50 text-xs font-bold text-slate-700">
                        {salaryData.salaryType === 'hourly' ? 'بالساعة' : 'شهري ثابت'}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-slate-600">
                      {salaryData.salaryType === 'hourly' ? (
                        <span>
                          {salaryData.totalHours.toFixed(1)} س × {employee.salary.toFixed(2)} ={' '}
                          <strong className="text-slate-900">{salaryData.basicSalary.toFixed(2)}</strong>
                        </span>
                      ) : (
                        <strong className="text-slate-900">
                          {salaryData.basicSalary.toFixed(2)} {storeSettings.currency}
                        </strong>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      {paidRecord ? (
                        <span className="text-emerald-700 font-bold">
                          +{Number(paidRecord.bonuses || 0).toFixed(2)}
                        </span>
                      ) : (
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={adj.bonuses}
                          onChange={(e) =>
                            setAdjustments((prev) => ({
                              ...prev,
                              [employee.id!]: { ...adj, bonuses: e.target.value },
                            }))
                          }
                          className="w-24 px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      {paidRecord ? (
                        <span className="text-rose-600 font-bold">
                          -{Number(paidRecord.deductions || 0).toFixed(2)}
                        </span>
                      ) : (
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={adj.deductions}
                          onChange={(e) =>
                            setAdjustments((prev) => ({
                              ...prev,
                              [employee.id!]: { ...adj, deductions: e.target.value },
                            }))
                          }
                          className="w-24 px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                      )}
                    </td>
                    <td className="px-5 py-3.5 font-black text-indigo-700">
                      {(paidRecord ? paidRecord.netSalary : salaryData.netSalary).toFixed(2)}{' '}
                      {storeSettings.currency}
                    </td>
                    <td className="px-5 py-3.5">
                      {paidRecord ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-bold bg-emerald-50 text-emerald-700 border-emerald-200 whitespace-nowrap">
                          <CheckCircle className="w-3.5 h-3.5" />
                          تم الصرف ({paidRecord.paymentMethod === 'card' ? 'شبكة' : 'نقدي'})
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-bold bg-amber-50 text-amber-800 border-amber-200 whitespace-nowrap">
                          <AlertCircle className="w-3.5 h-3.5" />
                          قيد الانتظار
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      {!paidRecord && (
                        <button
                          onClick={() => {
                            setPayoutMethod('cash');
                            setPayoutModalData(salaryData);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-xs font-bold whitespace-nowrap"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          صرف الراتب
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {employees.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-6 py-10 text-center text-slate-400">
                    لا يوجد موظفون مسجلون
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Payout Confirmation & Payment Method Modal */}
      {payoutModalData && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-base font-bold text-slate-900">
                تأكيد صرف راتب: {payoutModalData.employee.name}
              </h3>
              <button
                onClick={() => setPayoutModalData(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleConfirmPayout} className="p-5 space-y-4 text-sm">
              <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 space-y-1.5 tabular-nums">
                <div className="flex justify-between text-slate-600">
                  <span>الراتب الأساسي:</span>
                  <span className="font-bold">{payoutModalData.basicSalary.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-emerald-700">
                  <span>الحوافز والمكافآت:</span>
                  <span className="font-bold">+{payoutModalData.bonuses.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-rose-600">
                  <span>الخصومات:</span>
                  <span className="font-bold">-{payoutModalData.deductions.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-indigo-700 font-black text-base pt-2 border-t border-slate-200">
                  <span>الصافي للصرف:</span>
                  <span>
                    {payoutModalData.netSalary.toFixed(2)} {storeSettings.currency}
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">طريقة الصرف</label>
                <select
                  value={payoutMethod}
                  onChange={(e) => setPayoutMethod(e.target.value as 'cash' | 'card')}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="cash">نقدي (من صندوق الكاشير 1010)</option>
                  <option value="card">تحويل بنكي / شبكة (1020)</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPayoutModalData(null)}
                  className="px-4 py-2 border border-slate-200 rounded-xl text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isProcessing}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-bold disabled:opacity-50"
                >
                  {isProcessing ? 'جاري الصرف...' : 'اعتماد وصرف الراتب'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Payroll;
