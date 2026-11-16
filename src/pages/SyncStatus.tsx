import React, { useState, useEffect } from 'react';
import { RefreshCw, XCircle, CheckCircle2, Clock, AlertCircle, Trash2, Database, Cloud, AlertTriangle, Server, ServerOff } from 'lucide-react';
import { db, SyncOperation, InventoryAlert } from '../db/db';
import { apiService } from '../services/apiService';
import { syncService } from '../services/syncService';
import { useSyncStore } from '../store/syncStore';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import { ar } from 'date-fns/locale';

interface SyncItem {
  id: string | number;
  table: string;
  status: string;
  data?: any;
  updatedAt?: string;
}

export default function SyncStatus() {
  const { isOnline } = useSyncStore();
  const [activeTab, setActiveTab] = useState<'local' | 'alerts' | 'supabase'>('local');
  const [operations, setOperations] = useState<SyncOperation[]>([]);
  const [localItems, setLocalItems] = useState<SyncItem[]>([]);
  const [inventoryAlerts, setInventoryAlerts] = useState<InventoryAlert[]>([]);
  const [supabaseItems, setSupabaseItems] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [activeTab]);

  const fetchData = async () => {
    try {
      if (activeTab === 'local') {
        await fetchLocalQueue();
      } else if (activeTab === 'alerts') {
        await fetchAlerts();
      } else {
        await fetchSupabaseQueue();
      }
    } catch (error) {
      console.error('Error fetching sync data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAlerts = async () => {
    const alerts = await db.inventoryAlerts.toArray();
    alerts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    setInventoryAlerts(alerts);
  };

  const fetchLocalQueue = async () => {
    const ops = await db.syncOperations.toArray();
    ops.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    setOperations(ops.slice(0, 100));

    const tables = [
      'categories', 'products', 'customers', 'suppliers',
      'employees', 'expenses', 'shifts', 'branches', 'payroll', 'offers',
      'settings', 'auditLogs', 'stocktakingSessions', 'stocktakingEntries',
    ];

    let items: SyncItem[] = [];
    for (const table of tables) {
      if ((db as any)[table]) {
        try {
          const pendingOrErr = await (db as any)[table]
            .where('syncStatus')
            .anyOf(['pending', 'error', 'conflict'])
            .toArray();

          const mapped = pendingOrErr.map((r: any) => ({
            id: r.id || r.key,
            table,
            status: r.syncStatus,
            data: r,
            updatedAt: r.updatedAt || r.createdAt || new Date().toISOString(),
          }));
          items = [...items, ...mapped];
        } catch {
          // Ignore table errors
        }
      }
    }

    items.sort((a, b) => new Date(b.updatedAt!).getTime() - new Date(a.updatedAt!).getTime());
    setLocalItems(items.slice(0, 100));
  };

  const fetchSupabaseQueue = async () => {
    try {
      const data = await apiService.getSyncQueue();
      setSupabaseItems(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to fetch Supabase queue:', error);
    }
  };

  const handleRetryOp = async (op: SyncOperation) => {
    await db.syncOperations.update(op.id, {
      status: 'pending',
      nextRetryAt: undefined,
      updatedAt: new Date().toISOString(),
    });
    toast.success('تمت إعادة جدولة العملية');
    await fetchLocalQueue();
    syncService.syncAll().catch(() => {});
  };

  const handleDeleteOp = async (opId: string) => {
    await db.syncOperations.delete(opId);
    toast.success('تم حذف السجل من طابور العمليات');
    await fetchLocalQueue();
    syncService.updatePendingCount();
  };

  const handleResolveAlert = async (alertId: string) => {
    try {
      await apiService.resolveInventoryAlert(alertId);
      await db.inventoryAlerts.update(alertId, { resolved: 1 });
      toast.success('تم تأكيد مراجعة تنبيه المخزون');
      fetchAlerts();
    } catch {
      toast.error('تعذر تحديث حالة التنبيه، تأكد من الاتصال بالسيرفر');
    }
  };

  const handleCancelLocal = async (item: SyncItem) => {
    try {
      await (db as any)[item.table].update(item.id, { syncStatus: 'synced' });
      toast.success('تم إلغاء العملية من الطابور');
      fetchLocalQueue();
    } catch {
      toast.error('حدث خطأ أثناء الإلغاء');
    }
  };

  const handleRetryLocal = async (item: SyncItem) => {
    try {
      await (db as any)[item.table].update(item.id, { syncStatus: 'pending' });
      toast.success('تمت إعادة العملية إلى الطابور');
      fetchLocalQueue();
      syncService.syncAll().catch(() => {});
    } catch {
      toast.error('حدث خطأ أثناء إعادة المحاولة');
    }
  };

  const handleCancelSupabase = async (id: string) => {
    try {
      await apiService.deleteSyncQueueItem(id);
      toast.success('تم إلغاء العملية السحابية');
      fetchSupabaseQueue();
    } catch {
      toast.error('حدث خطأ أثناء الإلغاء');
    }
  };

  const handleRetrySupabase = async (id: string) => {
    try {
      await apiService.retrySyncQueueItem(id);
      toast.success('تمت إعادة المحاولة السحابية');
      fetchSupabaseQueue();
    } catch {
      toast.error('حدث خطأ أثناء إعادة المحاولة');
    }
  };

  const handleSyncNow = async () => {
    setIsSyncing(true);
    try {
      if (activeTab === 'supabase') {
        await apiService.processSyncQueue();
        toast.success('تم تشغيل المزامنة السحابية');
        await fetchSupabaseQueue();
      } else {
        const ok = await syncService.syncAll();
        if (ok) {
          toast.success('تمت المزامنة مع السيرفر المحلي بنجاح');
        } else {
          toast.error('السيرفر المحلي غير متاح حالياً');
        }
        await fetchLocalQueue();
        await fetchAlerts();
      }
    } catch {
      toast.error('حدث خطأ أثناء المزامنة');
    } finally {
      setIsSyncing(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'synced':
      case 'completed':
        return <span className="inline-flex items-center gap-1 text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg text-xs font-bold"><CheckCircle2 className="w-3 h-3" /> تمت المزامنة</span>;
      case 'error':
      case 'failed':
        return <span className="inline-flex items-center gap-1 text-rose-600 bg-rose-50 px-2 py-1 rounded-lg text-xs font-bold"><XCircle className="w-3 h-3" /> فشل مؤقت</span>;
      case 'conflict':
        return <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-100 px-2 py-1 rounded-lg text-xs font-bold"><AlertTriangle className="w-3 h-3" /> تعارض</span>;
      case 'pending':
        return <span className="inline-flex items-center gap-1 text-amber-600 bg-amber-50 px-2 py-1 rounded-lg text-xs font-bold"><Clock className="w-3 h-3" /> بانتظار الشبكة</span>;
      default:
        return <span className="inline-flex items-center gap-1 text-gray-600 bg-gray-50 px-2 py-1 rounded-lg text-xs font-bold"><AlertCircle className="w-3 h-3" /> {status}</span>;
    }
  };

  const opTypeLabels: Record<string, string> = {
    sale: 'فاتورة مبيعات',
    return: 'مستند مرتجع',
    order_void: 'إلغاء فاتورة مبيعات',
    purchase: 'فاتورة مشتريات',
    purchase_update: 'تعديل مشتريات',
    purchase_delete: 'حذف مشتريات',
    purchase_return: 'مرتجع مشتريات',
    expense: 'مصروف',
    expense_delete: 'حذف مصروف',
    customer_payment: 'تحصيل عميل',
    supplier_payment: 'سداد مورد',
    payroll: 'صرف راتب',
    shift_open: 'فتح وردية',
    shift_close: 'إغلاق وردية',
    shift_movement: 'حركة نقدية بالوردية',
    stocktake_approve: 'اعتماد جرد',
    entity_upsert: 'حفظ / تعديل سجل',
    entity_delete: 'حذف سجل',
  };

  return (
    <div className="p-6 max-w-7xl mx-auto h-full flex flex-col" dir="rtl">
      <div className="flex flex-wrap justify-between items-center gap-4 mb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">حالة المزامنة والشبكة المحلية</h1>
          <div className="flex items-center gap-2 mt-1 text-sm">
            {isOnline ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-600 font-bold">
                <Server className="w-4 h-4" /> متصل بسيرفر الشبكة المحلية (LAN)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-rose-600 font-bold">
                <ServerOff className="w-4 h-4" /> السيرفر غير متصل — العمليات محفوظة محلياً بأمان
              </span>
            )}
          </div>
        </div>
        <button
          onClick={handleSyncNow}
          disabled={isSyncing}
          className="bg-indigo-600 text-white px-5 py-2.5 rounded-xl font-bold hover:bg-indigo-700 transition-colors flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw className={`w-5 h-5 ${isSyncing ? 'animate-spin' : ''}`} />
          {isSyncing ? 'جاري المزامنة...' : 'مزامنة الآن'}
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-6 shrink-0">
        <button
          onClick={() => setActiveTab('local')}
          className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold transition-all ${
            activeTab === 'local' ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-gray-600 hover:bg-gray-50 border border-gray-200'
          }`}
        >
          <Database className="w-5 h-5" />
          سجل العمليات المحلية (LAN)
        </button>
        <button
          onClick={() => setActiveTab('alerts')}
          className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold transition-all ${
            activeTab === 'alerts' ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-gray-600 hover:bg-gray-50 border border-gray-200'
          }`}
        >
          <AlertTriangle className="w-5 h-5" />
          تنبيهات عجز المخزون (أوفلاين)
        </button>
        <button
          onClick={() => setActiveTab('supabase')}
          className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold transition-all ${
            activeTab === 'supabase' ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-gray-600 hover:bg-gray-50 border border-gray-200'
          }`}
        >
          <Cloud className="w-5 h-5" />
          المزامنة السحابية
        </button>
      </div>

      <div className="flex-1 overflow-auto space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <RefreshCw className="w-8 h-8 text-indigo-600 animate-spin" />
          </div>
        ) : activeTab === 'local' ? (
          <>
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex justify-between items-center">
                <h3 className="font-bold text-gray-900">العمليات التجارية المؤقتة / المتزامنة (Idempotent Operations)</h3>
                <span className="text-xs text-gray-500 font-bold tabular-nums">{operations.length} عملية</span>
              </div>
              {operations.length === 0 ? (
                <div className="text-center py-10 text-gray-500">لا توجد عمليات مسجلة في الطابور المحلي</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-right">
                    <thead className="bg-gray-50 text-xs font-bold text-gray-500">
                      <tr>
                        <th className="px-6 py-3">نوع العملية</th>
                        <th className="px-6 py-3">المعرف</th>
                        <th className="px-6 py-3">الوقت</th>
                        <th className="px-6 py-3">المحاولات / الخطأ</th>
                        <th className="px-6 py-3">الحالة</th>
                        <th className="px-6 py-3 text-left">إجراءات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 text-sm">
                      {operations.map((op) => (
                        <tr key={op.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4 font-bold text-gray-900">{opTypeLabels[op.type] || op.type}</td>
                          <td className="px-6 py-4 font-mono text-xs text-gray-500 tabular-nums">{op.id.slice(0, 12)}...</td>
                          <td className="px-6 py-4 text-gray-500 tabular-nums">{format(new Date(op.createdAt), 'dd/MM HH:mm', { locale: ar })}</td>
                          <td className="px-6 py-4 text-xs text-rose-600 tabular-nums">{op.lastError ? `${op.lastError} (${op.retryCount})` : op.retryCount > 0 ? `${op.retryCount} محاولات` : '-'}</td>
                          <td className="px-6 py-4">{getStatusBadge(op.status)}</td>
                          <td className="px-6 py-4 text-left">
                            <div className="flex items-center justify-end gap-2">
                              {(op.status === 'error' || op.status === 'conflict') && (
                                <button onClick={() => handleRetryOp(op)} className="text-indigo-600 bg-indigo-50 p-2 rounded-lg" title="إعادة المحاولة">
                                  <RefreshCw className="w-4 h-4" />
                                </button>
                              )}
                              <button onClick={() => handleDeleteOp(op.id)} className="text-rose-600 bg-rose-50 p-2 rounded-lg" title="حذف">
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {localItems.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
                  <h3 className="font-bold text-gray-900">تغييرات الجداول المعلقة</h3>
                </div>
                <table className="min-w-full divide-y divide-gray-200 text-right">
                  <thead className="bg-gray-50 text-xs font-bold text-gray-500">
                    <tr>
                      <th className="px-6 py-3">الجدول</th>
                      <th className="px-6 py-3">المعرف</th>
                      <th className="px-6 py-3">الوقت</th>
                      <th className="px-6 py-3">الحالة</th>
                      <th className="px-6 py-3 text-left">إجراءات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 text-sm">
                    {localItems.map((item, idx) => (
                      <tr key={`${item.table}-${item.id}-${idx}`} className="hover:bg-gray-50">
                        <td className="px-6 py-4 font-bold text-gray-900">{item.table}</td>
                        <td className="px-6 py-4 font-mono text-gray-500">{item.id}</td>
                        <td className="px-6 py-4 text-gray-500">{format(new Date(item.updatedAt!), 'dd/MM HH:mm', { locale: ar })}</td>
                        <td className="px-6 py-4">{getStatusBadge(item.status)}</td>
                        <td className="px-6 py-4 text-left">
                          <div className="flex items-center justify-end gap-2">
                            <button onClick={() => handleRetryLocal(item)} className="text-indigo-600 bg-indigo-50 p-2 rounded-lg" title="إعادة المحاولة">
                              <RefreshCw className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleCancelLocal(item)} className="text-rose-600 bg-rose-50 p-2 rounded-lg" title="تجاهل">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : activeTab === 'alerts' ? (
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 bg-amber-50/50">
              <h3 className="font-bold text-gray-900">تنبيهات البيع الأوفلاين وعجز المخزون (Inventory Alerts)</h3>
              <p className="text-xs text-gray-500 mt-1">تُنشأ تلقائياً عند مزامنة مبيعات أوفلاين تجاوزت الرصيد الفعلي المتاح على السيرفر</p>
            </div>
            {inventoryAlerts.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
                لا توجد تنبيهات عجز مخزون مسجلة
              </div>
            ) : (
              <table className="min-w-full divide-y divide-gray-200 text-right text-sm">
                <thead className="bg-gray-50 text-xs font-bold text-gray-500">
                  <tr>
                    <th className="px-6 py-3">المنتج</th>
                    <th className="px-6 py-3">كمية العجز</th>
                    <th className="px-6 py-3">الملاحظات</th>
                    <th className="px-6 py-3">التاريخ</th>
                    <th className="px-6 py-3">الحالة</th>
                    <th className="px-6 py-3 text-left">إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {inventoryAlerts.map((a) => (
                    <tr key={a.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 font-bold text-gray-900">{a.productName}</td>
                      <td className="px-6 py-4 font-black text-rose-600" dir="ltr">
                        {a.resultingQty} ({a.changeQty >= 0 ? `+${a.changeQty}` : a.changeQty})
                      </td>
                      <td className="px-6 py-4 text-gray-600">{a.reason || '-'}</td>
                      <td className="px-6 py-4 text-gray-500">{format(new Date(a.createdAt), 'dd/MM HH:mm', { locale: ar })}</td>
                      <td className="px-6 py-4">
                        {a.resolved ? (
                          <span className="text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg text-xs font-bold">تمت المراجعة</span>
                        ) : (
                          <span className="text-rose-600 bg-rose-50 px-2 py-1 rounded-lg text-xs font-bold">يتطلب مراجعة</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-left">
                        {!a.resolved && (
                          <button
                            onClick={() => handleResolveAlert(a.id)}
                            className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700"
                          >
                            تمت المراجعة
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            {supabaseItems.length === 0 ? (
              <div className="text-center py-12">
                <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
                <h3 className="text-lg font-bold text-gray-900">جميع البيانات متزامنة</h3>
                <p className="text-gray-500">لا توجد عمليات معلقة في طابور المزامنة السحابية.</p>
              </div>
            ) : (
              <table className="min-w-full divide-y divide-gray-200 text-right text-sm">
                <thead className="bg-gray-50 text-xs font-bold text-gray-500">
                  <tr>
                    <th className="px-6 py-3">النوع</th>
                    <th className="px-6 py-3">العملية</th>
                    <th className="px-6 py-3">الوقت</th>
                    <th className="px-6 py-3">الحالة</th>
                    <th className="px-6 py-3 text-left">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {supabaseItems.map((item: any) => (
                    <tr key={item.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 font-bold text-gray-900">{item.type}</td>
                      <td className="px-6 py-4">{item.action}</td>
                      <td className="px-6 py-4 text-gray-500">{format(new Date(item.createdAt), 'dd/MM HH:mm', { locale: ar })}</td>
                      <td className="px-6 py-4">{getStatusBadge(item.status)}</td>
                      <td className="px-6 py-4 text-left">
                        <div className="flex items-center justify-end gap-2">
                          {(item.status === 'failed' || item.status === 'error') && (
                            <button onClick={() => handleRetrySupabase(item.id)} className="text-indigo-600 bg-indigo-50 p-2 rounded-lg">
                              <RefreshCw className="w-4 h-4" />
                            </button>
                          )}
                          <button onClick={() => handleCancelSupabase(item.id)} className="text-rose-600 bg-rose-50 p-2 rounded-lg">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
