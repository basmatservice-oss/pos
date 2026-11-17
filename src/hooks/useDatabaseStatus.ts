import { useState, useEffect } from 'react';
import { checkDatabaseHealth } from '../services/dbHealth';

export const useDatabaseStatus = () => {
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const scheduleNext = (delayMs: number) => {
      if (!active) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(runCheck, delayMs);
    };

    const runCheck = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const isHealthy = await checkDatabaseHealth();
        if (!active) return;
        setStatus(isHealthy ? 'connected' : 'disconnected');
        scheduleNext(isHealthy ? 15000 : 5000);
      } finally {
        inFlight = false;
      }
    };

    const handleOnline = () => {
      runCheck();
    };
    const handleOffline = () => {
      if (active) setStatus('disconnected');
    };

    runCheck();
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return status;
};
