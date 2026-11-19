import { useState, useMemo, useRef } from 'react';
import { usePosFirstRecordWhereEquals } from '../hooks/usePosFirstRecordWhereEquals';
import { getFirstPosRecordWhereEquals, getPosRecord, getPosRecordsWhereEquals } from '../services/posDataAccess';
import { usePosEntityRecords } from '../hooks/usePosEntityRecords';
import type { Product, Supplier, Purchase, PurchaseItem } from '../db/db';
import {
  Plus,
  Search,
  ShoppingCart,
  Trash2,
  Save,
  Truck,
  Package,
  X,
  Receipt,
  ArrowLeft,
  RotateCcw,
  Edit2,
  Printer,
  Lock,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'react-hot-toast';
import { useReactToPrint } from 'react-to-print';
import { useSettings } from '../hooks/useSettings';
import { v4 as uuidv4 } from 'uuid';
import { useAuth } from '../context/AuthContext';
import { dispatchOperation } from '../services/operationService';
import { getProductUnits } from '../store/useCartStore';
import { useInventoryStore } from '../store/useInventoryStore';
import { formatMoney, formatNumber, formatQty, roundAmount, roundQty } from '../utils/format';
import ConfirmationModal from '../components/ConfirmationModal';
import PurchaseReceipt from '../components/PurchaseReceipt';

interface PurchaseCartRow {
  rowId: string;
  product: Product;
  quantity: number;
  unit: string;
  conversionFactor: number;
  costPrice: number;
  batchNumber?: string;
  expiryDate?: string;
}

export default function Purchases() {
  const storeSettings = useSettings();
  const decimals = storeSettings.currencyDecimals ?? 2;
  const qtyDecimals = storeSettings.quantityDecimals ?? 3;
  const { user } = useAuth();

  const hasPermission = (permission: string) => {
    return user?.role === 'admin' || user?.permissions?.includes(permission);
  };

  const [isAddingNew, setIsAddingNew] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Data State using Dexie Live Query
  const products = usePosEntityRecords<any>('products');
  const suppliers = usePosEntityRecords<any>('suppliers');
  const allPurchases = usePosEntityRecords<any>('purchases');
  const allBatches = usePosEntityRecords<any>('inventoryBatches');
  const exchangeRateHistory = usePosEntityRecords<any>('exchangeRateHistory');
  const openShift = usePosFirstRecordWhereEquals<any>('shifts', 'status', 'open');

  const purchases = useMemo(() => {
    return [...allPurchases].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [allPurchases]);

  // Map purchaseId -> whether any batch has been consumed or a return exists
  const purchaseMutationMap = useMemo(() => {
    const map = new Map<string, { locked: boolean; reason: string }>();
    for (const p of allPurchases) {
      if (!p.id) continue;
      if (Number(p.returnedAmount || 0) > 0) {
        map.set(p.id, { locked: true, reason: 'تم تسجيل مرتجع مشتريات على الفاتورة' });
        continue;
      }
      const pBatches = allBatches.filter((b) => b.purchaseId === p.id);
      const consumed = pBatches.some(
        (b) => Number(b.remainingQuantity ?? b.quantity) < Number(b.quantity)
      );
      if (consumed) {
        map.set(p.id, { locked: true, reason: 'تم بيع جزء من مخزون هذه الفاتورة' });
      } else {
        map.set(p.id, { locked: false, reason: '' });
      }
    }
    return map;
  }, [allPurchases, allBatches]);

  // New / Edit Purchase State
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [cart, setCart] = useState<PurchaseCartRow[]>([]);
  const [paidAmount, setPaidAmount] = useState<string>('0');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card'>('cash');
  const [purchaseDate, setPurchaseDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [editingPurchase, setEditingPurchase] = useState<Purchase | null>(null);

  // FX & Landed Cost State
  const [currency, setCurrency] = useState<string>(storeSettings.currency);
  const [exchangeRateInput, setExchangeRateInput] = useState<string>('1');
  const [pricesInForeignCurrency, setPricesInForeignCurrency] = useState<boolean>(false);
  const [shippingCostInput, setShippingCostInput] = useState<string>('0');
  const [customsCostInput, setCustomsCostInput] = useState<string>('0');
  const [otherCostsInput, setOtherCostsInput] = useState<string>('0');
  const [extraCostsPaymentMethod, setExtraCostsPaymentMethod] = useState<'cash' | 'card' | 'supplier'>('cash');

  // Confirm Delete Modal State
  const [purchaseToDelete, setPurchaseToDelete] = useState<Purchase | null>(null);

  // Purchase Return Modal State
  const [returnPurchaseTarget, setReturnPurchaseTarget] = useState<Purchase | null>(null);
  const [returnItemsState, setReturnItemsState] = useState<
    Array<{
      productId: number;
      productName: string;
      purchasedQty: number;
      remainingBatchQty: number;
      costPrice: number;
      returnQty: number;
      batchId?: string;
    }>
  >([]);
  const [returnRefundMethod, setReturnRefundMethod] = useState<'credit_adjustment' | 'cash' | 'card'>(
    'credit_adjustment'
  );
  const [returnReason, setReturnReason] = useState('');
  const [isSubmittingReturn, setIsSubmittingReturn] = useState(false);

  // Print Preview Modal
  const [previewPurchase, setPreviewPurchase] = useState<{
    purchase: Purchase;
    items: PurchaseItem[];
  } | null>(null);
  const printRef = useRef<HTMLDivElement>(null);
  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: 'Purchase-Invoice',
  });

  const filteredProducts = useMemo(() => {
    if (!searchQuery) return products;
    const q = searchQuery.toLowerCase();
    return products.filter(
      (p) => (p.name || '').toLowerCase().includes(q) || (p.barcode || '').includes(searchQuery)
    );
  }, [products, searchQuery]);

  const currencyOptions = useMemo(() => {
    const set = new Set<string>([storeSettings.currency, 'USD', 'EUR', 'SAR', 'AED', 'EGP']);
    for (const row of exchangeRateHistory) {
      if (row.currency) set.add(row.currency);
    }
    return Array.from(set).filter(Boolean);
  }, [storeSettings.currency, exchangeRateHistory]);

  const handleCurrencyChange = (nextCurrency: string) => {
    setCurrency(nextCurrency);
    if (nextCurrency === storeSettings.currency) {
      setExchangeRateInput('1');
      setPricesInForeignCurrency(false);
    } else {
      const latest = [...exchangeRateHistory]
        .filter((h) => h.currency === nextCurrency)
        .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime())[0];
      const suggested = latest ? Number(latest.rate || 1) : Number(storeSettings.exchangeRate || 1);
      setExchangeRateInput(String(suggested > 0 ? suggested : 1));
      setPricesInForeignCurrency(true);
    }
  };

  const handleBarcodeSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;

    const match = useInventoryStore.getState().getMatchByBarcode(q);
    if (match) {
      addToCart(match.product, match.matchedUnit?.name);
      setSearchQuery('');
      return;
    }

    const product = await getFirstPosRecordWhereEquals<any>('products', 'barcode', q);
    if (product) {
      addToCart(product);
      setSearchQuery('');
    } else {
      toast.error('المنتج غير موجود');
    }
  };

  const addToCart = (product: Product, preferredUnit?: string) => {
    const units = getProductUnits(product);
    const unitMeta = preferredUnit ? units.find((u) => u.name === preferredUnit) : units[0];
    const targetUnit = unitMeta?.name || product.unit || 'piece';
    const factor = unitMeta?.conversionFactor || 1;
    const defaultCost = unitMeta?.costPrice ?? roundAmount(product.costPrice * factor, decimals);

    const existing = cart.find((item) => item.product.id === product.id && item.unit === targetUnit);
    if (existing) {
      setCart(
        cart.map((item) =>
          item.rowId === existing.rowId ? { ...item, quantity: roundQty(item.quantity + 1) } : item
        )
      );
    } else {
      setCart([
        ...cart,
        {
          rowId: uuidv4(),
          product,
          quantity: 1,
          unit: targetUnit,
          conversionFactor: factor,
          costPrice: defaultCost,
          batchNumber: '',
          expiryDate: '',
        },
      ]);
    }
  };

  const removeFromCart = (rowId: string) => {
    setCart(cart.filter((item) => item.rowId !== rowId));
  };

  const updateCartRow = (rowId: string, patch: Partial<PurchaseCartRow>) => {
    setCart(cart.map((item) => (item.rowId === rowId ? { ...item, ...patch } : item)));
  };

  const handleRowUnitChange = (row: PurchaseCartRow, unitName: string) => {
    const units = getProductUnits(row.product);
    const meta = units.find((u) => u.name === unitName);
    const factor = meta?.conversionFactor || 1;
    const nextCost = meta?.costPrice ?? roundAmount(row.product.costPrice * factor, decimals);
    updateCartRow(row.rowId, {
      unit: unitName,
      conversionFactor: factor,
      costPrice: nextCost,
    });
  };

  const fxRate = Math.max(0.0001, parseFloat(exchangeRateInput || '1') || 1);
  const shippingCost = Math.max(0, parseFloat(shippingCostInput || '0') || 0);
  const customsCost = Math.max(0, parseFloat(customsCostInput || '0') || 0);
  const otherCosts = Math.max(0, parseFloat(otherCostsInput || '0') || 0);
  const extraLandedCost = roundAmount(shippingCost + customsCost + otherCosts, decimals);

  const totalAmount = roundAmount(
    cart.reduce((sum, item) => {
      const unitCostBase = pricesInForeignCurrency ? item.costPrice * fxRate : item.costPrice;
      return sum + item.quantity * unitCostBase;
    }, 0),
    decimals
  );

  const capitalizedTotal = roundAmount(totalAmount + extraLandedCost, decimals);
  const invoicePayable = extraCostsPaymentMethod === 'supplier' ? capitalizedTotal : totalAmount;
  const paidNum = Math.max(0, parseFloat(paidAmount || '0') || 0);
  const remainingAmount = Math.max(0, roundAmount(invoicePayable - paidNum, decimals));

  const resetForm = () => {
    setIsAddingNew(false);
    setEditingPurchase(null);
    setCart([]);
    setSelectedSupplier(null);
    setPaidAmount('0');
    setPaymentMethod('cash');
    setPurchaseDate(format(new Date(), 'yyyy-MM-dd'));
    setCurrency(storeSettings.currency);
    setExchangeRateInput('1');
    setPricesInForeignCurrency(false);
    setShippingCostInput('0');
    setCustomsCostInput('0');
    setOtherCostsInput('0');
    setExtraCostsPaymentMethod('cash');
  };

  const handleSavePurchase = async () => {
    if (!selectedSupplier) {
      toast.error('الرجاء اختيار المورد');
      return;
    }
    if (cart.length === 0) {
      toast.error('السلة فارغة');
      return;
    }
    if (cart.some((i) => i.quantity <= 0)) {
      toast.error('الكمية يجب أن تكون أكبر من صفر');
      return;
    }
    if (paidNum > invoicePayable + 0.01) {
      toast.error('المبلغ المدفوع لا يمكن أن يتجاوز إجمالي الفاتورة المستحق');
      return;
    }

    try {
      const now = new Date().toISOString();
      const purchaseId = editingPurchase ? editingPurchase.id! : uuidv4();

      const purchasePayload = {
        id: purchaseId,
        supplierId: selectedSupplier.id!,
        supplierName: selectedSupplier.name,
        totalAmount,
        paidAmount: paidNum,
        paymentMethod,
        paymentStatus: remainingAmount <= 0.01 ? 'paid' : paidNum > 0 ? 'partial' : 'unpaid',
        currency,
        exchangeRate: fxRate,
        shippingCost,
        customsCost,
        otherCosts,
        extraCostsPaymentMethod,
        date: new Date(purchaseDate).toISOString(),
        branchId: user?.branchId,
        createdAt: editingPurchase?.createdAt || now,
        updatedAt: now,
      };

      const itemsPayload = cart.map((item) => {
        const unitCostBase = pricesInForeignCurrency
          ? roundAmount(item.costPrice * fxRate, 4)
          : item.costPrice;
        const lineTotal = roundAmount(item.quantity * unitCostBase, decimals);
        const share = totalAmount > 0 ? (lineTotal / totalAmount) * extraLandedCost : 0;
        const baseQty = roundQty(item.quantity * (item.conversionFactor || 1));
        const landedCostPerBaseUnit = baseQty > 0 ? Math.round(((lineTotal + share) / baseQty) * 10000) / 10000 : unitCostBase;
        return {
          productId: item.product.id!,
          productName: item.product.name,
          quantity: roundQty(item.quantity),
          unit: item.unit || 'piece',
          conversionFactor: item.conversionFactor || 1,
          costPrice: item.costPrice,
          pricesInForeignCurrency,
          landedCostPerBaseUnit,
          total: lineTotal,
          batchNumber: item.batchNumber?.trim() || undefined,
          expiryDate: item.expiryDate || undefined,
        };
      });

      await dispatchOperation(
        editingPurchase ? 'purchase_update' : 'purchase',
        { purchase: purchasePayload, items: itemsPayload },
        user?.branchId
      );

      toast.success(
        editingPurchase ? 'تم تحديث الفاتورة والدفعات بنجاح' : 'تم تسجيل المشتريات وتحديث المخزون والتكلفة المرجحة'
      );
      resetForm();
    } catch (error: any) {
      console.error('Error saving purchase:', error);
      toast.error(error?.message || 'حدث خطأ أثناء حفظ المشتريات');
    }
  };

  const confirmDeletePurchase = async () => {
    if (!purchaseToDelete) return;
    try {
      await dispatchOperation('purchase_delete', { id: purchaseToDelete.id! }, user?.branchId);
      toast.success('تم حذف الفاتورة وعكس تأثيرها المالي والمخزني');
      setPurchaseToDelete(null);
    } catch (error: any) {
      console.error(error);
      toast.error(error?.message || 'حدث خطأ أثناء حذف الفاتورة');
      setPurchaseToDelete(null);
    }
  };

  const handleEditPurchase = async (purchase: Purchase) => {
    const lockInfo = purchase.id ? purchaseMutationMap.get(purchase.id) : undefined;
    if (lockInfo?.locked) {
      toast.error(lockInfo.reason + ' — استخدم مرتجع المشتريات بدلاً من التعديل');
      return;
    }

    const items = await getPosRecordsWhereEquals<any>('purchaseItems', 'purchaseId', purchase.id!);
    const supplier = suppliers.find((s) => s.id === purchase.supplierId);

    setEditingPurchase(purchase);
    setSelectedSupplier(supplier || null);
    setPurchaseDate(format(new Date(purchase.date), 'yyyy-MM-dd'));
    setPaidAmount(purchase.paidAmount.toString());
    setPaymentMethod(purchase.paymentMethod === 'card' ? 'card' : 'cash');
    setCurrency(purchase.currency || storeSettings.currency);
    setExchangeRateInput(String(purchase.exchangeRate || 1));
    setPricesInForeignCurrency(false);
    setShippingCostInput(String(purchase.shippingCost || 0));
    setCustomsCostInput(String(purchase.customsCost || 0));
    setOtherCostsInput(String(purchase.otherCosts || 0));
    setExtraCostsPaymentMethod((purchase.extraCostsPaymentMethod as any) || 'cash');

    const cartItems: PurchaseCartRow[] = items.map((item) => {
      const product = products.find((p) => p.id === item.productId);
      return {
        rowId: uuidv4(),
        product: product || ({ id: item.productId, name: item.productName, costPrice: item.costPrice } as any),
        quantity: item.quantity,
        unit: item.unit || 'piece',
        conversionFactor: item.conversionFactor || 1,
        costPrice: item.costPrice,
        batchNumber: item.batchNumber || '',
        expiryDate: item.expiryDate || '',
      };
    });
    setCart(cartItems);
    setIsAddingNew(true);
  };

  const openPurchaseReturnModal = async (purchase: Purchase) => {
    const items = await getPosRecordsWhereEquals<any>('purchaseItems', 'purchaseId', purchase.id!);
    const batches = await getPosRecordsWhereEquals<any>('inventoryBatches', 'purchaseId', purchase.id!);

    const mapped = items.map((item) => {
      const matchingBatch = batches.find((b) => b.productId === item.productId);
      const remainingBatchQty = matchingBatch
        ? Number(matchingBatch.remainingQuantity ?? matchingBatch.quantity)
        : item.quantity;
      return {
        productId: item.productId,
        productName: item.productName,
        purchasedQty: item.quantity,
        remainingBatchQty,
        costPrice: item.costPrice,
        returnQty: 0,
        batchId: matchingBatch?.id ? String(matchingBatch.id) : undefined,
      };
    });

    setReturnPurchaseTarget(purchase);
    setReturnItemsState(mapped);
    setReturnRefundMethod(purchase.paymentStatus === 'paid' ? 'cash' : 'credit_adjustment');
    setReturnReason('');
  };

  const returnTotal = useMemo(
    () =>
      returnItemsState.reduce((sum, item) => sum + item.returnQty * item.costPrice, 0),
    [returnItemsState]
  );

  const handleSubmitPurchaseReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnPurchaseTarget) return;

    const selected = returnItemsState.filter((i) => i.returnQty > 0);
    if (selected.length === 0) {
      toast.error('يرجى تحديد كمية واحدة على الأقل للإرجاع');
      return;
    }

    for (const item of selected) {
      if (item.returnQty > item.remainingBatchQty) {
        toast.error(
          `الكمية المتبقية المتاحة للمنتج ${item.productName} هي ${item.remainingBatchQty} فقط`
        );
        return;
      }
    }

    setIsSubmittingReturn(true);
    try {
      await dispatchOperation(
        'purchase_return',
        {
          id: uuidv4(),
          returnNumber: `PRET-${Date.now()}`,
          originalPurchaseId: returnPurchaseTarget.id!,
          refundMethod: returnRefundMethod,
          reason: returnReason.trim() || 'مرتجع مشتريات للمورد',
          shiftId: returnRefundMethod === 'cash' ? openShift?.id : undefined,
          branchId: user?.branchId ?? returnPurchaseTarget.branchId,
          createdBy: user?.name || 'System',
          items: selected.map((s) => ({
            productId: s.productId,
            productName: s.productName,
            quantity: s.returnQty,
            costPrice: s.costPrice,
            batchId: s.batchId,
          })),
        },
        user?.branchId
      );

      toast.success('تم تسجيل مرتجع المشتريات وتحديث المخزون والقيود بنجاح');
      setReturnPurchaseTarget(null);
    } catch (error: any) {
      console.error('Error creating purchase return:', error);
      toast.error(error?.message || 'حدث خطأ أثناء تسجيل مرتجع المشتريات');
    } finally {
      setIsSubmittingReturn(false);
    }
  };

  const openReceiptPreview = async (purchase: Purchase) => {
    const items = await getPosRecordsWhereEquals<any>('purchaseItems', 'purchaseId', purchase.id!);
    setPreviewPurchase({ purchase, items });
  };

  if (isAddingNew) {
    return (
      <div className="flex h-full bg-[var(--app-bg)] overflow-hidden" dir="rtl">
        {/* Left Side: Products Selection */}
        <div className="flex-1 flex flex-col p-6 overflow-hidden">
          <div className="flex items-center justify-between mb-6 gap-4">
            <div className="flex items-center gap-3">
              <button
                onClick={resetForm}
                className="p-2 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl transition-colors"
                aria-label="رجوع"
              >
                <ArrowLeft className="w-5 h-5 text-slate-600" />
              </button>
              <h2 className="text-xl font-bold text-slate-900">
                {editingPurchase ? 'تعديل فاتورة مشتريات' : 'فاتورة مشتريات جديدة'}
              </h2>
            </div>
            <form onSubmit={handleBarcodeSubmit} className="relative w-72">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
              <input
                type="text"
                placeholder="بحث بالاسم أو الباركود..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pr-9 pl-4 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </form>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar">
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3.5">
              {filteredProducts.map((product) => (
                <button
                  key={product.id}
                  onClick={() => addToCart(product)}
                  className="bg-white p-4 rounded-xl border border-slate-200 hover:border-indigo-300 transition-all text-right group"
                >
                  <div className="w-10 h-10 bg-indigo-50 rounded-lg flex items-center justify-center text-indigo-600 mb-3 group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                    <Package className="w-5 h-5" />
                  </div>
                  <h4 className="font-bold text-sm text-slate-900 mb-1 line-clamp-1">{product.name}</h4>
                  <p className="text-xs text-slate-400 font-mono mb-2">{product.barcode}</p>
                  <div className="flex justify-between items-center tabular-nums">
                    <span className="text-indigo-600 font-black text-sm">
                      {formatNumber(product.costPrice, decimals)}
                    </span>
                    <span className="text-[11px] bg-slate-100 px-2 py-0.5 rounded-md text-slate-600 border border-slate-200">
                      مخزون: {formatQty(product.stockQuantity, qtyDecimals)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right Side: Cart, Supplier, FX & Landed Costs */}
        <div className="w-[430px] bg-white border-r border-slate-200 flex flex-col">
          <div className="p-4 border-b border-slate-200 space-y-2.5">
            <h3 className="font-bold text-slate-900 flex items-center gap-2 text-sm">
              <Truck className="w-4 h-4 text-indigo-600" />
              بيانات المورد والفاتورة والعملة
            </h3>
            <select
              className="w-full p-2 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              value={selectedSupplier?.id || ''}
              onChange={(e) => {
                const s = suppliers.find((sup) => sup.id === Number(e.target.value));
                setSelectedSupplier(s || null);
              }}
            >
              <option value="">اختر المورد...</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[11px] text-slate-500 block mb-0.5">التاريخ</label>
                <input
                  type="date"
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                  className="w-full p-1.5 bg-slate-50 border border-slate-200 rounded-lg outline-none text-xs"
                />
              </div>
              <div>
                <label className="text-[11px] text-slate-500 block mb-0.5">العملة</label>
                <select
                  value={currency}
                  onChange={(e) => handleCurrencyChange(e.target.value)}
                  className="w-full p-1.5 bg-slate-50 border border-slate-200 rounded-lg outline-none text-xs"
                >
                  {currencyOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-slate-500 block mb-0.5">سعر الصرف</label>
                <input
                  type="number"
                  step="0.0001"
                  min="0.0001"
                  disabled={currency === storeSettings.currency}
                  value={exchangeRateInput}
                  onChange={(e) => setExchangeRateInput(e.target.value)}
                  className="w-full p-1.5 bg-slate-50 border border-slate-200 rounded-lg outline-none text-xs tabular-nums disabled:opacity-60"
                />
              </div>
            </div>
            {currency !== storeSettings.currency && (
              <label className="flex items-center gap-2 text-xs font-bold text-indigo-700 bg-indigo-50 px-2.5 py-1.5 rounded-lg border border-indigo-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pricesInForeignCurrency}
                  onChange={(e) => setPricesInForeignCurrency(e.target.checked)}
                />
                <span>أسعار الأصناف أدناه بعملة {currency} (تُحوَّل × {fxRate})</span>
              </label>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3.5 custom-scrollbar">
            {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-400">
                <ShoppingCart className="w-10 h-10 mb-2 opacity-30" />
                <p className="text-sm">السلة فارغة</p>
              </div>
            ) : (
              <div className="space-y-3">
                {cart.map((item) => {
                  const units = getProductUnits(item.product);
                  const unitCostBase = pricesInForeignCurrency ? item.costPrice * fxRate : item.costPrice;
                  const lineTotal = roundAmount(item.quantity * unitCostBase, decimals);
                  const share = totalAmount > 0 ? (lineTotal / totalAmount) * extraLandedCost : 0;
                  const baseQty = roundQty(item.quantity * (item.conversionFactor || 1));
                  const estLandedPerBase = baseQty > 0 ? (lineTotal + share) / baseQty : 0;

                  return (
                    <div key={item.rowId} className="bg-slate-50 p-3 rounded-xl border border-slate-200 space-y-2">
                      <div className="flex justify-between items-start gap-2">
                        <h4 className="font-bold text-xs text-slate-900 line-clamp-1">{item.product.name}</h4>
                        <button
                          onClick={() => removeFromCart(item.rowId)}
                          className="text-rose-500 hover:bg-rose-50 p-1 rounded-lg shrink-0"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="text-[11px] text-slate-500 block mb-0.5">الوحدة</label>
                          <select
                            value={item.unit}
                            onChange={(e) => handleRowUnitChange(item, e.target.value)}
                            className="w-full p-1.5 bg-white border border-slate-200 rounded-lg text-xs outline-none"
                          >
                            {units.map((u) => (
                              <option key={u.name} value={u.name}>
                                {u.name === 'piece' ? 'حبة' : u.name === 'box' ? 'صندوق' : u.name}
                                {u.conversionFactor !== 1 ? ` (×${formatQty(u.conversionFactor, qtyDecimals)})` : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-[11px] text-slate-500 block mb-0.5">الكمية</label>
                          <input
                            type="number"
                            step="any"
                            min="0.001"
                            value={item.quantity}
                            onChange={(e) =>
                              updateCartRow(item.rowId, { quantity: Math.max(0, Number(e.target.value)) })
                            }
                            className="w-full p-1.5 bg-white border border-slate-200 rounded-lg text-xs tabular-nums outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-slate-500 block mb-0.5">
                            التكلفة ({pricesInForeignCurrency ? currency : storeSettings.currency})
                          </label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={item.costPrice}
                            onChange={(e) =>
                              updateCartRow(item.rowId, { costPrice: Math.max(0, Number(e.target.value)) })
                            }
                            className="w-full p-1.5 bg-white border border-slate-200 rounded-lg text-xs tabular-nums outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="text"
                          placeholder="رقم التشغيلة (Batch)"
                          value={item.batchNumber || ''}
                          onChange={(e) => updateCartRow(item.rowId, { batchNumber: e.target.value })}
                          className="w-full p-1.5 bg-white border border-slate-200 rounded-lg text-[11px] outline-none"
                        />
                        <input
                          type="date"
                          title="تاريخ الانتهاء"
                          value={item.expiryDate || ''}
                          onChange={(e) => updateCartRow(item.rowId, { expiryDate: e.target.value })}
                          className="w-full p-1.5 bg-white border border-slate-200 rounded-lg text-[11px] outline-none"
                        />
                      </div>

                      <div className="flex justify-between items-center text-[11px] tabular-nums pt-1 border-t border-slate-200/70">
                        <span className="text-slate-500">
                          الواصل/أساس: <strong className="text-indigo-700">{formatNumber(estLandedPerBase, decimals)}</strong>
                        </span>
                        <span className="font-bold text-slate-700">
                          المجموع: {formatMoney(lineTotal, storeSettings.currency, decimals)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="p-4 bg-slate-50 border-t border-slate-200 space-y-2.5">
            {/* Extra Landed Costs */}
            <div className="grid grid-cols-3 gap-1.5 text-[11px]">
              <div>
                <label className="text-slate-500 block mb-0.5">شحن</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={shippingCostInput}
                  onChange={(e) => setShippingCostInput(e.target.value)}
                  className="w-full p-1.5 bg-white border border-slate-200 rounded-lg tabular-nums outline-none"
                />
              </div>
              <div>
                <label className="text-slate-500 block mb-0.5">جمارك</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={customsCostInput}
                  onChange={(e) => setCustomsCostInput(e.target.value)}
                  className="w-full p-1.5 bg-white border border-slate-200 rounded-lg tabular-nums outline-none"
                />
              </div>
              <div>
                <label className="text-slate-500 block mb-0.5">أخرى</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={otherCostsInput}
                  onChange={(e) => setOtherCostsInput(e.target.value)}
                  className="w-full p-1.5 bg-white border border-slate-200 rounded-lg tabular-nums outline-none"
                />
              </div>
            </div>

            {extraLandedCost > 0 && (
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-600">سداد المصاريف الإضافية</span>
                <select
                  value={extraCostsPaymentMethod}
                  onChange={(e) => setExtraCostsPaymentMethod(e.target.value as any)}
                  className="p-1 bg-white border border-slate-200 rounded-lg text-xs outline-none"
                >
                  <option value="cash">نقدي من الصندوق</option>
                  <option value="card">تحويل / بنك</option>
                  <option value="supplier">مضافة لذمة المورد</option>
                </select>
              </div>
            )}

            <div className="space-y-1.5 text-xs tabular-nums pt-1 border-t border-slate-200">
              <div className="flex justify-between text-slate-600">
                <span>قيمة البضاعة</span>
                <span className="font-bold text-slate-900">
                  {formatMoney(totalAmount, storeSettings.currency, decimals)}
                </span>
              </div>
              {extraLandedCost > 0 && (
                <div className="flex justify-between text-indigo-700 font-bold">
                  <span>التكلفة المرسملة بالمخزون (+مصاريف)</span>
                  <span>{formatMoney(capitalizedTotal, storeSettings.currency, decimals)}</span>
                </div>
              )}
              <div className="flex justify-between items-center gap-2">
                <span className="text-slate-600">المبلغ المدفوع للمورد</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={paidAmount}
                  onChange={(e) => setPaidAmount(e.target.value)}
                  className="w-28 p-1.5 bg-white border border-slate-200 rounded-lg text-left font-bold outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              {paidNum > 0 && (
                <div className="flex justify-between items-center gap-2">
                  <span className="text-slate-600">طريقة السداد</span>
                  <div className="flex rounded-lg border border-slate-200 overflow-hidden bg-white">
                    <button
                      type="button"
                      onClick={() => setPaymentMethod('cash')}
                      className={`px-3 py-1 text-xs font-bold ${
                        paymentMethod === 'cash'
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      نقدي
                    </button>
                    <button
                      type="button"
                      onClick={() => setPaymentMethod('card')}
                      className={`px-3 py-1 text-xs font-bold ${
                        paymentMethod === 'card'
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      شبكة
                    </button>
                  </div>
                </div>
              )}
              <div className="flex justify-between text-rose-600 font-bold pt-1.5 border-t border-slate-200">
                <span>المتبقي (ذمة للمورد)</span>
                <span>
                  {formatMoney(remainingAmount, storeSettings.currency, decimals)}
                </span>
              </div>
            </div>
            <button
              onClick={handleSavePurchase}
              className="w-full py-2.5 bg-indigo-600 text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-indigo-700 transition-colors"
            >
              <Save className="w-4 h-4" />
              {editingPurchase ? 'تحديث الفاتورة' : 'حفظ الفاتورة'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 h-full flex flex-col bg-[var(--app-bg)] overflow-y-auto custom-scrollbar" dir="rtl">
      <div className="flex justify-between items-center mb-6 shrink-0 gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <ShoppingCart className="w-6 h-6 text-indigo-600" />
            المشتريات وتوريد المخزون
          </h2>
          <p className="text-slate-500 text-sm mt-1">
            إدارة فواتير الشراء ودفعات المخزون ومرتجعات الموردين
          </p>
        </div>
        {hasPermission('add_purchase') && (
          <button
            onClick={() => {
              resetForm();
              setIsAddingNew(true);
            }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-xl font-bold flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-5 h-5" />
            فاتورة مشتريات جديدة
          </button>
        )}
      </div>

      {/* Purchases List */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden flex-1 flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/70">
          <h3 className="font-bold text-slate-900">سجل المشتريات</h3>
          <div className="flex items-center gap-2 text-xs text-slate-500 tabular-nums">
            <Receipt className="w-4 h-4" />
            <span>إجمالي الفواتير: {purchases.length}</span>
          </div>
        </div>

        <div className="overflow-x-auto flex-1">
          <table className="w-full text-right">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs font-bold border-b border-slate-200">
                <th className="px-5 py-3.5">التاريخ</th>
                <th className="px-5 py-3.5">المورد</th>
                <th className="px-5 py-3.5">الإجمالي</th>
                <th className="px-5 py-3.5">المرتجع</th>
                <th className="px-5 py-3.5">المدفوع</th>
                <th className="px-5 py-3.5">المتبقي</th>
                <th className="px-5 py-3.5">الحالة</th>
                <th className="px-5 py-3.5 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {purchases.map((purchase) => {
                const returned = Number(purchase.returnedAmount || 0);
                const netRemaining = Math.max(0, purchase.totalAmount - returned - purchase.paidAmount);
                const lockInfo = purchase.id ? purchaseMutationMap.get(purchase.id) : undefined;
                const isLocked = Boolean(lockInfo?.locked);

                return (
                  <tr key={purchase.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-5 py-3.5 text-slate-600 tabular-nums whitespace-nowrap">
                      {format(new Date(purchase.date), 'yyyy/MM/dd')}
                    </td>
                    <td className="px-5 py-3.5 font-bold text-slate-900">{purchase.supplierName}</td>
                    <td className="px-5 py-3.5 font-bold text-slate-900 tabular-nums">
                      {formatNumber(purchase.totalAmount, decimals)}
                    </td>
                    <td className="px-5 py-3.5 text-amber-700 font-medium tabular-nums">
                      {returned > 0 ? formatNumber(returned, decimals) : '-'}
                    </td>
                    <td className="px-5 py-3.5 text-emerald-700 font-bold tabular-nums">
                      {formatNumber(purchase.paidAmount, decimals)}
                    </td>
                    <td className="px-5 py-3.5 text-rose-600 font-bold tabular-nums">
                      {formatNumber(netRemaining, decimals)}
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`px-2.5 py-1 rounded-lg border text-xs font-bold whitespace-nowrap ${
                          purchase.paymentStatus === 'paid'
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : purchase.paymentStatus === 'partial'
                            ? 'bg-amber-50 text-amber-700 border-amber-200'
                            : 'bg-rose-50 text-rose-700 border-rose-200'
                        }`}
                      >
                        {purchase.paymentStatus === 'paid'
                          ? 'مدفوع'
                          : purchase.paymentStatus === 'partial'
                          ? 'مدفوع جزئياً'
                          : 'آجل'}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => openReceiptPreview(purchase)}
                          className="p-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                          title="عرض وطباعة الفاتورة"
                        >
                          <Receipt className="w-4 h-4" />
                        </button>
                        {hasPermission('edit_purchase') && (
                          <button
                            onClick={() => openPurchaseReturnModal(purchase)}
                            className="p-2 text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                            title="مرتجع مشتريات للمورد"
                          >
                            <RotateCcw className="w-4 h-4" />
                          </button>
                        )}
                        {hasPermission('edit_purchase') && (
                          <button
                            onClick={() => handleEditPurchase(purchase)}
                            disabled={isLocked}
                            className={`p-2 rounded-lg transition-colors ${
                              isLocked
                                ? 'text-slate-300 cursor-not-allowed'
                                : 'text-indigo-600 hover:bg-indigo-50'
                            }`}
                            title={isLocked ? lockInfo?.reason : 'تعديل الفاتورة'}
                          >
                            {isLocked ? <Lock className="w-4 h-4" /> : <Edit2 className="w-4 h-4" />}
                          </button>
                        )}
                        {hasPermission('delete_purchase') && (
                          <button
                            onClick={() =>
                              isLocked
                                ? toast.error(lockInfo?.reason || 'لا يمكن حذف فاتورة مرتبطة بمبيعات أو مرتجعات')
                                : setPurchaseToDelete(purchase)
                            }
                            className={`p-2 rounded-lg transition-colors ${
                              isLocked
                                ? 'text-slate-300 cursor-not-allowed'
                                : 'text-rose-600 hover:bg-rose-50'
                            }`}
                            title={isLocked ? lockInfo?.reason : 'حذف الفاتورة'}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {purchases.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-slate-400">
                    لا توجد فواتير مشتريات مسجلة بعد
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Purchase Return Modal */}
      {returnPurchaseTarget && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  مرتجع مشتريات للمورد: {returnPurchaseTarget.supplierName}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                  تاريخ الفاتورة: {format(new Date(returnPurchaseTarget.date), 'yyyy/MM/dd')}
                </p>
              </div>
              <button
                onClick={() => setReturnPurchaseTarget(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitPurchaseReturn} className="p-5 space-y-4 overflow-y-auto custom-scrollbar">
              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="w-full text-right text-sm">
                  <thead className="bg-slate-50 text-slate-500 text-xs">
                    <tr>
                      <th className="px-3 py-2.5">المنتج</th>
                      <th className="px-3 py-2.5 text-center">المشترى</th>
                      <th className="px-3 py-2.5 text-center">المتاح بالدفعة</th>
                      <th className="px-3 py-2.5 text-center">التكلفة</th>
                      <th className="px-3 py-2.5 text-center">كمية الإرجاع</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 tabular-nums">
                    {returnItemsState.map((item, idx) => (
                      <tr key={item.productId}>
                        <td className="px-3 py-2.5 font-medium text-slate-900">{item.productName}</td>
                        <td className="px-3 py-2.5 text-center text-slate-600">{formatQty(item.purchasedQty, qtyDecimals)}</td>
                        <td className="px-3 py-2.5 text-center font-bold text-indigo-600">
                          {formatQty(item.remainingBatchQty, qtyDecimals)}
                        </td>
                        <td className="px-3 py-2.5 text-center">{formatNumber(item.costPrice, decimals)}</td>
                        <td className="px-3 py-2.5 text-center">
                          <input
                            type="number"
                            step="any"
                            min={0}
                            max={item.remainingBatchQty}
                            value={item.returnQty}
                            onChange={(e) => {
                              const parsed = parseFloat(e.target.value);
                              const val = isNaN(parsed)
                                ? 0
                                : Math.min(item.remainingBatchQty, Math.max(0, roundQty(parsed)));
                              setReturnItemsState((prev) =>
                                prev.map((row, i) => (i === idx ? { ...row, returnQty: val } : row))
                              );
                            }}
                            className="w-20 px-2 py-1 text-center border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    طريقة تسوية المرتجع
                  </label>
                  <select
                    value={returnRefundMethod}
                    onChange={(e) =>
                      setReturnRefundMethod(e.target.value as 'credit_adjustment' | 'cash' | 'card')
                    }
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm bg-slate-50 outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="credit_adjustment">خصم من رصيد المورد المستحق</option>
                    <option value="cash">استرداد نقدي إلى الصندوق</option>
                    <option value="card">استرداد تحويلاً / شبكة إلى البنك</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">سبب الإرجاع</label>
                  <input
                    type="text"
                    value={returnReason}
                    onChange={(e) => setReturnReason(e.target.value)}
                    placeholder="مثال: بضاعة تالفة أو منتهية الصلاحية"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div className="flex justify-between items-center p-3.5 bg-amber-50 border border-amber-200 rounded-xl">
                <span className="text-sm font-bold text-amber-900">إجمالي قيمة المرتجع:</span>
                <span className="text-lg font-black text-amber-800 tabular-nums">
                  {formatMoney(returnTotal, storeSettings.currency, decimals)}
                </span>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setReturnPurchaseTarget(null)}
                  className="px-4 py-2 border border-slate-200 rounded-xl text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingReturn || returnTotal <= 0}
                  className="px-5 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-sm font-bold disabled:opacity-50"
                >
                  {isSubmittingReturn ? 'جاري التسجيل...' : 'اعتماد مرتجع المشتريات'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Invoice Print Preview Modal */}
      {previewPurchase && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-base font-bold text-slate-900">معاينة فاتورة الشراء</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handlePrint()}
                  className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 hover:bg-indigo-700"
                >
                  <Printer className="w-3.5 h-3.5" />
                  طباعة
                </button>
                <button
                  onClick={() => setPreviewPurchase(null)}
                  className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-4 overflow-y-auto custom-scrollbar">
              <PurchaseReceipt
                ref={printRef}
                purchase={previewPurchase.purchase}
                items={previewPurchase.items}
                settings={{
                  businessName: storeSettings.businessName,
                  currency: storeSettings.currency,
                }}
              />
            </div>
          </div>
        </div>
      )}

      <ConfirmationModal
        isOpen={Boolean(purchaseToDelete)}
        variant="danger"
        title="حذف فاتورة المشتريات"
        message={
          purchaseToDelete
            ? `هل أنت متأكد من حذف فاتورة المشتريات من "${purchaseToDelete.supplierName}" بقيمة ${formatMoney(purchaseToDelete.totalAmount, storeSettings.currency, decimals)}؟ سيتم خصم الدفعات والمخزون وعكس القيود المحاسبية.`
            : ''
        }
        confirmLabel="حذف الفاتورة"
        onConfirm={confirmDeletePurchase}
        onCancel={() => setPurchaseToDelete(null)}
      />
    </div>
  );
}
