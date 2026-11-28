import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { io } from 'socket.io-client';
import { syncService } from './services/syncService';
import { apiService } from './services/apiService';
import Layout from './components/Layout';
import POS from './pages/POS';
import Dashboard from './pages/Dashboard';
import Apps from './pages/Apps';
import Inventory from './pages/Inventory';
import Purchases from './pages/Purchases';
import Attendance from './pages/Attendance';
import Payroll from './pages/Payroll';
import Reports from './pages/Reports';
import Offers from './pages/Offers';
import Branches from './pages/Branches';
import MobileSales from './pages/MobileSales';
import Settings from './pages/Settings';
import Customers from './pages/Customers';
import Shifts from './pages/Shifts';
import Expenses from './pages/Expenses';
import Suppliers from './pages/Suppliers';
import Employees from './pages/Employees';
import Onboarding, { BusinessType, DeviceRole } from './pages/Onboarding';
import Login from './pages/Login';
import Returns from './pages/Returns';
import Stocktaking from './pages/Stocktaking';
import SyncStatus from './pages/SyncStatus';
import { AuthProvider, useAuth } from './context/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';
import ProtectedRoute from './components/ProtectedRoute';
import { useSettings } from './hooks/useSettings';
import { useInventoryStore } from './store/useInventoryStore';
import { getFirstPosRecordWhereEquals, putPosSetting } from './services/posDataAccess';
import { usePosEntityRecords } from './hooks/usePosEntityRecords';
import { normalizeNumericInput } from './utils/normalizeNumericInput';
import { applyAppTheme } from './utils/themeManager';

async function readAppSetting(key: string): Promise<{ key: string; value: any } | undefined> {
  return (await getFirstPosRecordWhereEquals<{ key: string; value: any }>('settings', 'key', key)) ?? undefined;
}

async function writeAppSetting(key: string, value: any): Promise<void> {
  await putPosSetting(key, value, 'synced');
}

function AppContent() {
  const [businessType, setBusinessType] = useState<BusinessType | null>(null);
  const [deviceRole, setDeviceRole] = useState<DeviceRole | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { user, isLoading: isAuthLoading } = useAuth();
  const settings = useSettings();
  const [socket, setSocket] = useState<any | null>(null);

  // Global RAM Cache Synchronization
  const liveProducts = usePosEntityRecords('products');
  const liveCategories = usePosEntityRecords('categories');

  useEffect(() => {
    if (liveProducts) {
      useInventoryStore.getState().updateProducts(liveProducts as any);
    }
  }, [liveProducts]);

  useEffect(() => {
    if (liveCategories) {
      useInventoryStore.getState().updateCategories(liveCategories as any);
    }
  }, [liveCategories]);

  // Global HID scanners are handled only when focus is outside editable controls.
  // This avoids stealing keystrokes from forms and prevents duplicate POS submissions.
  useEffect(() => {
    let buffer = '';
    let lastKeyTime = 0;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement && (
        target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
      )) {
        buffer = '';
        lastKeyTime = 0;
        return;
      }
      const now = Date.now();
      if (now - lastKeyTime > 120) buffer = '';
      lastKeyTime = now;
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      if (e.key === 'Enter') {
        if (buffer.length >= 3 && useInventoryStore.getState().getMatchByBarcode(buffer)) {
          window.dispatchEvent(new CustomEvent('barcode-scanned', { detail: buffer }));
        }
        buffer = '';
      } else if (e.key.length === 1) {
        buffer += e.key;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Force a Western numeric keyboard on Android and normalize digits pasted or typed
  // into text-based numeric controls before React consumes the input event.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && (
        target.type === 'number' || target.inputMode === 'numeric' || target.inputMode === 'decimal'
      )) {
        target.lang = 'en-US';
        target.dir = 'ltr';
        if (target.type === 'number' && !target.inputMode) target.inputMode = 'decimal';
      }
    };
    const onInput = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      if (!(target instanceof HTMLInputElement) || !['number', 'text', 'tel'].includes(target.type)) return;
      if (target instanceof HTMLInputElement && target.type === 'text' &&
          target.inputMode !== 'numeric' && target.inputMode !== 'decimal') return;
      const normalized = normalizeNumericInput(target.value);
      if (normalized === target.value) return;
      const prototype = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(target, normalized);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('input', onInput, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('input', onInput, true);
    };
  }, []);

  useEffect(() => {
    if (settings) {
      const root = document.documentElement;
      root.style.setProperty('--primary-color', settings.primaryColor);
      root.style.setProperty('--secondary-color', settings.secondaryColor);
      root.style.setProperty('--sidebar-bg', settings.sidebarColor);
      root.style.setProperty('--header-bg', settings.headerColor);
      root.style.setProperty('--app-bg', settings.backgroundColor);
      root.style.setProperty('--text-main', settings.textColor);
      root.style.setProperty('--base-font-size', settings.fontSize || '14px');
      root.style.setProperty('--border-radius', settings.borderRadius || '12px');
      
      if (settings.fontFamily === 'Tajawal') {
        root.style.fontFamily = '"Tajawal", "Cairo", sans-serif';
      } else {
        root.style.fontFamily = '"Cairo", "Tajawal", sans-serif';
      }
      applyAppTheme(settings as any);
    }
  }, [
    settings.primaryColor, 
    settings.secondaryColor, 
    settings.sidebarColor, 
    settings.headerColor, 
    settings.backgroundColor, 
    settings.textColor, 
    settings.fontSize, 
    settings.borderRadius, 
    settings.fontFamily,
    settings.themeName,
    settings.appearanceMode
  ]);

  useEffect(() => {
    let activeSocket: any = null;
    let isMounted = true;

    const initSocket = async () => {
      let serverUrl = window.location.origin;

      if (deviceRole === 'client') {
        const urlSetting = await readAppSetting('serverUrl');
        if (urlSetting && urlSetting.value) {
          const raw = String(urlSetting.value).trim().replace(/\/+$/, '');
          serverUrl = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
        }
      }

      if (!isMounted) return;
      const newSocket = io(serverUrl, {
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000,
      });
      activeSocket = newSocket;

      newSocket.on('connect', () => {
        console.log(`Connected to server via socket.io (${deviceRole})`);
        const isMobileApp = !!(window as any).Capacitor || !!(window as any).cordova;
        const deviceName =
          localStorage.getItem('pos_device_name') ||
          (isMobileApp ? 'تطبيق الجوال' : deviceRole === 'client' ? 'نقطة بيع فرعية' : 'السيرفر الرئيسي');
        newSocket.emit('register-terminal', {
          deviceName,
          userName: user?.name,
        });
        syncService.syncAll().catch(() => {});
      });

      newSocket.on('connect_error', () => {
        // Offline / LAN server temporarily unreachable
      });

      newSocket.on('data-updated', () => {
        syncService.pullAll().catch(() => {});
      });

      newSocket.on('operation:applied', () => {
        syncService.pullAll().catch(() => {});
      });

      setSocket(newSocket);
    };

    if (deviceRole !== 'standalone') {
      syncService.initAutoSync().catch(() => {});
      initSocket();
    }

    return () => {
      isMounted = false;
      if (activeSocket) activeSocket.disconnect();
    };
  }, [deviceRole]);

  useEffect(() => {
    if (socket?.connected && user) {
      const isMobileApp = !!(window as any).Capacitor || !!(window as any).cordova;
      const deviceName =
        localStorage.getItem('pos_device_name') ||
        (isMobileApp ? 'تطبيق الجوال' : deviceRole === 'client' ? 'نقطة بيع فرعية' : 'السيرفر الرئيسي');
      socket.emit('register-terminal', { deviceName, userName: user.name });
    }
  }, [socket, user, deviceRole]);

  useEffect(() => {
    const fetchInitialSetup = async () => {
      try {
        // Read device role and business type from the active local database
        const roleSetting = await readAppSetting('deviceRole');
        const typeSetting = await readAppSetting('businessType');
        
        // Check if it's a mobile device (Capacitor/Cordova)
        const isMobileApp = !!(window as any).Capacitor || !!(window as any).cordova;

        if (isMobileApp) {
          // Android supports standalone SQLite mode or an explicitly configured LAN client.
          // Legacy/missing "server" roles on Android are normalized to standalone.
          const mobileRole = roleSetting?.value === 'client' ? 'client' : 'standalone';
          setDeviceRole(mobileRole as DeviceRole);
          if (roleSetting?.value !== mobileRole) {
            await putPosSetting('deviceRole', mobileRole, 'local');
          }
          if (typeSetting && typeSetting.value) {
            setBusinessType(typeSetting.value as BusinessType);
          }
        } else {
          if (roleSetting && roleSetting.value) {
            setDeviceRole(roleSetting.value as DeviceRole);
          }
          if (typeSetting && typeSetting.value) {
            setBusinessType(typeSetting.value as BusinessType);
          } else {
            // Fallback to server if not found locally (for existing setups, desktop only)
            try {
              const data = await apiService.get('/settings/businessType');
              if (data && data.value) {
                setBusinessType(data.value as BusinessType);
                await putPosSetting('businessType', data.value, 'synced');
                // Preserve the role supplied by Electron runtime config. Only
                // default to server when no desktop role exists.
                if (!roleSetting && !(window as any).electronAPI?.getDeviceRole) {
                  setDeviceRole('server');
                  await writeAppSetting('deviceRole', 'server');
                }
              }
            } catch (e) {
              console.log('Server not reachable for initial setup check');
            }
          }
        }
      } catch (err) {
        console.error('Error fetching initial setup:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchInitialSetup();
  }, []);

  const handleOnboardingComplete = (type: BusinessType, role: DeviceRole) => {
    setBusinessType(type);
    setDeviceRole(role);
  };

  if (isLoading || isAuthLoading) {
    return (
      <div className="lineage-startup-loader min-h-screen flex flex-col items-center justify-center bg-[#f8fafc] font-sans" dir="rtl">
        <div className="w-12 h-12 border-4 border-indigo-100 border-t-indigo-600 rounded-full animate-spin" />
        <div className="mt-6 text-center">
          <h1 className="text-xl font-extrabold text-slate-900 tracking-tight">POS System v3</h1>
          <p className="text-sm text-slate-500 mt-1 font-medium">جاري تهيئة النظام...</p>
        </div>
      </div>
    );
  }

  if (!businessType || !deviceRole) {
    return (
      <>
        {settings.enableNotifications && <Toaster position="top-center" reverseOrder={false} />}
        <Onboarding onComplete={handleOnboardingComplete} />
      </>
    );
  }

  if (!user) {
    return (
      <>
        {settings.enableNotifications && <Toaster position="top-center" reverseOrder={false} />}
        <Login />
      </>
    );
  }

  // Standalone Android is a full POS workstation, not the restricted mobile-client UI.
  // Keep the compact mobile-sales experience only for devices operating as server clients.
  const isMobileUser = deviceRole !== 'standalone' && (user.deviceType === 'mobile' || user.role === 'sales_rep');

  return (
    <BrowserRouter>
      {settings.enableNotifications && <Toaster position="top-center" reverseOrder={false} />}
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route path="apps" element={<Apps />} />
          <Route index element={
            isMobileUser ? <Navigate to="/mobile-sales" replace /> : 
            <ProtectedRoute permissionId="view_dashboard">
              <Dashboard />
            </ProtectedRoute>
          } />
          
          {/* Redirect sales reps away from desktop-only pages if they try to access them directly */}
          <Route path="pos" element={
            isMobileUser && user.role !== 'admin' ? <Navigate to="/mobile-sales" replace /> :
            <ProtectedRoute permissionId="view_pos"><POS /></ProtectedRoute>
          } />
          <Route path="returns" element={
            isMobileUser && user.role !== 'admin' ? <Navigate to="/mobile-sales" replace /> :
            <ProtectedRoute permissionId="view_returns"><Returns /></ProtectedRoute>
          } />
          <Route path="inventory" element={
            isMobileUser && user.role !== 'admin' ? <Navigate to="/mobile-sales" replace /> :
            <ProtectedRoute permissionId="view_inventory"><Inventory /></ProtectedRoute>
          } />
          <Route path="stocktaking" element={
            isMobileUser && user.role !== 'admin' ? <Navigate to="/mobile-sales" replace /> :
            <ProtectedRoute permissionId="view_stocktaking"><Stocktaking /></ProtectedRoute>
          } />
          <Route path="purchases" element={
            isMobileUser && user.role !== 'admin' ? <Navigate to="/mobile-sales" replace /> :
            <ProtectedRoute permissionId="view_purchases"><Purchases /></ProtectedRoute>
          } />
          <Route path="customers" element={<ProtectedRoute permissionId="view_customers"><Customers /></ProtectedRoute>} />
          <Route path="suppliers" element={
            isMobileUser && user.role !== 'admin' ? <Navigate to="/mobile-sales" replace /> :
            <ProtectedRoute permissionId="view_suppliers"><Suppliers /></ProtectedRoute>
          } />
          <Route path="employees" element={<ProtectedRoute permissionId="view_employees"><Employees /></ProtectedRoute>} />
          <Route path="attendance" element={<ProtectedRoute permissionId="view_attendance"><Attendance /></ProtectedRoute>} />
          <Route path="payroll" element={<ProtectedRoute permissionId="view_payroll"><Payroll /></ProtectedRoute>} />
          <Route path="offers" element={<ProtectedRoute permissionId="view_offers"><Offers /></ProtectedRoute>} />
          <Route path="branches" element={<ProtectedRoute permissionId="view_branches"><Branches /></ProtectedRoute>} />
          <Route path="mobile-sales" element={<ProtectedRoute permissionId="view_mobile_sales"><MobileSales /></ProtectedRoute>} />
          <Route path="shifts" element={
            isMobileUser && user.role !== 'admin' ? <Navigate to="/mobile-sales" replace /> :
            <ProtectedRoute permissionId="view_shifts"><Shifts /></ProtectedRoute>
          } />
          <Route path="expenses" element={
            isMobileUser && user.role !== 'admin' ? <Navigate to="/mobile-sales" replace /> :
            <ProtectedRoute permissionId="view_expenses"><Expenses /></ProtectedRoute>
          } />
          <Route path="reports" element={
            isMobileUser && user.role !== 'admin' ? <Navigate to="/mobile-sales" replace /> :
            <ProtectedRoute permissionId="view_reports"><Reports /></ProtectedRoute>
          } />
          <Route path="settings" element={<ProtectedRoute permissionId="manage_settings"><Settings /></ProtectedRoute>} />
          <Route path="sync-status" element={<ProtectedRoute permissionId="manage_settings"><SyncStatus /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ErrorBoundary>
  );
}
