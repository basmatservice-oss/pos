import { useState, useRef, useEffect, useMemo } from 'react';
import { usePosRecordsWhereEquals } from '../hooks/usePosRecordsWhereEquals';
import { getPosRecord, getPosRecordsWhereEquals, getFirstPosRecordWhereEquals } from '../services/posDataAccess';
import { usePosFirstRecordWhereEquals } from '../hooks/usePosFirstRecordWhereEquals';
import { usePosEntityRecords } from '../hooks/usePosEntityRecords';
import type { Product, StocktakingSession, StocktakingEntry } from '../db/db';
import { useInventoryStore } from '../store/useInventoryStore';
import { 
  Package, 
  Search, 
  ScanLine, 
  Camera, 
  RefreshCw, 
  CheckCircle2, 
  AlertCircle, 
  History, 
  Trash2, 
  X, 
  ChevronLeft, 
  ChevronRight, 
  User, 
  Calendar,
  Eye,
  CheckCircle,
  Clock,
  Plus,
  Smartphone
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Html5Qrcode } from 'html5-qrcode';
import { useSettings } from '../hooks/useSettings';
import { useAuth } from '../context/AuthContext';
import { v4 as uuidv4 } from 'uuid';
import { dispatchOperation } from '../services/operationService';
import ConfirmationModal from '../components/ConfirmationModal';

export default function Stocktaking() {
  const { user } = useAuth();
  const storeSettings = useSettings();
  const [view, setView] = useState<'sessions' | 'details' | 'new'>('sessions');
  const [selectedSession, setSelectedSession] = useState<StocktakingSession | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastScannedTimeRef = useRef<Record<string, number>>({});
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [newSessionItems, setNewSessionItems] = useState<any[]>([]);
  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    variant: 'primary' | 'danger';
    action: (() => Promise<void> | void) | null;
  }>({
    isOpen: false,
    title: '',
    message: '',
    confirmLabel: 'تأكيد',
    variant: 'primary',
    action: null,
  });
  
  const { 
    products: allProducts, 
    getProductByBarcode 
  } = useInventoryStore();

  // Sync store with database changes
  const liveProducts = usePosEntityRecords<any>('products');
  const liveUnitDefinitions = usePosEntityRecords<any>('unitDefinitions');
  useEffect(() => {
    if (liveProducts) {
      useInventoryStore.getState().updateProducts(liveProducts);
    }
  }, [liveProducts]);

  const allSessions = usePosEntityRecords<any>('stocktakingSessions');
  const sessions = useMemo(() => [...allSessions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()), [allSessions]);
  
  const sessionEntries = usePosRecordsWhereEquals<any>('stocktakingEntries', 'sessionId', selectedSession?.id);
  const scannerRef = useRef<Html5Qrcode | null>(null);

  const handleApproveSession = (session: StocktakingSession) => {
    setConfirmState({
      isOpen: true,
      title: 'اعتماد نتائج الجرد',
      message: 'هل أنت متأكد من اعتماد نتائج هذا الجرد؟ سيتم تحديث الكميات في المخزون وتسوية القيود المحاسبية.',
      confirmLabel: 'اعتماد الجرد',
      variant: 'primary',
      action: async () => {
        setIsProcessing(true);
        try {
          const approvedAt = new Date().toISOString();
          const sessionSnapshot = await getPosRecord<any>('stocktakingSessions', session.id!);
          const entrySnapshots = await getPosRecordsWhereEquals<any>('stocktakingEntries', 'sessionId', session.id!);
          await dispatchOperation(
            'stocktake_approve',
            {
              sessionId: session.id!,
              approvedAt,
              session: sessionSnapshot,
              entries: entrySnapshots,
            },
            user?.branchId
          );
          toast.success('تم اعتماد الجرد وتحديث المخزون بنجاح');
          setView('sessions');
          setSelectedSession(null);
        } catch (error: any) {
          console.error(error);
          toast.error(error?.message || 'حدث خطأ أثناء اعتماد الجرد');
        } finally {
          setIsProcessing(false);
        }
      },
    });
  };

  const handleUpdateSessionStatus = async (id: string, status: 'open' | 'closed' | 'suspended' | 'approved') => {
    try {
      const existing = sessions.find((s) => s.id === id);
      if (existing) {
        await dispatchOperation('entity_upsert', {
          table: 'stocktakingSessions',
          record: { ...existing, status },
        });
      }
      toast.success('تم تحديث حالة الجلسة بنجاح');
      if (selectedSession?.id === id) {
        setSelectedSession({ ...selectedSession, status });
      }
    } catch (error) {
      console.error(error);
      toast.error('حدث خطأ أثناء تحديث حالة الجلسة');
    }
  };

  const handleDeleteSession = (id: string) => {
    setConfirmState({
      isOpen: true,
      title: 'حذف جلسة الجرد',
      message: 'هل أنت متأكد من حذف هذه الجلسة؟ سيتم حذف جميع البيانات المرتبطة بها.',
      confirmLabel: 'حذف الجلسة',
      variant: 'danger',
      action: async () => {
        try {
          const entries = await getPosRecordsWhereEquals<any>('stocktakingEntries', 'sessionId', id);
          for (const entry of entries) {
            if (entry.id !== undefined) {
              await dispatchOperation('entity_delete', { table: 'stocktakingEntries', id: entry.id });
            }
          }
          await dispatchOperation('entity_delete', { table: 'stocktakingSessions', id });
          toast.success('تم حذف الجلسة بنجاح');
          setView('sessions');
          setSelectedSession(null);
        } catch (error) {
          console.error(error);
          toast.error('حدث خطأ أثناء حذف الجلسة');
        }
      },
    });
  };

  const handleStartMobileSession = async () => {
    setIsProcessing(true);
    try {
      const sessionId = uuidv4();
      const session: StocktakingSession = {
        id: sessionId,
        status: 'open',
        createdAt: new Date().toISOString(),
        createdBy: user?.name || 'System',
        branchId: user?.branchId,
        syncStatus: 'pending',
      };

      await dispatchOperation('entity_upsert', {
        table: 'stocktakingSessions',
        record: session,
      });
      toast.success('تم فتح جلسة جرد للمناديب بنجاح');
      setView('sessions');
    } catch (error) {
      console.error(error);
      toast.error('فشل فتح الجلسة');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCreateNewSession = async () => {
    if (newSessionItems.length === 0) return toast.error('القائمة فارغة');

    setIsProcessing(true);
    try {
      const sessionId = uuidv4();
      const now = new Date().toISOString();
      const session: StocktakingSession = {
        id: sessionId,
        status: 'open',
        createdAt: now,
        createdBy: user?.name || 'System',
        branchId: user?.branchId,
        syncStatus: 'pending',
      };

      await dispatchOperation('entity_upsert', {
        table: 'stocktakingSessions',
        record: session,
      });

      for (let i = 0; i < newSessionItems.length; i++) {
        const item = newSessionItems[i];
        const entryId = Date.now() * 1000 + i;
        const entry: StocktakingEntry = {
          id: entryId,
          sessionId,
          productId: item.productId,
          productName: item.name,
          barcode: item.barcode,
          systemQuantity: item.systemQuantity,
          actualQuantity: item.actualQuantity,
          unitCode: item.baseUnitCode || undefined,
          baseUnitCode: item.baseUnitCode || undefined,
          scannedBy: user?.name || 'System',
          scannedAt: now,
          syncStatus: 'pending',
        };
        await dispatchOperation('entity_upsert', {
          table: 'stocktakingEntries',
          record: entry,
        });
      }

      toast.success('تم إنشاء جلسة الجرد بنجاح');
      setNewSessionItems([]);
      setView('sessions');
    } catch (error) {
      console.error(error);
      toast.error('فشل إنشاء الجلسة');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const barcode = searchInputRef.current?.value?.trim();
    if (!barcode) return;
    
    // Double scan protection
    const now = Date.now();
    if (lastScannedTimeRef.current[barcode] && (now - lastScannedTimeRef.current[barcode]) < 500) {
      return;
    }
    lastScannedTimeRef.current[barcode] = now;

    // Optimized lookup using memory cache
    const product = getProductByBarcode(barcode);
    if (product) {
      addToNewSession(product);
      if (searchInputRef.current) {
        searchInputRef.current.value = '';
        setSearchQuery('');
      }
    } else {
      // Fallback to direct DB
      const dbProd = await getFirstPosRecordWhereEquals<any>('products', 'barcode', barcode);
      if (dbProd) {
        addToNewSession(dbProd);
        if (searchInputRef.current) {
          searchInputRef.current.value = '';
          setSearchQuery('');
        }
      } else {
        toast.error('المنتج غير موجود');
      }
    }
  };

  const addToNewSession = (product: Product) => {
    if (newSessionItems.some(item => item.productId === product.id)) {
      toast.error('المنتج مضاف مسبقاً');
      return;
    }
    setNewSessionItems(prev => [{
      productId: product.id!,
      name: product.name,
      barcode: product.barcode,
      systemQuantity: product.stockQuantity,
      actualQuantity: product.stockQuantity,
      baseUnitCode: product.baseUnitCode || undefined,
      quantityPrecision: product.quantityPrecision ?? 0,
      unitLabel: product.baseUnitCode
        ? liveUnitDefinitions.find((unit) => unit.code === product.baseUnitCode)?.name || product.baseUnitCode
        : (product.unit === 'box' ? 'حبة' : product.unit || 'حبة'),
      difference: 0
    }, ...prev]);
  };

  const renderSessionsList = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold text-gray-800">جلسات الجرد</h2>
        <div className="flex gap-3">
          <button 
            onClick={handleStartMobileSession}
            disabled={isProcessing}
            className="bg-amber-500 text-white px-6 py-2 rounded-xl font-bold flex items-center gap-2 shadow-lg shadow-amber-100 disabled:opacity-50"
          >
            <Smartphone className="w-5 h-5" />
            فتح جلسة للمناديب
          </button>
          <button 
            onClick={() => setView('new')}
            className="bg-indigo-600 text-white px-6 py-2 rounded-xl font-bold flex items-center gap-2 shadow-lg shadow-indigo-100"
          >
            <Plus className="w-5 h-5" />
            جرد جديد
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {sessions.map(session => (
          <div 
            key={session.id} 
            className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-all cursor-pointer group"
            onClick={() => { setSelectedSession(session); setView('details'); }}
          >
            <div className="flex justify-between items-start mb-4">
              <div className={`p-3 rounded-xl ${
                session.status === 'approved' ? 'bg-emerald-50 text-emerald-600' : 
                session.status === 'closed' ? 'bg-gray-50 text-gray-600' : 'bg-amber-50 text-amber-600'
              }`}>
                {session.status === 'approved' ? <CheckCircle className="w-6 h-6" /> : 
                 session.status === 'closed' ? <X className="w-6 h-6" /> : <Clock className="w-6 h-6" />}
              </div>
              <span className={`text-xs font-bold px-2.5 py-1 rounded-lg border ${
                session.status === 'approved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 
                session.status === 'closed' ? 'bg-slate-50 text-slate-700 border-slate-200' : 'bg-amber-50 text-amber-700 border-amber-200'
              }`}>
                {session.status === 'approved' ? 'معتمد' : session.status === 'closed' ? 'مغلق' : 'قيد المراجعة'}
              </span>
            </div>
            <h3 className="font-bold text-gray-900 mb-2">جلسة جرد #{session.id?.slice(0, 8)}</h3>
            <div className="space-y-2 text-sm text-gray-500">
              <div className="flex items-center gap-2">
                <User className="w-4 h-4" />
                <span>بواسطة: {session.createdBy}</span>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                <span>بتاريخ: {new Date(session.createdAt).toLocaleDateString('ar-SA')}</span>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 border-t pt-4">
              <button 
                onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.id!); }}
                className="p-2 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                title="حذف"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              {session.status === 'open' && (
                <button 
                  onClick={(e) => { e.stopPropagation(); handleUpdateSessionStatus(session.id!, 'suspended'); }}
                  className="p-2 text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                  title="تعليق"
                >
                  <Clock className="w-4 h-4" />
                </button>
              )}
              {session.status === 'suspended' && (
                <button 
                  onClick={(e) => { e.stopPropagation(); handleUpdateSessionStatus(session.id!, 'open'); }}
                  className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                  title="استئناف"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              )}
              {session.status !== 'closed' && session.status !== 'approved' && (
                <button 
                  onClick={(e) => { e.stopPropagation(); handleUpdateSessionStatus(session.id!, 'closed'); }}
                  className="p-2 text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
                  title="إغلاق"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="mt-4 flex items-center justify-between text-indigo-600 font-bold text-sm group-hover:translate-x-[-4px] transition-transform">
              <span>عرض التفاصيل</span>
              <ChevronLeft className="w-4 h-4" />
            </div>
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="col-span-full py-20 text-center text-gray-400 bg-white rounded-2xl border border-dashed border-gray-200">
            <History className="w-16 h-16 mx-auto mb-4 opacity-20" />
            <p>لا توجد جلسات جرد سابقة</p>
          </div>
        )}
      </div>
    </div>
  );

  const renderSessionDetails = () => (
    <div className="space-y-6">
      <div className="flex items-center gap-4 mb-6">
        <button onClick={() => setView('sessions')} className="p-2 bg-white border border-gray-200 rounded-xl hover:bg-gray-50">
          <ChevronRight className="w-6 h-6" />
        </button>
        <div>
          <h2 className="text-xl font-bold">تفاصيل الجلسة #{selectedSession?.id?.slice(0, 8)}</h2>
          <p className="text-sm text-gray-500">بواسطة {selectedSession?.createdBy} في {new Date(selectedSession?.createdAt || '').toLocaleString('en-GB')}</p>
        </div>
        {selectedSession?.status === 'open' && (
          <button 
            onClick={() => handleApproveSession(selectedSession)}
            disabled={isProcessing}
            className="mr-auto bg-emerald-600 text-white px-6 py-2 rounded-xl font-bold flex items-center gap-2 shadow-lg shadow-emerald-100 disabled:opacity-50"
          >
            {isProcessing ? <RefreshCw className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
            اعتماد الجرد
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm">
        <table className="w-full text-right">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="px-6 py-4 text-sm font-bold text-gray-700">المنتج</th>
              <th className="px-6 py-4 text-sm font-bold text-gray-700 text-center">كمية النظام</th>
              <th className="px-6 py-4 text-sm font-bold text-gray-700 text-center">الكمية الفعلية</th>
              <th className="px-6 py-4 text-sm font-bold text-gray-700 text-center">الفرق</th>
              <th className="px-6 py-4 text-sm font-bold text-gray-700">المسؤول</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sessionEntries.map(entry => (
              <tr key={entry.id} className="hover:bg-gray-50/50 transition-colors">
                <td className="px-6 py-4">
                  <p className="font-bold text-gray-900">{entry.productName}</p>
                  <p className="text-xs text-gray-500">{entry.barcode}</p>
                </td>
                <td className="px-6 py-4 text-center font-bold text-gray-600 tabular-nums">{entry.systemQuantity}</td>
                <td className="px-6 py-4 text-center font-bold text-indigo-600 tabular-nums">{entry.actualQuantity}</td>
                <td className="px-6 py-4 text-center tabular-nums">
                  <span className={`font-bold ${
                    entry.actualQuantity - entry.systemQuantity > 0 ? 'text-emerald-600' : 
                    entry.actualQuantity - entry.systemQuantity < 0 ? 'text-rose-600' : 'text-gray-400'
                  }`}>
                    {entry.actualQuantity - entry.systemQuantity > 0 ? `+${entry.actualQuantity - entry.systemQuantity}` : entry.actualQuantity - entry.systemQuantity}
                  </span>
                </td>
                <td className="px-6 py-4 text-sm text-gray-500">{entry.scannedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderNewSession = () => (
    <div className="space-y-6">
      <div className="flex items-center gap-4 mb-6">
        <button onClick={() => setView('sessions')} className="p-2 bg-white border border-gray-200 rounded-xl hover:bg-gray-50">
          <ChevronRight className="w-6 h-6" />
        </button>
        <h2 className="text-xl font-bold">جرد جديد</h2>
        <button 
          onClick={handleCreateNewSession}
          disabled={newSessionItems.length === 0 || isProcessing}
          className="mr-auto bg-indigo-600 text-white px-6 py-2 rounded-xl font-bold flex items-center gap-2 shadow-lg shadow-indigo-100 disabled:opacity-50"
        >
          {isProcessing ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />}
          بدء الجلسة
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
              <Search className="w-5 h-5 text-indigo-600" />
              إضافة منتج
            </h3>
            <form onSubmit={handleSearchSubmit} className="relative">
              <input
                type="text"
                ref={searchInputRef}
                placeholder="ابحث بالاسم أو الباركود..."
                defaultValue={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
              />
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5" />
            </form>
            {searchQuery && (
              <div className="mt-4 border-t border-gray-50 pt-4 max-h-60 overflow-y-auto custom-scrollbar">
                {allProducts
                  .filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()) || p.barcode.includes(searchQuery))
                  .slice(0, 5)
                  .map(product => (
                    <button
                      key={product.id}
                      onClick={() => addToNewSession(product)}
                      className="w-full flex items-center gap-3 p-3 hover:bg-gray-50 rounded-xl transition-colors text-right"
                    >
                      <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center shrink-0">
                        <Package className="w-6 h-6 text-gray-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm text-gray-900 truncate">{product.name}</p>
                        <p className="text-xs text-gray-500">{product.barcode}</p>
                      </div>
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <table className="w-full text-right">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-6 py-4 text-sm font-bold text-gray-700">المنتج</th>
                  <th className="px-6 py-4 text-sm font-bold text-gray-700 text-center">كمية النظام</th>
                  <th className="px-6 py-4 text-sm font-bold text-gray-700 text-center">الكمية الفعلية (وحدة الأساس)</th>
                  <th className="px-6 py-4 text-sm font-bold text-gray-700"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {newSessionItems.map(item => (
                  <tr key={item.productId}>
                    <td className="px-6 py-4">
                      <p className="font-bold text-gray-900">{item.name}</p>
                      <p className="text-xs text-gray-500">{item.barcode} · وحدة الأساس: {item.unitLabel || 'وحدة'}</p>
                    </td>
                    <td className="px-6 py-4 text-center font-bold text-gray-600">{item.systemQuantity}</td>
                    <td className="px-6 py-4 text-center">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={item.actualQuantity}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setNewSessionItems(prev => prev.map(i => i.productId === item.productId ? { ...i, actualQuantity: val } : i));
                        }}
                        className="w-20 px-2 py-1 border border-gray-200 rounded-lg text-center font-bold focus:ring-2 focus:ring-indigo-500 outline-none"
                      />
                    </td>
                    <td className="px-6 py-4 text-left">
                      <button onClick={() => setNewSessionItems(prev => prev.filter(i => i.productId !== item.productId))} className="text-rose-500">
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-7xl min-w-0 p-3 sm:p-6" dir="rtl">
      <div className="mb-5 sm:mb-8">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <RefreshCw className="w-8 h-8 text-indigo-600" />
          الجرد المخزني
        </h1>
        <p className="text-gray-500 mt-1">إدارة ومراجعة عمليات جرد المخزون</p>
      </div>

      {view === 'sessions' && renderSessionsList()}
      {view === 'details' && renderSessionDetails()}
      {view === 'new' && renderNewSession()}

      <ConfirmationModal
        isOpen={confirmState.isOpen}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        variant={confirmState.variant}
        onCancel={() => setConfirmState(prev => ({ ...prev, isOpen: false, action: null }))}
        onConfirm={async () => {
          const act = confirmState.action;
          setConfirmState(prev => ({ ...prev, isOpen: false, action: null }));
          if (act) await act();
        }}
      />
    </div>
  );
}
