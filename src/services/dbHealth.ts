import axios from 'axios';
import { apiService } from './apiService';

export const checkDatabaseHealth = async (): Promise<boolean> => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
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
