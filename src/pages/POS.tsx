import { useState, useRef, useEffect, useMemo } from 'react';
import { generateUUID } from '../utils/uuid';
import {
  Search,
  ScanLine,
  Trash2,
  Plus,
  Minus,
  CreditCard,
  Banknote,
  Receipt,
  Package,
  Printer,
  X,
  Users,
  UserCheck,
  Camera,
  LayoutGrid,
  PauseCircle,
  PlayCircle,
  Split,
  Percent,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useReactToPrint } from 'react-to-print';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, Order, OrderItem, Customer, HeldOrder } from '../db/db';
import { useInventoryStore } from '../store/useInventoryStore';
import { useAuth } from '../context/AuthContext';
import { useCartStore, getItemPrice, type CartUnitSelection } from '../store/useCartStore';
import { useSettings } from '../hooks/useSettings';
import { Html5Qrcode } from 'html5-qrcode';
import { Receipt as ReceiptComponent } from '../components/Receipt';
import { printService } from '../services/printService';
import { dispatchOperation } from '../services/operationService';
import { roundMoney } from '../utils/tax';
import ConfirmationModal from '../components/ConfirmationModal';

export default function POS() {
  const { user } = useAuth();

  const hasPermission = (permission: string) => {
    return user?.role === 'admin' || user?.permissions?.includes(permission);
  };

  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastScannedTimeRef = useRef<Record<string, number>>({});
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | 'all'>('all');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [pointsToRedeem, setPointsToRedeem] = useState(0);
  const [completedOrder, setCompletedOrder] = useState<{ order: Order; items: OrderItem[] } | null>(null);
  const [tableNumber, setTableNumber] = useState('');
  const [orderType, setOrderType] = useState<'dine_in' | 'takeaway' | 'delivery'>('dine_in');

  // Discount modals (replacing window.prompt / confirm)
  const [itemDiscountTarget, setItemDiscountTarget] = useState<{
    cartItemId: string;
    name: string;
    value: string;
    type: 'percentage' | 'fixed';
  } | null>(null);
  const [isGlobalDiscountOpen, setIsGlobalDiscountOpen] = useState(false);
  const [globalDiscountInput, setGlobalDiscountInput] = useState('0');
  const [globalDiscountInputType, setGlobalDiscountInputType] = useState<'percentage' | 'fixed'>('fixed');

  // Mixed / Split payment modal
  const [isMixedModalOpen, setIsMixedModalOpen] = useState(false);
  const [mixedCashInput, setMixedCashInput] = useState('0');
  const [mixedCardInput, setMixedCardInput] = useState('0');

  // Held / Parked orders modals
  const [isHoldModalOpen, setIsHoldModalOpen] = useState(false);
  const [isHeldListOpen, setIsHeldListOpen] = useState(false);
  const [heldDeleteTarget, setHeldDeleteTarget] = useState<HeldOrder | null>(null);

  const receiptRef = useRef<HTMLDivElement>(null);
  const storeSettings = useSettings();
  const {
    items,
    globalDiscount,
    globalDiscountType,
    clearCart,
    loadCartState,
    removeItem,
    updateQuantity,
    updateItemUnit,
    updateItemDiscount,
    addItem,
    setGlobalDiscount,
    setOfferDiscount,
    setLoyaltyDiscount,
    getTaxSummary,
    setTaxRate,
  } = useCartStore();

  const currentShift = useLiveQuery(() => db.shifts.where('status').equals('open').first());
  const allOffers = useLiveQuery(() => db.offers.toArray()) || [];
  const heldOrders = useLiveQuery(() => db.heldOrders.toArray()) || [];

  const customers =
    useLiveQuery(() => {
      const query = (customerSearchQuery || '').toLowerCase();
      if (!query) return db.customers.limit(25).toArray();
      return db.customers
        .filter((c) => (c.name || '').toLowerCase().includes(query) || (c.phone || '').includes(query))
        .toArray();
    }, [customerSearchQuery]) || [];

  useEffect(() => {
    if (storeSettings.taxRate !== undefined) {
      setTaxRate(storeSettings.taxRate);
    }
  }, [storeSettings.taxRate, setTaxRate]);

  // Compute automatic promotional offer discount from active db.offers
  const activeOfferDiscount = useMemo(() => {
    if (items.length === 0) return 0;
    const now = new Date();
    const activeOffers = allOffers.filter(
      (o) => o.isActive && new Date(o.startDate) <= now && new Date(o.endDate) >= now
    );
    const rawGrossSubtotal = items.reduce((sum, i) => sum + getItemPrice(i) * i.cartQuantity, 0);

    let totalOffer = 0;
    for (const offer of activeOffers) {
      if (offer.minPurchaseAmount && rawGrossSubtotal < offer.minPurchaseAmount) continue;
      if (offer.type === 'discount') {
        if (offer.applicableProducts && offer.applicableProducts.length > 0) {
          for (const item of items) {
            if (offer.applicableProducts.includes(item.id!)) {
              totalOffer += getItemPrice(item) * item.cartQuantity * (offer.value / 100);
            }
          }
        } else {
          totalOffer += rawGrossSubtotal * (offer.value / 100);
        }
      } else if (offer.type === 'bogo') {
        if (offer.applicableProducts && offer.applicableProducts.length > 0) {
          for (const item of items) {
            if (offer.applicableProducts.includes(item.id!)) {
              const freeQty = Math.floor(item.cartQuantity / 2);
              totalOffer += freeQty * getItemPrice(item);
            }
          }
        }
      } else if (offer.type === 'bundle') {
        if (offer.applicableProducts && offer.applicableProducts.length > 0) {
          const hasAll = offer.applicableProducts.every((pid) => items.some((i) => i.id === pid));
          if (hasAll) totalOffer += Number(offer.value || 0);
        }
      }
    }
    return roundMoney(totalOffer);
  }, [items, allOffers]);

  useEffect(() => {
    setOfferDiscount(activeOfferDiscount);
  }, [activeOfferDiscount, setOfferDiscount]);

  useEffect(() => {
    setLoyaltyDiscount(roundMoney(pointsToRedeem * 0.1));
  }, [pointsToRedeem, setLoyaltyDiscount]);

  const taxSummary = getTaxSummary(roundMoney(pointsToRedeem * 0.1));

  const {
    products: allProducts,
    categories,
    getProductByBarcode,
  } = useInventoryStore();

  const liveProducts = useLiveQuery(() => db.products.toArray());
  const liveProductUnits = useLiveQuery(() => db.productUnits.where('isActive').equals(1).toArray()) || [];
  const liveUnitDefinitions = useLiveQuery(() => db.unitDefinitions.toArray()) || [];

  const getUnitSelection = (productId: number, unitCode: string): CartUnitSelection | undefined => {
    const row = liveProductUnits.find((unit) => unit.productId === productId && unit.unitCode === unitCode && unit.isActive === 1);
    if (!row) return undefined;
    const definition = liveUnitDefinitions.find((unit) => unit.code === unitCode);
    const label = definition
      ? `${definition.name}${definition.symbol ? ` (${definition.symbol})` : ''}`
      : unitCode;
    return {
      unitCode: row.unitCode,
      conversionToBase: Number(row.conversionToBase),
      label,
      sellingPrice: row.sellingPrice == null ? null : Number(row.sellingPrice),
    };
  };

  const handleAddProduct = (product: (typeof allProducts)[number]) => {
    if (product.isActive === 0) {
      toast.error('هذا الصنف موقوف ولا يمكن بيعه');
      return;
    }
    const rows = liveProductUnits.filter((unit) => unit.productId === product.id && unit.isActive === 1);
    const base = rows.find((unit) => unit.isBaseUnit === 1) ||
      rows.find((unit) => unit.unitCode === product.baseUnitCode);
    if (base) {
      addItem(product, base.unitCode, getUnitSelection(product.id!, base.unitCode));
    } else {
      addItem(product);
    }
  };

  const addProductByBarcode = (barcode: string) => {
    const alternate = liveProductUnits.find((unit) => unit.barcode === barcode && unit.isActive === 1);
    if (alternate) {
      const product = allProducts.find((item) => item.id === alternate.productId);
      if (product?.isActive === 0) {
        toast.error('هذا الصنف موقوف ولا يمكن بيعه');
        return null;
      }
      if (product) {
        addItem(product, alternate.unitCode, getUnitSelection(product.id!, alternate.unitCode));
        return product;
      }
    }
    const product = getProductByBarcode(barcode) || allProducts.find((item) => item.barcode === barcode);
    if (product?.isActive === 0) {
      toast.error('هذا الصنف موقوف ولا يمكن بيعه');
      return null;
    }
    if (product) handleAddProduct(product);
    return product || null;
  };

  const handleCartUnitChange = (cartItemId: string, unitCode: string) => {
    const item = items.find((row) => row.cartItemId === cartItemId);
    if (!item) return;
    const selection = getUnitSelection(item.id!, unitCode);
    if (selection) updateItemUnit(cartItemId, unitCode, selection);
    else updateItemUnit(cartItemId, unitCode as 'piece' | 'box');
  };

  const getUnitQuantityStep = (item: (typeof items)[number]) => {
    const precision = item.selectedUnitCode
      ? Number(liveUnitDefinitions.find((unit) => unit.code === item.selectedUnitCode)?.decimalPlaces ?? 0)
      : 0;
    return 10 ** -Math.max(0, Math.min(6, precision));
  };

  useEffect(() => {
    if (liveProducts) {
      useInventoryStore.getState().updateProducts(liveProducts);
    }
  }, [liveProducts]);

  const liveCategories = useLiveQuery(() => db.categories.toArray());
  useEffect(() => {
    if (liveCategories) {
      useInventoryStore.getState().updateCategories(liveCategories);
    }
  }, [liveCategories]);

  useEffect(() => {
    const handler = setTimeout(() => {
      const currentVal = searchInputRef.current?.value || '';
      setDebouncedSearchQuery(currentVal);
    }, 250);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  const filteredProducts = useMemo(() => {
    let list = allProducts.filter((product) => product.isActive !== 0);
    if (selectedCategory !== 'all') {
      const categoryId = parseInt(selectedCategory, 10);
      list = allProducts.filter((p) => p.categoryId === categoryId);
    }
    return list.filter(
      (p) =>
        (p.name || '').toLowerCase().includes(debouncedSearchQuery.toLowerCase()) ||
        (p.barcode || '').includes(debouncedSearchQuery)
    );
  }, [allProducts, selectedCategory, debouncedSearchQuery]);

  const handlePrint = useReactToPrint({ contentRef: receiptRef });

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const lastScannedRef = useRef<{ code: string; time: number }>({ code: '', time: 0 });

  useEffect(() => {
    const handleGlobalScan = (e: any) => {
      const barcode = e.detail;
      const product = addProductByBarcode(String(barcode));
      if (product) {
        toast.success(`تم العثور على: ${product.name}`);
      }
    };

    window.addEventListener('barcode-scanned' as any, handleGlobalScan);
    return () => window.removeEventListener('barcode-scanned' as any, handleGlobalScan);
  }, [getProductByBarcode, addItem, allProducts, liveProductUnits, liveUnitDefinitions]);

  useEffect(() => {
    let isMounted = true;
    const stopScanner = async () => {
      if (scannerRef.current) {
        try {
          await scannerRef.current.stop();
          scannerRef.current.clear();
          scannerRef.current = null;
        } catch (err) {
          console.error('Error stopping scanner:', err);
        }
      }
    };

    if (isScannerOpen) {
      const startScanner = async () => {
        try {
          const devices = await Html5Qrcode.getCameras();
          if (devices && devices.length > 0) {
            scannerRef.current = new Html5Qrcode('reader');
            await scannerRef.current.start(
              { facingMode: 'environment' },
              { fps: 10, qrbox: { width: 250, height: 250 } },
              (decodedText) => {
                const now = Date.now();
                if (lastScannedRef.current.code !== decodedText || now - lastScannedRef.current.time > 2000) {
                  lastScannedRef.current = { code: decodedText, time: now };
                  const product = addProductByBarcode(decodedText);
                  if (product) {
                    toast.success(`تم العثور على: ${product.name}`);
                  } else {
                    toast.error('المنتج غير موجود');
                  }
                }
              },
              () => {}
            );
          } else {
            toast.error('لا يوجد كاميرا متاحة');
            setIsScannerOpen(false);
          }
        } catch (err) {
          console.error('Error starting scanner:', err);
          if (isMounted) {
            toast.error('تعذر الوصول للكاميرا. يرجى التحقق من الصلاحيات.');
            setIsScannerOpen(false);
          }
        }
      };
      startScanner();
    } else {
      stopScanner();
    }

    return () => {
      isMounted = false;
      stopScanner();
    };
  }, [isScannerOpen, getProductByBarcode, addItem, allProducts, liveProductUnits, liveUnitDefinitions]);

  const handleBarcodeSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const barcode = searchInputRef.current?.value?.trim();
    if (!barcode) return;

    const now = Date.now();
    if (lastScannedTimeRef.current[barcode] && now - lastScannedTimeRef.current[barcode] < 500) {
      return;
    }
    lastScannedTimeRef.current[barcode] = now;

    const product = addProductByBarcode(barcode);
    if (product) {
      if (searchInputRef.current) {
        searchInputRef.current.value = '';
        setSearchQuery('');
      }
    } else {
      const dbProduct = await db.products.where('barcode').equals(barcode).first();
      if (dbProduct) {
        handleAddProduct(dbProduct);
        if (searchInputRef.current) {
          searchInputRef.current.value = '';
          setSearchQuery('');
        }
      } else {
        toast.error('المنتج غير موجود');
      }
    }
  };

  const handleHoldCurrentOrder = async (labelInput?: string) => {
    if (items.length === 0) return;
    try {
      const id = generateUUID();
      const label = labelInput?.trim() || `فاتورة معلقة #${heldOrders.length + 1}`;
      await db.heldOrders.add({
        id,
        label,
        items: items.map((i) => ({ ...i })),
        globalDiscount,
        globalDiscountType,
        customerId: selectedCustomer?.id,
        customerName: selectedCustomer?.name,
        orderType: storeSettings.businessType === 'restaurant' ? orderType : undefined,
        tableNumber: storeSettings.businessType === 'restaurant' ? tableNumber : undefined,
        createdBy: user?.name || 'System',
        createdAt: new Date().toISOString(),
      });
      clearCart();
      setSelectedCustomer(null);
      setPointsToRedeem(0);
      setTableNumber('');
      setIsHoldModalOpen(false);
      toast.success(`تم تعليق الفاتورة: ${label}`);
    } catch (error) {
      console.error('Failed to hold order:', error);
      toast.error('تعذر تعليق الفاتورة');
    }
  };

  const handleResumeHeldOrder = async (held: HeldOrder) => {
    try {
      loadCartState({
        items: held.items || [],
        globalDiscount: held.globalDiscount || 0,
        globalDiscountType: held.globalDiscountType || 'percentage',
      });
      if (held.customerId) {
        const cust = await db.customers.get(held.customerId);
        setSelectedCustomer(cust || null);
      } else {
        setSelectedCustomer(null);
      }
      if (held.orderType) setOrderType(held.orderType);
      if (held.tableNumber) setTableNumber(held.tableNumber);
      setPointsToRedeem(0);
      await db.heldOrders.delete(held.id);
      setIsHeldListOpen(false);
      toast.success(`تم استرجاع الفاتورة: ${held.label}`);
    } catch (error) {
      console.error('Failed to resume held order:', error);
      toast.error('تعذر استرجاع الفاتورة');
    }
  };

  const openMixedPaymentModal = () => {
    if (items.length === 0) return;
    if (!currentShift) {
      toast.error('يجب فتح وردية أولاً للتمكن من البيع');
      return;
    }
    const total = taxSummary.netAmount;
    const halfCash = roundMoney(total / 2);
    const halfCard = roundMoney(total - halfCash);
    setMixedCashInput(halfCash.toFixed(2));
    setMixedCardInput(halfCard.toFixed(2));
    setIsMixedModalOpen(true);
  };

  const handleCheckout = async (
    paymentMethod: 'cash' | 'card' | 'credit' | 'mixed',
    mixedSplit?: { cashAmount: number; cardAmount: number }
  ) => {
    if (items.length === 0) return;

    if (!currentShift) {
      toast.error('يجب فتح وردية أولاً للتمكن من البيع');
      return;
    }

    if (paymentMethod === 'credit' && !selectedCustomer) {
      toast.error('يجب اختيار عميل للبيع الآجل');
      setIsCustomerModalOpen(true);
      return;
    }

    const summary = getTaxSummary(roundMoney(pointsToRedeem * 0.1));
    const grandTotal = summary.netAmount;

    let cashAmount = 0;
    let cardAmount = 0;
    if (paymentMethod === 'cash') {
      cashAmount = grandTotal;
    } else if (paymentMethod === 'card') {
      cardAmount = grandTotal;
    } else if (paymentMethod === 'mixed') {
      cashAmount = roundMoney(mixedSplit?.cashAmount || 0);
      cardAmount = roundMoney(mixedSplit?.cardAmount || 0);
      if (cashAmount < 0 || cardAmount < 0 || Math.abs(cashAmount + cardAmount - grandTotal) > 0.05) {
        toast.error(`مجموع النقدي والشبكة يجب أن يساوي الإجمالي (${grandTotal.toFixed(2)})`);
        return;
      }
    }

    setIsProcessing(true);

    try {
      const orderId = generateUUID();
      const receiptNumber = `INV-${Date.now()}`;
      const now = new Date().toISOString();
      const pointsEarned = Math.floor(grandTotal / 10);

      const newOrder: Order = {
        id: orderId,
        receiptNumber,
        totalAmount: summary.totalAmountExclTax,
        discountAmount: summary.discountAmountExclTax,
        taxAmount: summary.taxAmount,
        netAmount: grandTotal,
        paidAmount: paymentMethod === 'credit' ? 0 : grandTotal,
        cashAmount: paymentMethod === 'mixed' ? cashAmount : undefined,
        cardAmount: paymentMethod === 'mixed' ? cardAmount : undefined,
        returnedAmount: 0,
        paymentMethod,
        customerId: selectedCustomer?.id,
        customerName: selectedCustomer?.name,
        shiftId: currentShift.id,
        branchId: user?.branchId,
        tableNumber: storeSettings.businessType === 'restaurant' ? tableNumber : undefined,
        orderType: storeSettings.businessType === 'restaurant' ? orderType : undefined,
        status: 'completed',
        createdBy: user?.name || 'مستخدم غير معروف',
        createdAt: now,
        updatedAt: now,
        syncStatus: 'pending',
      };

      const orderItemsPayload: OrderItem[] = items.map((item, idx) => {
        const unitPrice = getItemPrice(item);
        const line = summary.lines[idx];

        const factor = item.selectedUnitCode
          ? Number(item.selectedConversionToBase || 1)
          : item.selectedUnit === 'box' ? Number(item.conversionFactor || 1) : 1;
        return {
          orderId,
          productId: item.id!,
          productName: item.name,
          quantity: item.cartQuantity,
          returnedQuantity: 0,
          unit: item.selectedUnit || 'piece',
          conversionFactor: factor,
          unitCode: item.selectedUnitCode,
          baseUnitCode: item.baseUnitCode || null,
          conversionToBase: factor,
          baseQuantity: item.cartQuantity * factor,
          unitPrice,
          costPriceAtTimeOfSale: roundMoney((item.costPriceAtTimeOfSale ?? item.costPrice ?? 0) * factor),
          discountAmount: line.discountExclTax,
          subTotal: line.subTotalExclTax,
          taxAmount: line.taxAmount,
          total: line.finalGross,
          syncStatus: 'pending',
        };
      });

      const opResult = await dispatchOperation(
        'sale',
        {
          order: newOrder,
          items: orderItemsPayload,
          pointsEarned,
          pointsRedeemed: pointsToRedeem,
        },
        user?.branchId
      );

      if (opResult.synced) {
        toast.success(`تم إصدار الفاتورة بنجاح: ${receiptNumber}`);
      } else {
        toast.success(`تم حفظ الفاتورة محلياً (${receiptNumber}) وستُزامَن مع السيرفر تلقائياً`);
      }

      clearCart();
      setSelectedCustomer(null);
      setPointsToRedeem(0);
      setIsMixedModalOpen(false);
      setCompletedOrder({ order: newOrder, items: orderItemsPayload });

      if (storeSettings.enableDirectPrint) {
        try {
          await printService.connect(storeSettings.printerType);
          await printService.printReceipt(
            {
              id: receiptNumber,
              date: now,
              items: orderItemsPayload,
              subtotal: summary.netSalesExclTax.toFixed(2),
              tax: summary.taxAmount.toFixed(2),
              total: grandTotal.toFixed(2),
            },
            storeSettings
          );
        } catch (printErr) {
          console.error('Direct print failed:', printErr);
          toast.error('فشلت الطباعة المباشرة، يرجى التحقق من اتصال الطابعة');
        }
      }
    } catch (error: any) {
      console.error('Checkout failed', error);
      toast.error(error?.message || 'حدث خطأ أثناء إصدار الفاتورة');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex h-full bg-[var(--app-bg)] relative">
      {/* Products Section */}
      <div className="flex-1 flex flex-col p-4 overflow-hidden">
        {/* Search & Top Actions */}
        <div className="flex gap-3 mb-4 shrink-0">
          <form onSubmit={handleBarcodeSubmit} className="flex-1 relative">
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-slate-400" />
            </div>
            <input
              type="text"
              ref={searchInputRef}
              className="block w-full pl-10 pr-10 py-3 border border-slate-200 rounded-xl leading-5 bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              placeholder="ابحث بالاسم أو امسح الباركود..."
              defaultValue={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus={storeSettings.posScannerType === 'usb'}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleBarcodeSubmit();
                }
              }}
            />
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <ScanLine className="h-5 w-5 text-slate-400" />
            </div>
          </form>

          <button
            type="button"
            onClick={() => setIsHeldListOpen(true)}
            className="px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
          >
            <PlayCircle className="w-4 h-4 text-amber-600" />
            <span>المعلقة</span>
            <span className="px-1.5 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-amber-700 text-xs tabular-nums">
              {heldOrders.length}
            </span>
          </button>

          {storeSettings.posScannerType === 'camera' && (
            <button
              onClick={() => setIsScannerOpen(true)}
              className="bg-indigo-600 text-white px-3.5 py-2.5 rounded-xl hover:bg-indigo-700 transition-colors flex items-center justify-center shrink-0"
              title="مسح الباركود بالكاميرا"
              type="button"
            >
              <Camera className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Categories */}
        <div className="flex gap-2 overflow-x-auto pb-2 mb-4 shrink-0 hide-scrollbar scroll-smooth">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`px-4 py-2 rounded-xl text-sm font-bold whitespace-nowrap shrink-0 transition-colors flex items-center gap-2 border ${
              selectedCategory === 'all'
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/40'
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
            <span>الكل</span>
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(String(cat.id!))}
              className={`px-4 py-2 rounded-xl text-sm font-bold whitespace-nowrap shrink-0 transition-colors flex items-center gap-2 border ${
                selectedCategory === String(cat.id)
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/40'
              }`}
            >
              <span>{cat.name}</span>
            </button>
          ))}
        </div>

        {/* Products Grid */}
        <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5">
            {filteredProducts.map((product) => (
              <button
                key={product.id}
                onClick={() => handleAddProduct(product)}
                className="bg-white border border-slate-200 rounded-2xl p-3.5 flex flex-col items-center text-center hover:border-indigo-500 transition-colors active:scale-98 group"
              >
                <div className="w-14 h-14 bg-slate-50 border border-slate-100 rounded-xl flex items-center justify-center mb-2.5 group-hover:bg-indigo-50 transition-colors relative overflow-hidden">
                  {product.imageUrl ? (
                    <img src={product.imageUrl} alt={product.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    <Package className="w-7 h-7 text-slate-400 group-hover:text-indigo-500" />
                  )}
                  {product.stockQuantity <= (product.minStockLevel || 5) && (
                    <span className="absolute top-0.5 right-0.5 w-2.5 h-2.5 bg-rose-500 rounded-full border border-white" title="مخزون منخفض" />
                  )}
                </div>
                <h3 className="font-bold text-slate-800 text-sm mb-1 line-clamp-2">{product.name}</h3>
                <p className="text-indigo-600 font-extrabold mt-auto tabular-nums">
                  {product.sellingPrice.toFixed(2)} {storeSettings.currency}
                </p>
                {product.priceInUSD ? (
                  <p className="text-xs text-slate-500 font-medium tabular-nums">${product.priceInUSD.toFixed(2)}</p>
                ) : null}
                <p className="text-[11px] text-slate-400 mt-1 font-mono">{product.barcode}</p>
              </button>
            ))}
            {filteredProducts.length === 0 && (
              <div className="col-span-full flex flex-col items-center justify-center py-20 text-slate-400">
                <Package className="w-14 h-14 mb-3 opacity-30" />
                <p className="text-base font-medium">لا توجد منتجات مطابقة</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Cart Section */}
      <div className="w-[410px] bg-white border-r border-slate-200 flex flex-col z-10">
        {/* Cart Header */}
        <div className="p-4 border-b border-slate-200 flex items-center justify-between shrink-0 bg-slate-50/70">
          <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
            <Receipt className="w-5 h-5 text-indigo-600" />
            <span>الفاتورة الحالية</span>
          </h2>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setIsHoldModalOpen(true)}
              disabled={items.length === 0}
              className="text-amber-600 hover:bg-amber-50 px-2.5 py-1.5 rounded-lg text-xs font-bold border border-transparent hover:border-amber-200 transition-colors disabled:opacity-40 flex items-center gap-1 whitespace-nowrap shrink-0"
              title="تعليق الفاتورة"
            >
              <PauseCircle className="w-4 h-4" />
              <span>تعليق</span>
            </button>
            {hasPermission('void_items') && (
              <button
                onClick={clearCart}
                disabled={items.length === 0}
                className="text-rose-500 hover:bg-rose-50 p-2 rounded-lg transition-colors disabled:opacity-40"
                title="إفراغ السلة"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Restaurant Options */}
        {storeSettings.businessType === 'restaurant' && (
          <div className="p-3.5 border-b border-slate-100 bg-white space-y-2.5">
            <div className="flex gap-2">
              {(['dine_in', 'takeaway', 'delivery'] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setOrderType(type)}
                  className={`flex-1 py-2 rounded-xl text-xs font-bold transition-colors border whitespace-nowrap ${
                    orderType === type
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {type === 'dine_in' ? 'محلي' : type === 'takeaway' ? 'سفري' : 'توصيل'}
                </button>
              ))}
            </div>
            {orderType === 'dine_in' && (
              <div className="flex items-center gap-2">
                <label className="text-xs font-bold text-slate-500 whitespace-nowrap">رقم الطاولة:</label>
                <input
                  type="text"
                  value={tableNumber}
                  onChange={(e) => setTableNumber(e.target.value)}
                  placeholder="مثال: 5"
                  className="w-full px-3 py-1.5 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                />
              </div>
            )}
          </div>
        )}

        {/* Cart Items */}
        <div className="flex-1 overflow-y-auto p-3.5 custom-scrollbar">
          {items.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-3">
              <div className="w-20 h-20 bg-slate-50 border border-slate-100 rounded-2xl flex items-center justify-center">
                <Receipt className="w-9 h-9 text-slate-300" />
              </div>
              <p className="text-sm font-medium">السلة فارغة، قم بإضافة منتجات</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {items.map((item) => (
                <div key={item.cartItemId} className="flex flex-col p-3 bg-white border border-slate-200 rounded-xl">
                  <div className="flex justify-between items-start gap-2 mb-2">
                    <h4 className="font-bold text-slate-800 text-sm">{item.name}</h4>
                    <span className="font-bold text-slate-900 tabular-nums shrink-0">
                      {(getItemPrice(item) * item.cartQuantity).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-col gap-1">
                      <p className="text-xs text-slate-500 tabular-nums">
                        {getItemPrice(item).toFixed(2)} {storeSettings.currency} / للوحدة (شامل الضريبة)
                      </p>
                      {(() => {
                        const unitRows = liveProductUnits.filter((unit) => unit.productId === item.id && unit.isActive === 1);
                        if (unitRows.length > 1) {
                          return (
                            <select
                              value={item.selectedUnitCode || item.selectedUnit}
                              onChange={(e) => handleCartUnitChange(item.cartItemId, e.target.value)}
                              className="text-xs border border-slate-200 rounded-lg p-1 bg-slate-50 text-slate-700 outline-none focus:border-indigo-500 w-fit"
                            >
                              {unitRows.map((unit) => {
                                const definition = liveUnitDefinitions.find((row) => row.code === unit.unitCode);
                                const label = definition
                                  ? `${definition.name}${definition.symbol ? ` (${definition.symbol})` : ''}`
                                  : unit.unitCode;
                                return <option key={unit.id} value={unit.unitCode}>{label} — ×{unit.conversionToBase}</option>;
                              })}
                            </select>
                          );
                        }
                        if (item.unit === 'box' && !item.selectedUnitCode) {
                          return (
                            <select
                              value={item.selectedUnit}
                              onChange={(e) => updateItemUnit(item.cartItemId, e.target.value as 'piece' | 'box')}
                              className="text-xs border border-slate-200 rounded-lg p-1 bg-slate-50 text-slate-700 outline-none focus:border-indigo-500 w-fit"
                            >
                              <option value="piece">حبة</option>
                              <option value="box">صندوق ({item.conversionFactor} حبة)</option>
                            </select>
                          );
                        }
                        return item.selectedUnitLabel ? <span className="text-xs text-slate-500">{item.selectedUnitLabel}</span> : null;
                      })()}
                      {item.discount > 0 && (
                        <p className="text-[11px] text-rose-600 font-bold tabular-nums">
                          خصم: {item.discountType === 'percentage' ? `${item.discount}%` : `${item.discount} ${storeSettings.currency}`}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {hasPermission('apply_discounts') && (
                        <button
                          type="button"
                          onClick={() =>
                            setItemDiscountTarget({
                              cartItemId: item.cartItemId,
                              name: item.name,
                              value: String(item.discount || 0),
                              type: item.discountType,
                            })
                          }
                          className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 px-2.5 py-1.5 rounded-lg font-bold transition-colors whitespace-nowrap"
                        >
                          خصم
                        </button>
                      )}
                      <div className="flex items-center gap-2 bg-slate-50 rounded-lg p-1 border border-slate-200">
                        {hasPermission('void_items') ? (
                          <button
                            onClick={() => {
                              const nextQuantity = item.cartQuantity - getUnitQuantityStep(item);
                              if (nextQuantity <= 0.0000001) removeItem(item.cartItemId);
                              else updateQuantity(item.cartItemId, nextQuantity);
                            }}
                            className="w-7 h-7 flex items-center justify-center bg-white rounded border border-slate-200 text-slate-600 hover:text-rose-600"
                          >
                            <Minus className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <div className="w-7 h-7" />
                        )}
                        <input
                          type="number"
                          min="0.000001"
                          step="any"
                          value={item.cartQuantity}
                          onChange={(e) => {
                            if (e.target.value === '') return;
                            const nextQuantity = Number(e.target.value);
                            if (nextQuantity <= 0) removeItem(item.cartItemId);
                            else updateQuantity(item.cartItemId, nextQuantity);
                          }}
                          className="font-bold w-14 text-center text-sm tabular-nums bg-transparent outline-none"
                          aria-label="الكمية"
                        />
                        <button
                          onClick={() => updateQuantity(item.cartItemId, item.cartQuantity + getUnitQuantityStep(item))}
                          className="w-7 h-7 flex items-center justify-center bg-white rounded border border-slate-200 text-slate-600 hover:text-indigo-600"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cart Totals & Actions */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 shrink-0">
          {/* Customer Selection */}
          <div className="mb-3">
            {selectedCustomer ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between bg-indigo-50 border border-indigo-200 p-2.5 rounded-xl">
                  <div className="flex items-center gap-2">
                    <UserCheck className="w-5 h-5 text-indigo-600 shrink-0" />
                    <div>
                      <p className="text-sm font-bold text-indigo-950">{selectedCustomer.name}</p>
                      <p className="text-xs text-indigo-700 tabular-nums">
                        الرصيد: {selectedCustomer.balance.toFixed(2)} {storeSettings.currency} | النقاط: {selectedCustomer.points || 0}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setSelectedCustomer(null);
                      setPointsToRedeem(0);
                    }}
                    className="text-indigo-500 hover:text-indigo-700 p-1"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {selectedCustomer.points > 0 && (
                  <div className="bg-amber-50 border border-amber-200 p-2 rounded-xl flex items-center justify-between">
                    <span className="text-xs font-bold text-amber-800">استبدال نقاط:</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        max={selectedCustomer.points}
                        min={0}
                        value={pointsToRedeem}
                        onChange={(e) =>
                          setPointsToRedeem(
                            Math.min(selectedCustomer.points, Math.max(0, parseInt(e.target.value, 10) || 0))
                          )
                        }
                        className="w-16 text-center text-xs border border-amber-300 bg-white rounded-lg p-1 focus:outline-none tabular-nums"
                      />
                      <span className="text-xs font-bold text-amber-700 tabular-nums">
                        (-{(pointsToRedeem * 0.1).toFixed(2)})
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={() => setIsCustomerModalOpen(true)}
                className="w-full flex items-center justify-center gap-2 bg-white border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/40 text-slate-700 py-2.5 rounded-xl font-bold text-xs transition-colors"
              >
                <Users className="w-4 h-4 text-indigo-600" />
                <span>ربط الفاتورة بعميل (اختياري)</span>
              </button>
            )}
          </div>

          <div className="space-y-1.5 mb-3 text-xs tabular-nums">
            <div className="flex justify-between text-slate-600">
              <span>الصافي قبل الضريبة</span>
              <span className="font-bold">
                {taxSummary.netSalesExclTax.toFixed(2)} {storeSettings.currency}
              </span>
            </div>
            {activeOfferDiscount > 0 && (
              <div className="flex justify-between text-emerald-600 font-bold">
                <span>خصم العروض التلقائي</span>
                <span>
                  -{activeOfferDiscount.toFixed(2)} {storeSettings.currency}
                </span>
              </div>
            )}
            <div className="flex justify-between items-center text-rose-600">
              <div className="flex items-center gap-2">
                <span>الخصم</span>
                {hasPermission('apply_discounts') && (
                  <button
                    type="button"
                    onClick={() => {
                      setGlobalDiscountInput(String(globalDiscount || 0));
                      setGlobalDiscountInputType(globalDiscountType || 'fixed');
                      setIsGlobalDiscountOpen(true);
                    }}
                    className="text-[11px] bg-rose-50 border border-rose-200 hover:bg-rose-100 px-2 py-0.5 rounded-md font-bold text-rose-700 transition-colors"
                  >
                    تعديل
                  </button>
                )}
              </div>
              <span className="font-bold">
                -{taxSummary.grossDiscountTotal.toFixed(2)} {storeSettings.currency}
              </span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>ضريبة القيمة المضافة المضمنة ({storeSettings.taxRate}%)</span>
              <span className="font-bold">
                {taxSummary.taxAmount.toFixed(2)} {storeSettings.currency}
              </span>
            </div>
            <div className="pt-2 mt-1 border-t border-slate-200 flex justify-between items-center">
              <span className="text-base font-bold text-slate-900">الإجمالي النهائي</span>
              <span className="text-2xl font-black text-indigo-600">
                {taxSummary.netAmount.toFixed(2)} {storeSettings.currency}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2">
            <button
              onClick={() => handleCheckout('cash')}
              disabled={items.length === 0 || isProcessing || !currentShift}
              className="flex flex-col items-center justify-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-xl text-xs font-bold transition-colors disabled:opacity-50"
            >
              <Banknote className="w-4 h-4" />
              <span>نقدي</span>
            </button>
            <button
              onClick={() => handleCheckout('card')}
              disabled={items.length === 0 || isProcessing || !currentShift}
              className="flex flex-col items-center justify-center gap-1 bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-xl text-xs font-bold transition-colors disabled:opacity-50"
            >
              <CreditCard className="w-4 h-4" />
              <span>شبكة</span>
            </button>
            <button
              onClick={openMixedPaymentModal}
              disabled={items.length === 0 || isProcessing || !currentShift}
              className="flex flex-col items-center justify-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl text-xs font-bold transition-colors disabled:opacity-50"
            >
              <Split className="w-4 h-4" />
              <span>مختلط</span>
            </button>
            <button
              onClick={() => handleCheckout('credit')}
              disabled={items.length === 0 || isProcessing || !currentShift}
              className="flex flex-col items-center justify-center gap-1 bg-amber-500 hover:bg-amber-600 text-white py-2.5 rounded-xl text-xs font-bold transition-colors disabled:opacity-50"
            >
              <Users className="w-4 h-4" />
              <span>آجل</span>
            </button>
          </div>
          {!currentShift && (
            <p className="text-center text-rose-600 text-xs mt-2 font-bold">يجب فتح وردية لإتمام البيع</p>
          )}
        </div>
      </div>

      {/* Hold Order Modal */}
      <ConfirmationModal
        isOpen={isHoldModalOpen}
        title="تعليق الفاتورة الحالية"
        message="أدخل اسماً أو رقماً مرجعياً لتسهيل استرجاع الفاتورة لاحقاً:"
        confirmLabel="تعليق الفاتورة"
        promptLabel="الاسم المرجعي (اختياري)"
        promptPlaceholder={`فاتورة معلقة #${heldOrders.length + 1}`}
        onConfirm={(val) => handleHoldCurrentOrder(val)}
        onCancel={() => setIsHoldModalOpen(false)}
      />

      {/* Delete Held Order Confirm Modal */}
      <ConfirmationModal
        isOpen={Boolean(heldDeleteTarget)}
        title="حذف الفاتورة المعلقة"
        message={`هل تريد حذف "${heldDeleteTarget?.label || ''}" نهائياً؟`}
        confirmLabel="حذف"
        variant="danger"
        onConfirm={async () => {
          if (heldDeleteTarget) {
            await db.heldOrders.delete(heldDeleteTarget.id);
            toast.success('تم حذف الفاتورة المعلقة');
          }
          setHeldDeleteTarget(null);
        }}
        onCancel={() => setHeldDeleteTarget(null)}
      />

      {/* Held Orders List Modal */}
      {isHeldListOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[80vh]">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <PauseCircle className="w-5 h-5 text-amber-600" />
                <span>الفواتير المعلقة ({heldOrders.length})</span>
              </h3>
              <button onClick={() => setIsHeldListOpen(false)} className="text-slate-400 hover:text-slate-600 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2.5 custom-scrollbar">
              {heldOrders.length === 0 ? (
                <div className="py-12 text-center text-slate-400 text-sm">لا توجد فواتير معلقة حالياً</div>
              ) : (
                heldOrders.map((held) => (
                  <div
                    key={held.id}
                    className="p-3.5 rounded-xl border border-slate-200 bg-white flex items-center justify-between gap-3"
                  >
                    <div>
                      <p className="font-bold text-slate-900 text-sm">{held.label}</p>
                      <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                        {held.items?.length || 0} أصناف {held.customerName ? `• ${held.customerName}` : ''} •{' '}
                        {new Date(held.createdAt).toLocaleTimeString('ar-SA')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleResumeHeldOrder(held)}
                        className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold flex items-center gap-1 whitespace-nowrap"
                      >
                        <PlayCircle className="w-4 h-4" />
                        <span>استرجاع</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setHeldDeleteTarget(held)}
                        className="p-2 rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50"
                        title="حذف"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Item Discount Modal */}
      {itemDiscountTarget && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-sm p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Percent className="w-4 h-4 text-indigo-600" />
                <span>خصم على الصنف</span>
              </h3>
              <button onClick={() => setItemDiscountTarget(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-500 mb-4 font-bold">{itemDiscountTarget.name}</p>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setItemDiscountTarget({ ...itemDiscountTarget, type: 'percentage' })}
                  className={`py-2 rounded-xl text-xs font-bold border ${
                    itemDiscountTarget.type === 'percentage'
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-slate-50 text-slate-600 border-slate-200'
                  }`}
                >
                  نسبة مئوية (%)
                </button>
                <button
                  type="button"
                  onClick={() => setItemDiscountTarget({ ...itemDiscountTarget, type: 'fixed' })}
                  className={`py-2 rounded-xl text-xs font-bold border ${
                    itemDiscountTarget.type === 'fixed'
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-slate-50 text-slate-600 border-slate-200'
                  }`}
                >
                  مبلغ ثابت ({storeSettings.currency})
                </button>
              </div>
              <input
                type="number"
                step="0.01"
                min="0"
                autoFocus
                value={itemDiscountTarget.value}
                onChange={(e) => setItemDiscountTarget({ ...itemDiscountTarget, value: e.target.value })}
                className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-sm font-bold text-center tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setItemDiscountTarget(null)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-bold"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const num = Math.max(0, parseFloat(itemDiscountTarget.value) || 0);
                    updateItemDiscount(itemDiscountTarget.cartItemId, num, itemDiscountTarget.type);
                    setItemDiscountTarget(null);
                  }}
                  className="px-5 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700"
                >
                  تطبيق
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Global Discount Modal */}
      {isGlobalDiscountOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-sm p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-base font-bold text-slate-900">تعديل الخصم العام للفاتورة</h3>
              <button onClick={() => setIsGlobalDiscountOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setGlobalDiscountInputType('fixed')}
                  className={`py-2 rounded-xl text-xs font-bold border ${
                    globalDiscountInputType === 'fixed'
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-slate-50 text-slate-600 border-slate-200'
                  }`}
                >
                  مبلغ ثابت ({storeSettings.currency})
                </button>
                <button
                  type="button"
                  onClick={() => setGlobalDiscountInputType('percentage')}
                  className={`py-2 rounded-xl text-xs font-bold border ${
                    globalDiscountInputType === 'percentage'
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-slate-50 text-slate-600 border-slate-200'
                  }`}
                >
                  نسبة مئوية (%)
                </button>
              </div>
              <input
                type="number"
                step="0.01"
                min="0"
                autoFocus
                value={globalDiscountInput}
                onChange={(e) => setGlobalDiscountInput(e.target.value)}
                className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-sm font-bold text-center tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsGlobalDiscountOpen(false)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-bold"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const num = Math.max(0, parseFloat(globalDiscountInput) || 0);
                    setGlobalDiscount(num, globalDiscountInputType);
                    setIsGlobalDiscountOpen(false);
                  }}
                  className="px-5 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700"
                >
                  تطبيق
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mixed / Split Payment Modal */}
      {isMixedModalOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Split className="w-5 h-5 text-indigo-600" />
                <span>الدفع المختلط (نقدي + شبكة)</span>
              </h3>
              <button onClick={() => setIsMixedModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-3.5 bg-indigo-50 border border-indigo-200 rounded-xl flex justify-between items-center mb-5 tabular-nums">
              <span className="text-sm font-bold text-indigo-900">المبلغ المطلوب سداده</span>
              <span className="text-xl font-black text-indigo-700">
                {taxSummary.netAmount.toFixed(2)} {storeSettings.currency}
              </span>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">المبلغ المدفوع نقداً</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max={taxSummary.netAmount}
                  autoFocus
                  value={mixedCashInput}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setMixedCashInput(raw);
                    const cashVal = Math.max(0, Math.min(taxSummary.netAmount, parseFloat(raw) || 0));
                    setMixedCardInput(roundMoney(taxSummary.netAmount - cashVal).toFixed(2));
                  }}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-base font-bold tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">المبلغ المدفوع بالشبكة</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max={taxSummary.netAmount}
                  value={mixedCardInput}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setMixedCardInput(raw);
                    const cardVal = Math.max(0, Math.min(taxSummary.netAmount, parseFloat(raw) || 0));
                    setMixedCashInput(roundMoney(taxSummary.netAmount - cardVal).toFixed(2));
                  }}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-base font-bold tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={() => setIsMixedModalOpen(false)}
                className="px-4 py-2.5 rounded-xl border border-slate-200 text-slate-700 text-sm font-bold"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={isProcessing}
                onClick={() =>
                  handleCheckout('mixed', {
                    cashAmount: parseFloat(mixedCashInput) || 0,
                    cardAmount: parseFloat(mixedCardInput) || 0,
                  })
                }
                className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-50"
              >
                اعتماد الدفع المختلط
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scanner Modal */}
      {isScannerOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Camera className="w-5 h-5 text-indigo-600" />
                مسح الباركود
              </h3>
              <button onClick={() => setIsScannerOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-4">
              <div id="reader" className="w-full" />
              <p className="text-center text-sm text-slate-500 mt-4">
                قم بتوجيه الكاميرا نحو الباركود لمسحه تلقائياً
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Customer Selection Modal */}
      {isCustomerModalOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[80vh]">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Users className="w-5 h-5 text-indigo-600" />
                اختيار عميل
              </h3>
              <button onClick={() => setIsCustomerModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="p-4 border-b border-slate-100">
              <div className="relative">
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                  <Search className="h-5 w-5 text-slate-400" />
                </div>
                <input
                  type="text"
                  className="block w-full pl-3 pr-10 py-2 border border-slate-200 rounded-xl leading-5 bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 sm:text-sm"
                  placeholder="ابحث باسم العميل أو رقم الهاتف..."
                  value={customerSearchQuery}
                  onChange={(e) => setCustomerSearchQuery(e.target.value)}
                  autoFocus
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
              {customers.length === 0 ? (
                <div className="p-8 text-center text-slate-500">
                  <Users className="w-12 h-12 mx-auto text-slate-300 mb-3" />
                  <p>لا يوجد عملاء مطابقين للبحث</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {customers.map((customer) => (
                    <button
                      key={customer.id}
                      onClick={() => {
                        setSelectedCustomer(customer);
                        setIsCustomerModalOpen(false);
                      }}
                      className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-slate-50 transition-colors text-right"
                    >
                      <div>
                        <p className="font-bold text-slate-900">{customer.name}</p>
                        <p className="text-xs text-slate-500">{customer.phone}</p>
                      </div>
                      <div className="text-left tabular-nums">
                        <p className="text-xs text-slate-500 mb-1">الرصيد</p>
                        <p className={`text-sm font-bold ${customer.balance > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                          {customer.balance.toFixed(2)} {storeSettings.currency}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Receipt Modal */}
      {completedOrder && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Receipt className="w-5 h-5 text-indigo-600" />
                تم إصدار الفاتورة
              </h3>
              <button onClick={() => setCompletedOrder(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 bg-slate-100 flex justify-center custom-scrollbar">
              <div className="bg-white border border-slate-200">
                <ReceiptComponent
                  ref={receiptRef}
                  order={completedOrder.order}
                  items={completedOrder.items}
                  settings={storeSettings}
                />
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 bg-white grid grid-cols-2 gap-3">
              <button
                onClick={() => setCompletedOrder(null)}
                className="py-3 rounded-xl font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
              >
                طلب جديد
              </button>
              <button
                onClick={() => handlePrint()}
                className="flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors"
              >
                <Printer className="w-5 h-5" />
                طباعة الفاتورة
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
