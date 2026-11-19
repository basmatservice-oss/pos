import axios from 'axios';
import { apiService } from './apiService';
import { ensureNativePosDatabase, isNativeAndroid } from '../native/posLocalDatabase';
import { nativePosRepository } from '../native/nativePosRepository';

export const checkDatabaseHealth = async (): Promise<boolean> => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    // A standalone Android device is healthy when its local SQLite store is available.
    if (isNativeAndroid()) {
      try {
        const role = await nativePosRepository.firstWhereEquals<{ key: string; value: string }>(
          'settings',
          'key',
          'deviceRole',
        );
        if (role?.value === 'standalone') return await ensureNativePosDatabase();
      } catch {
        return false;
      }
    }
    return false;
  }

  if (isNativeAndroid()) {
    try {
      const role = await nativePosRepository.firstWhereEquals<{ key: string; value: string }>(
        'settings',
        'key',
        'deviceRole',
      );
      if (role?.value === 'standalone') return await ensureNativePosDatabase();
    } catch {
      return false;
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await axios.get(`${apiService.API_BASE}/health`, { timeout: 12000 });
      return response.data?.connected === true;
    } catch {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  return false;
};
