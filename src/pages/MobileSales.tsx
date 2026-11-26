import { playSuccessSound, playErrorSound, playScanSound } from '../lib/sound';
import { usePosRecordsWhereEquals } from '../hooks/usePosRecordsWhereEquals';
import { getPosRecordsWhereEquals } from '../services/posDataAccess';
import { usePosFirstRecordWhereEquals } from '../hooks/usePosFirstRecordWhereEquals';
import { usePosEntityRecords } from '../hooks/usePosEntityRecords';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  ShoppingBag,
  Search,
  Plus,
  Minus,
  Trash2,
  ChevronLeft,
  CreditCard,
  Package,
  ArrowRight,
  X,
  Camera,
  Banknote,
  Users,
  LayoutGrid,
  History,
  Settings as SettingsIcon,
  LogOut,
  Scan,
  ClipboardList,
  Globe,
  Printer,
  Receipt as ReceiptIcon,
} from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import { PRODUCT_BARCODE_FORMATS, PRODUCT_BARCODE_CAMERA_CONFIG, createBarcodeScanGate, normalizeBarcodeValue } from '../utils/barcodeScanner';
import { findProductBarcodeMatch, getProductUnitOptions, resolveProductUnitFactor } from '../utils/productUnits';
import { ensureAndroidCameraPermission } from '../native/cameraPermission';
import { useReactToPrint } from 'react-to-print';
import type { Product, Customer, Order, OrderItem, StocktakingEntry } from '../db/db';
import toast from 'react-hot-toast';
import { useSettings } from '../hooks/useSettings';
import { useAuth } from '../context/AuthContext';
import { v4 as uuidv4 } from 'uuid';
import { dispatchOperation } from '../services/operationService';
import { calculateVatInclusiveOrder, roundMoney } from '../utils/tax';
import ConfirmationModal from '../components/ConfirmationModal';
import { Receipt as ReceiptComponent } from '../components/Receipt';

type Tab = 'sales' | 'inventory' | 'scanner' | 'invoices' | 'settings';

const MobileSales: React.FC = () => {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('sales');
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const [selectedCategory, setSelectedCategory] = useState<string | 'all'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [cart, setCart] = useState<{ product: Product; quantity: number; unit: string }[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [scannerMode, setScannerMode] = useState<'sales' | 'stocktaking'>('sales');
  const [hasAcknowledgedSession, setHasAcknowledgedSession] = useState(false);
  const [isStocktakingModalOpen, setIsStocktakingModalOpen] = useState(false);
  const [isCloseSessionModalOpen, setIsCloseSessionModalOpen] = useState(false);
  const [actualQuantity, setActualQuantity] = useState('');
  const [scannedProduct, setScannedProduct] = useState<Product | null>(null);
  const [tableNumber, setTableNumber] = useState('');
  const [orderType, setOrderType] = useState<'dine_in' | 'takeaway' | 'delivery'>('dine_in');
  const [completedOrder, setCompletedOrder] = useState<{ order: Order; items: OrderItem[] } | null>(null);
  const receiptRef = useRef<HTMLDivElement>(null);
  const storeSettings = useSettings();

  const handlePrint = useReactToPrint({ contentRef: receiptRef });

  const allProducts = usePosEntityRecords<any>('products');
  const products = useMemo(() => {
    if (selectedCategory === 'all') return allProducts;
    const categoryId = parseInt(selectedCategory, 10);
    return Number.isNaN(categoryId) ? [] : allProducts.filter((product) => product.categoryId === categoryId);
  }, [allProducts, selectedCategory]);

  const categories = usePosEntityRecords<any>('categories');
  const customers = usePosEntityRecords<any>('customers');
  const allOffers = usePosEntityRecords<any>('offers');
  const currentShift = usePosFirstRecordWhereEquals<any>('shifts', 'status', 'open');
  const myOrders = usePosRecordsWhereEquals<any>('orders', 'createdBy', user?.name || '')
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  const openSession = usePosFirstRecordWhereEquals<any>('stocktakingSessions', 'status', 'open');

  const now = new Date();
  const offers = allOffers.filter(
    (o) => o.isActive && new Date(o.startDate) <= now && new Date(o.endDate) >= now
  );

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const scanGateRef = useRef(createBarcodeScanGate(1400));
  const mobileScannerInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let isMounted = true;

    const stopScanner = async () => {
      const activeScanner = scannerRef.current;
      if (!activeScanner) return;
      scannerRef.current = null;
      try {
        if (activeScanner.isScanning) await activeScanner.stop();
        await activeScanner.clear();
      } catch (err) {
        console.error('Error stopping scanner:', err);
      }
    };

    if (isScannerOpen) {
      const startScanner = async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (!isMounted || !isScannerOpen) return;

        const element = document.getElementById('mobile-reader');
        if (!element) return;

        try {
          const cameraGranted = await ensureAndroidCameraPermission();
          if (!cameraGranted) {
            toast.error(lang === 'en' ? 'Camera permission is required' : 'يجب السماح للتطبيق باستخدام الكاميرا');
            if (isMounted) setIsScannerOpen(false);
            return;
          }
          await stopScanner();
          const html5QrCode = new Html5Qrcode('mobile-reader', {
            verbose: false,
            formatsToSupport: PRODUCT_BARCODE_FORMATS,
            experimentalFeatures: { useBarCodeDetectorIfSupported: true },
          } as any);
          scannerRef.current = html5QrCode;

          await html5QrCode.start(
            { facingMode: 'environment' },
            PRODUCT_BARCODE_CAMERA_CONFIG as any,
                        (decodedText) => {
              const barcode = normalizeBarcodeValue(decodedText);
              if (!scanGateRef.current(barcode)) return;
              const match = findProductBarcodeMatch(allProducts, barcode);
              if (match) {
                playScanSound();
                if (scannerMode === 'stocktaking') {
                  setScannedProduct(match.product);
                  setActualQuantity('');
                  setIsStocktakingModalOpen(true);
                  setIsScannerOpen(false);
                } else {
                  addToCart(match.product, match.matchedUnit?.name || match.product.unit || 'piece');
                }
              } else {
                playErrorSound();
                toast.error(lang === 'en' ? 'Product not found' : 'المنتج غير موجود');
              }
            },
            () => {}
          );
        } catch (err) {
          console.error('Error starting scanner:', err);
          if (isMounted) {
            toast.error(lang === 'en' ? 'Camera access denied' : 'تعذر الوصول للكاميرا');
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
  }, [isScannerOpen, allProducts, scannerMode, lang]);

  const addToCart = (product: Product, unit: string = 'piece') => {
    if (product.isActive === 0) {
      toast.error('هذا الصنف موقوف ولا يمكن بيعه');
      return;
    }
    setCart((prev) => {
      const existing = prev.find((item) => item.product.id === product.id && item.unit === unit);
      if (existing) {
        return prev.map((item) =>
          item.product.id === product.id && item.unit === unit ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...prev, { product, quantity: 1, unit }];
    });
    toast.success(`${product.name} تمت إضافته للسلة`, { duration: 1000 });
    playSuccessSound();
  };

  const handleSaveStocktakingEntry = async () => {
    if (!openSession) return toast.error('لا توجد جلسة جرد مفتوحة');
    if (!scannedProduct) return;
    if (!actualQuantity || isNaN(Number(actualQuantity))) return toast.error('يرجى إدخال كمية صحيحة');

    try {
      const entryId = uuidv4();
      const entry: StocktakingEntry = {
        id: entryId,
        sessionId: openSession.id!,
        productId: scannedProduct.id!,
        productName: scannedProduct.name,
        barcode: scannedProduct.barcode,
        systemQuantity: scannedProduct.stockQuantity,
        actualQuantity: Number(actualQuantity),
        scannedBy: user?.name || 'System',
        scannedAt: new Date().toISOString(),
        syncStatus: 'pending',
      };

      await dispatchOperation('entity_upsert', { table: 'stocktakingEntries', record: entry }, user?.branchId);
      playSuccessSound();
      toast.success(`تم جرد ${scannedProduct.name} بنجاح`);
      setIsStocktakingModalOpen(false);
      setScannedProduct(null);
      setTimeout(() => setIsScannerOpen(true), 500);
    } catch (error) {
      console.error(error);
      toast.error('فشل حفظ بيانات الجرد');
    }
  };

  const confirmCloseSession = async () => {
    if (!openSession) return;
    try {
      await dispatchOperation(
        'entity_upsert',
        { table: 'stocktakingSessions', record: { ...openSession, status: 'closed' } },
        user?.branchId
      );
      toast.success('تم إغلاق جلسة الجرد');
      setScannerMode('sales');
    } catch (error) {
      console.error(error);
      toast.error('فشل إغلاق الجلسة');
    } finally {
      setIsCloseSessionModalOpen(false);
    }
  };

  const updateQuantity = (productId: number, unit: string, delta: number) => {
    setCart((prev) =>
      prev.map((item) => {
        if (item.product.id === productId && item.unit === unit) {
          const newQty = Math.max(1, item.quantity + delta);
          return { ...item, quantity: newQty };
        }
        return item;
      })
    );
  };

  const removeFromCart = (productId: number, unit: string) => {
    setCart((prev) => prev.filter((item) => !(item.product.id === productId && item.unit === unit)));
    toast.success(lang === 'en' ? 'Item removed' : 'تم حذف المنتج');
  };

  const clearCart = () => {
    setCart([]);
    setIsCheckoutOpen(false);
    toast.success(lang === 'en' ? 'Cart cleared' : 'تم إلغاء الفاتورة');
  };

  const getMobileItemPrice = (item: { product: Product; unit: string }) => {
    const unit = getProductUnitOptions(item.product).find((option) => option.name.toLocaleLowerCase() === item.unit.toLocaleLowerCase());
    return Number(unit?.sellingPrice ?? item.product.sellingPrice) || 0;
  };

  const handleMobileBarcodeInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' && e.key !== 'Tab') return;
    e.preventDefault();
    const input = e.currentTarget;
    const barcode = normalizeBarcodeValue(input.value);
    input.value = '';
    if (!scanGateRef.current(barcode)) return;
    const match = findProductBarcodeMatch(allProducts, barcode);
    if (!match) {
      playErrorSound();
      toast.error(lang === 'en' ? 'Product not found' : 'المنتج غير موجود');
      return;
    }
    if (scannerMode === 'stocktaking') {
      setScannedProduct(match.product);
      setActualQuantity('');
      setIsStocktakingModalOpen(true);
    } else {
      addToCart(match.product, match.matchedUnit?.name || match.product.unit || 'piece');
    }
  };

  const grossSubtotal = cart.reduce((sum, item) => sum + getMobileItemPrice(item) * item.quantity, 0);

  const offerDiscount = useMemo(() => {
    let totalOfferDiscount = 0;
    offers.forEach((offer) => {
      if (offer.minPurchaseAmount && grossSubtotal < offer.minPurchaseAmount) return;
      if (offer.type === 'discount') {
        if (offer.applicableProducts && offer.applicableProducts.length > 0) {
          cart.forEach((item) => {
            if (offer.applicableProducts!.includes(item.product.id!)) {
              totalOfferDiscount += getMobileItemPrice(item) * item.quantity * (offer.value / 100);
            }
          });
        } else {
          totalOfferDiscount += grossSubtotal * (offer.value / 100);
        }
      } else if (offer.type === 'bogo') {
        if (offer.applicableProducts && offer.applicableProducts.length > 0) {
          cart.forEach((item) => {
            if (offer.applicableProducts!.includes(item.product.id!)) {
              const freeItems = Math.floor(item.quantity / 2);
              totalOfferDiscount += freeItems * getMobileItemPrice(item);
            }
          });
        }
      } else if (offer.type === 'bundle') {
        if (offer.applicableProducts && offer.applicableProducts.length > 0) {
          const hasAllProducts = offer.applicableProducts.every((productId) =>
            cart.some((item) => item.product.id === productId)
          );
          if (hasAllProducts) totalOfferDiscount += offer.value;
        }
      }
    });
    return roundMoney(totalOfferDiscount);
  }, [cart, offers, grossSubtotal]);

  const taxSummary = useMemo(
    () =>
      calculateVatInclusiveOrder({
        items: cart.map((item) => ({
          quantity: item.quantity,
          unitPrice: getMobileItemPrice(item),
          discount: 0,
          discountType: 'percentage',
          vatRate: storeSettings.taxRate,
        })),
        offerDiscountGross: offerDiscount,
        defaultTaxRate: storeSettings.taxRate,
      }),
    [cart, offerDiscount, storeSettings.taxRate]
  );

  const handleCheckout = async (paymentMethod: 'cash' | 'card' | 'credit') => {
    if (cart.length === 0) return toast.error(lang === 'en' ? 'Cart is empty' : 'السلة فارغة');
    if (paymentMethod === 'credit' && !selectedCustomer) {
      return toast.error(lang === 'en' ? 'Select a customer for credit sale' : 'يجب اختيار عميل للبيع الآجل');
    }

    try {
      const orderId = uuidv4();
      const receiptNumber = `MOB-${Date.now()}`;
      const nowStr = new Date().toISOString();
      const grandTotal = taxSummary.netAmount;
      const pointsEarned = selectedCustomer ? Math.floor(grandTotal / 10) : 0;

      const newOrder: Order = {
        id: orderId,
        receiptNumber,
        totalAmount: taxSummary.totalAmountExclTax,
        discountAmount: taxSummary.discountAmountExclTax,
        taxAmount: taxSummary.taxAmount,
        netAmount: grandTotal,
        paidAmount: paymentMethod === 'credit' ? 0 : grandTotal,
        returnedAmount: 0,
        paymentMethod,
        customerId: selectedCustomer?.id,
        customerName: selectedCustomer?.name,
        shiftId: currentShift?.id,
        branchId: user?.branchId,
        tableNumber: storeSettings.businessType === 'restaurant' ? tableNumber : undefined,
        orderType: storeSettings.businessType === 'restaurant' ? orderType : undefined,
        status: 'completed',
        createdAt: nowStr,
        updatedAt: nowStr,
        createdBy: user?.name || 'System',
        syncStatus: 'pending',
      };

      const orderItemsPayload: OrderItem[] = cart.map((item, idx) => {
        const unitPrice = getMobileItemPrice(item);
        const factor = resolveProductUnitFactor(item.product, { unit: item.unit });
        const line = taxSummary.lines[idx];
        return {
          orderId,
          productId: item.product.id!,
          productName: item.product.name,
          quantity: item.quantity,
          returnedQuantity: 0,
          unit: item.unit || 'piece',
          conversionFactor: item.product.conversionFactor || 1,
          unitPrice,
          costPriceAtTimeOfSale: roundMoney(Number(item.product.costPrice || 0) * factor),
          discountAmount: line.discountExclTax,
          subTotal: line.subTotalExclTax,
          taxAmount: line.taxAmount,
          total: line.finalGross,
          syncStatus: 'pending',
        };
      });

      const res = await dispatchOperation(
        'sale',
        { order: newOrder, items: orderItemsPayload, pointsEarned, pointsRedeemed: 0 },
        user?.branchId
      );

      toast.success(
        res.synced ? 'تم إتمام الطلب ومزامنته بنجاح' : 'تم حفظ الطلب محلياً وسيتم مزامنته عند توفر الشبكة'
      );
      playSuccessSound();
      setCart([]);
      setSelectedCustomer(null);
      setIsCheckoutOpen(false);
      setCompletedOrder({ order: newOrder, items: orderItemsPayload });
      setActiveTab('invoices');
    } catch (error: any) {
      console.error(error);
      playErrorSound();
      toast.error(error?.message || 'حدث خطأ أثناء إتمام الطلب');
    }
  };

  const filteredProducts = products.filter(
    (p) =>
      p.isActive !== 0 &&
      ((p.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (p.barcode || '').includes(searchTerm))
  );

  const renderSales = () => (
    <div className="flex flex-col h-full">
      <div className="p-4 bg-white sticky top-0 z-10 space-y-3 border-b border-slate-100">
        <div className="relative">
          <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
          <input
            type="text"
            placeholder={lang === 'en' ? 'Search products...' : 'البحث عن منتج...'}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 rounded-xl py-2.5 pr-12 pl-4 focus:ring-2 focus:ring-indigo-500 outline-none text-sm"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1 hide-scrollbar scroll-smooth">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap shrink-0 flex items-center gap-1.5 border ${
              selectedCategory === 'all'
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white text-slate-600 border-slate-200'
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
            <span>{lang === 'en' ? 'All' : 'الكل'}</span>
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(String(cat.id!))}
              className={`px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap shrink-0 border ${
                selectedCategory === String(cat.id)
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-slate-600 border-slate-200'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-24">
        <div className="grid grid-cols-2 gap-3">
          {filteredProducts.map((product) => (
            <div
              key={product.id}
              onClick={() => addToCart(product)}
              className="bg-white p-3 rounded-2xl border border-slate-200 active:scale-95 transition-transform cursor-pointer"
            >
              <div className="w-full aspect-square bg-slate-50 rounded-xl mb-2.5 flex items-center justify-center overflow-hidden">
                {product.imageUrl ? (
                  <img src={product.imageUrl} alt={product.name} className="w-full h-full object-cover" />
                ) : (
                  <Package className="w-8 h-8 text-slate-300" />
                )}
              </div>
              <h3 className="text-sm font-bold text-slate-900 truncate">{product.name}</h3>
              <p className="text-indigo-600 font-black mt-1 tabular-nums">
                {product.sellingPrice.toFixed(2)} {storeSettings.currency}
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
                {lang === 'en' ? 'Stock' : 'مخزون'}: {product.stockQuantity}
              </p>
            </div>
          ))}
        </div>
      </div>

      {cart.length > 0 && (
        <div className="fixed bottom-20 left-0 right-0 px-4 z-20">
          <div className="max-w-md mx-auto bg-indigo-600 text-white p-4 rounded-2xl shadow-xl flex items-center justify-between">
            <div>
              <p className="text-[11px] opacity-80">{lang === 'en' ? 'Cart Total (Incl. VAT)' : 'الإجمالي شامل الضريبة'}</p>
              <p className="text-lg font-black tabular-nums">
                {taxSummary.netAmount.toFixed(2)} {storeSettings.currency}
              </p>
            </div>
            <button
              onClick={() => setIsCheckoutOpen(true)}
              className="bg-white text-indigo-600 px-5 py-2 rounded-xl font-bold flex items-center gap-2 text-sm whitespace-nowrap shrink-0"
            >
              <span>{lang === 'en' ? 'Checkout' : 'إتمام الطلب'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const renderInventory = () => (
    <div className="flex flex-col h-full">
      <div className="p-4 bg-white sticky top-0 z-10 space-y-3 border-b border-slate-100">
        <h2 className="text-lg font-bold">{lang === 'en' ? 'Inventory' : 'المخزون'}</h2>
        <div className="relative">
          <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
          <input
            type="text"
            placeholder={lang === 'en' ? 'Search inventory...' : 'البحث في المخزون...'}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 rounded-xl py-2.5 pr-12 pl-4 focus:ring-2 focus:ring-indigo-500 outline-none text-sm"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-24 space-y-2.5">
        {filteredProducts.map((product) => (
          <div key={product.id} className="bg-white p-3.5 rounded-2xl border border-slate-200 flex items-center gap-3">
            <div className="w-11 h-11 bg-slate-50 rounded-xl flex items-center justify-center shrink-0">
              <Package className="w-5 h-5 text-slate-400" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-bold text-slate-900 truncate text-sm">{product.name}</h4>
              <p className="text-xs text-slate-500 font-mono">{product.barcode}</p>
            </div>
            <div className="text-left tabular-nums">
              <p className="text-sm font-black text-indigo-600">
                {product.stockQuantity} {product.unit || 'حبة'}
              </p>
              <p className="text-[11px] text-slate-400">
                {product.sellingPrice.toFixed(2)} {storeSettings.currency}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderScanner = () => (
    <div className="flex flex-col h-full p-4 bg-slate-900">
      <div className="flex justify-between items-center mb-6 text-white">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Scan className="w-5 h-5" />
          {lang === 'en' ? 'Barcode Scanner' : 'الماسح الضوئي'}
        </h2>
        <button onClick={() => setIsScannerOpen(!isScannerOpen)} className="p-2 bg-white/10 rounded-xl">
          {isScannerOpen ? <X className="w-5 h-5" /> : <Camera className="w-5 h-5" />}
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center relative">
        <div className="w-full aspect-square max-w-sm bg-black rounded-3xl overflow-hidden border-4 border-indigo-500/30 relative">
          <div id="mobile-reader" className="w-full h-full" />
          {!isScannerOpen && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white/60 space-y-3">
              <Camera className="w-14 h-14 opacity-30" />
              <p className="text-sm">{lang === 'en' ? 'Tap icon to start camera' : 'اضغط على الأيقونة لتشغيل الكاميرا'}</p>
            </div>
          )}
        </div>
        <div className="w-full max-w-sm mt-5">
          <label className="block text-sm text-white/80 mb-2">{lang === 'en' ? 'USB / Bluetooth scanner' : 'الماسح الخارجي USB / Bluetooth'}</label>
          <input
            ref={mobileScannerInputRef}
            type="text"
            inputMode="none"
            autoComplete="off"
            placeholder={lang === 'en' ? 'Scan barcode here...' : 'وجّه الماسح إلى هذا الحقل...'}
            onKeyDown={handleMobileBarcodeInput}
            className="w-full rounded-xl border border-white/20 bg-white px-4 py-3 text-center font-mono text-lg text-slate-900 outline-none focus:ring-2 focus:ring-indigo-400"
          />
        </div>
      </div>
    </div>
  );

  const renderInvoices = () => (
    <div className="flex flex-col h-full">
      <div className="p-4 bg-white sticky top-0 z-10 border-b border-slate-100">
        <h2 className="text-lg font-bold mb-3">{lang === 'en' ? 'My Invoices' : 'فواتيري'}</h2>
        <div className="bg-indigo-50 border border-indigo-200 p-4 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-xs text-indigo-700 font-bold">
              {lang === 'en' ? "Today's Total Sales" : 'إجمالي مبيعات اليوم'}
            </p>
            <p className="text-2xl font-black text-indigo-950 tabular-nums">
              {myOrders
                .filter((o) => o.status !== 'void' && new Date(o.createdAt).toDateString() === new Date().toDateString())
                .reduce((sum, o) => sum + o.netAmount, 0)
                .toFixed(2)}{' '}
              {storeSettings.currency}
            </p>
          </div>
          <div className="bg-white p-3 rounded-xl border border-indigo-100">
            <History className="w-5 h-5 text-indigo-600" />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-24 space-y-2.5">
        {myOrders.map((order) => (
          <div
            key={order.id}
            onClick={async () => {
              const items = await getPosRecordsWhereEquals<any>('orderItems', 'orderId', order.id!);
              setCompletedOrder({ order, items });
            }}
            className="bg-white p-3.5 rounded-2xl border border-slate-200 flex items-center justify-between cursor-pointer hover:border-indigo-300"
          >
            <div>
              <p className="font-bold text-slate-900 font-mono text-sm">{order.receiptNumber}</p>
              <p className="text-xs text-slate-500">{new Date(order.createdAt).toLocaleTimeString('ar-SA')}</p>
            </div>
            <div className="text-left tabular-nums">
              <p className="font-black text-indigo-600 text-sm">
                {order.netAmount.toFixed(2)} {storeSettings.currency}
              </p>
              <span className="text-[11px] font-bold text-slate-600">
                {order.paymentMethod === 'cash'
                  ? 'نقدي'
                  : order.paymentMethod === 'card'
                  ? 'شبكة'
                  : order.paymentMethod === 'mixed'
                  ? 'مختلط'
                  : 'آجل'}
              </span>
            </div>
          </div>
        ))}
        {myOrders.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <History className="w-14 h-14 mb-3 opacity-30" />
            <p className="text-sm">{lang === 'en' ? 'No invoices yet' : 'لا توجد فواتير سابقة'}</p>
          </div>
        )}
      </div>
    </div>
  );

  const renderSettings = () => (
    <div className="flex flex-col h-full p-4 space-y-5 overflow-y-auto pb-24">
      <h2 className="text-lg font-bold">{lang === 'en' ? 'Settings' : 'الإعدادات'}</h2>

      <div className="space-y-4">
        <div className="bg-white p-4 rounded-2xl border border-slate-200">
          <div className="flex items-center gap-2.5 mb-3">
            <Globe className="w-5 h-5 text-indigo-600" />
            <h3 className="font-bold text-sm">{lang === 'en' ? 'Language' : 'اللغة'}</h3>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setLang('ar')}
              className={`py-2.5 rounded-xl text-sm font-bold border ${
                lang === 'ar' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-50 text-slate-600 border-slate-200'
              }`}
            >
              العربية
            </button>
            <button
              type="button"
              onClick={() => setLang('en')}
              className={`py-2.5 rounded-xl text-sm font-bold border ${
                lang === 'en' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-50 text-slate-600 border-slate-200'
              }`}
            >
              English
            </button>
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200">
          <div className="flex items-center gap-2.5 mb-3">
            <Scan className="w-5 h-5 text-indigo-600" />
            <h3 className="font-bold text-sm">{lang === 'en' ? 'Scanner Mode' : 'وضع الماسح'}</h3>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setScannerMode('sales')}
              className={`py-2.5 rounded-xl text-sm font-bold border ${
                scannerMode === 'sales'
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-slate-50 text-slate-600 border-slate-200'
              }`}
            >
              {lang === 'en' ? 'Sales' : 'البيع'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!openSession) {
                  toast.error('لا توجد جلسة جرد مفتوحة حالياً');
                  return;
                }
                setScannerMode('stocktaking');
              }}
              className={`py-2.5 rounded-xl text-sm font-bold border ${
                scannerMode === 'stocktaking'
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-slate-50 text-slate-600 border-slate-200'
              }`}
            >
              {lang === 'en' ? 'Stocktaking' : 'الجرد'}
            </button>
          </div>
          {scannerMode === 'stocktaking' && openSession && (
            <button
              type="button"
              onClick={() => setIsCloseSessionModalOpen(true)}
              className="w-full mt-3 py-2 text-rose-600 text-sm font-bold border border-rose-200 rounded-xl hover:bg-rose-50"
            >
              إغلاق جلسة الجرد
            </button>
          )}
        </div>

        <button
          onClick={logout}
          className="w-full bg-rose-50 text-rose-600 py-3.5 rounded-2xl font-bold flex items-center justify-center gap-2 border border-rose-200"
        >
          <LogOut className="w-5 h-5" />
          <span>{lang === 'en' ? 'Logout' : 'تسجيل الخروج'}</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-[100dvh] flex-col items-center overflow-hidden bg-slate-50" dir={lang === 'en' ? 'ltr' : 'rtl'}>
      <div className="flex flex-col h-full w-full max-w-md bg-white relative overflow-hidden border-x border-slate-200">
        {/* Top Header */}
        <header className="bg-white px-4 py-3.5 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white overflow-hidden">
              {storeSettings.businessLogo ? (
                <img src={storeSettings.businessLogo} alt="Logo" className="w-full h-full object-cover" />
              ) : (
                <ShoppingBag className="w-5 h-5" />
              )}
            </div>
            <div>
              <h1 className="font-extrabold text-base leading-none text-slate-900">
                {storeSettings.businessName || 'POS System'}
              </h1>
              <p className="text-xs text-slate-500 mt-1">{user?.name}</p>
            </div>
          </div>
          <button onClick={() => setActiveTab('settings')} className="p-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-600">
            <SettingsIcon className="w-5 h-5" />
          </button>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 overflow-hidden relative">
          {openSession && !hasAcknowledgedSession && (
            <div className="absolute inset-0 z-[60] bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-6">
              <div className="bg-white w-full rounded-2xl border border-slate-200 p-6 shadow-2xl">
                <div className="w-12 h-12 bg-amber-50 border border-amber-200 text-amber-600 rounded-xl flex items-center justify-center mx-auto mb-4">
                  <ClipboardList className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-center mb-2">جلسة جرد جديدة</h3>
                <p className="text-sm text-slate-500 text-center mb-5">
                  قام المدير بفتح جلسة جرد جديدة. هل تريد الانتقال للإعدادات لتفعيل وضع الجرد؟
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => {
                      setHasAcknowledgedSession(true);
                      setActiveTab('settings');
                    }}
                    className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold text-sm"
                  >
                    الانتقال للإعدادات
                  </button>
                  <button
                    onClick={() => setHasAcknowledgedSession(true)}
                    className="w-full py-2.5 text-slate-500 text-sm font-bold"
                  >
                    تجاهل
                  </button>
                </div>
              </div>
            </div>
          )}

          {isStocktakingModalOpen && scannedProduct && (
            <div className="absolute inset-0 z-[70] bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-6">
              <div className="bg-white w-full rounded-2xl border border-slate-200 p-6 shadow-2xl">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-12 h-12 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-center overflow-hidden">
                    <Package className="w-6 h-6 text-slate-400" />
                  </div>
                  <div>
                    <h3 className="font-bold text-base">{scannedProduct.name}</h3>
                    <p className="text-slate-400 text-xs font-mono">{scannedProduct.barcode}</p>
                  </div>
                </div>
                <div className="space-y-3 mb-5">
                  <label className="block text-xs font-bold text-slate-600">الكمية الفعلية على الرف</label>
                  <input
                    type="number"
                    autoFocus
                    value={actualQuantity}
                    onChange={(e) => setActualQuantity(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-xl font-black text-center outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="0"
                  />
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>الكمية في النظام:</span>
                    <span className="font-bold tabular-nums">{scannedProduct.stockQuantity}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setIsStocktakingModalOpen(false);
                      setScannedProduct(null);
                      setTimeout(() => setIsScannerOpen(true), 500);
                    }}
                    className="flex-1 py-3 bg-slate-100 text-slate-700 rounded-xl font-bold text-sm"
                  >
                    إلغاء
                  </button>
                  <button
                    onClick={handleSaveStocktakingEntry}
                    className="flex-[2] py-3 bg-indigo-600 text-white rounded-xl font-bold text-sm"
                  >
                    تأكيد وحفظ
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'sales' && renderSales()}
          {activeTab === 'inventory' && renderInventory()}
          {activeTab === 'scanner' && renderScanner()}
          {activeTab === 'invoices' && renderInvoices()}
          {activeTab === 'settings' && renderSettings()}
        </main>

        {/* Bottom Navigation */}
        <nav className="bg-white border-t border-slate-200 px-6 py-3 flex items-center justify-between shrink-0 pb-6">
          <button
            onClick={() => setActiveTab('inventory')}
            className={`flex flex-col items-center gap-1 ${activeTab === 'inventory' ? 'text-indigo-600' : 'text-slate-400'}`}
          >
            <LayoutGrid className="w-5 h-5" />
            <span className="text-[11px] font-bold">{lang === 'en' ? 'Stock' : 'المخزون'}</span>
          </button>

          <button
            onClick={() => setActiveTab('scanner')}
            className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center text-white -mt-6 border-4 border-white shadow-md"
          >
            <Scan className="w-6 h-6" />
          </button>

          <button
            onClick={() => setActiveTab('invoices')}
            className={`flex flex-col items-center gap-1 ${activeTab === 'invoices' ? 'text-indigo-600' : 'text-slate-400'}`}
          >
            <History className="w-5 h-5" />
            <span className="text-[11px] font-bold">{lang === 'en' ? 'Invoices' : 'الفواتير'}</span>
          </button>

          <button
            onClick={() => setActiveTab('sales')}
            className={`flex flex-col items-center gap-1 ${activeTab === 'sales' ? 'text-indigo-600' : 'text-slate-400'}`}
          >
            <ShoppingBag className="w-5 h-5" />
            <span className="text-[11px] font-bold">{lang === 'en' ? 'Sell' : 'البيع'}</span>
          </button>
        </nav>

        {/* Checkout Modal Overlay */}
        {isCheckoutOpen && (
          <div className="absolute inset-0 z-50 bg-white flex flex-col">
            <header className="px-4 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button onClick={() => setIsCheckoutOpen(false)} className="p-2 bg-slate-100 rounded-xl">
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <h2 className="text-lg font-bold">{lang === 'en' ? 'Review Order' : 'مراجعة الطلب'}</h2>
              </div>
              <button
                onClick={clearCart}
                className="p-2 text-rose-600 bg-rose-50 rounded-xl hover:bg-rose-100"
                title="إلغاء الفاتورة"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto p-4 space-y-5">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-2">
                  {lang === 'en' ? 'Customer' : 'العميل'}
                </label>
                <select
                  value={selectedCustomer?.id || ''}
                  onChange={(e) => {
                    const customer = customers.find((c) => c.id === Number(e.target.value));
                    setSelectedCustomer(customer || null);
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl py-2.5 px-3 text-sm outline-none"
                >
                  <option value="">{lang === 'en' ? 'Walk-in Customer' : 'عميل نقدي'}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              {storeSettings.businessType === 'restaurant' && (
                <div className="space-y-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <label className="block text-xs font-bold text-slate-700">نوع الطلب</label>
                  <div className="flex gap-2">
                    {(['dine_in', 'takeaway', 'delivery'] as const).map((type) => (
                      <button
                        key={type}
                        onClick={() => setOrderType(type)}
                        className={`flex-1 py-2 rounded-xl text-xs font-bold border ${
                          orderType === type ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200'
                        }`}
                      >
                        {type === 'dine_in' ? 'محلي' : type === 'takeaway' ? 'سفري' : 'توصيل'}
                      </button>
                    ))}
                  </div>
                  {orderType === 'dine_in' && (
                    <input
                      type="text"
                      value={tableNumber}
                      onChange={(e) => setTableNumber(e.target.value)}
                      placeholder="رقم الطاولة (مثال: 5)"
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white outline-none"
                    />
                  )}
                </div>
              )}

              <div className="space-y-2.5">
                {cart.map((item) => (
                  <div
                    key={`${item.product.id}-${item.unit}`}
                    className="flex items-center gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200"
                  >
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-bold truncate">{item.product.name}</h4>
                      <p className="text-xs text-slate-500 tabular-nums">
                        {getMobileItemPrice(item).toFixed(2)} {storeSettings.currency}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-2 bg-white px-2 py-1 rounded-xl border border-slate-200">
                        <button onClick={() => updateQuantity(item.product.id!, item.unit, -1)} className="p-1 text-slate-500">
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="font-bold text-sm w-4 text-center tabular-nums">{item.quantity}</span>
                        <button onClick={() => updateQuantity(item.product.id!, item.unit, 1)} className="p-1 text-indigo-600">
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <button
                        onClick={() => removeFromCart(item.product.id!, item.unit)}
                        className="p-2 text-rose-600 bg-white rounded-xl border border-slate-200"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="bg-indigo-600 rounded-2xl p-5 text-white tabular-nums">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between text-indigo-100">
                    <span>الصافي قبل الضريبة</span>
                    <span>
                      {taxSummary.netSalesExclTax.toFixed(2)} {storeSettings.currency}
                    </span>
                  </div>
                  {taxSummary.grossDiscountTotal > 0 && (
                    <div className="flex justify-between text-indigo-200">
                      <span>الخصم</span>
                      <span>
                        -{taxSummary.grossDiscountTotal.toFixed(2)} {storeSettings.currency}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between text-indigo-100">
                    <span>ضريبة القيمة المضافة ({storeSettings.taxRate}%)</span>
                    <span>
                      {taxSummary.taxAmount.toFixed(2)} {storeSettings.currency}
                    </span>
                  </div>
                  <div className="pt-2.5 border-t border-indigo-500 flex justify-between font-black text-lg">
                    <span>الإجمالي</span>
                    <span>
                      {taxSummary.netAmount.toFixed(2)} {storeSettings.currency}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4 bg-white border-t border-slate-200 grid grid-cols-3 gap-2">
              <button
                onClick={() => handleCheckout('cash')}
                className="flex flex-col items-center justify-center gap-1 bg-emerald-600 text-white py-3 rounded-xl font-bold text-xs"
              >
                <Banknote className="w-4 h-4" />
                <span>نقدي</span>
              </button>
              <button
                onClick={() => handleCheckout('card')}
                className="flex flex-col items-center justify-center gap-1 bg-blue-600 text-white py-3 rounded-xl font-bold text-xs"
              >
                <CreditCard className="w-4 h-4" />
                <span>شبكة</span>
              </button>
              <button
                onClick={() => handleCheckout('credit')}
                className="flex flex-col items-center justify-center gap-1 bg-amber-500 text-white py-3 rounded-xl font-bold text-xs"
              >
                <Users className="w-4 h-4" />
                <span>آجل</span>
              </button>
            </div>
          </div>
        )}

        {/* Receipt Print Modal */}
        {completedOrder && (
          <div className="absolute inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full overflow-hidden flex flex-col max-h-[90vh]">
              <div className="flex justify-between items-center p-3.5 border-b border-slate-200 bg-slate-50">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <ReceiptIcon className="w-4 h-4 text-indigo-600" />
                  <span>إيصال المبيعات</span>
                </h3>
                <button onClick={() => setCompletedOrder(null)} className="text-slate-400 hover:text-slate-600">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-3 bg-slate-100 flex justify-center">
                <div className="bg-white border border-slate-200">
                  <ReceiptComponent
                    ref={receiptRef}
                    order={completedOrder.order}
                    items={completedOrder.items}
                    settings={storeSettings}
                  />
                </div>
              </div>
              <div className="p-3.5 border-t border-slate-200 bg-white grid grid-cols-2 gap-2">
                <button
                  onClick={() => setCompletedOrder(null)}
                  className="py-2.5 rounded-xl font-bold text-sm text-slate-700 bg-slate-100"
                >
                  إغلاق
                </button>
                <button
                  onClick={() => handlePrint()}
                  className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-bold text-sm text-white bg-indigo-600"
                >
                  <Printer className="w-4 h-4" />
                  <span>طباعة</span>
                </button>
              </div>
            </div>
          </div>
        )}

        <ConfirmationModal
          isOpen={isCloseSessionModalOpen}
          title="إغلاق جلسة الجرد"
          message="هل أنت متأكد من إغلاق جلسة الجرد الحالية؟"
          confirmLabel="إغلاق الجلسة"
          variant="danger"
          onConfirm={confirmCloseSession}
          onCancel={() => setIsCloseSessionModalOpen(false)}
        />
      </div>
    </div>
  );
};

export default MobileSales;
