import { useState, useMemo, useRef } from 'react';
import { usePosFirstRecordWhereEquals } from '../hooks/usePosFirstRecordWhereEquals';
import { usePosEntityRecords } from '../hooks/usePosEntityRecords';
import {
  Plus,
  Search,
  Edit2,
  Trash2,
  Phone,
  Mail,
  MapPin,
  DollarSign,
  X,
  Truck,
  Receipt,
  FileText,
  Printer,
  Download,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import type { Supplier, Purchase, PurchaseItem } from '../db/db';
import { getPosRecordsWhereEquals } from '../services/posDataAccess';
import { useSettings } from '../hooks/useSettings';
import PurchaseReceipt from '../components/PurchaseReceipt';
import { format } from 'date-fns';
import { useReactToPrint } from 'react-to-print';
import { dispatchOperation } from '../services/operationService';
import { useAuth } from '../context/AuthContext';
import ConfirmationModal from '../components/ConfirmationModal';

interface SupplierStatementRow {
  id: string;
  date: string;
  type: string;
  ref: string;
  credit: number; // له (مشتريات)
  debit: number; // عليه (مدفوعات ومرتجعات)
  runningBalance: number;
}

export default function Suppliers() {
  const storeSettings = useSettings();
  const { user } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [supplierToDelete, setSupplierToDelete] = useState<Supplier | null>(null);

  const [selectedSupplierForPayment, setSelectedSupplierForPayment] = useState<Supplier | null>(
    null
  );
  const [supplierUnpaidPurchases, setSupplierUnpaidPurchases] = useState<Purchase[]>([]);
  const [customPayAmount, setCustomPayAmount] = useState('');
  const [customPayMethod, setCustomPayMethod] = useState<'cash' | 'card'>('cash');
  const [customPayNotes, setCustomPayNotes] = useState('');
  const [isPayingCustom, setIsPayingCustom] = useState(false);

  const [selectedPurchaseForPreview, setSelectedPurchaseForPreview] = useState<{
    purchase: Purchase;
    items: PurchaseItem[];
  } | null>(null);

  // Account Statement Modal
  const [statementSupplier, setStatementSupplier] = useState<Supplier | null>(null);
  const statementPrintRef = useRef<HTMLDivElement>(null);
  const handlePrintStatement = useReactToPrint({
    contentRef: statementPrintRef,
    documentTitle: `Supplier-Statement-${statementSupplier?.name || 'Report'}`,
  });

  // Data State using Dexie Live Query
  const allSuppliers = usePosEntityRecords<any>('suppliers');
  const allPurchases = usePosEntityRecords<any>('purchases');
  const allPurchaseReturns = usePosEntityRecords<any>('purchaseReturns');
  const allSupplierPayments = usePosEntityRecords<any>('supplierPayments');
  const openShift = usePosFirstRecordWhereEquals<any>('shifts', 'status', 'open');

  const suppliers = useMemo(() => {
    if (!searchQuery) return allSuppliers;
    const q = searchQuery.toLowerCase();
    return allSuppliers.filter(
      (s) => (s.name || '').toLowerCase().includes(q) || (s.phone || '').includes(searchQuery)
    );
  }, [allSuppliers, searchQuery]);

  const statementData = useMemo(() => {
    if (!statementSupplier?.id)
      return { rows: [] as SupplierStatementRow[], totalCredit: 0, totalDebit: 0 };

    const sid = statementSupplier.id;
    const rawEvents: Array<{
      id: string;
      date: string;
      type: string;
      ref: string;
      credit: number;
      debit: number;
    }> = [];

    for (const p of allPurchases) {
      if (p.supplierId !== sid) continue;
      rawEvents.push({
        id: `pur-${p.id}`,
        date: p.date || p.createdAt,
        type: 'فاتورة مشتريات',
        ref: p.id?.slice(0, 10) || '-',
        credit: Number(p.totalAmount || 0),
        debit: 0,
      });

      const linkedPaymentsSum = allSupplierPayments
        .filter((sp) => sp.purchaseId === p.id)
        .reduce((sum, sp) => sum + Number(sp.amount || 0), 0);
      const upfrontPaid = Math.max(
        0,
        Math.round((Number(p.paidAmount || 0) - linkedPaymentsSum) * 100) / 100
      );
      if (upfrontPaid > 0.01) {
        rawEvents.push({
          id: `pur-paid-${p.id}`,
          date: p.createdAt || p.date,
          type: `دفعة عند الشراء (${p.paymentMethod === 'card' ? 'شبكة' : 'نقدي'})`,
          ref: p.id?.slice(0, 10) || '-',
          credit: 0,
          debit: upfrontPaid,
        });
      }
    }

    for (const r of allPurchaseReturns) {
      if (r.supplierId !== sid) continue;
      if (r.refundMethod === 'credit_adjustment') {
        rawEvents.push({
          id: `pret-${r.id}`,
          date: r.createdAt,
          type: 'مرتجع مشتريات (خصم من المستحق)',
          ref: r.returnNumber || r.id.slice(0, 8),
          credit: 0,
          debit: Number(r.totalReturn || 0),
        });
      }
    }

    for (const sp of allSupplierPayments) {
      if (sp.supplierId !== sid) continue;
      rawEvents.push({
        id: `spay-${sp.id}`,
        date: sp.createdAt,
        type: sp.paymentMethod === 'card' ? 'سند صرف للمورد (شبكة)' : 'سند صرف للمورد (نقدي)',
        ref: sp.notes || sp.id.slice(0, 8),
        credit: 0,
        debit: Number(sp.amount || 0),
      });
    }

    rawEvents.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let running = 0;
    let totalCredit = 0;
    let totalDebit = 0;
    const rows: SupplierStatementRow[] = rawEvents.map((ev) => {
      running = Math.round((running + ev.credit - ev.debit) * 100) / 100;
      totalCredit = Math.round((totalCredit + ev.credit) * 100) / 100;
      totalDebit = Math.round((totalDebit + ev.debit) * 100) / 100;
      return { ...ev, runningBalance: running };
    });

    return { rows, totalCredit, totalDebit };
  }, [statementSupplier, allPurchases, allPurchaseReturns, allSupplierPayments]);

  const handleExportStatementCSV = () => {
    if (!statementSupplier) return;
    const headers = ['التاريخ', 'البيان', 'المرجع', 'له (مشتريات)', 'عليه (مدفوعات/مرتجعات)', 'الرصيد التراكمي'];
    const lines = [
      headers.join(','),
      ...statementData.rows.map((r) =>
        [
          `"${format(new Date(r.date), 'yyyy-MM-dd HH:mm')}"`,
          `"${r.type}"`,
          `"${r.ref}"`,
          r.credit.toFixed(2),
          r.debit.toFixed(2),
          r.runningBalance.toFixed(2),
        ].join(',')
      ),
    ].join('\n');

    const blob = new Blob(['\uFEFF' + lines], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `supplier_statement_${statementSupplier.name}_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Add/Edit Form state
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [balance, setBalance] = useState('0');

  const handleOpenModal = (supplier?: Supplier) => {
    if (supplier) {
      setEditingSupplier(supplier);
      setName(supplier.name);
      setPhone(supplier.phone);
      setEmail(supplier.email || '');
      setAddress(supplier.address || '');
      setBalance(supplier.balance.toString());
    } else {
      setEditingSupplier(null);
      setName('');
      setPhone('');
      setEmail('');
      setAddress('');
      setBalance('0');
    }
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingSupplier(null);
  };

  const handleSaveSupplier = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim() || !phone.trim()) {
      toast.error('الرجاء إدخال اسم المورد ورقم الهاتف');
      return;
    }

    const parsedBalance = parseFloat(balance) || 0;
    const now = new Date().toISOString();

    try {
      const record: Supplier = editingSupplier?.id
        ? {
            ...editingSupplier,
            name: name.trim(),
            phone: phone.trim(),
            email: email.trim(),
            address: address.trim(),
            updatedAt: now,
            syncStatus: 'pending',
          }
        : {
            id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
            name: name.trim(),
            phone: phone.trim(),
            email: email.trim(),
            address: address.trim(),
            balance: parsedBalance,
            createdAt: now,
            updatedAt: now,
            syncStatus: 'pending',
          };

      await dispatchOperation('entity_upsert', { table: 'suppliers', record }, user?.branchId);

      toast.success(editingSupplier ? 'تم تحديث بيانات المورد بنجاح' : 'تمت إضافة المورد بنجاح');
      handleCloseModal();
    } catch (error: any) {
      console.error('Error saving supplier:', error);
      toast.error(error?.message || 'حدث خطأ أثناء حفظ بيانات المورد');
    }
  };

  const confirmDeleteSupplier = async () => {
    if (!supplierToDelete?.id) return;
    if (Math.abs(supplierToDelete.balance) > 0.01) {
      toast.error('لا يمكن حذف مورد لديه رصيد مستحق');
      setSupplierToDelete(null);
      return;
    }

    try {
      await dispatchOperation(
        'entity_delete',
        { table: 'suppliers', id: supplierToDelete.id },
        user?.branchId
      );
      toast.success('تم حذف المورد بنجاح');
      setSupplierToDelete(null);
    } catch (error: any) {
      console.error('Error deleting supplier:', error);
      toast.error(error?.message || 'حدث خطأ أثناء حذف المورد');
      setSupplierToDelete(null);
    }
  };

  const handlePayment = async (supplier: Supplier) => {
    setSelectedSupplierForPayment(supplier);
    setCustomPayAmount(supplier.balance > 0 ? supplier.balance.toFixed(2) : '');
    setCustomPayMethod('cash');
    setCustomPayNotes('');
    try {
      const supplierPurchases = await getPosRecordsWhereEquals<Purchase>('purchases', 'supplierId', supplier.id!);
      const unpaidPurchases = supplierPurchases.filter((purchase) => {
        const remaining = purchase.totalAmount - (purchase.returnedAmount || 0) - purchase.paidAmount;
        return purchase.paymentStatus !== 'paid' && remaining > 0.01;
      });
      unpaidPurchases.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setSupplierUnpaidPurchases(unpaidPurchases);
    } catch (error) {
      console.error('Error fetching unpaid purchases:', error);
      toast.error('حدث خطأ أثناء جلب الفواتير المستحقة');
    }
  };

  const payPurchase = async (purchase: Purchase, method: 'cash' | 'card') => {
    try {
      const amountToPay = Math.max(
        0,
        Math.round(
          (purchase.totalAmount - (purchase.returnedAmount || 0) - purchase.paidAmount) * 100
        ) / 100
      );
      if (amountToPay <= 0) return;

      await dispatchOperation(
        'supplier_payment',
        {
          supplierId: purchase.supplierId!,
          amount: amountToPay,
          paymentMethod: method,
          purchaseId: purchase.id,
          shiftId: method === 'cash' ? openShift?.id : undefined,
          branchId: purchase.branchId ?? user?.branchId,
          createdBy: user?.name || 'System',
        },
        purchase.branchId ?? user?.branchId
      );

      toast.success(`تم تسديد الفاتورة بنجاح (${method === 'cash' ? 'نقدي' : 'شبكة'})`);

      setSupplierUnpaidPurchases((prev) => prev.filter((p) => p.id !== purchase.id));
      setSelectedSupplierForPayment((prev) =>
        prev
          ? { ...prev, balance: Math.round((prev.balance - amountToPay) * 100) / 100 }
          : null
      );
    } catch (error: any) {
      console.error('Error paying purchase:', error);
      toast.error(error?.message || 'حدث خطأ أثناء تسديد الفاتورة');
    }
  };

  const handleCustomPaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSupplierForPayment?.id) return;

    const amount = parseFloat(customPayAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error('الرجاء إدخال مبلغ صحيح أكبر من صفر');
      return;
    }

    setIsPayingCustom(true);
    try {
      await dispatchOperation(
        'supplier_payment',
        {
          supplierId: selectedSupplierForPayment.id,
          amount,
          paymentMethod: customPayMethod,
          notes: customPayNotes.trim() || 'سداد دفعة على الحساب',
          shiftId: customPayMethod === 'cash' ? openShift?.id : undefined,
          branchId: user?.branchId,
          createdBy: user?.name || 'System',
        },
        user?.branchId
      );
      toast.success('تم تسديد الدفعة للمورد بنجاح');
      setSelectedSupplierForPayment(null);
    } catch (err: any) {
      toast.error(err?.message || 'حدث خطأ أثناء تسديد الدفعة');
    } finally {
      setIsPayingCustom(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-[var(--app-bg)] p-3 sm:p-6" dir="rtl">
      <div className="mb-4 flex shrink-0 flex-col items-stretch justify-between gap-3 sm:mb-6 sm:flex-row sm:items-center sm:gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">الموردون</h2>
          <p className="text-slate-500 text-sm mt-1">
            إدارة بيانات الموردين والذمم الدائنة وكشوف الحساب
          </p>
        </div>
        <button
          onClick={() => handleOpenModal()}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          إضافة مورد
        </button>
      </div>

      <div className="flex min-h-[20rem] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="p-4 border-b border-slate-200 bg-slate-50/60 shrink-0">
          <div className="relative max-w-md">
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-slate-400" />
            </div>
            <input
              type="text"
              placeholder="البحث برقم الهاتف أو اسم المورد..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="block w-full pl-3 pr-9 py-2 border border-slate-200 bg-white rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
            />
          </div>
        </div>

        <div className="overflow-x-auto flex-1 custom-scrollbar">
          <table className="w-full text-right">
            <thead className="bg-slate-50 text-slate-500 text-xs font-bold border-b border-slate-200 sticky top-0 z-10">
              <tr>
                <th className="px-6 py-3.5">اسم المورد</th>
                <th className="px-6 py-3.5">معلومات التواصل</th>
                <th className="px-6 py-3.5">الرصيد المستحق للمورد</th>
                <th className="px-6 py-3.5 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {suppliers.map((supplier) => (
                <tr key={supplier.id} className="hover:bg-slate-50/70 transition-colors">
                  <td className="px-6 py-3.5 whitespace-nowrap">
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0 h-9 w-9 bg-indigo-50 border border-indigo-200 rounded-lg flex items-center justify-center text-indigo-600">
                        <Truck className="w-4 h-4" />
                      </div>
                      <div className="font-bold text-slate-900">{supplier.name}</div>
                    </div>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap">
                    <div className="flex flex-col gap-1 text-xs text-slate-500">
                      <div className="flex items-center gap-1.5 font-mono tabular-nums">
                        <Phone className="w-3.5 h-3.5" />
                        <span dir="ltr">{supplier.phone}</span>
                      </div>
                      {supplier.email && (
                        <div className="flex items-center gap-1.5">
                          <Mail className="w-3.5 h-3.5" />
                          <span>{supplier.email}</span>
                        </div>
                      )}
                      {supplier.address && (
                        <div className="flex items-center gap-1.5">
                          <MapPin className="w-3.5 h-3.5" />
                          <span>{supplier.address}</span>
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap tabular-nums">
                    <span
                      className={`px-2.5 py-1 inline-flex text-xs font-bold rounded-lg border ${
                        supplier.balance > 0
                          ? 'bg-rose-50 text-rose-700 border-rose-200'
                          : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      }`}
                    >
                      {supplier.balance.toFixed(2)} {storeSettings.currency}
                    </span>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap text-center">
                    <div className="flex items-center justify-center gap-1.5">
                      <button
                        onClick={() => setStatementSupplier(supplier)}
                        className="text-slate-700 hover:bg-slate-100 border border-slate-200 px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors"
                        title="كشف حساب المورد"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        كشف حساب
                      </button>
                      <button
                        onClick={() => handlePayment(supplier)}
                        className="text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors"
                        title="تسجيل دفعة"
                      >
                        <DollarSign className="w-3.5 h-3.5" />
                        دفعة
                      </button>
                      <button
                        onClick={() => handleOpenModal(supplier)}
                        className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                        title="تعديل"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() =>
                          Math.abs(supplier.balance) > 0.01
                            ? toast.error('لا يمكن حذف مورد لديه رصيد مستحق')
                            : setSupplierToDelete(supplier)
                        }
                        className="p-2 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                        title="حذف"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {suppliers.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-12 text-center text-slate-400">
                    لا يوجد موردين مطابقين للبحث
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Payment Modal */}
      {selectedSupplierForPayment && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-base font-bold text-slate-900">
                سداد مستحقات المورد: {selectedSupplierForPayment.name}
              </h3>
              <button
                onClick={() => setSelectedSupplierForPayment(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto custom-scrollbar flex-1 space-y-5">
              <div className="bg-amber-50 text-amber-900 p-4 rounded-xl border border-amber-200 flex justify-between items-center">
                <span className="text-sm font-bold">إجمالي الرصيد المستحق للمورد:</span>
                <span className="text-xl font-black tabular-nums">
                  {selectedSupplierForPayment.balance.toFixed(2)} {storeSettings.currency}
                </span>
              </div>

              {/* Custom / Partial Payment Form */}
              <form
                onSubmit={handleCustomPaymentSubmit}
                className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-3"
              >
                <h4 className="text-sm font-bold text-slate-800">تسديد دفعة على الحساب (جزئية أو كاملة)</h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">
                      المبلغ ({storeSettings.currency})
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      value={customPayAmount}
                      onChange={(e) => setCustomPayAmount(e.target.value)}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm tabular-nums outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="0.00"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">طريقة الدفع</label>
                    <select
                      value={customPayMethod}
                      onChange={(e) => setCustomPayMethod(e.target.value as 'cash' | 'card')}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="cash">نقدي (من الدرج)</option>
                      <option value="card">شبكة / تحويل بنكي</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">ملاحظات</label>
                    <input
                      type="text"
                      value={customPayNotes}
                      onChange={(e) => setCustomPayNotes(e.target.value)}
                      placeholder="سند صرف دفعة"
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={isPayingCustom}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold disabled:opacity-50"
                  >
                    {isPayingCustom ? 'جاري السداد...' : 'اعتماد وصرف الدفعة'}
                  </button>
                </div>
              </form>

              <div>
                <h4 className="font-bold text-slate-900 text-sm mb-3">
                  فواتير الشراء المستحقة ({supplierUnpaidPurchases.length})
                </h4>

                {supplierUnpaidPurchases.length === 0 ? (
                  <div className="text-center py-6 text-slate-400 text-xs bg-slate-50 rounded-xl border border-slate-200">
                    لا توجد فواتير مستحقة لهذا المورد.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {supplierUnpaidPurchases.map((purchase) => {
                      const remaining = Math.max(
                        0,
                        purchase.totalAmount - (purchase.returnedAmount || 0) - purchase.paidAmount
                      );
                      return (
                        <div
                          key={purchase.id}
                          className="flex flex-col sm:flex-row sm:items-center justify-between p-3.5 border border-slate-200 rounded-xl bg-white gap-3"
                        >
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-bold text-sm text-slate-900">
                                فاتورة #{purchase.id?.slice(0, 10)}
                              </span>
                              <span className="text-xs text-slate-500 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md tabular-nums">
                                {format(new Date(purchase.date), 'yyyy/MM/dd')}
                              </span>
                            </div>
                            <div className="text-base font-black text-rose-600 tabular-nums">
                              المتبقي: {remaining.toFixed(2)} {storeSettings.currency}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={async () => {
                                const items = await getPosRecordsWhereEquals<PurchaseItem>('purchaseItems', 'purchaseId', purchase.id!);
                                setSelectedPurchaseForPreview({ purchase, items });
                              }}
                              className="px-3 py-2 bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 rounded-lg text-xs font-bold"
                              title="معاينة"
                            >
                              <Receipt className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => payPurchase(purchase, 'cash')}
                              className="px-3.5 py-2 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded-lg text-xs font-bold whitespace-nowrap"
                            >
                              سداد نقدي
                            </button>
                            <button
                              onClick={() => payPurchase(purchase, 'card')}
                              className="px-3.5 py-2 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 rounded-lg text-xs font-bold whitespace-nowrap"
                            >
                              سداد شبكة
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Detailed Supplier Account Statement Modal */}
      {statementSupplier && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-4xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex flex-wrap justify-between items-center p-4 border-b border-slate-200 bg-slate-50 gap-2">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  كشف حساب المورد: {statementSupplier.name}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                  الهاتف: {statementSupplier.phone} | الرصيد المستحق للمورد:{' '}
                  {statementSupplier.balance.toFixed(2)} {storeSettings.currency}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleExportStatementCSV}
                  className="px-3 py-1.5 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-bold flex items-center gap-1.5 hover:bg-slate-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  CSV
                </button>
                <button
                  onClick={() => handlePrintStatement()}
                  className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 hover:bg-indigo-700"
                >
                  <Printer className="w-3.5 h-3.5" />
                  طباعة
                </button>
                <button
                  onClick={() => setStatementSupplier(null)}
                  className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-5 overflow-y-auto custom-scrollbar flex-1" ref={statementPrintRef}>
              <div className="grid grid-cols-3 gap-3 mb-4 tabular-nums">
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500">إجمالي التوريد والمشتريات (له)</p>
                  <p className="text-base font-black text-slate-900">
                    {statementData.totalCredit.toFixed(2)} {storeSettings.currency}
                  </p>
                </div>
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500">إجمالي المدفوعات والمرتجعات (عليه)</p>
                  <p className="text-base font-black text-emerald-700">
                    {statementData.totalDebit.toFixed(2)} {storeSettings.currency}
                  </p>
                </div>
                <div className="p-3 bg-indigo-50 rounded-xl border border-indigo-200">
                  <p className="text-xs text-indigo-700">الرصيد المستحق الحالي</p>
                  <p className="text-base font-black text-indigo-900">
                    {statementSupplier.balance.toFixed(2)} {storeSettings.currency}
                  </p>
                </div>
              </div>

              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3">التاريخ</th>
                      <th className="px-4 py-3">البيان</th>
                      <th className="px-4 py-3">المرجع</th>
                      <th className="px-4 py-3">له (مشتريات)</th>
                      <th className="px-4 py-3">عليه (مدفوع/مرتجع)</th>
                      <th className="px-4 py-3">الرصيد التراكمي</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 tabular-nums">
                    {statementData.rows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                          لا توجد حركات مسجلة لهذا المورد
                        </td>
                      </tr>
                    ) : (
                      statementData.rows.map((row) => (
                        <tr key={row.id} className="hover:bg-slate-50/70">
                          <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">
                            {format(new Date(row.date), 'yyyy/MM/dd HH:mm')}
                          </td>
                          <td className="px-4 py-2.5 font-bold text-slate-800">{row.type}</td>
                          <td className="px-4 py-2.5 text-slate-600 font-mono">{row.ref}</td>
                          <td className="px-4 py-2.5 text-rose-600 font-bold">
                            {row.credit > 0 ? row.credit.toFixed(2) : '-'}
                          </td>
                          <td className="px-4 py-2.5 text-emerald-700 font-bold">
                            {row.debit > 0 ? row.debit.toFixed(2) : '-'}
                          </td>
                          <td className="px-4 py-2.5 font-black text-slate-900">
                            {row.runningBalance.toFixed(2)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Purchase Preview Modal */}
      {selectedPurchaseForPreview && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-base font-bold text-slate-900">معاينة فاتورة الشراء</h3>
              <button
                onClick={() => setSelectedPurchaseForPreview(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto custom-scrollbar">
              <PurchaseReceipt
                purchase={selectedPurchaseForPreview.purchase}
                items={selectedPurchaseForPreview.items}
                settings={{
                  businessName: storeSettings.businessName,
                  currency: storeSettings.currency,
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit Supplier Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex justify-between items-center p-5 border-b border-slate-200 bg-slate-50">
              <h3 className="text-base font-bold text-slate-900">
                {editingSupplier ? 'تعديل بيانات المورد' : 'إضافة مورد جديد'}
              </h3>
              <button
                onClick={handleCloseModal}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveSupplier} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">اسم المورد *</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="اسم المورد أو الشركة"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">رقم الهاتف *</label>
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none text-left"
                  placeholder="05xxxxxxxx"
                  dir="ltr"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  البريد الإلكتروني
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none text-left"
                  placeholder="example@domain.com"
                  dir="ltr"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">العنوان</label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="المدينة، الحي، الشارع"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  الرصيد الافتتاحي المستحق ({storeSettings.currency})
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={balance}
                  onChange={(e) => setBalance(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none disabled:bg-slate-100"
                  placeholder="0.00"
                  disabled={!!editingSupplier}
                />
                {editingSupplier && (
                  <p className="text-xs text-slate-400 mt-1">
                    لا يمكن تعديل الرصيد من هنا، استخدم زر "دفعة"
                  </p>
                )}
              </div>

              <div className="pt-2 flex gap-2.5">
                <button
                  type="button"
                  onClick={handleCloseModal}
                  className="flex-1 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 py-2.5 rounded-xl text-sm font-bold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl text-sm font-bold"
                >
                  {editingSupplier ? 'حفظ التعديلات' : 'إضافة المورد'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmationModal
        isOpen={Boolean(supplierToDelete)}
        variant="danger"
        title="حذف المورد"
        message={
          supplierToDelete
            ? `هل أنت متأكد من حذف المورد "${supplierToDelete.name}"؟`
            : ''
        }
        confirmLabel="حذف المورد"
        onConfirm={confirmDeleteSupplier}
        onCancel={() => setSupplierToDelete(null)}
      />
    </div>
  );
}
