import { useEffect, useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { LayoutGrid, Package, FileText, Settings, LogOut, Clock, Wifi, WifiOff, Users, Wallet, Truck, UserCircle, ShoppingBag, ShoppingCart, UserCheck, DollarSign, Tag, Building2, Smartphone, RotateCcw, Bell, RefreshCw, ShieldAlert, Lock } from 'lucide-react';
import { getFirstPosRecordWhereEquals, getPosRecord, getPosRecords, putPosRecord } from '../services/posDataAccess';
import { apiService } from '../services/apiService';
import { syncService } from '../services/syncService';
import { useAuth, Role } from '../context/AuthContext';
import { useSyncStore } from '../store/syncStore';
import { useInventoryStore } from '../store/useInventoryStore';
import { DatabaseStatusIndicator } from './DatabaseStatusIndicator';
import SyncIndicator from './SyncIndicator';
import toast from 'react-hot-toast';

export default function Layout() {
  const { isOnline, isSyncing } = useSyncStore();
  const [logo, setLogo] = useState('');
  const [lowStockCount, setLowStockCount] = useState(0);
  const [themeName, setThemeName] = useState('modern');
  const { user, logout, updateCurrentUser, changeLocalCredentials } = useAuth();
  const navigate = useNavigate();

  const [deviceRole, setDeviceRole] = useState<'server' | 'client' | 'standalone'>('server');
  const [oversellAlertCount, setOversellAlertCount] = useState(0);
  const [curPass, setCurPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [newPin, setNewPin] = useState('');
  const [updatingCreds, setUpdatingCreds] = useState(false);

  useEffect(() => {
    useInventoryStore.getState().initialize();

    const loadRoleAndInitialSync = async () => {
      try {
        const roleSetting = await getFirstPosRecordWhereEquals<any>('settings', 'key', 'deviceRole');
        if (roleSetting?.value === 'client' || roleSetting?.value === 'server' || roleSetting?.value === 'standalone') {
          setDeviceRole(roleSetting.value);
        }
        await loadSettings();
        await checkLowStock();
        await syncService.syncAll().catch(() => {});
      } catch (e) {
        console.error('Layout init error:', e);
      }
    };

    loadRoleAndInitialSync();

    const handleOnline = () => {
      syncService.syncAll().catch(() => {});
    };
    window.addEventListener('online', handleOnline);

    const syncInterval = setInterval(() => {
      handleSync();
    }, 30000);

    return () => {
      clearInterval(syncInterval);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  const handleSync = async () => {
    if (isSyncing) return;

    try {
      const synced = await syncService.syncAll();
      if (synced) {
        await loadSettings();
        await checkLowStock();
      }
    } catch (error) {
      console.error('Sync error:', error);
    }
  };

  const checkLowStock = async () => {
    try {
      const products = await getPosRecords<any>('products');
      const lowStock = products.filter(p => p.stockQuantity <= (p.minStockLevel || 5));
      setLowStockCount(lowStock.length);

      const alerts = await getPosRecords<any>('inventoryAlerts');
      setOversellAlertCount(alerts.filter(a => !a.resolved).length);
    } catch (error) {
      console.error('Error checking low stock:', error);
    }
  };

  const loadSettings = async () => {
    try {
      const res = await getPosRecords<any>('settings');
      if (res && res.length > 0) {
        const theme: any = {};
        res.forEach((s: any) => {
          theme[s.key] = s.value;
          if (s.key === 'businessLogo') setLogo(s.value);
        });
        
        const root = document.documentElement;
        if (theme.primaryColor) root.style.setProperty('--primary-color', theme.primaryColor);
        if (theme.secondaryColor) root.style.setProperty('--secondary-color', theme.secondaryColor);
        if (theme.sidebarColor) {
          root.style.setProperty('--sidebar-bg', theme.sidebarColor);
          const hex = theme.sidebarColor.replace('#', '');
          const r = parseInt(hex.substr(0, 2), 16);
          const g = parseInt(hex.substr(2, 2), 16);
          const b = parseInt(hex.substr(4, 2), 16);
          const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
          if (yiq >= 128) {
            document.body.classList.remove('sidebar-dark');
            document.body.classList.add('sidebar-light');
          } else {
            document.body.classList.remove('sidebar-light');
            document.body.classList.add('sidebar-dark');
          }
        }
        if (theme.headerColor) {
          root.style.setProperty('--header-bg', theme.headerColor);
          const hex = theme.headerColor.replace('#', '');
          const r = parseInt(hex.substr(0, 2), 16);
          const g = parseInt(hex.substr(2, 2), 16);
          const b = parseInt(hex.substr(4, 2), 16);
          const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
          if (yiq >= 128) {
            document.body.classList.remove('header-dark');
            document.body.classList.add('header-light');
          } else {
            document.body.classList.remove('header-light');
            document.body.classList.add('header-dark');
          }
        }
        if (theme.backgroundColor) root.style.setProperty('--app-bg', theme.backgroundColor);
        if (theme.textColor) root.style.setProperty('--text-main', theme.textColor);
        if (theme.fontSize) root.style.setProperty('--base-font-size', theme.fontSize);
        if (theme.borderRadius) root.style.setProperty('--border-radius', theme.borderRadius);
        
        // Apply font family
        if (theme.fontFamily === 'Tajawal') {
          root.style.fontFamily = '"Tajawal", "Cairo", sans-serif';
        } else {
          root.style.fontFamily = '"Cairo", "Tajawal", sans-serif';
        }

        const currentThemeName = theme.themeName || 'modern';
        setThemeName(currentThemeName);
        document.body.className = `theme-${currentThemeName}`;
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const handleMandatoryPasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    const standalone = await syncService.getDeviceRole() === 'standalone';
    if (!newPass || newPass.length < 6) {
      toast.error('كلمة المرور الجديدة يجب أن لا تقل عن 6 أحرف');
      return;
    }
    if (newPass === '123456') {
      toast.error('يرجى اختيار كلمة مرور غير الافتراضية 123456');
      return;
    }
    if (newPass !== confirmPass) {
      toast.error('تأكيد كلمة المرور غير متطابق');
      return;
    }
    if (newPin && (newPin.length < 4 || newPin === '1234')) {
      toast.error('يرجى إدخال رمز PIN جديد مكون من 4 أرقام على الأقل (غير 1234)');
      return;
    }

    setUpdatingCreds(true);
    try {
      if (standalone) {
        await changeLocalCredentials(curPass, newPass, newPin || undefined);
        setCurPass('');
        setNewPass('');
        setConfirmPass('');
        setNewPin('');
        toast.success('تم تحديث كلمة المرور ورمز الدخول محليًا على هذا الجهاز');
        return;
      }
      await apiService.changePassword({
        currentPassword: curPass || undefined,
        newPassword: newPass,
        newPinCode: newPin || undefined,
      });
      if (user?.id) {
        const employee = await getPosRecord<any>('employees', user.id);
        if (employee) {
          await putPosRecord('employees', {
            ...employee,
            mustChangePassword: false,
            syncStatus: 'synced',
          }, 'synced').catch(() => {});
        }
      }
      updateCurrentUser({ mustChangePassword: false });
      setCurPass('');
      setNewPass('');
      setConfirmPass('');
      setNewPin('');
      toast.success('تم تأمين الحساب وتحديث بيانات الدخول بنجاح');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'تعذر تحديث كلمة المرور — تأكد من الاتصال بالسيرفر');
    } finally {
      setUpdatingCreds(false);
    }
  };

  const roleLabels: Record<Role, string> = {
    admin: 'مدير النظام',
    manager: 'مدير فرع',
    cashier: 'كاشير',
    sales_rep: 'مندوب مبيعات'
  };

  const navItems = [
    { to: '/', icon: LayoutGrid, label: 'الرئيسية', permissionId: 'view_dashboard' },
    { to: '/pos', icon: ShoppingBag, label: 'نقطة البيع', permissionId: 'view_pos' },
    { to: '/returns', icon: RotateCcw, label: 'المرتجعات', permissionId: 'view_returns' },
    { to: '/inventory', icon: Package, label: 'المخزون', permissionId: 'view_inventory' },
    { to: '/stocktaking', icon: RefreshCw, label: 'الجرد', permissionId: 'view_stocktaking' },
    { to: '/purchases', icon: ShoppingCart, label: 'المشتريات', permissionId: 'view_purchases' },
    { to: '/customers', icon: Users, label: 'العملاء', permissionId: 'view_customers' },
    { to: '/suppliers', icon: Truck, label: 'الموردون', permissionId: 'view_suppliers' },
    { to: '/employees', icon: UserCircle, label: 'الموظفون', permissionId: 'view_employees' },
    { to: '/attendance', icon: UserCheck, label: 'الحضور', permissionId: 'view_attendance' },
    { to: '/payroll', icon: DollarSign, label: 'الرواتب', permissionId: 'view_payroll' },
    { to: '/offers', icon: Tag, label: 'العروض', permissionId: 'view_offers' },
    { to: '/branches', icon: Building2, label: 'الفروع', permissionId: 'view_branches' },
    { to: '/mobile-sales', icon: Smartphone, label: 'تطبيق المناديب', permissionId: 'view_mobile_sales' },
    { to: '/shifts', icon: Clock, label: 'الورديات', permissionId: 'view_shifts' },
    { to: '/expenses', icon: Wallet, label: 'المصروفات', permissionId: 'view_expenses' },
    { to: '/reports', icon: FileText, label: 'التقارير', permissionId: 'view_reports' },
    { to: '/sync-status', icon: RefreshCw, label: 'المزامنة', permissionId: 'manage_settings' },
    { to: '/settings', icon: Settings, label: 'الإعدادات', permissionId: 'manage_settings' },
  ];

  const filteredNavItems = navItems.filter(item => {
    if (!user) return false;
    
    // Hide sync status on server only when there are no unresolved oversell/sync alerts
    if (item.to === '/sync-status' && deviceRole === 'server' && oversellAlertCount === 0) return false;
    
    // Admin always has access
    if (user.role === 'admin') return true;

    // Check if user has explicit permission
    const hasPermission = user.permissions?.includes(item.permissionId);
    
    return hasPermission;
  });

  const isMobileSalesPage = window.location.pathname === '/mobile-sales';

  if (isMobileSalesPage) {
    return (
      <div className="flex h-screen bg-white overflow-hidden" dir="rtl">
        <main className="flex-1 flex flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[var(--app-bg)] text-[var(--text-main)] font-sans" dir="rtl">
      {/* Sidebar */}
      <aside className="w-24 bg-sidebar border-l border-gray-200 flex flex-col items-center py-6 shadow-sm z-10 overflow-y-auto hide-scrollbar">
        <div className="w-12 h-12 shrink-0 bg-indigo-600 text-white rounded-xl flex items-center justify-center font-bold text-xl mb-8 shadow-md overflow-hidden">
          {logo ? <img src={logo} alt="Logo" className="w-full h-full object-cover" /> : 'POS'}
        </div>
        
        <nav className="flex-1 w-full flex flex-col gap-2 px-3">
          {filteredNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center p-3 rounded-xl transition-all duration-200 ${
                  isActive
                    ? 'bg-indigo-50 text-indigo-600 shadow-sm'
                    : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
                }`
              }
            >
              <item.icon className="w-6 h-6 mb-1" />
              <span className="text-[10px] font-medium text-center leading-tight">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="mt-4 shrink-0 flex flex-col items-center gap-4 w-full px-3">
          {deviceRole === 'client' && (
            <button 
              onClick={handleSync}
              disabled={isSyncing || !isOnline}
              className={`flex flex-col items-center justify-center p-2 rounded-xl w-full transition-all ${
                isSyncing ? 'animate-pulse text-indigo-600 bg-indigo-50' : 
                !isOnline ? 'text-gray-300 bg-gray-50 cursor-not-allowed' :
                'text-indigo-600 bg-indigo-50 hover:bg-indigo-100'
              }`}
            >
              <RefreshCw className={`w-5 h-5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span className="text-[9px] mt-1 font-bold">{isSyncing ? 'جاري...' : 'مزامنة'}</span>
            </button>
          )}

          <div className={`flex flex-col items-center justify-center p-2 rounded-xl w-full ${isOnline ? 'text-emerald-500 bg-emerald-50' : 'text-rose-500 bg-rose-50'}`}>
            {isOnline ? <Wifi className="w-5 h-5" /> : <WifiOff className="w-5 h-5" />}
            <span className="text-[9px] mt-1 font-bold">{isOnline ? 'متصل' : 'أوفلاين'}</span>
          </div>
          
          <button onClick={handleLogout} className="flex flex-col items-center justify-center p-3 rounded-xl text-gray-500 hover:bg-rose-50 hover:text-rose-600 transition-all duration-200 w-full">
            <LogOut className="w-6 h-6 mb-1" />
            <span className="text-[10px] font-medium">خروج</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header */}
        <header className="h-16 bg-header border-b border-gray-200 flex items-center justify-between px-6 shrink-0">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-gray-800">نظام الكاشير الذكي</h1>
            <div className="h-6 w-px bg-gray-300"></div>
            <div className="flex items-center text-sm text-gray-500">
              <Clock className="w-4 h-4 ml-2" />
              <span>{new Date().toLocaleDateString('ar-SA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <DatabaseStatusIndicator />
            {deviceRole === 'client' && <SyncIndicator />}
            <div className="h-6 w-px bg-gray-300"></div>
            {(lowStockCount > 0 || oversellAlertCount > 0) && (
              <button 
                onClick={() => navigate(oversellAlertCount > 0 ? '/sync-status' : '/inventory')}
                className="relative p-2 text-gray-500 hover:bg-gray-100 rounded-full transition-colors"
                title={oversellAlertCount > 0 ? 'تنبيهات بيع أوفلاين وعجز مخزون' : 'تنبيهات المخزون'}
              >
                <Bell className="w-6 h-6" />
                <span className="absolute top-0 right-0 w-5 h-5 bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center rounded-full border-2 border-white">
                  {lowStockCount + oversellAlertCount}
                </span>
              </button>
            )}
            <div className="text-right">
              <p className="text-sm font-bold text-gray-900">{user?.name || 'مستخدم'}</p>
              <p className="text-xs text-gray-500">{user ? roleLabels[user.role] : ''}</p>
            </div>
            <div className="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-700 font-bold border border-indigo-200">
              {user?.name ? user.name.substring(0, 2) : 'م'}
            </div>
          </div>
        </header>

        {user?.mustChangePassword && (
          <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center justify-between text-xs text-amber-900 shrink-0">
            <span className="font-bold">
              تنبيه أمني: ما زلت تستخدم كلمة المرور أو رمز PIN الافتراضي. يرجى تغييرهما لحماية النظام.
            </span>
            <button
              onClick={() => navigate('/settings')}
              className="px-3 py-1.5 bg-amber-600 text-white rounded-lg font-bold hover:bg-amber-700 transition-colors whitespace-nowrap shrink-0"
            >
              تغيير الآن
            </button>
          </div>
        )}

        {/* Page Content */}
        <div className="flex-1 overflow-hidden relative">
          <Outlet />
        </div>
      </main>

      {user?.mustChangePassword && (
        <div className="fixed inset-0 z-[120] bg-slate-900/75 backdrop-blur-sm flex items-center justify-center p-4" dir="rtl">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl border border-slate-200 p-7 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600 shrink-0">
                <ShieldAlert className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-black text-slate-900">تغيير بيانات الدخول الإلزامي</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  لحماية النظام قبل التشغيل الإنتاجي، يجب تغيير كلمة المرور الافتراضية الآن.
                </p>
              </div>
            </div>

            <form onSubmit={handleMandatoryPasswordChange} className="space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">كلمة المرور الحالية (الافتراضية: 123456)</label>
                <input
                  type="password"
                  value={curPass}
                  onChange={(e) => setCurPass(e.target.value)}
                  placeholder="أدخل كلمة المرور الحالية"
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">كلمة المرور الجديدة *</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  placeholder="6 أحرف أو أرقام على الأقل"
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">تأكيد كلمة المرور الجديدة *</label>
                <input
                  type="password"
                  required
                  value={confirmPass}
                  onChange={(e) => setConfirmPass(e.target.value)}
                  placeholder="أعد إدخال كلمة المرور"
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">رمز PIN جديد (اختياري - 4 أرقام)</label>
                <input
                  type="text"
                  maxLength={6}
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  placeholder="مثال: 5820"
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="flex items-center gap-2.5 pt-2">
                <button
                  type="submit"
                  disabled={updatingCreds}
                  className="flex-1 flex items-center justify-center gap-2 py-3 bg-indigo-600 text-white rounded-xl font-bold text-sm hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Lock className="w-4 h-4" />
                  {updatingCreds ? 'جاري التحديث...' : 'حفظ وتأمين الحساب'}
                </button>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="px-4 py-3 bg-slate-100 text-slate-600 rounded-xl font-bold text-sm hover:bg-slate-200"
                >
                  خروج
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
