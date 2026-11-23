import Dexie, { Table } from 'dexie';

// --- Interfaces ---

export interface AuditLog {
  id?: string | number;
  date: string;
  userName: string;
  productName?: string;
  operationName: string;
  action?: string;
  type: string;
  details: string;
  quantity: number;
  value: number;
  branchId?: number;
  entityId?: string;
  entityName?: string;
  syncStatus: 'synced' | 'pending' | 'error';
}

export interface ProductUnit {
  name: string;
  barcode?: string;
  conversionFactor: number;
  sellingPrice: number;
  costPrice?: number;
  priceInUSD?: number;
  allowFractions?: boolean;
}

export interface Product {
  id?: number;
  barcode: string;
  name: string;
  categoryId: number;
  costPrice: number;
  sellingPrice: number; // VAT-inclusive price
  costInUSD?: number; // USD anchor for the current SDG cost; zero means fixed manually in SDG.
  priceInUSD?: number; // USD anchor for the current SDG selling price; zero means fixed manually in SDG.
  stockQuantity: number;
  minStockLevel?: number;
  unit: string;
  conversionFactor: number;
  itemType?: 'stock' | 'service' | 'service_with_materials' | 'bundle';
  allowFractions?: boolean | number;
  unitsJson?: string;
  baseUnitCode?: string;
  quantityPrecision?: number;
  isActive?: number;
  vatRate: number;
  imageUrl?: string;
  branchId?: number;
  expiryDate?: string;
  batchNumber?: string;
  syncStatus: 'synced' | 'pending' | 'error';
  updatedAt: string;
}

export interface UnitDefinition {
  code: string;
  name: string;
  symbol?: string;
  dimension: string;
  decimalPlaces: number;
  isFractional: number;
  isSystem?: number;
  syncStatus?: 'synced' | 'pending' | 'error';
}

export interface ProductUnitRecord {
  id: string;
  productId: number;
  unitCode: string;
  conversionToBase: number;
  isBaseUnit: number;
  sellingPrice?: number | null;
  barcode?: string | null;
  syncStatus?: 'synced' | 'pending' | 'error';
}

export interface InventoryMovementRecord {
  id: string;
  movementKey: string;
  productId: number;
  movementType: string;
  sourceType: string;
  sourceId: string;
  quantityDeltaBase: number;
  baseUnitCode?: string;
  unitCost: number;
  totalCost: number;
  branchId?: number;
  operationId?: string;
  reason?: string;
  createdBy?: string;
  syncStatus: 'synced' | 'pending' | 'error' | 'conflict';
  createdAt: string;
}

export interface ServiceRecipe {
  id: string;
  parentProductId: number;
  ingredientProductId: number;
  ingredientName?: string;
  quantity: number;
  unit?: string;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt?: string;
  updatedAt?: string;
}

export interface ExchangeRateRecord {
  id: string;
  currency: string;
  rate: number;
  source?: string;
  effectiveFrom: string;
  notes?: string;
  createdBy?: string;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt?: string;
}

export interface FiscalPeriod {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'open' | 'closed';
  closedAt?: string;
  closedBy?: string;
  notes?: string;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt?: string;
  updatedAt?: string;
}

export interface InventoryBatch {
  id?: string | number;
  productId: number;
  purchaseId?: string | null;
  quantity: number;
  remainingQuantity?: number;
  costPrice: number;
  currency?: string;
  exchangeRate?: number;
  purchaseDate: string;
  expiryDate?: string;
  batchNumber?: string;
  branchId?: number;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt?: string;
  updatedAt?: string;
}

export interface Category {
  id?: number;
  name: string;
  color: string;
  branchId?: number;
  syncStatus: 'synced' | 'pending' | 'error';
}

export interface Order {
  id?: string;
  receiptNumber: string;
  totalAmount: number; // Gross sales excl. tax before discounts
  discountAmount: number; // Discount excl. tax
  taxAmount: number;
  netAmount: number; // Final VAT-inclusive total paid
  paidAmount?: number;
  cashAmount?: number;
  cardAmount?: number;
  returnedAmount?: number;
  paymentMethod: 'cash' | 'card' | 'credit' | 'mixed';
  currency?: string;
  exchangeRate?: number;
  customerId?: number;
  customerName?: string;
  branchId?: number;
  shiftId?: string;
  tableNumber?: string;
  orderType?: 'dine_in' | 'takeaway' | 'delivery';
  status: 'completed' | 'refunded' | 'void' | 'returned' | 'partially_returned';
  createdBy?: string;
  deviceId?: string;
  operationId?: string;
  createdAt: string;
  updatedAt?: string;
  syncStatus: 'synced' | 'pending' | 'error';
  items?: any[];
}

export interface OrderItem {
  id?: number;
  orderId: string;
  productId: number;
  productName: string;
  quantity: number;
  returnedQuantity?: number;
  unit?: string;
  conversionFactor?: number;
  itemType?: 'stock' | 'service' | 'service_with_materials' | 'bundle';
  unitPrice: number;
  costPriceAtTimeOfSale: number;
  discountAmount?: number;
  subTotal: number;
  taxAmount: number;
  total: number;
  batchAllocations?: string;
  syncStatus?: 'synced' | 'pending' | 'error';
}

export interface ReturnRecord {
  id: string;
  returnNumber: string;
  originalOrderId: string;
  originalReceiptNumber?: string;
  customerId?: number;
  customerName?: string;
  branchId?: number;
  shiftId?: string;
  refundMethod: 'cash' | 'card' | 'credit_adjustment';
  currency?: string;
  exchangeRate?: number;
  subTotal: number;
  discountAmount: number;
  taxAmount: number;
  totalRefund: number;
  totalCostReversed: number;
  reason?: string;
  createdBy?: string;
  deviceId?: string;
  operationId?: string;
  createdAt: string;
  updatedAt: string;
  syncStatus: 'synced' | 'pending' | 'error';
}

export interface ReturnItem {
  id: string;
  returnId: string;
  orderItemId?: number;
  productId: number;
  productName: string;
  quantity: number;
  condition?: 'resalable' | 'damaged';
  unitPrice: number;
  costPrice: number;
  taxAmount: number;
  total: number;
  batchAllocations?: string;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt?: string;
}

export interface Account {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  parentCode?: string;
  balance: number;
  isSystem?: number;
  createdAt?: string;
  updatedAt: string;
}

export interface JournalEntry {
  id?: string | number;
  entryNumber?: string;
  date: string;
  description: string;
  debitAccount?: string;
  creditAccount?: string;
  amount?: number;
  totalDebit?: number;
  totalCredit?: number;
  status?: 'posted' | 'reversed';
  reversedEntryId?: string;
  createdBy?: string;
  branchId?: number;
  referenceId: string;
  referenceType:
    | 'order'
    | 'purchase'
    | 'purchase_return'
    | 'expense'
    | 'payment'
    | 'return'
    | 'payroll'
    | 'stocktake'
    | 'shift_movement'
    | 'opening';
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt?: string;
}

export interface Transaction {
  id?: string | number;
  orderId?: string;
  purchaseId?: string;
  returnId?: string;
  journalEntryId: string | number;
  accountId?: string;
  accountName?: string;
  type?: 'debit' | 'credit';
  amount?: number;
  debit?: number;
  credit?: number;
  description?: string;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt?: string;
}

export interface Shift {
  id?: string;
  startTime: string;
  endTime?: string;
  openingCash: number;
  expectedCash?: number;
  actualCash?: number;
  branchId?: number;
  status: 'open' | 'closed';
  syncStatus: 'synced' | 'pending' | 'error';
}

export interface ShiftMovement {
  id: string;
  shiftId: string;
  type: 'deposit' | 'withdrawal';
  amount: number;
  reason?: string;
  createdBy?: string;
  branchId?: number;
  operationId?: string;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt: string;
}

export interface Customer {
  id?: number;
  name: string;
  phone: string;
  email?: string;
  balance: number;
  points: number;
  branchId?: number;
  createdAt: string;
  updatedAt: string;
  syncStatus: 'synced' | 'pending' | 'error';
}

export interface CustomerPayment {
  id: string;
  customerId: number;
  customerName?: string;
  orderId?: string;
  amount: number;
  paymentMethod: 'cash' | 'card';
  notes?: string;
  shiftId?: string;
  branchId?: number;
  createdBy?: string;
  operationId?: string;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt: string;
}

export interface Attendance {
  id?: number | string;
  employeeId: number;
  employeeName: string;
  date: string;
  checkIn: string;
  checkOut?: string;
  totalHours?: number;
  branchId?: number;
  status: 'present' | 'absent' | 'late';
  syncStatus: 'synced' | 'pending' | 'error';
}

export interface LoyaltyTransaction {
  id?: number | string;
  customerId: number;
  orderId?: string;
  type: 'earn' | 'redeem';
  points: number;
  date: string;
  syncStatus: 'synced' | 'pending' | 'error';
}

export interface Branch {
  id?: number;
  name: string;
  address: string;
  phone?: string;
  email?: string;
  isActive: boolean;
  status?: string;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt: string;
}

export interface Payroll {
  id?: number;
  employeeId: number;
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  salaryType?: 'monthly' | 'hourly';
  totalHours: number;
  hourlyRate: number;
  basicSalary: number;
  bonuses: number;
  deductions: number;
  netSalary: number;
  paymentMethod?: 'cash' | 'card';
  branchId?: number;
  paymentDate: string;
  status: 'paid' | 'pending';
  syncStatus: 'synced' | 'pending' | 'error';
}

export interface Offer {
  id?: number;
  name: string;
  type: 'discount' | 'bogo' | 'bundle';
  value: number;
  startDate: string;
  endDate: string;
  isActive: boolean;
  applicableProducts?: number[];
  minPurchaseAmount?: number;
  branchId?: number;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt: string;
  updatedAt: string;
}

export interface Expense {
  id?: number;
  description: string;
  amount: number;
  category: string;
  paymentMethod?: 'cash' | 'card';
  shiftId?: string;
  date: string;
  branchId?: number;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt: string;
  updatedAt: string;
}

export interface Supplier {
  id?: number;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  balance: number;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt: string;
  updatedAt: string;
}

export interface SupplierPayment {
  id: string;
  supplierId: number;
  supplierName?: string;
  purchaseId?: string;
  amount: number;
  paymentMethod: 'cash' | 'card';
  notes?: string;
  shiftId?: string;
  branchId?: number;
  createdBy?: string;
  operationId?: string;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt: string;
}

export interface Employee {
  id?: number;
  name: string;
  username: string;
  password?: string;
  pinCode?: string;
  mustChangePassword?: boolean | number;
  role: 'admin' | 'manager' | 'cashier' | 'sales_rep';
  phone: string;
  salary: number;
  salaryType?: 'monthly' | 'hourly';
  branchId?: number;
  joinDate: string;
  status: 'active' | 'inactive';
  deviceType: 'desktop' | 'mobile';
  permissions?: string[];
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt: string;
  updatedAt: string;
}

export interface AppSetting {
  id?: number;
  key: string;
  value: any;
  syncStatus: 'synced' | 'pending' | 'error';
  updatedAt: string;
}

export interface Purchase {
  id?: string;
  supplierId: number;
  supplierName: string;
  totalAmount: number;
  paymentStatus: 'paid' | 'partial' | 'unpaid';
  paymentMethod?: 'cash' | 'card';
  paidAmount: number;
  returnedAmount?: number;
  currency?: string;
  currencyCode?: string;
  baseCurrencyCode?: string;
  originalTotalAmount?: number;
  originalPaidAmount?: number;
  exchangeRate?: number;
  shippingCost?: number;
  customsCost?: number;
  otherCosts?: number;
  extraCostsPaymentMethod?: 'cash' | 'card' | 'supplier';
  date: string;
  branchId?: number;
  deviceId?: string;
  operationId?: string;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt: string;
  updatedAt?: string;
}

export interface PurchaseItem {
  id?: number;
  purchaseId: string;
  productId: number;
  productName: string;
  quantity: number;
  unit?: string;
  unitCode?: string;
  baseUnitCode?: string;
  conversionFactor?: number;
  conversionToBase?: number;
  baseQuantity?: number;
  costPrice: number;
  landedCostPerBaseUnit?: number;
  total: number;
  originalTotal?: number;
  expiryDate?: string;
  batchNumber?: string;
  syncStatus?: 'synced' | 'pending' | 'error';
}

export interface PurchaseReturn {
  id: string;
  returnNumber: string;
  originalPurchaseId: string;
  supplierId?: number;
  supplierName?: string;
  branchId?: number;
  shiftId?: string;
  refundMethod: 'cash' | 'card' | 'credit_adjustment';
  currency?: string;
  exchangeRate?: number;
  totalReturn: number;
  reason?: string;
  createdBy?: string;
  deviceId?: string;
  operationId?: string;
  createdAt: string;
  updatedAt: string;
  syncStatus: 'synced' | 'pending' | 'error';
}

export interface PurchaseReturnItem {
  id: string;
  purchaseReturnId: string;
  productId: number;
  productName: string;
  quantity: number;
  costPrice: number;
  total: number;
  batchId?: string;
  syncStatus: 'synced' | 'pending' | 'error';
  createdAt?: string;
}

export interface HeldOrder {
  id: string;
  label: string;
  items: any[];
  globalDiscount: number;
  globalDiscountType: 'percentage' | 'fixed';
  customerId?: number;
  customerName?: string;
  orderType?: 'dine_in' | 'takeaway' | 'delivery';
  tableNumber?: string;
  createdBy?: string;
  createdAt: string;
}

export interface StocktakingSession {
  id?: string;
  status: 'open' | 'closed' | 'approved' | 'suspended';
  createdAt: string;
  createdBy: string;
  branchId?: number;
  syncStatus: 'synced' | 'pending' | 'error';
}

export interface StocktakingEntry {
  id?: number | string;
  sessionId: string;
  productId: number;
  productName: string;
  barcode: string;
  systemQuantity: number;
  actualQuantity: number;
  unitCode?: string;
  baseUnitCode?: string;
  scannedBy: string;
  scannedAt: string;
  syncStatus: 'synced' | 'pending' | 'error';
}

export interface SyncOperation {
  id: string;
  type:
    | 'sale'
    | 'return'
    | 'order_void'
    | 'purchase'
    | 'purchase_update'
    | 'purchase_delete'
    | 'purchase_return'
    | 'expense'
    | 'expense_delete'
    | 'shift_open'
    | 'shift_close'
    | 'shift_movement'
    | 'customer_payment'
    | 'supplier_payment'
    | 'payroll'
    | 'stocktake_approve'
    | 'entity_upsert'
    | 'entity_delete';
  payload: any;
  deviceId: string;
  branchId?: number;
  status: 'pending' | 'syncing' | 'synced' | 'error' | 'conflict';
  retryCount: number;
  lastError?: string;
  nextRetryAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryAlert {
  id: string;
  productId: number;
  productName: string;
  previousQty: number;
  changeQty: number;
  resultingQty: number;
  operationId?: string;
  deviceId?: string;
  reason: string;
  resolved: number;
  createdAt: string;
}

export class POSDatabase extends Dexie {
  products!: Table<Product, number>;
  categories!: Table<Category, number>;
  orders!: Table<Order, string>;
  orderItems!: Table<OrderItem, number>;
  returns!: Table<ReturnRecord, string>;
  returnItems!: Table<ReturnItem, string>;
  accounts!: Table<Account, string>;
  shifts!: Table<Shift, string>;
  shiftMovements!: Table<ShiftMovement, string>;
  customers!: Table<Customer, number>;
  customerPayments!: Table<CustomerPayment, string>;
  expenses!: Table<Expense, number>;
  suppliers!: Table<Supplier, number>;
  supplierPayments!: Table<SupplierPayment, string>;
  employees!: Table<Employee, number>;
  settings!: Table<AppSetting, number>;
  purchases!: Table<Purchase, string>;
  purchaseItems!: Table<PurchaseItem, number>;
  purchaseReturns!: Table<PurchaseReturn, string>;
  purchaseReturnItems!: Table<PurchaseReturnItem, string>;
  attendance!: Table<Attendance, number | string>;
  loyaltyTransactions!: Table<LoyaltyTransaction, number>;
  branches!: Table<Branch, number>;
  payroll!: Table<Payroll, number>;
  offers!: Table<Offer, number>;
  auditLogs!: Table<AuditLog, string | number>;
  journalEntries!: Table<JournalEntry, string | number>;
  transactions!: Table<Transaction, string | number>;
  stocktakingSessions!: Table<StocktakingSession, string>;
  stocktakingEntries!: Table<StocktakingEntry, number | string>;
  inventoryBatches!: Table<InventoryBatch, string | number>;
  syncOperations!: Table<SyncOperation, string>;
  inventoryAlerts!: Table<InventoryAlert, string>;
  heldOrders!: Table<HeldOrder, string>;
  serviceRecipes!: Table<ServiceRecipe, string>;
  exchangeRateHistory!: Table<ExchangeRateRecord, string>;
  fiscalPeriods!: Table<FiscalPeriod, string>;
  unitDefinitions!: Table<UnitDefinition, string>;
  productUnits!: Table<ProductUnitRecord, string>;
  inventoryMovements!: Table<InventoryMovementRecord, string>;

  constructor() {
    super('RetailPOSDB');

    this.version(1).stores({
      products: '++id, barcode, categoryId, name, syncStatus',
      categories: '++id, name, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, syncStatus',
      orderItems: '++id, orderId, productId',
      shifts: 'id, status, startTime, syncStatus',
    });

    this.version(2).stores({
      products: '++id, barcode, categoryId, name, syncStatus',
      categories: '++id, name, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, syncStatus, customerId',
      orderItems: '++id, orderId, productId',
      shifts: 'id, status, startTime, syncStatus',
      customers: '++id, name, phone, syncStatus',
    });

    this.version(3).stores({
      products: '++id, barcode, categoryId, name, syncStatus',
      categories: '++id, name, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, syncStatus, customerId',
      orderItems: '++id, orderId, productId',
      shifts: 'id, status, startTime, syncStatus',
      customers: '++id, name, phone, syncStatus',
      expenses: '++id, date, category, syncStatus',
    });

    this.version(4).stores({
      products: '++id, barcode, categoryId, name, syncStatus',
      categories: '++id, name, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, syncStatus, customerId',
      orderItems: '++id, orderId, productId',
      shifts: 'id, status, startTime, syncStatus',
      customers: '++id, name, phone, syncStatus',
      expenses: '++id, date, category, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
    });

    this.version(5).stores({
      products: '++id, barcode, categoryId, name, syncStatus',
      categories: '++id, name, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, syncStatus, customerId',
      orderItems: '++id, orderId, productId',
      shifts: 'id, status, startTime, syncStatus',
      customers: '++id, name, phone, syncStatus',
      expenses: '++id, date, category, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      employees: '++id, name, role, status, syncStatus',
    });

    this.version(6).stores({
      products: '++id, barcode, categoryId, name, syncStatus',
      categories: '++id, name, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, syncStatus, customerId',
      orderItems: '++id, orderId, productId',
      shifts: 'id, status, startTime, syncStatus',
      customers: '++id, name, phone, syncStatus',
      expenses: '++id, date, category, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      employees: '++id, name, role, status, syncStatus',
      settings: '++id, key, syncStatus',
    });

    this.version(7).stores({
      products: '++id, barcode, categoryId, name, syncStatus',
      categories: '++id, name, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, syncStatus, customerId',
      orderItems: '++id, orderId, productId',
      shifts: 'id, status, startTime, syncStatus',
      customers: '++id, name, phone, syncStatus',
      expenses: '++id, date, category, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      employees: '++id, name, role, status, syncStatus',
      settings: '++id, key, syncStatus',
      purchases: 'id, supplierId, date, syncStatus',
      purchaseItems: '++id, purchaseId, productId',
    });

    this.version(8).stores({
      products: '++id, barcode, categoryId, name, syncStatus',
      categories: '++id, name, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, syncStatus, customerId',
      orderItems: '++id, orderId, productId',
      shifts: 'id, status, startTime, syncStatus',
      customers: '++id, name, phone, syncStatus',
      expenses: '++id, date, category, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      employees: '++id, name, role, status, syncStatus',
      settings: '++id, key, syncStatus',
      purchases: 'id, supplierId, date, syncStatus',
      purchaseItems: '++id, purchaseId, productId',
      attendance: '++id, employeeId, date, syncStatus',
      loyaltyTransactions: '++id, customerId, orderId, syncStatus',
    });

    this.version(11).stores({
      products: '++id, barcode, categoryId, name, branchId, syncStatus',
      categories: '++id, name, branchId, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, branchId, syncStatus, customerId',
      orderItems: '++id, orderId, productId',
      shifts: '++id, status, startTime, branchId, syncStatus',
      customers: '++id, name, phone, branchId, syncStatus',
      expenses: '++id, date, category, branchId, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      employees: '++id, name, role, status, branchId, syncStatus',
      settings: '++id, key, syncStatus',
      purchases: 'id, supplierId, date, branchId, syncStatus',
      purchaseItems: '++id, purchaseId, productId, syncStatus',
      attendance: '++id, employeeId, date, branchId, syncStatus',
      loyaltyTransactions: '++id, customerId, orderId, date, syncStatus',
      branches: '++id, name, status, syncStatus',
      payroll: '++id, employeeId, periodStart, status, syncStatus',
      offers: '++id, name, type, status, branchId, syncStatus',
    });

    this.version(13).stores({
      products: '++id, barcode, categoryId, name, branchId, syncStatus',
      categories: '++id, name, branchId, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, branchId, syncStatus, customerId',
      orderItems: '++id, orderId, productId, syncStatus',
      shifts: '++id, status, startTime, branchId, syncStatus',
      customers: '++id, name, phone, branchId, syncStatus',
      expenses: '++id, date, category, branchId, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      employees: '++id, name, role, status, branchId, syncStatus, pinCode, username',
      settings: '++id, key, syncStatus',
      purchases: 'id, supplierId, date, branchId, syncStatus',
      purchaseItems: '++id, purchaseId, productId, syncStatus',
      attendance: '++id, employeeId, date, branchId, syncStatus',
      loyaltyTransactions: '++id, customerId, orderId, date, syncStatus',
      branches: '++id, name, status, syncStatus',
      payroll: '++id, employeeId, periodStart, status, syncStatus',
      offers: '++id, name, type, status, branchId, syncStatus',
    });

    this.version(14).stores({
      products: '++id, barcode, categoryId, name, branchId, syncStatus',
      categories: '++id, name, branchId, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, branchId, syncStatus, customerId',
      orderItems: '++id, orderId, productId, syncStatus',
      shifts: '++id, status, startTime, branchId, syncStatus',
      customers: '++id, name, phone, branchId, syncStatus',
      expenses: '++id, date, category, branchId, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      employees: '++id, name, role, status, branchId, syncStatus, pinCode, username',
      settings: '++id, key, syncStatus',
      purchases: 'id, supplierId, date, branchId, syncStatus',
      purchaseItems: '++id, purchaseId, productId, syncStatus',
      attendance: '++id, employeeId, date, branchId, syncStatus',
      loyaltyTransactions: '++id, customerId, orderId, date, syncStatus',
      branches: '++id, name, status, syncStatus',
      payroll: '++id, employeeId, periodStart, status, syncStatus',
      offers: '++id, name, type, status, branchId, syncStatus',
      auditLogs: '++id, date, type, userName',
    });

    this.version(17).stores({
      products: '++id, barcode, categoryId, name, branchId, syncStatus',
      categories: '++id, name, branchId, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, branchId, syncStatus, customerId, createdBy',
      orderItems: '++id, orderId, productId, syncStatus',
      shifts: '++id, status, startTime, branchId, syncStatus',
      customers: '++id, name, phone, branchId, syncStatus',
      expenses: '++id, date, category, branchId, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      employees: '++id, name, role, status, branchId, syncStatus, pinCode, username',
      settings: '++id, key, syncStatus',
      purchases: 'id, supplierId, date, branchId, syncStatus',
      purchaseItems: '++id, purchaseId, productId, syncStatus',
      attendance: '++id, employeeId, date, branchId, syncStatus',
      loyaltyTransactions: '++id, customerId, orderId, date, syncStatus',
      branches: '++id, name, status, syncStatus',
      payroll: '++id, employeeId, periodStart, status, syncStatus',
      offers: '++id, name, type, status, branchId, syncStatus',
      auditLogs: '++id, date, type, userName',
      journalEntries: '++id, date, referenceId, referenceType',
      transactions: '++id, orderId, purchaseId, journalEntryId',
      stocktakingSessions: 'id, status, createdAt, branchId, syncStatus',
      stocktakingEntries: '++id, sessionId, productId, barcode, syncStatus',
      inventoryBatches: '++id, productId, syncStatus',
    });

    this.version(18).stores({
      products: '++id, barcode, categoryId, name, branchId, syncStatus',
      categories: '++id, name, branchId, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, branchId, syncStatus, customerId, createdBy',
      orderItems: '++id, orderId, productId, syncStatus',
      shifts: '++id, status, startTime, branchId, syncStatus',
      customers: '++id, name, phone, branchId, syncStatus',
      expenses: '++id, date, category, branchId, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      employees: '++id, name, role, status, branchId, syncStatus, pinCode, username',
      settings: '++id, key, syncStatus',
      purchases: 'id, supplierId, date, branchId, syncStatus',
      purchaseItems: '++id, purchaseId, productId, syncStatus',
      attendance: '++id, employeeId, date, branchId, syncStatus',
      loyaltyTransactions: '++id, customerId, orderId, date, syncStatus',
      branches: '++id, name, status, syncStatus',
      payroll: '++id, employeeId, periodStart, status, syncStatus',
      offers: '++id, name, type, status, branchId, syncStatus',
      auditLogs: '++id, date, type, userName, syncStatus',
      journalEntries: '++id, date, referenceId, referenceType, syncStatus',
      transactions: '++id, orderId, purchaseId, journalEntryId, syncStatus',
      stocktakingSessions: 'id, status, createdAt, branchId, syncStatus',
      stocktakingEntries: '++id, sessionId, productId, barcode, syncStatus',
      inventoryBatches: '++id, productId, syncStatus',
    });

    this.version(19).stores({
      products: '++id, barcode, categoryId, name, branchId, syncStatus',
      categories: '++id, name, branchId, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, branchId, syncStatus, customerId, createdBy',
      orderItems: '++id, orderId, productId, syncStatus',
      shifts: '++id, status, startTime, branchId, syncStatus',
      customers: '++id, name, phone, branchId, syncStatus',
      expenses: '++id, date, category, branchId, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      employees: '++id, name, role, status, branchId, syncStatus, pinCode, username',
      settings: '++id, key, syncStatus',
      purchases: 'id, supplierId, date, branchId, syncStatus',
      purchaseItems: '++id, purchaseId, productId, syncStatus',
      attendance: '++id, employeeId, date, branchId, syncStatus',
      loyaltyTransactions: '++id, customerId, orderId, date, syncStatus',
      branches: '++id, name, status, syncStatus',
      payroll: '++id, employeeId, periodStart, status, syncStatus',
      offers: '++id, name, type, status, branchId, syncStatus',
      auditLogs: '++id, date, type, userName, syncStatus',
      journalEntries: '++id, date, referenceId, referenceType, syncStatus',
      transactions: '++id, orderId, purchaseId, journalEntryId, syncStatus',
      stocktakingSessions: 'id, status, createdAt, branchId, syncStatus',
      stocktakingEntries: '++id, sessionId, productId, barcode, syncStatus',
      inventoryBatches: '++id, productId, syncStatus',
    });

    this.version(20).stores({
      products: '++id, barcode, categoryId, name, branchId, syncStatus',
      categories: '++id, name, branchId, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, branchId, syncStatus, customerId, createdBy, operationId',
      orderItems: '++id, orderId, productId, syncStatus',
      returns: 'id, returnNumber, originalOrderId, createdAt, branchId, syncStatus',
      returnItems: 'id, returnId, orderItemId, productId, syncStatus',
      accounts: 'code, type, name',
      shifts: '++id, status, startTime, branchId, syncStatus',
      customers: '++id, name, phone, branchId, syncStatus',
      expenses: '++id, date, category, branchId, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      employees: '++id, name, role, status, branchId, syncStatus, pinCode, username',
      settings: '++id, key, syncStatus',
      purchases: 'id, supplierId, date, branchId, syncStatus, operationId',
      purchaseItems: '++id, purchaseId, productId, syncStatus',
      attendance: '++id, employeeId, date, branchId, syncStatus',
      loyaltyTransactions: '++id, customerId, orderId, date, syncStatus',
      branches: '++id, name, status, syncStatus',
      payroll: '++id, employeeId, periodStart, status, syncStatus',
      offers: '++id, name, type, status, branchId, syncStatus',
      auditLogs: '++id, date, type, userName, syncStatus',
      journalEntries: '++id, date, referenceId, referenceType, status, syncStatus',
      transactions: '++id, orderId, purchaseId, returnId, journalEntryId, accountId, syncStatus',
      stocktakingSessions: 'id, status, createdAt, branchId, syncStatus',
      stocktakingEntries: '++id, sessionId, productId, barcode, syncStatus',
      inventoryBatches: '++id, productId, purchaseId, purchaseDate, syncStatus',
      syncOperations: 'id, type, status, createdAt, nextRetryAt',
      inventoryAlerts: 'id, productId, resolved, createdAt',
    });

    // Version 21: Add new operational tables without altering any existing primary keys
    this.version(21).stores({
      products: '++id, barcode, categoryId, name, branchId, syncStatus',
      categories: '++id, name, branchId, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, branchId, syncStatus, customerId, createdBy, operationId',
      orderItems: '++id, orderId, productId, syncStatus',
      returns: 'id, returnNumber, originalOrderId, createdAt, branchId, syncStatus',
      returnItems: 'id, returnId, orderItemId, productId, syncStatus',
      accounts: 'code, type, name',
      shifts: '++id, status, startTime, branchId, syncStatus',
      shiftMovements: 'id, shiftId, type, branchId, createdAt, syncStatus',
      customers: '++id, name, phone, branchId, syncStatus',
      customerPayments: 'id, customerId, orderId, shiftId, createdAt, syncStatus',
      expenses: '++id, date, category, shiftId, branchId, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      supplierPayments: 'id, supplierId, purchaseId, shiftId, createdAt, syncStatus',
      employees: '++id, name, role, status, branchId, syncStatus, pinCode, username',
      settings: '++id, key, syncStatus',
      purchases: 'id, supplierId, date, branchId, syncStatus, operationId',
      purchaseItems: '++id, purchaseId, productId, syncStatus',
      purchaseReturns: 'id, returnNumber, originalPurchaseId, supplierId, createdAt, branchId, syncStatus',
      purchaseReturnItems: 'id, purchaseReturnId, productId, syncStatus',
      attendance: '++id, employeeId, date, branchId, syncStatus',
      loyaltyTransactions: '++id, customerId, orderId, date, syncStatus',
      branches: '++id, name, status, syncStatus',
      payroll: '++id, employeeId, periodStart, status, branchId, syncStatus',
      offers: '++id, name, type, status, branchId, syncStatus',
      auditLogs: '++id, date, type, userName, syncStatus',
      journalEntries: '++id, date, referenceId, referenceType, status, syncStatus',
      transactions: '++id, orderId, purchaseId, returnId, journalEntryId, accountId, syncStatus',
      stocktakingSessions: 'id, status, createdAt, branchId, syncStatus',
      stocktakingEntries: '++id, sessionId, productId, barcode, syncStatus',
      inventoryBatches: '++id, productId, purchaseId, purchaseDate, syncStatus',
      syncOperations: 'id, type, status, createdAt, nextRetryAt',
      inventoryAlerts: 'id, productId, resolved, createdAt',
      heldOrders: 'id, createdAt, customerId',
    });

    // Version 22: Add serviceRecipes, exchangeRateHistory, fiscalPeriods without altering any existing primary keys
    this.version(22).stores({
      products: '++id, barcode, categoryId, name, branchId, itemType, syncStatus',
      categories: '++id, name, branchId, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, branchId, syncStatus, customerId, createdBy, operationId',
      orderItems: '++id, orderId, productId, syncStatus',
      returns: 'id, returnNumber, originalOrderId, createdAt, branchId, syncStatus',
      returnItems: 'id, returnId, orderItemId, productId, syncStatus',
      accounts: 'code, type, name',
      shifts: '++id, status, startTime, branchId, syncStatus',
      shiftMovements: 'id, shiftId, type, branchId, createdAt, syncStatus',
      customers: '++id, name, phone, branchId, syncStatus',
      customerPayments: 'id, customerId, orderId, shiftId, createdAt, syncStatus',
      expenses: '++id, date, category, shiftId, branchId, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      supplierPayments: 'id, supplierId, purchaseId, shiftId, createdAt, syncStatus',
      employees: '++id, name, role, status, branchId, syncStatus, pinCode, username',
      settings: '++id, key, syncStatus',
      purchases: 'id, supplierId, date, branchId, syncStatus, operationId',
      purchaseItems: '++id, purchaseId, productId, syncStatus',
      purchaseReturns: 'id, returnNumber, originalPurchaseId, supplierId, createdAt, branchId, syncStatus',
      purchaseReturnItems: 'id, purchaseReturnId, productId, syncStatus',
      attendance: '++id, employeeId, date, branchId, syncStatus',
      loyaltyTransactions: '++id, customerId, orderId, date, syncStatus',
      branches: '++id, name, status, syncStatus',
      payroll: '++id, employeeId, periodStart, status, branchId, syncStatus',
      offers: '++id, name, type, status, branchId, syncStatus',
      auditLogs: '++id, date, type, userName, syncStatus',
      journalEntries: '++id, date, referenceId, referenceType, status, syncStatus',
      transactions: '++id, orderId, purchaseId, returnId, journalEntryId, accountId, syncStatus',
      stocktakingSessions: 'id, status, createdAt, branchId, syncStatus',
      stocktakingEntries: '++id, sessionId, productId, barcode, syncStatus',
      inventoryBatches: '++id, productId, purchaseId, purchaseDate, syncStatus',
      syncOperations: 'id, type, status, createdAt, nextRetryAt',
      inventoryAlerts: 'id, productId, resolved, createdAt',
      heldOrders: 'id, createdAt, customerId',
      serviceRecipes: 'id, parentProductId, ingredientProductId, syncStatus',
      exchangeRateHistory: 'id, currency, effectiveFrom, syncStatus',
      fiscalPeriods: 'id, startDate, endDate, status, syncStatus',
    });

    this.version(23).stores({
      products: '++id, barcode, categoryId, name, branchId, itemType, syncStatus',
      categories: '++id, name, branchId, syncStatus',
      orders: 'id, receiptNumber, createdAt, status, branchId, syncStatus, customerId, createdBy, operationId',
      orderItems: '++id, orderId, productId, syncStatus',
      returns: 'id, returnNumber, originalOrderId, createdAt, branchId, syncStatus',
      returnItems: 'id, returnId, orderItemId, productId, syncStatus',
      accounts: 'code, type, name',
      shifts: '++id, status, startTime, branchId, syncStatus',
      shiftMovements: 'id, shiftId, type, branchId, createdAt, syncStatus',
      customers: '++id, name, phone, branchId, syncStatus',
      customerPayments: 'id, customerId, orderId, shiftId, createdAt, syncStatus',
      expenses: '++id, date, category, shiftId, branchId, syncStatus',
      suppliers: '++id, name, phone, syncStatus',
      supplierPayments: 'id, supplierId, purchaseId, shiftId, createdAt, syncStatus',
      employees: '++id, name, role, status, branchId, syncStatus, pinCode, username',
      settings: '++id, key, syncStatus',
      purchases: 'id, supplierId, date, branchId, syncStatus, operationId',
      purchaseItems: '++id, purchaseId, productId, syncStatus',
      purchaseReturns: 'id, returnNumber, originalPurchaseId, supplierId, createdAt, branchId, syncStatus',
      purchaseReturnItems: 'id, purchaseReturnId, productId, syncStatus',
      attendance: '++id, employeeId, date, branchId, syncStatus',
      loyaltyTransactions: '++id, customerId, orderId, date, syncStatus',
      branches: '++id, name, status, syncStatus',
      payroll: '++id, employeeId, periodStart, status, branchId, syncStatus',
      offers: '++id, name, type, status, branchId, syncStatus',
      auditLogs: '++id, date, type, userName, syncStatus',
      journalEntries: '++id, date, referenceId, referenceType, status, syncStatus',
      transactions: '++id, orderId, purchaseId, returnId, journalEntryId, accountId, syncStatus',
      stocktakingSessions: 'id, status, createdAt, branchId, syncStatus',
      stocktakingEntries: '++id, sessionId, productId, barcode, syncStatus',
      inventoryBatches: '++id, productId, purchaseId, purchaseDate, syncStatus',
      syncOperations: 'id, type, status, createdAt, nextRetryAt',
      inventoryAlerts: 'id, productId, resolved, createdAt',
      heldOrders: 'id, createdAt, customerId',
      serviceRecipes: 'id, parentProductId, ingredientProductId, syncStatus',
      exchangeRateHistory: 'id, currency, effectiveFrom, syncStatus',
      fiscalPeriods: 'id, startDate, endDate, status, syncStatus',
      unitDefinitions: 'code, dimension',
      productUnits: 'id, productId, unitCode, barcode',
      inventoryMovements: 'id, &movementKey, productId, sourceType, sourceId, branchId, createdAt, syncStatus',
    });
  }
}

export const db = new POSDatabase();

db.tables.forEach((table) => {
  if (table.schema.primKey.auto) {
    table.hook('creating', function (primKey) {
      if (typeof primKey === 'undefined') {
        const timestamp = Date.now();
        const random = Math.floor(Math.random() * 1000);
        return timestamp * 1000 + random;
      }
    });
  }
});

async function rescueLegacyIndexedDB(): Promise<Record<string, any[]>> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; refusing destructive schema recovery');
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open('RetailPOSDB');
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    request.onerror = () => fail(request.error || new Error('Could not open the legacy IndexedDB for recovery'));
    request.onblocked = () => fail(new Error('Legacy IndexedDB recovery is blocked by another open connection'));
    request.onsuccess = () => {
      const rawDb = request.result;
      const storeNames = Array.from(rawDb.objectStoreNames);
      if (storeNames.length === 0) {
        rawDb.close();
        if (!settled) {
          settled = true;
          resolve({});
        }
        return;
      }

      try {
        const transaction = rawDb.transaction(storeNames, 'readonly');
        const reads = storeNames.map((storeName) => new Promise<[string, any[]]>((readResolve, readReject) => {
          const read = transaction.objectStore(storeName).getAll();
          read.onsuccess = () => readResolve([storeName, Array.isArray(read.result) ? read.result : []]);
          read.onerror = () => readReject(read.error || new Error(`Could not rescue IndexedDB store ${storeName}`));
        }));

        Promise.all(reads).then((entries) => {
          rawDb.close();
          if (settled) return;
          settled = true;
          resolve(Object.fromEntries(entries.filter(([, rows]) => rows.length > 0)));
        }).catch((error) => {
          rawDb.close();
          fail(error);
        });

        transaction.onabort = () => {
          rawDb.close();
          fail(transaction.error || new Error('Legacy IndexedDB recovery transaction was aborted'));
        };
        transaction.onerror = () => {
          rawDb.close();
          fail(transaction.error || new Error('Legacy IndexedDB recovery transaction failed'));
        };
      } catch (error) {
        rawDb.close();
        fail(error);
      }
    };
  });
}

let dbReadyPromise: Promise<void> | null = null;

export function ensureDatabaseReady(): Promise<void> {
  if (!dbReadyPromise) {
    dbReadyPromise = (async () => {
      try {
        await db.open();
      } catch (err: any) {
        const msg = `${err?.name || ''} ${err?.message || String(err)}`;
        const isUpgradeFailure =
          err?.name === 'UpgradeError' ||
          msg.includes('UpgradeError') ||
          msg.includes('changing primary key') ||
          msg.includes('VersionError');

        if (!isUpgradeFailure) {
          throw err;
        }

        console.warn('Recovering RetailPOSDB from incompatible legacy schema:', msg);
        const rescued = await rescueLegacyIndexedDB();
        try {
          db.close();
        } catch {}
        await Dexie.delete('RetailPOSDB');
        await db.open();

        for (const [storeName, rows] of Object.entries(rescued)) {
          const table = (db as any)[storeName];
          if (!table) {
            throw new Error(`Recovered IndexedDB store ${storeName} has no destination table; refusing to continue with partial recovery`);
          }
          if (rows.length > 0) {
            try {
              await table.bulkPut(rows);
            } catch (restoreErr) {
              throw new Error(`Could not restore recovered IndexedDB store ${storeName}: ${String(restoreErr)}`);
            }
          }
        }
      }
    })();
  }
  return dbReadyPromise;
}

export async function seedDatabase() {
  // Database starts empty as requested.
}

export async function seedUsers() {
  const userCount = await db.employees.count();
  if (userCount === 0) {
    const bcrypt = await import('bcryptjs');
    const adminHashedPassword = bcrypt.default.hashSync('admin', 10);
    const adminHashedPin = bcrypt.default.hashSync('1234', 10);

    await db.employees.add({
      name: 'المدير العام',
      username: 'admin',
      password: adminHashedPassword,
      pinCode: adminHashedPin,
      mustChangePassword: true,
      role: 'admin',
      status: 'active',
      phone: '0000000000',
      salary: 0,
      salaryType: 'monthly',
      joinDate: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deviceType: 'desktop',
      syncStatus: 'pending',
      permissions: [
        'view_dashboard', 'view_pos', 'apply_discounts', 'void_items',
        'view_returns', 'process_returns', 'view_inventory', 'add_product',
        'edit_product', 'delete_product', 'manage_categories', 'view_stocktaking',
        'manage_stocktaking', 'view_purchases', 'add_purchase', 'edit_purchase',
        'delete_purchase', 'view_customers', 'add_customer', 'edit_customer',
        'delete_customer', 'view_suppliers', 'add_supplier', 'edit_supplier',
        'delete_supplier', 'view_employees', 'add_employee', 'edit_employee',
        'delete_employee', 'view_attendance', 'manage_attendance', 'view_payroll',
        'manage_payroll', 'view_offers', 'manage_offers', 'view_branches',
        'manage_branches', 'view_mobile_sales', 'view_shifts', 'manage_shifts',
        'view_expenses', 'add_expense', 'edit_expense', 'delete_expense',
        'view_reports', 'manage_settings',
      ],
    });
  }
}
