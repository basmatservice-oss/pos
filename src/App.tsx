import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { io } from 'socket.io-client';
import { syncService } from './services/syncService';
import Layout from './components/Layout';
import POS from './pages/POS';
import Dashboard from './pages/Dashboard';
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
import { db, ensureDatabaseReady } from './db/db';
import { useInventoryStore } from './store/useInventoryStore';
import { useLiveQuery } from 'dexie-react-hooks';

function AppContent() {
  const [businessType, setBusinessType] = useState<BusinessType | null>(null);
  const [deviceRole, setDeviceRole] = useState<DeviceRole | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { user, isLoading: isAuthLoading } = useAuth();
  const settings = useSettings();
  const [socket, setSocket] = useState<any | null>(null);

  // Global RAM Cache Synchronization
  const liveProducts = useLiveQuery(() => db.products.toArray());
  const liveCategories = useLiveQuery(() => db.categories.toArray());

  useEffect(() => {
    if (liveProducts) {
      useInventoryStore.getState().updateProducts(liveProducts);
    }
  }, [liveProducts]);

  useEffect(() => {
    if (liveCategories) {
      useInventoryStore.getState().updateCategories(liveCategories);
    }
  }, [liveCategories]);

  // --- Professional Global HID Scanner Listener ---
  useEffect(() => {
    let buffer = '';
    let lastKeyTime = Date.now();

    const handleKeyDown = (e: KeyboardEvent) => {
      const now = Date.now();
      
      // If time between keys is > 50ms, it's probably a human typing, reset
      if (now - lastKeyTime > 50) {
        buffer = '';
      }
      
      lastKeyTime = now;

      // Ignore single modifier keys
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;

      if (e.key === 'Enter') {
        if (buffer.length > 2) {
          // It's a barcode!
          const product = useInventoryStore.getState().getProductByBarcode(buffer);
          if (product) {
            // Trigger a custom event that POS.tsx can listen to
            window.dispatchEvent(new CustomEvent('barcode-scanned', { detail: buffer }));
            // toast.success(`تم العثور على: ${product.name}`);
          }
          buffer = '';
        }
      } else if (e.key.length === 1) {
        buffer += e.key;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
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
    settings.fontFamily
  ]);

  useEffect(() => {
    let activeSocket: any = null;
    let isMounted = true;

    const initSocket = async () => {
      let serverUrl = window.location.origin;

      if (deviceRole === 'client') {
        const urlSetting = await db.settings.where('key').equals('serverUrl').first();
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

    syncService.initAutoSync();

    initSocket();

    return () => {
      isMounted = false;
      if (activeSocket) activeSocket.disconnect();
    };
  }, [deviceRole]);

  useEffect(() => {
    const fetchInitialSetup = async () => {
      try {
        await ensureDatabaseReady();
        // First check local Dexie DB for role and business type
        const roleSetting = await db.settings.where('key').equals('deviceRole').first();
        const typeSetting = await db.settings.where('key').equals('businessType').first();
        
        // Check if it's a mobile device (Capacitor/Cordova)
        const isMobileApp = !!(window as any).Capacitor || !!(window as any).cordova;

        if (isMobileApp) {
          // Force client role for mobile apps
          setDeviceRole('client');
          if (!roleSetting || roleSetting.value !== 'client') {
             await db.settings.put({ key: 'deviceRole', value: 'client', syncStatus: 'synced', updatedAt: new Date().toISOString() });
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
              const res = await fetch('/api/settings/businessType');
              if (res.ok) {
                const data = await res.json();
                if (data && data.value) {
                  setBusinessType(data.value as BusinessType);
                  // Assume server role if it was already set up before this update
                  if (!roleSetting) {
                    setDeviceRole('server');
                    await db.settings.put({ key: 'deviceRole', value: 'server', syncStatus: 'synced', updatedAt: new Date().toISOString() });
                  }
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
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#f8fafc] font-sans" dir="rtl">
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

  // Smart redirection based on role/device
  const isMobileUser = user.deviceType === 'mobile' || user.role === 'sales_rep';

  return (
    <BrowserRouter>
      {settings.enableNotifications && <Toaster position="top-center" reverseOrder={false} />}
      <Routes>
        <Route path="/" element={<Layout />}>
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
