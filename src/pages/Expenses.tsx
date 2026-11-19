import { useState, useMemo } from 'react';
import { usePosFirstRecordWhereEquals } from '../hooks/usePosFirstRecordWhereEquals';
import { usePosEntityRecords } from '../hooks/usePosEntityRecords';
import { Plus, Trash2, Wallet, Calendar, Tag, FileText, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import type { Expense } from '../db/db';
import { format } from 'date-fns';
import { arSA } from 'date-fns/locale';
import { useSettings } from '../hooks/useSettings';
import { useAuth } from '../context/AuthContext';
import { dispatchOperation } from '../services/operationService';
import ConfirmationModal from '../components/ConfirmationModal';

export default function Expenses() {
  const storeSettings = useSettings();
  const { user } = useAuth();

  // Data State using Dexie Live Query
  const allExpenses = usePosEntityRecords<any>('expenses');
  const openShift = usePosFirstRecordWhereEquals<any>('shifts', 'status', 'open');

  const expenses = useMemo(
    () =>
      [...allExpenses].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      ),
    [allExpenses]
  );

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('عام');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card'>('cash');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [expenseToDelete, setExpenseToDelete] = useState<Expense | null>(null);

  const expenseCategories = ['عام', 'رواتب', 'إيجار', 'فواتير', 'صيانة', 'مشتريات'];

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      toast.error('الرجاء إدخال مبلغ صحيح');
      return;
    }

    if (!description.trim()) {
      toast.error('الرجاء إدخال وصف المصروف');
      return;
    }

    const now = new Date().toISOString();
    const expenseId = Date.now() * 1000 + Math.floor(Math.random() * 1000);

    try {
      await dispatchOperation(
        'expense',
        {
          id: expenseId,
          description: description.trim(),
          amount: parsedAmount,
          category,
          paymentMethod,
          shiftId: paymentMethod === 'cash' ? openShift?.id : undefined,
          date: new Date(date).toISOString(),
          branchId: user?.branchId,
          createdAt: now,
        },
        user?.branchId
      );

      toast.success('تمت إضافة المصروف بنجاح');
      setIsModalOpen(false);
      setDescription('');
      setAmount('');
      setCategory('عام');
      setPaymentMethod('cash');
      setDate(new Date().toISOString().split('T')[0]);
    } catch (error: any) {
      console.error('Error adding expense:', error);
      toast.error(error?.message || 'حدث خطأ أثناء إضافة المصروف');
    }
  };

  const confirmDeleteExpense = async () => {
    if (!expenseToDelete) return;
    try {
      await dispatchOperation('expense_delete', { id: expenseToDelete.id! }, user?.branchId);
      toast.success('تم حذف المصروف وعكس القيد المحاسبي');
      setExpenseToDelete(null);
    } catch (error: any) {
      console.error('Error deleting expense:', error);
      toast.error(error?.message || 'حدث خطأ أثناء الحذف');
      setExpenseToDelete(null);
    }
  };

  const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);

  return (
    <div className="p-6 h-full flex flex-col bg-[var(--app-bg)]" dir="rtl">
      <div className="flex justify-between items-center mb-6 shrink-0 gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">المصروفات</h2>
          <p className="text-slate-500 text-sm mt-1">إدارة وتسجيل المصروفات التشغيلية</p>
        </div>
        <button
          onClick={() => setIsModalOpen(true)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-xl font-bold flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="w-5 h-5" />
          إضافة مصروف
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-6 shrink-0">
        <div className="bg-white rounded-2xl p-5 border border-slate-200 flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-600">
            <Wallet className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs text-slate-500 font-bold mb-1">إجمالي المصروفات</p>
            <p className="text-2xl font-black text-slate-900 tabular-nums">
              {totalExpenses.toFixed(2)}{' '}
              <span className="text-xs text-slate-500 font-normal">{storeSettings.currency}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 flex-1 flex flex-col overflow-hidden">
        <div className="overflow-x-auto flex-1 custom-scrollbar">
          <table className="w-full text-right">
            <thead className="bg-slate-50 text-slate-500 text-xs font-bold border-b border-slate-200 sticky top-0 z-10">
              <tr>
                <th className="px-6 py-3.5">التاريخ</th>
                <th className="px-6 py-3.5">الوصف</th>
                <th className="px-6 py-3.5">التصنيف</th>
                <th className="px-6 py-3.5">طريقة الدفع</th>
                <th className="px-6 py-3.5">المبلغ</th>
                <th className="px-6 py-3.5 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {expenses.map((expense) => (
                <tr key={expense.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-6 py-3.5 whitespace-nowrap text-slate-500 tabular-nums">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-slate-400" />
                      {format(new Date(expense.date), 'dd MMMM yyyy', { locale: arSA })}
                    </div>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap">
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0 h-9 w-9 bg-slate-100 border border-slate-200 rounded-lg flex items-center justify-center">
                        <FileText className="h-4 w-4 text-slate-500" />
                      </div>
                      <span className="font-bold text-slate-900">{expense.description}</span>
                    </div>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap">
                    <span className="px-2.5 py-1 inline-flex text-xs font-bold rounded-lg bg-slate-100 border border-slate-200 text-slate-700 items-center gap-1 w-fit">
                      <Tag className="w-3 h-3" />
                      {expense.category}
                    </span>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap">
                    <span
                      className={`px-2.5 py-1 rounded-lg border text-xs font-bold ${
                        expense.paymentMethod === 'card'
                          ? 'bg-blue-50 text-blue-700 border-blue-200'
                          : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      }`}
                    >
                      {expense.paymentMethod === 'card' ? 'شبكة / بنك' : 'نقدي'}
                    </span>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap font-black text-rose-600 tabular-nums">
                    {expense.amount.toFixed(2)} {storeSettings.currency}
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap text-center">
                    <button
                      onClick={() => setExpenseToDelete(expense)}
                      className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                      title="حذف"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {expenses.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-400">
                    لا توجد مصروفات مسجلة
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Expense Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex justify-between items-center p-5 border-b border-slate-200 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-900">إضافة مصروف جديد</h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddExpense} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">الوصف</label>
                <input
                  type="text"
                  required
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="مثال: فاتورة كهرباء"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    المبلغ ({storeSettings.currency})
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">طريقة الدفع</label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as 'cash' | 'card')}
                    className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                  >
                    <option value="cash">نقدي (من الدرج)</option>
                    <option value="card">شبكة / تحويل بنكي</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">التصنيف</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                  >
                    {expenseCategories.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">التاريخ</label>
                  <input
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none text-right"
                    dir="ltr"
                  />
                </div>
              </div>

              <div className="pt-2 flex gap-2.5">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="flex-1 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 py-2.5 rounded-xl text-sm font-bold transition-colors"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl text-sm font-bold transition-colors"
                >
                  حفظ المصروف
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmationModal
        isOpen={Boolean(expenseToDelete)}
        variant="danger"
        title="حذف المصروف"
        message={
          expenseToDelete
            ? `هل أنت متأكد من حذف مصروف "${expenseToDelete.description}" بقيمة ${expenseToDelete.amount.toFixed(2)} ${storeSettings.currency}؟ سيتم عكس القيد المحاسبي المرتبط به.`
            : ''
        }
        confirmLabel="حذف المصروف"
        onConfirm={confirmDeleteExpense}
        onCancel={() => setExpenseToDelete(null)}
      />
    </div>
  );
}
