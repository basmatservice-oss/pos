import axios from 'axios';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { nativePosRepository } from '../native/nativePosRepository';
import { electronPosRepository, isElectronDesktop } from '../native/electronPosRepository';

export let API_BASE = '/api';

const TOKEN_STORAGE_KEY = 'pos_auth_token';

export const getAuthToken = (): string | null => {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_STORAGE_KEY);
};

export const setAuthToken = (token: string | null) => {
  if (typeof window === 'undefined') return;
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
};

axios.interceptors.request.use((config) => {
  const token = getAuthToken();
  if (token) {
    const headers = axios.AxiosHeaders.from(config.headers);
    headers.set('Authorization', `Bearer ${token}`);
    config.headers = headers;
  }
  return config;
});

const getRuntimeSetting = async (key: string): Promise<{ key: string; value: any } | undefined> => {
  if (isNativeAndroid()) {
    return (await nativePosRepository.firstWhereEquals<{ key: string; value: any }>('settings', 'key', key)) ?? undefined;
  }
  if (isElectronDesktop()) {
    return (await electronPosRepository.firstWhereEquals<{ key: string; value: any }>('settings', 'key', key)) ?? undefined;
  }
  const { db } = await import('../db/db');
  return db.settings.where('key').equals(key).first();
};

const putRuntimeSetting = async (key: string, value: any, updatedAt: string): Promise<void> => {
  const record = { key, value, syncStatus: 'synced', updatedAt };
  if (isNativeAndroid()) {
    await nativePosRepository.put('settings', record, 'synced');
    return;
  }
  if (isElectronDesktop()) {
    const existing = await electronPosRepository.firstWhereEquals<{ id?: unknown } & Record<string, unknown>>('settings', 'key', key);
    await electronPosRepository.put('settings', { ...existing, id: existing?.id ?? Date.now() * 1000, ...record }, 'synced');
    return;
  }
  const { db } = await import('../db/db');
  await db.settings.put(record);
};

const formatUrl = (url: string) => {
  let formattedUrl = url.trim();
  if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
    formattedUrl = `http://${formattedUrl}`;
  }
  return formattedUrl.endsWith('/') ? `${formattedUrl}api` : `${formattedUrl}/api`;
};

const initApiBase = async () => {
  try {
    if (typeof window !== 'undefined' && window.location.hostname.includes('run.app')) {
      API_BASE = '/api';
      return;
    }

    const desktopApi = (window as any).electronAPI;
    if (desktopApi?.getDeviceRole) {
      const runtimeRole = await desktopApi.getDeviceRole();
      const runtimeServerUrl = runtimeRole === 'client' && desktopApi.getServerUrl
        ? await desktopApi.getServerUrl()
        : null;
      if (runtimeRole === 'server' || runtimeRole === 'client') {
        const updatedAt = new Date().toISOString();
        await putRuntimeSetting('deviceRole', runtimeRole, updatedAt);
        if (runtimeRole === 'client' && runtimeServerUrl) {
          await putRuntimeSetting('serverUrl', runtimeServerUrl, updatedAt);
          API_BASE = formatUrl(runtimeServerUrl);
        } else {
          API_BASE = '/api';
        }
        return;
      }
    }

    const deviceRoleSetting = await getRuntimeSetting('deviceRole');
    const deviceRole = deviceRoleSetting ? deviceRoleSetting.value : 'server';

    if (deviceRole === 'server') {
      API_BASE = '/api';
    } else {
      const serverUrlSetting = await getRuntimeSetting('serverUrl');
      if (serverUrlSetting && serverUrlSetting.value) {
        API_BASE = formatUrl(serverUrlSetting.value);
      }
    }
  } catch (e) {
    console.error('Failed to init API_BASE:', e);
  }
};

initApiBase();

export const updateApiBase = async (url: string) => {
  try {
    if (typeof window !== 'undefined' && window.location.hostname.includes('run.app')) {
      API_BASE = '/api';
      return;
    }

    const deviceRoleSetting = await getRuntimeSetting('deviceRole');
    const deviceRole = deviceRoleSetting ? deviceRoleSetting.value : 'server';

    if (deviceRole === 'server') {
      API_BASE = '/api';
    } else {
      API_BASE = formatUrl(url);
    }
  } catch {
    API_BASE = formatUrl(url);
  }
};

export const setApiBaseDirect = (url: string) => {
  if (!url) {
    API_BASE = '/api';
  } else {
    API_BASE = formatUrl(url);
  }
};

const requestWithRetry = async (fn: () => Promise<any>, retries = 2, delay = 600): Promise<any> => {
  try {
    return await fn();
  } catch (error: any) {
    if (retries === 0) throw error;
    const status = error?.response?.status;
    // Do not retry client/auth/conflict errors
    if (status && status >= 400 && status < 500) throw error;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return requestWithRetry(fn, retries - 1, delay * 2);
  }
};

axios.defaults.timeout = 10000;

export const apiService = {
  get API_BASE() {
    return API_BASE;
  },

  async checkServerReachability(timeoutMs = 2500): Promise<boolean> {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${API_BASE}/health`, { signal: controller.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  },

  async get(endpoint: string, params?: Record<string, any>) {
    const cleanPath = endpoint.startsWith('/api/')
      ? `${API_BASE}${endpoint.slice(4)}`
      : endpoint.startsWith('/')
      ? `${API_BASE}${endpoint}`
      : `${API_BASE}/${endpoint}`;
    return requestWithRetry(() => axios.get(cleanPath, { params }).then((r) => r.data));
  },

  async post(endpoint: string, data?: any) {
    const cleanPath = endpoint.startsWith('/api/')
      ? `${API_BASE}${endpoint.slice(4)}`
      : endpoint.startsWith('/')
      ? `${API_BASE}${endpoint}`
      : `${API_BASE}/${endpoint}`;
    return requestWithRetry(() => axios.post(cleanPath, data).then((r) => r.data));
  },

  // --- Auth & Pairing ---
  async getPublicConfig() {
    return requestWithRetry(() => axios.get(`${API_BASE}/public-config`).then((r) => r.data));
  },

  async saveInitialSetup(businessType: string) {
    return axios.post(`${API_BASE}/settings/initial-setup`, { businessType }).then((r) => r.data);
  },

  async changePassword(data: { currentPassword?: string; newPassword?: string; newPinCode?: string }) {
    return axios.post(`${API_BASE}/auth/change-password`, data).then((r) => r.data);
  },

  // --- Atomic Business Operations ---
  async executeOperation(type: string, payload: any, operationId?: string, deviceId?: string) {
    return axios
      .post(`${API_BASE}/operations/execute`, { type, payload, operationId, deviceId })
      .then((r) => r.data);
  },

  async executeOperationsBatch(operations: Array<{ id: string; type: string; payload: any; deviceId?: string; branchId?: number }>) {
    return axios.post(`${API_BASE}/operations/batch`, { operations }).then((r) => r.data);
  },

  // --- Products ---
  async getProducts() {
    return requestWithRetry(() => axios.get(`${API_BASE}/products`).then((r) => r.data));
  },
  async createProduct(product: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/products`, product).then((r) => r.data));
  },
  async updateProduct(id: number, product: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/products/${id}`, product).then((r) => r.data));
  },
  async deleteProduct(id: number) {
    return requestWithRetry(() => axios.delete(`${API_BASE}/products/${id}`).then((r) => r.data));
  },

  // --- Categories ---
  async getCategories() {
    return requestWithRetry(() => axios.get(`${API_BASE}/categories`).then((r) => r.data));
  },
  async createCategory(category: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/categories`, category).then((r) => r.data));
  },
  async updateCategory(id: number, category: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/categories/${id}`, category).then((r) => r.data));
  },
  async deleteCategory(id: number) {
    return requestWithRetry(() => axios.delete(`${API_BASE}/categories/${id}`).then((r) => r.data));
  },

  // --- Customers ---
  async getCustomers() {
    return requestWithRetry(() => axios.get(`${API_BASE}/customers`).then((r) => r.data));
  },
  async createCustomer(customer: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/customers`, customer).then((r) => r.data));
  },
  async updateCustomer(id: number, customer: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/customers/${id}`, customer).then((r) => r.data));
  },
  async deleteCustomer(id: number) {
    return requestWithRetry(() => axios.delete(`${API_BASE}/customers/${id}`).then((r) => r.data));
  },

  // --- Suppliers ---
  async getSuppliers() {
    return requestWithRetry(() => axios.get(`${API_BASE}/suppliers`).then((r) => r.data));
  },
  async createSupplier(supplier: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/suppliers`, supplier).then((r) => r.data));
  },
  async updateSupplier(id: number, supplier: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/suppliers/${id}`, supplier).then((r) => r.data));
  },
  async deleteSupplier(id: number) {
    return requestWithRetry(() => axios.delete(`${API_BASE}/suppliers/${id}`).then((r) => r.data));
  },

  // --- Orders & Returns ---
  async getOrders() {
    return requestWithRetry(() => axios.get(`${API_BASE}/orders`).then((r) => r.data));
  },
  async createOrder(order: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/orders`, order).then((r) => r.data));
  },
  async updateOrder(id: string, order: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/orders/${id}`, order).then((r) => r.data));
  },
  async getOrderItems() {
    return requestWithRetry(() => axios.get(`${API_BASE}/orderItems`).then((r) => r.data));
  },
  async createOrderItem(orderItem: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/orderItems`, orderItem).then((r) => r.data));
  },
  async deleteOrderItem(id: number) {
    return requestWithRetry(() => axios.delete(`${API_BASE}/orderItems/${id}`).then((r) => r.data));
  },
  async getReturns() {
    return requestWithRetry(() => axios.get(`${API_BASE}/returns`).then((r) => r.data));
  },
  async getReturnItems() {
    return requestWithRetry(() => axios.get(`${API_BASE}/returnItems`).then((r) => r.data));
  },

  // --- Accounting ---
  async getAccounts() {
    return requestWithRetry(() => axios.get(`${API_BASE}/accounts`).then((r) => r.data));
  },
  async getJournalEntries() {
    return requestWithRetry(() => axios.get(`${API_BASE}/journalEntries`).then((r) => r.data));
  },
  async getTransactions() {
    return requestWithRetry(() => axios.get(`${API_BASE}/transactions`).then((r) => r.data));
  },
  async getFinancialReport(params?: { startDate?: string; endDate?: string; branchId?: number }) {
    return requestWithRetry(() => axios.get(`${API_BASE}/reports/financial`, { params }).then((r) => r.data));
  },

  // --- Shifts ---
  async getShifts() {
    return requestWithRetry(() => axios.get(`${API_BASE}/shifts`).then((r) => r.data));
  },
  async getShiftMovements() {
    return requestWithRetry(() => axios.get(`${API_BASE}/shiftMovements`).then((r) => r.data));
  },
  async createShift(shift: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/shifts`, shift).then((r) => r.data));
  },
  async updateShift(id: string, shift: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/shifts/${id}`, shift).then((r) => r.data));
  },

  // --- Expenses ---
  async getExpenses() {
    return requestWithRetry(() => axios.get(`${API_BASE}/expenses`).then((r) => r.data));
  },
  async createExpense(expense: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/expenses`, expense).then((r) => r.data));
  },
  async deleteExpense(id: number) {
    return requestWithRetry(() => axios.delete(`${API_BASE}/expenses/${id}`).then((r) => r.data));
  },

  // --- Employees ---
  async getEmployees() {
    return requestWithRetry(() => axios.get(`${API_BASE}/employees`).then((r) => r.data));
  },
  async createEmployee(employee: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/employees`, employee).then((r) => r.data));
  },
  async updateEmployee(id: number, employee: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/employees/${id}`, employee).then((r) => r.data));
  },
  async deleteEmployee(id: number) {
    return requestWithRetry(() => axios.delete(`${API_BASE}/employees/${id}`).then((r) => r.data));
  },

  // --- Settings ---
  async getSettings() {
    return requestWithRetry(() => axios.get(`${API_BASE}/settings`).then((r) => r.data));
  },
  async createSetting(setting: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/settings`, setting).then((r) => r.data));
  },
  async updateSetting(key: string, setting: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/settings/${key}`, setting).then((r) => r.data));
  },

  async checkout(checkoutData: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/checkout`, checkoutData).then((r) => r.data));
  },

  // --- Attendance & Loyalty & Payroll ---
  async getAttendance() {
    return requestWithRetry(() => axios.get(`${API_BASE}/attendance`).then((r) => r.data));
  },
  async recordAttendance(attendance: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/attendance`, attendance).then((r) => r.data));
  },
  async updateAttendance(id: string, attendance: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/attendance/${id}`, attendance).then((r) => r.data));
  },
  async getLoyaltyTransactions() {
    return requestWithRetry(() => axios.get(`${API_BASE}/loyalty-transactions`).then((r) => r.data));
  },
  async createLoyaltyTransaction(transaction: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/loyalty-transactions`, transaction).then((r) => r.data));
  },
  async getPayroll() {
    return requestWithRetry(() => axios.get(`${API_BASE}/payroll`).then((r) => r.data));
  },
  async createPayroll(payroll: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/payroll`, payroll).then((r) => r.data));
  },

  // --- Branches & Offers ---
  async getBranches() {
    return requestWithRetry(() => axios.get(`${API_BASE}/branches`).then((r) => r.data));
  },
  async createBranch(branch: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/branches`, branch).then((r) => r.data));
  },
  async updateBranch(id: number, branch: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/branches/${id}`, branch).then((r) => r.data));
  },
  async deleteBranch(id: number) {
    return requestWithRetry(() => axios.delete(`${API_BASE}/branches/${id}`).then((r) => r.data));
  },
  async getOffers() {
    return requestWithRetry(() => axios.get(`${API_BASE}/offers`).then((r) => r.data));
  },
  async createOffer(offer: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/offers`, offer).then((r) => r.data));
  },
  async updateOffer(id: number, offer: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/offers/${id}`, offer).then((r) => r.data));
  },
  async deleteOffer(id: number) {
    return requestWithRetry(() => axios.delete(`${API_BASE}/offers/${id}`).then((r) => r.data));
  },

  // --- Purchases ---
  async getPurchases() {
    return requestWithRetry(() => axios.get(`${API_BASE}/purchases`).then((r) => r.data));
  },
  async getPurchaseItems() {
    return requestWithRetry(() => axios.get(`${API_BASE}/purchaseItems`).then((r) => r.data));
  },
  async createPurchase(purchaseData: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/purchases`, purchaseData).then((r) => r.data));
  },
  async createPurchaseItem(purchaseItem: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/purchaseItems`, purchaseItem).then((r) => r.data));
  },
  async updatePurchase(id: string, purchase: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/purchases/${id}`, purchase).then((r) => r.data));
  },
  async deletePurchase(id: string) {
    return requestWithRetry(() => axios.delete(`${API_BASE}/purchases/${id}`).then((r) => r.data));
  },
  async getPurchaseReturns() {
    return requestWithRetry(() => axios.get(`${API_BASE}/purchaseReturns`).then((r) => r.data));
  },
  async getPurchaseReturnItems() {
    return requestWithRetry(() => axios.get(`${API_BASE}/purchaseReturnItems`).then((r) => r.data));
  },
  async getCustomerPayments() {
    return requestWithRetry(() => axios.get(`${API_BASE}/customerPayments`).then((r) => r.data));
  },
  async getSupplierPayments() {
    return requestWithRetry(() => axios.get(`${API_BASE}/supplierPayments`).then((r) => r.data));
  },

  async getSalesReport(params: { startDate?: string; endDate?: string; branchId?: number }) {
    return requestWithRetry(() => axios.get(`${API_BASE}/reports/sales`, { params }).then((r) => r.data));
  },

  // --- Audit, Stocktaking, Batches & Alerts ---
  async getAuditLogs() {
    return requestWithRetry(() => axios.get(`${API_BASE}/auditLogs`).then((r) => r.data));
  },
  async createAuditLog(log: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/auditLogs`, log).then((r) => r.data));
  },
  async getStocktakingSessions() {
    return requestWithRetry(() => axios.get(`${API_BASE}/stocktakingSessions`).then((r) => r.data));
  },
  async createStocktakingSession(session: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/stocktakingSessions`, session).then((r) => r.data));
  },
  async updateStocktakingSession(id: string, session: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/stocktakingSessions/${id}`, session).then((r) => r.data));
  },
  async getStocktakingEntries() {
    return requestWithRetry(() => axios.get(`${API_BASE}/stocktakingEntries`).then((r) => r.data));
  },
  async createStocktakingEntry(entry: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/stocktakingEntries`, entry).then((r) => r.data));
  },
  async getInventoryBatches() {
    return requestWithRetry(() => axios.get(`${API_BASE}/inventoryBatches`).then((r) => r.data));
  },
  async createInventoryBatch(batch: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/inventoryBatches`, batch).then((r) => r.data));
  },
  async updateInventoryBatch(id: string | number, batch: any) {
    return requestWithRetry(() => axios.put(`${API_BASE}/inventoryBatches/${id}`, batch).then((r) => r.data));
  },
  async getInventoryAlerts() {
    return requestWithRetry(() => axios.get(`${API_BASE}/inventoryAlerts`).then((r) => r.data));
  },
  async resolveInventoryAlert(id: string) {
    return requestWithRetry(() => axios.post(`${API_BASE}/inventoryAlerts/${id}/resolve`).then((r) => r.data));
  },
  async getInventoryMovements(params?: {
    productId?: number;
    latest?: boolean;
    offset?: number;
    limit?: number;
    branchId?: number;
    sourceType?: string;
    startDate?: string;
    endDate?: string;
  }) {
    return requestWithRetry(() => axios.get(`${API_BASE}/inventoryMovements`, { params }).then((r) => r.data));
  },
  async getInventoryMovementReconciliation() {
    return requestWithRetry(() => axios.get(`${API_BASE}/inventoryMovements/reconciliation`).then((r) => r.data));
  },

  // --- Backup & Restore ---
  async getBackup() {
    const token = getAuthToken();
    const response = await fetch(`${API_BASE}/backup`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error('Network response was not ok');
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-${new Date().toISOString().split('T')[0]}.db`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  },
  async listBackups() {
    return requestWithRetry(() => axios.get(`${API_BASE}/backup/list`).then((r) => r.data));
  },
  async verifyBackup(filename: string) {
    return axios.post(`${API_BASE}/backup/verify`, { filename }).then((r) => r.data);
  },
  async clearData() {
    return axios.post(`${API_BASE}/settings/clearData`).then((r) => r.data);
  },
  async importSql(file: File) {
    const formData = new FormData();
    formData.append('file', file);
    return axios
      .post(`${API_BASE}/settings/importSql`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data);
  },

  // --- Service Recipes, Exchange Rate History, Fiscal Periods & System Status ---
  async getServiceRecipes() {
    return requestWithRetry(() => axios.get(`${API_BASE}/serviceRecipes`).then((r) => r.data));
  },
  async saveServiceRecipe(recipe: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/serviceRecipes`, recipe).then((r) => r.data));
  },
  async deleteServiceRecipe(id: string) {
    return requestWithRetry(() => axios.delete(`${API_BASE}/serviceRecipes/${id}`).then((r) => r.data));
  },
  async getExchangeRateHistory() {
    return requestWithRetry(() => axios.get(`${API_BASE}/exchangeRateHistory`).then((r) => r.data));
  },
  async addExchangeRate(entry: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/exchangeRateHistory`, entry).then((r) => r.data));
  },
  async getFiscalPeriods() {
    return requestWithRetry(() => axios.get(`${API_BASE}/fiscalPeriods`).then((r) => r.data));
  },
  async saveFiscalPeriod(period: any) {
    return requestWithRetry(() => axios.post(`${API_BASE}/fiscalPeriods`, period).then((r) => r.data));
  },
  async closeFiscalPeriod(id: string) {
    return axios.post(`${API_BASE}/fiscalPeriods/${id}/close`).then((r) => r.data);
  },
  async reopenFiscalPeriod(id: string) {
    return axios.post(`${API_BASE}/fiscalPeriods/${id}/reopen`).then((r) => r.data);
  },
  async getSystemStatus() {
    return axios.get(`${API_BASE}/system/status`).then((r) => r.data);
  },

  // --- Sync Queue ---
  async getSyncQueue() {
    return requestWithRetry(() => axios.get(`${API_BASE}/sync-queue`).then((r) => r.data));
  },
  async deleteSyncQueueItem(id: string) {
    return requestWithRetry(() => axios.delete(`${API_BASE}/sync-queue/${id}`).then((r) => r.data));
  },
  async retrySyncQueueItem(id: string) {
    return requestWithRetry(() => axios.post(`${API_BASE}/sync-queue/${id}/retry`).then((r) => r.data));
  },
  async processSyncQueue() {
    return requestWithRetry(() => axios.post(`${API_BASE}/sync-queue/process`).then((r) => r.data));
  },
};
