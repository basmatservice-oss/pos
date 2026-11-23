import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const products = sqliteTable('Product', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  barcode: text('barcode').unique(),
  name: text('name').notNull(),
  categoryId: integer('categoryId'),
  costPrice: real('costPrice').default(0),
  sellingPrice: real('sellingPrice').default(0),
  costInUSD: real('costInUSD'), // Foreign-currency anchor; costPrice remains SDG.
  priceInUSD: real('priceInUSD'), // Foreign-currency anchor; sellingPrice remains SDG.
  stockQuantity: real('stockQuantity').default(0),
  minStockLevel: real('minStockLevel').default(5),
  unit: text('unit').default('piece'),
  conversionFactor: real('conversionFactor').default(1),
  itemType: text('itemType').default('stock'), // 'stock' | 'service' | 'service_with_materials' | 'bundle'
  allowFractions: integer('allowFractions').default(0),
  unitsJson: text('unitsJson'), // JSON array of extra units { name, barcode, conversionFactor, sellingPrice, costPrice, allowFractions }
  baseUnitCode: text('baseUnitCode'),
  quantityPrecision: integer('quantityPrecision').default(0),
  isActive: integer('isActive').default(1),
  vatRate: real('vatRate').default(0),
  imageUrl: text('imageUrl'),
  branchId: integer('branchId'),
  expiryDate: text('expiryDate'),
  batchNumber: text('batchNumber'),
  isSynced: integer('isSynced').default(0),
  updatedAt: text('updatedAt').notNull(),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const serviceRecipes = sqliteTable('ServiceRecipe', {
  id: text('id').primaryKey(),
  parentProductId: integer('parentProductId').notNull(),
  ingredientProductId: integer('ingredientProductId').notNull(),
  ingredientName: text('ingredientName'),
  quantity: real('quantity').notNull(), // consumed per 1 base unit of parent item
  unit: text('unit').default('piece'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const inventoryBatches = sqliteTable('InventoryBatch', {
  id: text('id').primaryKey(),
  productId: integer('productId').notNull(),
  purchaseId: text('purchaseId'),
  quantity: real('quantity').notNull(),
  remainingQuantity: real('remainingQuantity').notNull(),
  costPrice: real('costPrice').notNull(),
  currency: text('currency'),
  exchangeRate: real('exchangeRate').default(1),
  purchaseDate: text('purchaseDate').notNull(),
  expiryDate: text('expiryDate'),
  batchNumber: text('batchNumber'),
  branchId: integer('branchId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const categories = sqliteTable('Category', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  color: text('color'),
  icon: text('icon'),
  branchId: integer('branchId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const customers = sqliteTable('Customer', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  balance: real('balance').default(0),
  points: integer('points').default(0),
  branchId: integer('branchId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const suppliers = sqliteTable('Supplier', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  balance: real('balance').default(0),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const orders = sqliteTable('Order', {
  id: text('id').primaryKey(),
  receiptNumber: text('receiptNumber'),
  totalAmount: real('totalAmount').notNull(),
  discountAmount: real('discountAmount').default(0),
  taxAmount: real('taxAmount').default(0),
  netAmount: real('netAmount').notNull(),
  paidAmount: real('paidAmount').default(0),
  cashAmount: real('cashAmount').default(0),
  cardAmount: real('cardAmount').default(0),
  returnedAmount: real('returnedAmount').default(0),
  paymentMethod: text('paymentMethod').notNull(),
  currency: text('currency'),
  exchangeRate: real('exchangeRate').default(1),
  customerId: integer('customerId'),
  customerName: text('customerName'),
  branchId: integer('branchId'),
  shiftId: text('shiftId'),
  tableNumber: text('tableNumber'),
  orderType: text('orderType'),
  status: text('status').notNull(),
  createdBy: text('createdBy'),
  deviceId: text('deviceId'),
  operationId: text('operationId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const orderItems = sqliteTable('OrderItem', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orderId: text('orderId').notNull(),
  productId: integer('productId').notNull(),
  productName: text('productName').notNull(),
  quantity: real('quantity').notNull(),
  returnedQuantity: real('returnedQuantity').default(0),
  unit: text('unit').default('piece'),
  conversionFactor: real('conversionFactor').default(1),
  itemType: text('itemType').default('stock'),
  unitPrice: real('unitPrice').notNull(),
  costPriceAtTimeOfSale: real('costPriceAtTimeOfSale').default(0),
  discountAmount: real('discountAmount').default(0),
  subTotal: real('subTotal').notNull(),
  taxAmount: real('taxAmount').notNull(),
  total: real('total').notNull(),
  batchAllocations: text('batchAllocations'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const returns = sqliteTable('Return', {
  id: text('id').primaryKey(),
  returnNumber: text('returnNumber').notNull(),
  originalOrderId: text('originalOrderId').notNull(),
  originalReceiptNumber: text('originalReceiptNumber'),
  customerId: integer('customerId'),
  customerName: text('customerName'),
  branchId: integer('branchId'),
  shiftId: text('shiftId'),
  refundMethod: text('refundMethod').notNull(), // 'cash' | 'card' | 'credit_adjustment'
  currency: text('currency'),
  exchangeRate: real('exchangeRate').default(1),
  subTotal: real('subTotal').default(0),
  discountAmount: real('discountAmount').default(0),
  taxAmount: real('taxAmount').default(0),
  totalRefund: real('totalRefund').notNull(),
  totalCostReversed: real('totalCostReversed').default(0),
  reason: text('reason'),
  createdBy: text('createdBy'),
  deviceId: text('deviceId'),
  operationId: text('operationId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const returnItems = sqliteTable('ReturnItem', {
  id: text('id').primaryKey(),
  returnId: text('returnId').notNull(),
  orderItemId: integer('orderItemId'),
  productId: integer('productId').notNull(),
  productName: text('productName').notNull(),
  quantity: real('quantity').notNull(),
  condition: text('condition').default('resalable'), // 'resalable' | 'damaged'
  unitPrice: real('unitPrice').notNull(),
  costPrice: real('costPrice').default(0),
  taxAmount: real('taxAmount').default(0),
  total: real('total').notNull(),
  batchAllocations: text('batchAllocations'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const shifts = sqliteTable('Shift', {
  id: text('id').primaryKey(),
  startTime: text('startTime').notNull(),
  endTime: text('endTime'),
  openingCash: real('openingCash').default(0),
  expectedCash: real('expectedCash').default(0),
  actualCash: real('actualCash'),
  branchId: integer('branchId'),
  status: text('status').default('open'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const shiftMovements = sqliteTable('ShiftMovement', {
  id: text('id').primaryKey(),
  shiftId: text('shiftId').notNull(),
  type: text('type').notNull(), // 'deposit' | 'withdrawal'
  amount: real('amount').notNull(),
  reason: text('reason'),
  createdBy: text('createdBy'),
  branchId: integer('branchId'),
  operationId: text('operationId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const expenses = sqliteTable('Expense', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  description: text('description').notNull(),
  amount: real('amount').notNull(),
  category: text('category').notNull(),
  paymentMethod: text('paymentMethod').default('cash'),
  shiftId: text('shiftId'),
  date: text('date').notNull(),
  branchId: integer('branchId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const employees = sqliteTable('Employee', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  username: text('username').unique().notNull(),
  password: text('password').notNull(),
  role: text('role').notNull(),
  phone: text('phone'),
  salary: real('salary').default(0),
  salaryType: text('salaryType').default('monthly'), // 'monthly' | 'hourly'
  branchId: integer('branchId'),
  pinCode: text('pinCode'),
  mustChangePassword: integer('mustChangePassword').default(0),
  deviceType: text('deviceType').default('desktop'),
  joinDate: text('joinDate'),
  status: text('status').default('active'),
  permissions: text('permissions'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const settings = sqliteTable('Setting', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').unique().notNull(),
  value: text('value').notNull(),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const attendance = sqliteTable('Attendance', {
  id: text('id').primaryKey(),
  employeeId: integer('employeeId').notNull(),
  employeeName: text('employeeName').notNull(),
  date: text('date').notNull(),
  checkIn: text('checkIn').notNull(),
  checkOut: text('checkOut'),
  totalHours: real('totalHours'),
  branchId: integer('branchId'),
  status: text('status').default('present'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const loyaltyTransactions = sqliteTable('LoyaltyTransaction', {
  id: text('id').primaryKey(),
  customerId: integer('customerId').notNull(),
  orderId: text('orderId'),
  points: integer('points').notNull(),
  type: text('type').notNull(),
  date: text('date').notNull(),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const branches = sqliteTable('Branch', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  address: text('address'),
  phone: text('phone'),
  email: text('email'),
  isActive: integer('isActive').default(1),
  status: text('status').default('active'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const payrolls = sqliteTable('Payroll', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  employeeId: integer('employeeId').notNull(),
  employeeName: text('employeeName').notNull(),
  periodStart: text('periodStart').notNull(),
  periodEnd: text('periodEnd').notNull(),
  salaryType: text('salaryType').default('monthly'),
  totalHours: real('totalHours').default(0),
  hourlyRate: real('hourlyRate').default(0),
  basicSalary: real('basicSalary').default(0),
  bonuses: real('bonuses').default(0),
  deductions: real('deductions').default(0),
  netSalary: real('netSalary').default(0),
  paymentMethod: text('paymentMethod').default('cash'),
  branchId: integer('branchId'),
  paymentDate: text('paymentDate'),
  status: text('status').default('pending'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const offers = sqliteTable('Offer', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  value: real('value').default(0),
  isActive: integer('isActive').default(1),
  applicableProducts: text('applicableProducts'),
  minPurchaseAmount: real('minPurchaseAmount').default(0),
  buyProductId: integer('buyProductId'),
  buyQuantity: integer('buyQuantity'),
  getProductId: integer('getProductId'),
  getQuantity: integer('getQuantity'),
  discountPercentage: real('discountPercentage'),
  discountAmount: real('discountAmount'),
  startDate: text('startDate'),
  endDate: text('endDate'),
  status: text('status').default('active'),
  branchId: integer('branchId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const purchases = sqliteTable('Purchase', {
  id: text('id').primaryKey(),
  supplierId: integer('supplierId'),
  supplierName: text('supplierName'),
  totalAmount: real('totalAmount').notNull(),
  paymentStatus: text('paymentStatus').default('unpaid'),
  paymentMethod: text('paymentMethod').default('cash'),
  paidAmount: real('paidAmount').default(0),
  returnedAmount: real('returnedAmount').default(0),
  currency: text('currency'),
  exchangeRate: real('exchangeRate').default(1),
  shippingCost: real('shippingCost').default(0),
  customsCost: real('customsCost').default(0),
  otherCosts: real('otherCosts').default(0),
  extraCostsPaymentMethod: text('extraCostsPaymentMethod').default('cash'),
  date: text('date').notNull(),
  branchId: integer('branchId'),
  deviceId: text('deviceId'),
  operationId: text('operationId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const purchaseItems = sqliteTable('PurchaseItem', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  purchaseId: text('purchaseId').notNull(),
  productId: integer('productId').notNull(),
  productName: text('productName').notNull(),
  quantity: real('quantity').notNull(),
  unit: text('unit').default('piece'),
  conversionFactor: real('conversionFactor').default(1),
  costPrice: real('costPrice').notNull(),
  landedCostPerBaseUnit: real('landedCostPerBaseUnit'),
  total: real('total').notNull(),
  expiryDate: text('expiryDate'),
  batchNumber: text('batchNumber'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const purchaseReturns = sqliteTable('PurchaseReturn', {
  id: text('id').primaryKey(),
  returnNumber: text('returnNumber').notNull(),
  originalPurchaseId: text('originalPurchaseId').notNull(),
  supplierId: integer('supplierId'),
  supplierName: text('supplierName'),
  branchId: integer('branchId'),
  shiftId: text('shiftId'),
  refundMethod: text('refundMethod').notNull(), // 'cash' | 'card' | 'credit_adjustment'
  currency: text('currency'),
  exchangeRate: real('exchangeRate').default(1),
  totalReturn: real('totalReturn').notNull(),
  reason: text('reason'),
  createdBy: text('createdBy'),
  deviceId: text('deviceId'),
  operationId: text('operationId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const purchaseReturnItems = sqliteTable('PurchaseReturnItem', {
  id: text('id').primaryKey(),
  purchaseReturnId: text('purchaseReturnId').notNull(),
  productId: integer('productId').notNull(),
  productName: text('productName').notNull(),
  quantity: real('quantity').notNull(),
  costPrice: real('costPrice').notNull(),
  total: real('total').notNull(),
  batchId: text('batchId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const customerPayments = sqliteTable('CustomerPayment', {
  id: text('id').primaryKey(),
  customerId: integer('customerId').notNull(),
  customerName: text('customerName'),
  orderId: text('orderId'),
  amount: real('amount').notNull(),
  paymentMethod: text('paymentMethod').notNull(),
  notes: text('notes'),
  shiftId: text('shiftId'),
  branchId: integer('branchId'),
  createdBy: text('createdBy'),
  operationId: text('operationId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const supplierPayments = sqliteTable('SupplierPayment', {
  id: text('id').primaryKey(),
  supplierId: integer('supplierId').notNull(),
  supplierName: text('supplierName'),
  purchaseId: text('purchaseId'),
  amount: real('amount').notNull(),
  paymentMethod: text('paymentMethod').notNull(),
  notes: text('notes'),
  shiftId: text('shiftId'),
  branchId: integer('branchId'),
  createdBy: text('createdBy'),
  operationId: text('operationId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const auditLogs = sqliteTable('AuditLog', {
  id: text('id').primaryKey(),
  date: text('date').default(new Date().toISOString()),
  type: text('type').notNull(),
  userName: text('userName').notNull(),
  action: text('action').notNull(),
  operationName: text('operationName'),
  productName: text('productName'),
  details: text('details'),
  quantity: real('quantity').default(0),
  value: real('value').default(0),
  branchId: integer('branchId'),
  previousValue: text('previousValue'),
  newValue: text('newValue'),
  entityId: text('entityId'),
  entityName: text('entityName'),
});

export const accounts = sqliteTable('Account', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  parentCode: text('parentCode'),
  balance: real('balance').default(0),
  isSystem: integer('isSystem').default(1),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const journalEntries = sqliteTable('JournalEntry', {
  id: text('id').primaryKey(),
  entryNumber: text('entryNumber'),
  date: text('date').default(new Date().toISOString()),
  referenceId: text('referenceId'),
  referenceType: text('referenceType'),
  description: text('description').notNull(),
  totalDebit: real('totalDebit').default(0),
  totalCredit: real('totalCredit').default(0),
  status: text('status').default('posted'),
  reversedEntryId: text('reversedEntryId'),
  createdBy: text('createdBy'),
  branchId: integer('branchId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const transactions = sqliteTable('Transaction', {
  id: text('id').primaryKey(),
  journalEntryId: text('journalEntryId').notNull(),
  accountId: text('accountId').notNull(),
  accountName: text('accountName').notNull(),
  type: text('type').notNull(), // 'debit' | 'credit'
  amount: real('amount').notNull(),
  debit: real('debit').default(0),
  credit: real('credit').default(0),
  description: text('description'),
  orderId: text('orderId'),
  purchaseId: text('purchaseId'),
  returnId: text('returnId'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const stocktakingSessions = sqliteTable('StocktakingSession', {
  id: text('id').primaryKey(),
  status: text('status').default('open'),
  createdAt: text('createdAt').default(new Date().toISOString()),
  createdBy: text('createdBy'),
  branchId: integer('branchId'),
  isSynced: integer('isSynced').default(0),
});

export const stocktakingEntries = sqliteTable('StocktakingEntry', {
  id: text('id').primaryKey(),
  sessionId: text('sessionId').notNull(),
  productId: integer('productId').notNull(),
  productName: text('productName').notNull(),
  barcode: text('barcode'),
  systemQuantity: real('systemQuantity').notNull(),
  actualQuantity: real('actualQuantity').notNull(),
  scannedBy: text('scannedBy'),
  scannedAt: text('scannedAt').default(new Date().toISOString()),
  isSynced: integer('isSynced').default(0),
});

export const syncQueue = sqliteTable('SyncQueue', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  action: text('action').notNull(),
  data: text('data').notNull(),
  status: text('status').default('pending'),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const processedOperations = sqliteTable('ProcessedOperation', {
  operationId: text('operationId').primaryKey(),
  deviceId: text('deviceId'),
  operationType: text('operationType').notNull(),
  status: text('status').default('completed'),
  resultJson: text('resultJson'),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const inventoryAlerts = sqliteTable('InventoryAlert', {
  id: text('id').primaryKey(),
  productId: integer('productId').notNull(),
  productName: text('productName').notNull(),
  previousQty: real('previousQty').notNull(),
  changeQty: real('changeQty').notNull(),
  resultingQty: real('resultingQty').notNull(),
  operationId: text('operationId'),
  deviceId: text('deviceId'),
  reason: text('reason').notNull(),
  resolved: integer('resolved').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const exchangeRateHistory = sqliteTable('ExchangeRateHistory', {
  id: text('id').primaryKey(),
  currency: text('currency').notNull(),
  rate: real('rate').notNull(),
  source: text('source').default('manual'),
  effectiveFrom: text('effectiveFrom').notNull(),
  notes: text('notes'),
  createdBy: text('createdBy'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
});

export const fiscalPeriods = sqliteTable('FiscalPeriod', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  startDate: text('startDate').notNull(),
  endDate: text('endDate').notNull(),
  status: text('status').default('open'), // 'open' | 'closed'
  closedAt: text('closedAt'),
  closedBy: text('closedBy'),
  notes: text('notes'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const unitDefinitions = sqliteTable('UnitDefinition', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  symbol: text('symbol'),
  dimension: text('dimension').notNull(),
  decimalPlaces: integer('decimalPlaces').default(0),
  isFractional: integer('isFractional').default(0),
  isSystem: integer('isSystem').default(0),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const productUnits = sqliteTable('ProductUnit', {
  id: text('id').primaryKey(),
  productId: integer('productId').notNull(),
  unitCode: text('unitCode').notNull(),
  conversionToBase: real('conversionToBase').notNull(),
  isBaseUnit: integer('isBaseUnit').default(0),
  sellingPrice: real('sellingPrice'),
  costPrice: real('costPrice'),
  priceInUSD: real('priceInUSD').default(0),
  allowFractions: integer('allowFractions').default(0),
  barcode: text('barcode'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
  updatedAt: text('updatedAt').notNull(),
});

export const inventoryMovements = sqliteTable('InventoryMovement', {
  id: text('id').primaryKey(),
  movementKey: text('movementKey').unique().notNull(),
  productId: integer('productId').notNull(),
  movementType: text('movementType').notNull(),
  sourceType: text('sourceType').notNull(),
  sourceId: text('sourceId').notNull(),
  quantityDeltaBase: real('quantityDeltaBase').notNull(),
  baseUnitCode: text('baseUnitCode'),
  unitCost: real('unitCost').default(0),
  totalCost: real('totalCost').default(0),
  branchId: integer('branchId'),
  operationId: text('operationId'),
  reason: text('reason'),
  createdBy: text('createdBy'),
  isSynced: integer('isSynced').default(0),
  createdAt: text('createdAt').default(new Date().toISOString()),
});
