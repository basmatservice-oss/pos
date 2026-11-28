import { usePosEntityRecords } from './usePosEntityRecords';

export function useSettings() {
  const settings = usePosEntityRecords<any>('settings');
  const exchangeRateHistory = usePosEntityRecords<any>('exchangeRateHistory');

  const storeSettings = {
    businessName: 'متجري الذكي',
    businessLogo: '',
    businessAddress: '',
    businessPhone: '',
    taxNumber: '',
    primaryColor: '#4f46e5',
    secondaryColor: '#10b981',
    sidebarColor: '#1e293b',
    headerColor: '#ffffff',
    backgroundColor: '#f8fafc',
    textColor: '#1e293b',
    accentColor: '#6366f1',
    borderRadius: '12px',
    fontFamily: 'Inter',
    fontSize: '14px',
    shadowIntensity: 'medium',
    currency: 'ج.س',
    taxRate: 15,
    language: 'ar',
    enableNotifications: true,
    receiptHeader: 'شكراً لزيارتكم',
    receiptFooter: 'يرجى الاحتفاظ بالفاتورة للاستبدال',
    showTaxDetails: true,
    showCustomerInfo: true,
    showLogoOnReceipt: true,
    autoBackup: true,
    autoBackupInterval: 'daily' as 'hourly' | 'daily' | 'weekly' | 'monthly',
    enableDirectPrint: false,
    printerType: 'usb' as 'usb' | 'usb_58' | 'bluetooth' | 'network',
    scannerType: 'usb' as 'usb' | 'camera' | 'bluetooth',
    inventoryScannerType: 'usb' as 'usb' | 'camera',
    posScannerType: 'usb' as 'usb' | 'camera',
    loginMethod: 'password' as 'password' | 'pin',
    syncMode: 'local' as 'local' | 'cloud',
    supabaseUrl: '',
    supabaseKey: '',
    enableCloudSync: false,
    isOnlineMode: true,
    serverUrl: 'http://localhost:3000',
    themeName: 'modern' as 'modern' | 'classic' | 'brutalist' | 'glassmorphism' | 'playful' | 'lineageos24',
    appearanceMode: 'system' as 'system' | 'light' | 'dark',
    businessType: 'multi' as 'supermarket' | 'pharmacy' | 'apparel' | 'restaurant' | 'electronics' | 'hardware' | 'bookstore' | 'multi',
    deviceRole: 'server' as 'server' | 'client',
    exchangeRate: 0,
    baseCurrency: 'ج.س',
    currencyDecimals: 2,
    quantityDecimals: 3,
    allowNegativeStock: true,
    offlineStockPolicy: 'allow_with_alert' as 'allow_with_alert' | 'block' | 'manager_override',
    inventoryValuationMethod: 'fifo' as 'fifo' | 'weighted_average',
    targetProfitMargin: 25,
  };

  settings.forEach(setting => {
    const key = setting.key;
    const value = setting.value;

    if (key in storeSettings) {
      if (value === 'true') (storeSettings as any)[key] = true;
      else if (value === 'false') (storeSettings as any)[key] = false;
      else if (!isNaN(Number(value)) && typeof (storeSettings as any)[key] === 'number') (storeSettings as any)[key] = Number(value);
      else (storeSettings as any)[key] = value;
    }
    
    // Legacy mappings
    if (key === 'storeName') storeSettings.businessName = value;
    if (key === 'logoUrl') storeSettings.businessLogo = value;
    if (key === 'storeAddress') storeSettings.businessAddress = value;
    if (key === 'storePhone') storeSettings.businessPhone = value;
    if (key === 'showTaxOnReceipt') storeSettings.showTaxDetails = value === 'true';
    if (key === 'currency' && !settings.some(s => s.key === 'baseCurrency')) storeSettings.baseCurrency = value;
  });

  // The configured display currency is the single source of truth for the base currency.
  // Ignore stale legacy baseCurrency rows that could otherwise show a different unit.
  const latestUsdRate = exchangeRateHistory
    .filter((row) => String(row.currency || '').toUpperCase() === 'USD' && Number(row.rate) > 0)
    .sort((left, right) => new Date(right.effectiveFrom || right.createdAt || 0).getTime() - new Date(left.effectiveFrom || left.createdAt || 0).getTime())[0];
  if (latestUsdRate) storeSettings.exchangeRate = Number(latestUsdRate.rate);
  else if (Number(storeSettings.exchangeRate) === 1) storeSettings.exchangeRate = 0;
  storeSettings.currency = 'ج.س';
  storeSettings.baseCurrency = 'ج.س';

  return storeSettings;
}
