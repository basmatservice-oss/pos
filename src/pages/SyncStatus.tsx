import React, { useState, useEffect } from 'react';
import {
  RefreshCw,
  XCircle,
  CheckCircle2,
  Clock,
  AlertCircle,
  Trash2,
  Database,
  Cloud,
  AlertTriangle,
  Server,
  ServerOff,
  Activity,
  HardDrive,
  ShieldCheck,
  MonitorSmartphone,
} from 'lucide-react';
import type { SyncOperation, InventoryAlert } from '../db/db';
import { getPosRecord, getPosRecords, putPosRecord } from '../services/posDataAccess';
import { isNativeAndroid, listAllNativePosOperations, retryNativePosOperation, deleteNativePosOperation } from '../native/posLocalDatabase';
import { isElectronDesktop } from '../native/electronPosRepository';
import { nativePosRepository, NATIVE_POS_ENTITIES } from '../native/nativePosRepository';
const isLocalSqlite = (): boolean => isNativeAndroid() || isElectronDesktop();
import { apiService } from '../services/apiService';
import { syncService } from '../services/syncService';
import { useSyncStore } from '../store/syncStore';
import { formatNumber, formatQty } from '../utils/format';
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

interface SystemStatusInfo {
  ip: string;
  port: number;
  uptimeSeconds: number;
  dbPath: string;
  dbSizeBytes: number;
  walMode: string;
  integrity: string;
  lastAutoBackup: string | null;
  connectedCount: number;
  connectedTerminals: Array<{
    socketId: string;
    ip: string;
    deviceName: string;
    userName: string;
    connectedAt: string;
  }>;
  serverTime: string;
}

export default function SyncStatus() {
  const { isOnline } = useSyncStore();
  const [activeTab, setActiveTab] = useState<'local' | 'alerts' | 'supabase'>('local');
  const [operations, setOperations] = useState<SyncOperation[]>([]);
  const [localItems, setLocalItems] = useState<SyncItem[]>([]);
  const [inventoryAlerts, setInventoryAlerts] = useState<InventoryAlert[]>([]);
  const [supabaseItems, setSupabaseItems] = useState<any[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatusInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    if (isLocalSqlite()) {
      syncService.getDeviceRole().then((role) => setIsStandalone(role === 'standalone')).catch(() => setIsStandalone(false));
    }
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [activeTab]);

  const fetchSystemStatus = async () => {
    try {
      if (isLocalSqlite() && await syncService.getDeviceRole() === 'standalone') {
        setSystemStatus(null);
        return;
      }
      const status = await apiService.getSystemStatus();
      if (status && typeof status === 'object') {
        setSystemStatus(status);
      }
    } catch {
      setSystemStatus(null);
    }
  };

  const fetchData = async () => {
    try {
      await fetchSystemStatus();
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
    const alerts = await getPosRecords<InventoryAlert>('inventoryAlerts');
    alerts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    setInventoryAlerts(alerts);
  };

  const fetchLocalQueue = async () => {
    if (isLocalSqlite()) {
      const queued = await listAllNativePosOperations();
      const nativeOperations = queued.map((operation: any) => ({
        id: operation.operationId,
        type: operation.type as SyncOperation['type'],
        payload: operation.payload,
        deviceId: operation.deviceId || 'android',
        status: operation.status || 'pending',
        lastError: operation.lastError,
        nextRetryAt: operation.nextRetryAt ? new Date(operation.nextRetryAt).toISOString() : undefined,
        createdAt: new Date(operation.createdAt).toISOString(),
        updatedAt: new Date(operation.createdAt).toISOString(),
        retryCount: operation.retryCount || 0,
      })) as SyncOperation[];
      nativeOperations.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setOperations(nativeOperations.slice(0, 100));
      if (isElectronDesktop()) {
        const items: SyncItem[] = [];
        for (const entity of NATIVE_POS_ENTITIES) {
          const records = await nativePosRepository.getAllWithSyncState<any>(entity);
          for (const row of records) {
            const record = row.record as any;
            const status = String(record.syncStatus || row.syncState);
            if (!['pending', 'error', 'conflict'].includes(status)) continue;
            items.push({ id: record.id ?? record.key ?? record.code, table: entity, status, data: record, updatedAt: record.updatedAt || record.createdAt || new Date().toISOString() });
          }
        }
        items.sort((a,b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
        setLocalItems(items.slice(0,100));
      } else setLocalItems([]);
      return;
    }
    const { db } = await import('../db/db');
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
      if (isNativeAndroid() && await syncService.getDeviceRole() === 'standalone') {
        setSupabaseItems([]);
        return;
      }
      const data = await apiService.getSyncQueue();
      setSupabaseItems(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to fetch Supabase queue:', error);
    }
  };

  const handleRetryOp = async (op: SyncOperation) => {
    if (isNativeAndroid() && await syncService.getDeviceRole() === 'standalone') {
      toast.error('إعادة إرسال العمليات إلى الخادم غير متاحة في وضع التشغيل المستقل');
      return;
    }
    if (isLocalSqlite()) {
      if (op.status === 'error' || op.status === 'conflict') {
        await retryNativePosOperation(String(op.id));
      }
      await syncService.syncAll();
      await fetchLocalQueue();
      return;
    }
    const { db } = await import('../db/db');
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
    if (isNativeAndroid()) return;
    if (isElectronDesktop()) {
      await deleteNativePosOperation(opId);
      toast.success('تم حذف السجل من طابور العمليات');
      await fetchLocalQueue();
      syncService.updatePendingCount();
      return;
    }
    const { db } = await import('../db/db');
    await db.syncOperations.delete(opId);
    toast.success('تم حذف السجل من طابور العمليات');
    await fetchLocalQueue();
    syncService.updatePendingCount();
  };

  const handleResolveAlert = async (alertId: string) => {
    try {
      const standalone = isLocalSqlite() && await syncService.getDeviceRole() === 'standalone';
      if (!standalone) await apiService.resolveInventoryAlert(alertId);
      const alert = await getPosRecord<any>('inventoryAlerts', alertId);
      if (alert) {
        await putPosRecord('inventoryAlerts', { ...alert, resolved: 1 }, standalone ? 'local' : 'synced');
      }
      toast.success('تم تأكيد مراجعة تنبيه المخزون');
      fetchAlerts();
    } catch {
      toast.error('تعذر تحديث حالة التنبيه محلياً');
    }
  };

  const handleCancelLocal = async (item: SyncItem) => {
    try {
      if (isLocalSqlite()) {
        await nativePosRepository.setSyncState(item.table as any, item.id, 'synced');
      } else {
        const { db } = await import('../db/db');
        await (db as any)[item.table].update(item.id, { syncStatus: 'synced' });
      }
      toast.success('تم إلغاء العملية من الطابور');
      fetchLocalQueue();
    } catch {
      toast.error('حدث خطأ أثناء الإلغاء');
    }
  };

  const handleRetryLocal = async (item: SyncItem) => {
    try {
      if (isLocalSqlite()) {
        await nativePosRepository.setSyncState(item.table as any, item.id, 'pending');
      } else {
        const { db } = await import('../db/db');
        await (db as any)[item.table].update(item.id, { syncStatus: 'pending' });
      }
      toast.success('تمت إعادة العملية إلى الطابور');
      fetchLocalQueue();
      syncService.syncAll().catch(() => {});
    } catch {
      toast.error('حدث خطأ أثناء إعادة المحاولة');
    }
  };

  const handleCancelSupabase = async (id: string) => {
    try {
      if (isNativeAndroid() && await syncService.getDeviceRole() === 'standalone') {
        toast.error('إدارة طابور الخادم غير متاحة في وضع التشغيل المستقل');
        return;
      }
      await apiService.deleteSyncQueueItem(id);
      toast.success('تم إلغاء العملية السحابية');
      fetchSupabaseQueue();
    } catch {
      toast.error('حدث خطأ أثناء الإلغاء');
    }
  };

  const handleRetrySupabase = async (id: string) => {
    try {
      if (isNativeAndroid() && await syncService.getDeviceRole() === 'standalone') {
        toast.error('إعادة محاولة طابور الخادم غير متاحة في وضع التشغيل المستقل');
        return;
      }
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
        if (isNativeAndroid() && await syncService.getDeviceRole() === 'standalone') {
          setSupabaseItems([]);
          return;
        }
        await apiService.processSyncQueue();
        toast.success('تم تشغيل المزامنة السحابية');
        await fetchSupabaseQueue();
      } else {
        if (isNativeAndroid() && await syncService.getDeviceRole() === 'standalone') {
          await fetchLocalQueue();
          await fetchAlerts();
          toast.success('الجهاز يعمل مستقلًا؛ تم تحديث البيانات المحلية دون الاتصال بخادم');
          return;
        }
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

      {/* Live Server Health & Connected LAN Terminals */}
      {systemStatus && (
        <div className="mb-6 space-y-4 shrink-0 tabular-nums">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div className="bg-white rounded-2xl p-4 border border-slate-200 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                <Activity className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-500">عنوان السيرفر (LAN)</p>
                <p className="text-sm font-black text-slate-900 font-mono" dir="ltr">
                  {systemStatus.ip}:{systemStatus.port}
                </p>
                <p className="text-[11px] text-slate-400">
                  التشغيل: {Math.floor(systemStatus.uptimeSeconds / 60)} دقيقة
                </p>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-slate-200 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-500">سلامة قاعدة البيانات</p>
                <p className="text-sm font-black text-emerald-700">
                  {systemStatus.integrity === 'ok' ? 'سليمة (OK)' : systemStatus.integrity}
                </p>
                <p className="text-[11px] text-slate-500 uppercase">الوضع: {systemStatus.walMode}</p>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-slate-200 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center shrink-0">
                <HardDrive className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-500">حجم قاعدة البيانات</p>
                <p className="text-sm font-black text-slate-900">
                  {systemStatus.dbSizeBytes >= 1024 * 1024
                    ? `${formatNumber(systemStatus.dbSizeBytes / (1024 * 1024), 2)} MB`
                    : `${formatNumber(systemStatus.dbSizeBytes / 1024, 1)} KB`}
                </p>
                <p className="text-[11px] text-slate-400">
                  آخر نسخة: {systemStatus.lastAutoBackup ? format(new Date(systemStatus.lastAutoBackup), 'MM/dd HH:mm') : 'غير متوفر'}
                </p>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-slate-200 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                <MonitorSmartphone className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-500">الأجهزة المتصلة بالشبكة</p>
                <p className="text-lg font-black text-slate-900">
                  {formatQty(systemStatus.connectedCount, 0)} أجهزة
                </p>
                <p className="text-[11px] text-slate-400">متصلة لحظياً عبر Socket.io</p>
              </div>
            </div>
          </div>

          {systemStatus.connectedTerminals && systemStatus.connectedTerminals.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <MonitorSmartphone className="w-4 h-4 text-indigo-600" />
                  نقاط البيع والأجهزة المتصلة حالياً بالخادم
                </span>
                <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
                  مباشر
                </span>
              </div>
              <div className="divide-y divide-slate-100 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                {systemStatus.connectedTerminals.map((term) => (
                  <div key={term.socketId} className="px-4 py-2.5 flex items-center justify-between text-xs border-l border-slate-100">
                    <div>
                      <p className="font-bold text-slate-900">{term.deviceName || 'نقطة بيع'}</p>
                      <p className="text-slate-500">{term.userName || 'مستخدم'} • <span className="font-mono" dir="ltr">{term.ip}</span></p>
                    </div>
                    <span className="text-[11px] text-slate-400">
                      {format(new Date(term.connectedAt), 'HH:mm:ss')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

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
        {!isStandalone && (
          <button
            onClick={() => setActiveTab('supabase')}
            className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold transition-all ${
              activeTab === 'supabase' ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-gray-600 hover:bg-gray-50 border border-gray-200'
            }`}
          >
            <Cloud className="w-5 h-5" />
            المزامنة السحابية
          </button>
        )}
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
                              {!isNativeAndroid() && (
                                <button onClick={() => handleDeleteOp(op.id)} className="text-rose-600 bg-rose-50 p-2 rounded-lg" title="حذف">
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
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
                      <td className="px-6 py-4 font-black text-rose-600 tabular-nums" dir="ltr">
                        {formatQty(a.resultingQty)} ({a.changeQty >= 0 ? `+${formatQty(a.changeQty)}` : formatQty(a.changeQty)})
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
