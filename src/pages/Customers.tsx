import { useState, useMemo, useRef } from 'react';
import { usePosFirstRecordWhereEquals } from '../hooks/usePosFirstRecordWhereEquals';
import { usePosEntityRecords } from '../hooks/usePosEntityRecords';
import {
  Search,
  Plus,
  Edit2,
  Trash2,
  Users,
  CreditCard,
  X,
  Download,
  Upload,
  Receipt,
  FileText,
  Printer,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import type { Customer, Order, OrderItem } from '../db/db';
import { getPosRecordsWhereEquals } from '../services/posDataAccess';
import { format } from 'date-fns';
import { useReactToPrint } from 'react-to-print';
import { Receipt as ReceiptComponent } from '../components/Receipt';
import { useSettings } from '../hooks/useSettings';
import { useAuth } from '../context/AuthContext';
import { dispatchOperation } from '../services/operationService';
import ConfirmationModal from '../components/ConfirmationModal';

interface StatementRow {
  id: string;
  date: string;
  type: string;
  ref: string;
  debit: number;
  credit: number;
  runningBalance: number;
}

export default function Customers() {
  const storeSettings = useSettings();
  const { user } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [customerToDelete, setCustomerToDelete] = useState<Customer | null>(null);

  // Data State using Dexie Live Query
  const allCustomers = usePosEntityRecords<any>('customers');
  const allOrders = usePosEntityRecords<any>('orders');
  const allReturns = usePosEntityRecords<any>('returns');
  const allPayments = usePosEntityRecords<any>('customerPayments');
  const openShift = usePosFirstRecordWhereEquals<any>('shifts', 'status', 'open');

  const customers = useMemo(() => {
    if (!searchQuery) return allCustomers;
    const q = searchQuery.toLowerCase();
    return allCustomers.filter(
      (c) => (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(searchQuery)
    );
  }, [allCustomers, searchQuery]);

  // Add/Edit Form State
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  // Payment Modal State
  const [selectedCustomerForPayment, setSelectedCustomerForPayment] = useState<Customer | null>(
    null
  );
  const [customerUnpaidOrders, setCustomerUnpaidOrders] = useState<Order[]>([]);
  const [customPayAmount, setCustomPayAmount] = useState('');
  const [customPayMethod, setCustomPayMethod] = useState<'cash' | 'card'>('cash');
  const [customPayNotes, setCustomPayNotes] = useState('');
  const [isPayingCustom, setIsPayingCustom] = useState(false);

  // Invoice Preview
  const [selectedInvoiceForPreview, setSelectedInvoiceForPreview] = useState<{
    order: Order;
    items: OrderItem[];
  } | null>(null);

  // Account Statement Modal
  const [statementCustomer, setStatementCustomer] = useState<Customer | null>(null);
  const statementPrintRef = useRef<HTMLDivElement>(null);
  const handlePrintStatement = useReactToPrint({
    contentRef: statementPrintRef,
    documentTitle: `Customer-Statement-${statementCustomer?.name || 'Report'}`,
  });

  const statementData = useMemo(() => {
    if (!statementCustomer?.id) return { rows: [] as StatementRow[], totalDebit: 0, totalCredit: 0 };

    const cid = statementCustomer.id;
    const rawEvents: Array<{
      id: string;
      date: string;
      type: string;
      ref: string;
      debit: number;
      credit: number;
    }> = [];

    for (const o of allOrders) {
      if (o.customerId !== cid || o.status === 'void') continue;
      if (o.paymentMethod === 'credit') {
        rawEvents.push({
          id: `ord-${o.id}`,
          date: o.createdAt,
          type: 'فاتورة بيع آجل',
          ref: o.receiptNumber || o.id?.slice(0, 8) || '-',
          debit: Number(o.netAmount || 0),
          credit: 0,
        });
      } else {
        rawEvents.push({
          id: `ord-${o.id}`,
          date: o.createdAt,
          type: `فاتورة بيع (${o.paymentMethod === 'card' ? 'شبكة' : o.paymentMethod === 'mixed' ? 'مختلط' : 'نقدي'})`,
          ref: o.receiptNumber || o.id?.slice(0, 8) || '-',
          debit: Number(o.netAmount || 0),
          credit: Number(o.netAmount || 0),
        });
      }
    }

    for (const r of allReturns) {
      if (r.customerId !== cid) continue;
      if (r.refundMethod === 'credit_adjustment') {
        rawEvents.push({
          id: `ret-${r.id}`,
          date: r.createdAt,
          type: 'مرتجع مبيعات (خصم من الرصيد)',
          ref: r.returnNumber || r.id.slice(0, 8),
          debit: 0,
          credit: Number(r.totalRefund || 0),
        });
      }
    }

    for (const p of allPayments) {
      if (p.customerId !== cid) continue;
      rawEvents.push({
        id: `pay-${p.id}`,
        date: p.createdAt,
        type: p.paymentMethod === 'card' ? 'سند قبض (شبكة)' : 'سند قبض (نقدي)',
        ref: p.notes || p.id.slice(0, 8),
        debit: 0,
        credit: Number(p.amount || 0),
      });
    }

    rawEvents.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let running = 0;
    let totalDebit = 0;
    let totalCredit = 0;
    const rows: StatementRow[] = rawEvents.map((ev) => {
      running = Math.round((running + ev.debit - ev.credit) * 100) / 100;
      totalDebit = Math.round((totalDebit + ev.debit) * 100) / 100;
      totalCredit = Math.round((totalCredit + ev.credit) * 100) / 100;
      return { ...ev, runningBalance: running };
    });

    return { rows, totalDebit, totalCredit };
  }, [statementCustomer, allOrders, allReturns, allPayments]);

  const handleExportStatementCSV = () => {
    if (!statementCustomer) return;
    const headers = ['التاريخ', 'البيان', 'المرجع', 'مدين (فواتير)', 'دائن (سداد/مرتجع)', 'الرصيد التراكمي'];
    const lines = [
      headers.join(','),
      ...statementData.rows.map((r) =>
        [
          `"${format(new Date(r.date), 'yyyy-MM-dd HH:mm')}"`,
          `"${r.type}"`,
          `"${r.ref}"`,
          r.debit.toFixed(2),
          r.credit.toFixed(2),
          r.runningBalance.toFixed(2),
        ].join(',')
      ),
    ].join('\n');

    const blob = new Blob(['\uFEFF' + lines], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `statement_${statementCustomer.name}_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const openModal = (customer?: Customer) => {
    if (customer) {
      setEditingCustomer(customer);
      setName(customer.name);
      setPhone(customer.phone);
      setEmail(customer.email || '');
    } else {
      setEditingCustomer(null);
      setName('');
      setPhone('');
      setEmail('');
    }
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingCustomer(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !phone.trim()) {
      toast.error('يرجى إدخال اسم العميل ورقم الهاتف');
      return;
    }

    const now = new Date().toISOString();

    try {
      const record: Customer = editingCustomer?.id
        ? {
            ...editingCustomer,
            name: name.trim(),
            phone: phone.trim(),
            email: email.trim(),
            updatedAt: now,
            syncStatus: 'pending',
          }
        : {
            id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
            name: name.trim(),
            phone: phone.trim(),
            email: email.trim(),
            balance: 0,
            points: 0,
            branchId: user?.branchId,
            createdAt: now,
            updatedAt: now,
            syncStatus: 'pending',
          };

      await dispatchOperation(
        'entity_upsert',
        { table: 'customers', record },
        user?.branchId
      );

      toast.success(editingCustomer ? 'تم تحديث بيانات العميل بنجاح' : 'تمت إضافة العميل بنجاح');
      closeModal();
    } catch (error: any) {
      console.error('Error saving customer:', error);
      toast.error(error?.message || 'حدث خطأ أثناء حفظ بيانات العميل');
    }
  };

  const confirmDeleteCustomer = async () => {
    if (!customerToDelete?.id) return;
    if (Math.abs(customerToDelete.balance) > 0.01) {
      toast.error('لا يمكن حذف عميل لديه رصيد مستحق');
      setCustomerToDelete(null);
      return;
    }
    try {
      await dispatchOperation(
        'entity_delete',
        { table: 'customers', id: customerToDelete.id },
        user?.branchId
      );
      toast.success('تم حذف العميل بنجاح');
      setCustomerToDelete(null);
    } catch (error: any) {
      console.error('Error deleting customer:', error);
      toast.error(error?.message || 'حدث خطأ أثناء حذف العميل');
      setCustomerToDelete(null);
    }
  };

  const handlePayment = async (customer: Customer) => {
    setSelectedCustomerForPayment(customer);
    setCustomPayAmount(customer.balance > 0 ? customer.balance.toFixed(2) : '');
    setCustomPayMethod('cash');
    setCustomPayNotes('');
    try {
      const customerOrders = await getPosRecordsWhereEquals<Order>('orders', 'customerId', customer.id!);
      const unpaidOrders = customerOrders.filter((order) => {
        if (
          order.paymentMethod !== 'credit' ||
          order.status === 'void' ||
          order.status === 'returned'
        ) return false;
        const remaining =
          (order.netAmount || 0) - (order.returnedAmount || 0) - (order.paidAmount || 0);
        return remaining > 0.01;
      });
      unpaidOrders.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setCustomerUnpaidOrders(unpaidOrders);
    } catch (error) {
      console.error('Error fetching unpaid orders:', error);
      toast.error('حدث خطأ أثناء جلب الفواتير المستحقة');
    }
  };

  const payInvoice = async (order: Order, method: 'cash' | 'card') => {
    try {
      const remaining = Math.max(
        0,
        Math.round(
          ((order.netAmount || 0) - (order.returnedAmount || 0) - (order.paidAmount || 0)) * 100
        ) / 100
      );
      if (remaining <= 0) return;

      await dispatchOperation(
        'customer_payment',
        {
          customerId: order.customerId!,
          amount: remaining,
          paymentMethod: method,
          orderId: order.id,
          shiftId: method === 'cash' ? openShift?.id : undefined,
          branchId: order.branchId ?? user?.branchId,
          createdBy: user?.name || 'System',
        },
        order.branchId ?? user?.branchId
      );

      toast.success(`تم تسديد الفاتورة بنجاح (${method === 'cash' ? 'نقدي' : 'شبكة'})`);

      setCustomerUnpaidOrders((prev) => prev.filter((o) => o.id !== order.id));
      setSelectedCustomerForPayment((prev) =>
        prev
          ? {
              ...prev,
              balance: Math.max(0, Math.round((prev.balance - remaining) * 100) / 100),
            }
          : null
      );
    } catch (error: any) {
      console.error('Error paying invoice:', error);
      toast.error(error?.message || 'حدث خطأ أثناء تسديد الفاتورة');
    }
  };

  const handleCustomPaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomerForPayment?.id) return;

    const amount = parseFloat(customPayAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error('الرجاء إدخال مبلغ صحيح أكبر من صفر');
      return;
    }

    setIsPayingCustom(true);
    try {
      await dispatchOperation(
        'customer_payment',
        {
          customerId: selectedCustomerForPayment.id,
          amount,
          paymentMethod: customPayMethod,
          notes: customPayNotes.trim() || 'دفعة سداد على الحساب',
          shiftId: customPayMethod === 'cash' ? openShift?.id : undefined,
          branchId: user?.branchId,
          createdBy: user?.name || 'System',
        },
        user?.branchId
      );

      toast.success('تم تحصيل الدفعة بنجاح');
      setSelectedCustomerForPayment(null);
    } catch (err: any) {
      toast.error(err?.message || 'حدث خطأ أثناء التسديد');
    } finally {
      setIsPayingCustom(false);
    }
  };

  const handleExportCSV = () => {
    const headers = ['الاسم', 'رقم الهاتف', 'البريد الإلكتروني', 'الرصيد'];
    const csvContent = [
      headers.join(','),
      ...(customers || []).map((c) =>
        [`"${c.name}"`, `"${c.phone || ''}"`, `"${c.email || ''}"`, c.balance].join(',')
      ),
    ].join('\n');

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `customers_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleImportCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;
        const cleanText = text.replace(/^\uFEFF/, '');
        const lines = cleanText.split('\n').filter((line) => line.trim() !== '');

        if (lines.length <= 1) {
          toast.error('الملف فارغ أو لا يحتوي على بيانات');
          return;
        }

        let importedCount = 0;
        const now = new Date().toISOString();

        for (let i = 1; i < lines.length; i++) {
          const row: string[] = [];
          let currentField = '';
          let inQuotes = false;
          const line = lines[i];

          for (let j = 0; j < line.length; j++) {
            const char = line[j];
            if (char === '"') {
              inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
              row.push(currentField.trim());
              currentField = '';
            } else {
              currentField += char;
            }
          }
          row.push(currentField.trim());

          if (row.length >= 1) {
            const cName = row[0].replace(/^"|"$/g, '').trim();
            const cPhone = row.length >= 2 ? row[1].replace(/^"|"$/g, '').trim() : '';
            const cEmail = row.length >= 3 ? row[2].replace(/^"|"$/g, '').trim() : '';
            const cBalance = row.length >= 4 ? parseFloat(row[3].replace(/^"|"$/g, '')) : 0;

            if (cName && !allCustomers.some((c) => c.name === cName)) {
              await dispatchOperation(
                'entity_upsert',
                {
                  table: 'customers',
                  record: {
                    id: Date.now() * 1000 + i,
                    name: cName,
                    phone: cPhone,
                    email: cEmail,
                    balance: isNaN(cBalance) ? 0 : cBalance,
                    points: 0,
                    branchId: user?.branchId,
                    createdAt: now,
                    updatedAt: now,
                  },
                },
                user?.branchId
              );
              importedCount++;
            }
          }
        }

        if (importedCount > 0) {
          toast.success(`تم استيراد ${importedCount} عميل بنجاح`);
        } else {
          toast.error('لم يتم العثور على عملاء جدد صالحين للاستيراد');
        }
      } catch (error) {
        console.error('Error importing CSV:', error);
        toast.error('حدث خطأ أثناء استيراد الملف');
      }
      if (e.target) e.target.value = '';
    };
    reader.readAsText(file);
  };

  return (
    <div className="lineage-page lineage-customers-page flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-[var(--app-bg)] p-3 sm:p-6" dir="rtl">
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3 sm:mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">العملاء والديون</h2>
          <p className="text-slate-500 text-sm mt-1">
            إدارة بيانات العملاء وحسابات البيع الآجل وكشوف الحساب
          </p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <label className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-3.5 py-2 rounded-xl text-sm font-bold flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap">
            <Upload className="w-4 h-4" />
            استيراد CSV
            <input type="file" accept=".csv" className="hidden" onChange={handleImportCSV} />
          </label>
          <button
            onClick={handleExportCSV}
            className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-3.5 py-2 rounded-xl text-sm font-bold flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            <Download className="w-4 h-4" />
            تصدير CSV
          </button>
          <button
            onClick={() => openModal()}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            إضافة عميل
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="p-4 border-b border-slate-200 flex gap-4 bg-slate-50/60 shrink-0">
          <div className="relative flex-1 max-w-md">
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-slate-400" />
            </div>
            <input
              type="text"
              className="block w-full pl-3 pr-9 py-2 border border-slate-200 rounded-xl bg-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="ابحث باسم العميل أو رقم الهاتف..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto custom-scrollbar">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 sticky top-0 z-10 text-slate-500 text-xs font-bold">
              <tr>
                <th className="px-6 py-3.5 text-right">اسم العميل</th>
                <th className="px-6 py-3.5 text-right">رقم الهاتف</th>
                <th className="px-6 py-3.5 text-right">الرصيد المستحق</th>
                <th className="px-6 py-3.5 text-right">تاريخ الإضافة</th>
                <th className="px-6 py-3.5 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-100 text-sm">
              {customers.map((customer) => (
                <tr key={customer.id} className="hover:bg-slate-50/70 transition-colors">
                  <td className="px-6 py-3.5 whitespace-nowrap">
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0 h-9 w-9 bg-indigo-50 border border-indigo-200 rounded-lg flex items-center justify-center">
                        <Users className="h-4 w-4 text-indigo-600" />
                      </div>
                      <div>
                        <div className="font-bold text-slate-900">{customer.name}</div>
                        <div className="text-xs text-slate-500">{customer.email || 'لا يوجد بريد'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap text-slate-600 font-mono tabular-nums">
                    {customer.phone}
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap tabular-nums">
                    <span
                      className={`px-2.5 py-1 inline-flex text-xs font-bold rounded-lg border ${
                        customer.balance > 0
                          ? 'bg-rose-50 text-rose-700 border-rose-200'
                          : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      }`}
                    >
                      {customer.balance.toFixed(2)} {storeSettings.currency}
                    </span>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap text-slate-500 tabular-nums">
                    {format(new Date(customer.createdAt), 'yyyy-MM-dd')}
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap text-center">
                    <div className="flex items-center justify-center gap-1.5">
                      <button
                        onClick={() => setStatementCustomer(customer)}
                        className="text-slate-700 hover:bg-slate-100 border border-slate-200 px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors"
                        title="كشف حساب تفصيلي"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        كشف حساب
                      </button>
                      <button
                        onClick={() => handlePayment(customer)}
                        className="text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors"
                        title="تحصيل دفعة"
                      >
                        <CreditCard className="w-3.5 h-3.5" />
                        تحصيل
                      </button>
                      <button
                        onClick={() => openModal(customer)}
                        className="text-indigo-600 hover:bg-indigo-50 p-2 rounded-lg transition-colors"
                        title="تعديل"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() =>
                          Math.abs(customer.balance) > 0.01
                            ? toast.error('لا يمكن حذف عميل لديه رصيد مستحق')
                            : setCustomerToDelete(customer)
                        }
                        className="text-rose-600 hover:bg-rose-50 p-2 rounded-lg transition-colors"
                        title="حذف"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {customers.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-slate-400">
                    <Users className="mx-auto h-10 w-10 text-slate-300 mb-2" />
                    <p className="text-base font-bold text-slate-700">لا يوجد عملاء</p>
                    <p className="text-xs">قم بإضافة عملاء جدد للبدء في البيع الآجل</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-base font-bold text-slate-900">
                {editingCustomer ? 'تعديل بيانات العميل' : 'إضافة عميل جديد'}
              </h3>
              <button
                onClick={closeModal}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">اسم العميل *</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="أدخل اسم العميل"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">رقم الهاتف *</label>
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none text-left"
                  dir="ltr"
                  placeholder="05xxxxxxxx"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  البريد الإلكتروني (اختياري)
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none text-left"
                  dir="ltr"
                  placeholder="email@example.com"
                />
              </div>

              <div className="pt-2 flex gap-2.5">
                <button
                  type="button"
                  onClick={closeModal}
                  className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-700 rounded-xl hover:bg-slate-50 text-sm font-bold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 text-sm font-bold"
                >
                  حفظ
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {selectedCustomerForPayment && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-base font-bold text-slate-900">
                تحصيل دفعات العميل: {selectedCustomerForPayment.name}
              </h3>
              <button
                onClick={() => setSelectedCustomerForPayment(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto custom-scrollbar flex-1 space-y-5">
              <div className="bg-amber-50 text-amber-900 p-4 rounded-xl border border-amber-200 flex justify-between items-center">
                <span className="text-sm font-bold">إجمالي الرصيد المستحق:</span>
                <span className="text-xl font-black tabular-nums">
                  {selectedCustomerForPayment.balance.toFixed(2)} {storeSettings.currency}
                </span>
              </div>

              {/* Structured Custom Payment Form */}
              <form
                onSubmit={handleCustomPaymentSubmit}
                className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-3"
              >
                <h4 className="text-sm font-bold text-slate-800">تسديد دفعة على الحساب (مخصصة)</h4>
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
                      <option value="cash">نقدي (للدرج)</option>
                      <option value="card">شبكة / تحويل بنكي</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">ملاحظات</label>
                    <input
                      type="text"
                      value={customPayNotes}
                      onChange={(e) => setCustomPayNotes(e.target.value)}
                      placeholder="دفعة من الحساب"
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
                    {isPayingCustom ? 'جاري التحصيل...' : 'اعتماد وتحصيل الدفعة'}
                  </button>
                </div>
              </form>

              <div>
                <h4 className="font-bold text-slate-900 text-sm mb-3">
                  الفواتير الآجلة المفتوحة ({customerUnpaidOrders.length})
                </h4>
                {customerUnpaidOrders.length === 0 ? (
                  <div className="text-center py-6 text-slate-400 text-xs bg-slate-50 rounded-xl border border-slate-200">
                    لا توجد فواتير آجلة غير مسددة بالكامل.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {customerUnpaidOrders.map((order) => {
                      const remaining = Math.max(
                        0,
                        (order.netAmount || 0) -
                          (order.returnedAmount || 0) -
                          (order.paidAmount || 0)
                      );
                      return (
                        <div
                          key={order.id}
                          className="flex flex-col sm:flex-row sm:items-center justify-between p-3.5 border border-slate-200 rounded-xl bg-white gap-3"
                        >
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-bold text-sm text-slate-900">
                                {order.receiptNumber}
                              </span>
                              <span className="text-xs text-slate-500 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md tabular-nums">
                                {format(new Date(order.createdAt), 'yyyy/MM/dd')}
                              </span>
                            </div>
                            <div className="text-base font-black text-rose-600 tabular-nums">
                              المتبقي: {remaining.toFixed(2)} {storeSettings.currency}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={async () => {
                                const items = await getPosRecordsWhereEquals<OrderItem>('orderItems', 'orderId', order.id!);
                                setSelectedInvoiceForPreview({ order, items });
                              }}
                              className="px-3 py-2 bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 rounded-lg text-xs font-bold"
                              title="معاينة"
                            >
                              <Receipt className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => payInvoice(order, 'cash')}
                              className="px-3.5 py-2 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded-lg text-xs font-bold whitespace-nowrap"
                            >
                              سداد نقدي
                            </button>
                            <button
                              onClick={() => payInvoice(order, 'card')}
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

      {/* Detailed Customer Account Statement Modal */}
      {statementCustomer && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-4xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex flex-wrap justify-between items-center p-4 border-b border-slate-200 bg-slate-50 gap-2">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  كشف حساب العميل: {statementCustomer.name}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                  الهاتف: {statementCustomer.phone} | الرصيد الحالي:{' '}
                  {statementCustomer.balance.toFixed(2)} {storeSettings.currency}
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
                  onClick={() => setStatementCustomer(null)}
                  className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-5 overflow-y-auto custom-scrollbar flex-1" ref={statementPrintRef}>
              <div className="grid grid-cols-3 gap-3 mb-4 tabular-nums">
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500">إجمالي المسحوبات (مدين)</p>
                  <p className="text-base font-black text-slate-900">
                    {statementData.totalDebit.toFixed(2)} {storeSettings.currency}
                  </p>
                </div>
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500">إجمالي السداد والمرتجعات (دائن)</p>
                  <p className="text-base font-black text-emerald-700">
                    {statementData.totalCredit.toFixed(2)} {storeSettings.currency}
                  </p>
                </div>
                <div className="p-3 bg-indigo-50 rounded-xl border border-indigo-200">
                  <p className="text-xs text-indigo-700">الرصيد المستحق الحالي</p>
                  <p className="text-base font-black text-indigo-900">
                    {statementCustomer.balance.toFixed(2)} {storeSettings.currency}
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
                      <th className="px-4 py-3">مدين</th>
                      <th className="px-4 py-3">دائن</th>
                      <th className="px-4 py-3">الرصيد التراكمي</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 tabular-nums">
                    {statementData.rows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                          لا توجد حركات مسجلة لهذا العميل
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
                            {row.debit > 0 ? row.debit.toFixed(2) : '-'}
                          </td>
                          <td className="px-4 py-2.5 text-emerald-700 font-bold">
                            {row.credit > 0 ? row.credit.toFixed(2) : '-'}
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

      {/* Invoice Preview Modal */}
      {selectedInvoiceForPreview && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-base font-bold text-slate-900">معاينة الفاتورة</h3>
              <button
                onClick={() => setSelectedInvoiceForPreview(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto custom-scrollbar">
              <ReceiptComponent
                order={selectedInvoiceForPreview.order}
                items={selectedInvoiceForPreview.items}
                settings={storeSettings}
              />
            </div>
          </div>
        </div>
      )}

      <ConfirmationModal
        isOpen={Boolean(customerToDelete)}
        variant="danger"
        title="حذف العميل"
        message={
          customerToDelete
            ? `هل أنت متأكد من حذف العميل "${customerToDelete.name}"؟`
            : ''
        }
        confirmLabel="حذف العميل"
        onConfirm={confirmDeleteCustomer}
        onCancel={() => setCustomerToDelete(null)}
      />
    </div>
  );
}
