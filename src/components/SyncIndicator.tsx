import React, { useEffect } from 'react';
import { RefreshCw, Server, ServerOff } from 'lucide-react';
import { useSyncStore } from '../store/syncStore';
import { syncService } from '../services/syncService';
import { apiService } from '../services/apiService';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { nativePosRepository } from '../native/nativePosRepository';

export default function SyncIndicator() {
  const { isOnline, isSyncing, lastSynced, pendingItemsCount, setOnlineStatus } = useSyncStore();

  useEffect(() => {
    let active = true;
    let cleanupProbe = () => {};

    const start = async () => {
      if (isNativeAndroid()) {
        const role = await nativePosRepository.firstWhereEquals<{ key: string; value: unknown }>(
          'settings', 'key', 'deviceRole',
        );
        if (!active) return;
        if (role?.value === 'standalone') {
          // A standalone device has no server dependency: do not probe the LAN
          // or schedule periodic synchronization checks.
          setOnlineStatus(false);
          syncService.updatePendingCount().catch(() => {});
          return;
        }
      }

      const probeAndSync = async () => {
        const reachable = await apiService.checkServerReachability(2000);
        if (!active) return;
        setOnlineStatus(reachable);
        if (reachable) {
          syncService.syncAll().catch(() => {});
        } else {
          syncService.updatePendingCount().catch(() => {});
        }
      };

      const handleOnline = () => { probeAndSync(); };
      const handleOffline = () => setOnlineStatus(false);
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      probeAndSync();
      const interval = setInterval(probeAndSync, 15000);
      cleanupProbe = () => {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
        clearInterval(interval);
      };
    };

    start().catch((error) => {
      if (active) console.error('Unable to initialize sync indicator:', error);
    });
    return () => {
      active = false;
      cleanupProbe();
    };
  }, [setOnlineStatus]);

  return (
    <div className="flex items-center gap-3 text-sm">
      {pendingItemsCount > 0 && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-xs font-bold whitespace-nowrap tabular-nums">
          <span>{pendingItemsCount}</span>
          <span>بانتظار المزامنة</span>
        </div>
      )}

      <div
        className="flex items-center gap-2 text-gray-600"
        title={
          lastSynced
            ? `آخر مزامنة: ${lastSynced.toLocaleTimeString('ar-SA')}`
            : isOnline
            ? 'متصل بسيرفر الشبكة المحلية'
            : 'سيرفر الشبكة المحلية غير متاح (وضع أوفلاين)'
        }
      >
        {isSyncing ? (
          <RefreshCw className="w-5 h-5 animate-spin text-blue-500" />
        ) : isOnline ? (
          <Server className="w-5 h-5 text-emerald-500" />
        ) : (
          <ServerOff className="w-5 h-5 text-rose-500" />
        )}
      </div>
    </div>
  );
}
