import { useState, useEffect, useRef, useMemo } from 'react';
import { Capacitor } from '@capacitor/core';
import { getPosRecord, getPosRecords, getPosRecordsWhereEquals } from '../services/posDataAccess';
import { usePosEntityRecords } from '../hooks/usePosEntityRecords';
import type { Product, Category, ProductUnit, ServiceRecipe } from '../db/db';
import { useInventoryStore } from '../store/useInventoryStore';
import { Plus, Search, Edit, Trash2, Package, X, Download, Upload, RefreshCcw, Tags, ScanLine, Printer, Image as ImageIcon, Camera, History, Layers } from 'lucide-react';
import { toast } from 'react-hot-toast';
import Barcode from 'react-barcode';
import { useReactToPrint } from 'react-to-print';
import { Html5Qrcode } from 'html5-qrcode';
import { PRODUCT_BARCODE_FORMATS, createBarcodeScanGate, normalizeBarcodeValue, attachBarcodeKeyboardListener, optimizeBarcodeCamera } from '../utils/barcodeScanner';
import { startProductBarcodeCapture, type ProductBarcodeCaptureSession } from '../utils/productBarcodeCapture';
import { useSettings } from '../hooks/useSettings';
import { logAction } from '../services/auditService';
import { useAuth } from '../context/AuthContext';
import { dispatchOperation } from '../services/operationService';
import { formatMoney, formatQty, roundQty } from '../utils/format';
import { generateUUID } from '../utils/uuid';
import ConfirmationModal from '../components/ConfirmationModal';
import { ItemCardModal } from '../components/ItemCardModal';
import ProductPriceManager from '../components/ProductPriceManager';
import { getBaseUnitDimension } from '../utils/standardUnits.js';
import { findProductBarcodeMatch } from '../utils/productUnits';
import { buildProductPricingAnchors, buildProductUnitFxAnchors } from '../utils/exchangePricing';
import { compressProductImage } from '../utils/productImage';

export default function Inventory() {
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isPriceManagerOpen, setIsPriceManagerOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [itemCardProduct, setItemCardProduct] = useState<Product | null>(null);
  const [showLowStockOnly, setShowLowStockOnly] = useState(false);
  const [activeTab, setActiveTab] = useState<'products' | 'categories'>('products');
  const { user } = useAuth();
  
  const hasPermission = (permission: string) => {
    return user?.role === 'admin' || user?.permissions?.includes(permission);
  };
  
  // Barcode Scanner State (Unified)
  const [isScannerModalOpen, setIsScannerModalOpen] = useState(false);
  const scannerRef = useRef<ProductBarcodeCaptureSession | null>(null);
  const mainSearchInputRef = useRef<HTMLInputElement>(null);
  const deviceInputRef = useRef<HTMLInputElement>(null);
  const isSavingProductRef = useRef(false);
  const cameraScanGateRef = useRef(createBarcodeScanGate(2200));
  const deviceScanGateRef = useRef(createBarcodeScanGate(300));
  const isHandlingBarcodeRef = useRef(false);
  const barcodeScanCallbackRef = useRef<(barcode: string) => void>(() => {});

  // Category Form State
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [categoryFormData, setCategoryFormData] = useState({
    name: '',
    color: 'bg-indigo-500'
  });

  // Confirmation modal state
  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    variant: 'primary' | 'danger';
    action: (() => Promise<void> | void) | null;
  }>({
    isOpen: false,
    title: '',
    message: '',
    confirmLabel: 'تأكيد',
    variant: 'primary',
    action: null,
  });

  const makeTempNumericId = () => Date.now() * 1000 + Math.floor(Math.random() * 900);
  
  // Data State using Dexie Live Queries
  const { 
    products: allProducts, 
    categories, 
    isLoaded: isInventoryLoaded,
    getProductByBarcode 
  } = useInventoryStore();

  // Sync store with database changes
  const liveProducts = usePosEntityRecords<any>('products');
  useEffect(() => {
    if (liveProducts) {
      useInventoryStore.getState().updateProducts(liveProducts);
    }
  }, [liveProducts]);

  const suppliers = usePosEntityRecords<any>('suppliers');
  
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  const products = useMemo(() => {
    let filtered = allProducts;
    if (showLowStockOnly) {
      filtered = filtered.filter(p => p.stockQuantity <= (p.minStockLevel || 5));
    }
    if (debouncedSearchQuery) {
      filtered = filtered.filter(p => 
        (p.name || '').toLowerCase().includes(debouncedSearchQuery.toLowerCase()) || 
        (p.barcode || '').includes(debouncedSearchQuery)
      );
    }
    return filtered;
  }, [allProducts, showLowStockOnly, debouncedSearchQuery]);

  const [printingProduct, setPrintingProduct] = useState<Product | null>(null);
  const barcodeRef = useRef<HTMLDivElement>(null);

  const storeSettings = useSettings();
  const existingRecipes = usePosEntityRecords<any>('serviceRecipes');

  const handlePrintBarcode = useReactToPrint({
    contentRef: barcodeRef,
    onAfterPrint: () => setPrintingProduct(null),
  });

  const openPrintBarcode = (product: Product) => {
    setPrintingProduct(product);
    setTimeout(() => {
      handlePrintBarcode();
    }, 100);
  };

  // Form state
  const [formData, setFormData] = useState({
    barcode: '',
    name: '',
    categoryId: 1,
    costPrice: '',
    sellingPrice: '',
    costInUSD: '',
    priceInUSD: '',
    stockQuantity: '',
    minStockLevel: '5',
    vatRate: storeSettings.taxRate.toString(),
    imageUrl: '',
    expiryDate: '',
    batchNumber: '',
    unit: 'piece',
    conversionFactor: '1',
    itemType: 'stock' as 'stock' | 'service' | 'service_with_materials' | 'bundle',
    allowFractions: false,
  });
  const [extraUnits, setExtraUnits] = useState<ProductUnit[]>([]);
  const [recipeRows, setRecipeRows] = useState<Array<{ id?: string; ingredientProductId: number; ingredientName: string; quantity: string; unit: string }>>([]);
  const [removedRecipeIds, setRemovedRecipeIds] = useState<string[]>([]);
  const [costFxLinked, setCostFxLinked] = useState(false);
  const [sellingFxLinked, setSellingFxLinked] = useState(false);

  useEffect(() => {
    if (storeSettings.taxRate !== undefined && !editingProduct && !isModalOpen) {
      setFormData(prev => ({ ...prev, vatRate: storeSettings.taxRate.toString() }));
    }
  }, [storeSettings.taxRate, editingProduct, isModalOpen]);

  const handleOpenModal = (product?: Product, initialBarcode?: string) => {
    setRemovedRecipeIds([]);
    if (product) {
      setEditingProduct(product);
      setCostFxLinked(Number(product.costInUSD || 0) > 0);
      setSellingFxLinked(Number(product.priceInUSD || 0) > 0);
      setFormData({
        barcode: product.barcode,
        name: product.name,
        categoryId: product.categoryId,
        costPrice: product.costPrice.toString(),
        sellingPrice: product.sellingPrice.toString(),
        costInUSD: product.costInUSD?.toString() || '',
        priceInUSD: product.priceInUSD?.toString() || '',
        stockQuantity: product.stockQuantity.toString(),
        minStockLevel: (product.minStockLevel || 5).toString(),
        vatRate: product.vatRate.toString(),
        imageUrl: product.imageUrl || '',
        expiryDate: product.expiryDate || '',
        batchNumber: product.batchNumber || '',
        unit: product.unit || 'piece',
        conversionFactor: (product.conversionFactor || 1).toString(),
        itemType: (product.itemType || 'stock') as any,
        allowFractions: Boolean(product.allowFractions),
      });
      try {
        const parsedUnits = product.unitsJson ? JSON.parse(product.unitsJson) : [];
        setExtraUnits(Array.isArray(parsedUnits) ? parsedUnits : []);
      } catch {
        setExtraUnits([]);
      }
      const prodRecipes = existingRecipes.filter((r) => r.parentProductId === product.id);
      setRecipeRows(
        prodRecipes.map((r) => ({
          id: r.id,
          ingredientProductId: r.ingredientProductId,
          ingredientName: r.ingredientName || allProducts.find((p) => p.id === r.ingredientProductId)?.name || '',
          quantity: String(r.quantity),
          unit: r.unit || 'piece',
        }))
      );
    } else {
      setEditingProduct(null);
      // New products are priced in SDG by default; foreign-currency linkage is opt-in.
      setCostFxLinked(false);
      setSellingFxLinked(false);
      setFormData({
        barcode: initialBarcode || '',
        name: '',
        categoryId: categories.length > 0 ? categories[0].id! : 1,
        costPrice: '',
        sellingPrice: '',
        costInUSD: '',
        priceInUSD: '',
        stockQuantity: '0',
        minStockLevel: '5',
        vatRate: storeSettings.taxRate.toString(),
        imageUrl: '',
        expiryDate: '',
        batchNumber: '',
        unit: 'piece',
        conversionFactor: '1',
        itemType: 'stock',
        allowFractions: false,
      });
      setExtraUnits([]);
      setRecipeRows([]);
    }
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingProduct(null);
  };

  const handleBarcodeScanned = async (rawBarcode: string, source: 'camera' | 'device' = 'device') => {
    const barcode = normalizeBarcodeValue(rawBarcode);
    const acceptScan = source === 'camera' ? cameraScanGateRef.current : deviceScanGateRef.current;
    if (!barcode || isHandlingBarcodeRef.current || !acceptScan(barcode)) return;
    isHandlingBarcodeRef.current = true;
    try {
      const existingProduct = getProductByBarcode(barcode);
      setIsScannerModalOpen(false);
      if (existingProduct) {
        toast.success('تم العثور على المنتج: ' + existingProduct.name);
        handleOpenModal(existingProduct);
      } else {
        const dbProducts = await getPosRecords<Product>('products');
        const dbMatch = findProductBarcodeMatch(dbProducts, barcode);
        if (dbMatch) {
          handleOpenModal(dbMatch.product);
        } else {
          toast.success('منتج جديد، يرجى إكمال البيانات');
          handleOpenModal(undefined, barcode);
        }
      }
    } catch (error) {
      console.error('Barcode lookup failed:', error);
      toast.error('تعذر البحث عن الباركود، حاول مرة أخرى');
      setIsScannerModalOpen(false);
    } finally {
      isHandlingBarcodeRef.current = false;
    }
  };

  const generateBarcode = () => {
    const timestamp = new Date().getTime().toString().slice(-8);
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const newBarcode = `PRD${timestamp}${random}`;
    setFormData(prev => ({ ...prev, barcode: newBarcode }));
  };

  useEffect(() => {
    let isMounted = true;

    const stopScanner = async () => {
      const activeScanner = scannerRef.current;
      if (!activeScanner) return;
      scannerRef.current = null;
      try {
        await activeScanner.stop();
      } catch (err) {
        console.error('Error stopping scanner:', err);
      }
    };

    if (isScannerModalOpen && storeSettings.inventoryScannerType === 'camera') {
      const startScanner = async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        if (!isMounted || !isScannerModalOpen) return;
        
        const element = document.getElementById("inventory-reader");
        if (!element) return;

        try {
          await stopScanner();
          const webScanner = Capacitor.getPlatform() === 'android' ? null : new Html5Qrcode("inventory-reader", {
            verbose: false,
            formatsToSupport: PRODUCT_BARCODE_FORMATS,
            useBarCodeDetectorIfSupported: false,
          } as any);
          
          let lastDecodeDiagnosticAt = 0;
          const session = await startProductBarcodeCapture(
            webScanner,
            (decodedText) => {
              void handleBarcodeScanned(decodedText, 'camera');
            },
            (decodeError) => {
              const now = Date.now();
              if (now - lastDecodeDiagnosticAt >= 8000) {
                lastDecodeDiagnosticAt = now;
                console.debug('Inventory barcode camera is running; no code decoded in recent frames:', decodeError);
                toast('الكاميرا تعمل، لكن لم يُقرأ الرمز بعد. قرّب الملصق وثبّت الهاتف.', { duration: 2200 });
              }
            },
          );
          if (!isMounted) {
            await session.stop();
            return;
          }
          scannerRef.current = session;
          if (session.engine === 'android-mlkit') toast.success('تم تشغيل قارئ الكاميرا الأصلي. وجّه الباركود نحو العدسة.');
          if (webScanner) await optimizeBarcodeCamera(webScanner);
        } catch (err) {
          console.error("Error starting camera scanner:", err);
          if (isMounted) {
            toast.error(err instanceof Error ? err.message : 'تعذر تشغيل الكاميرا. تحقق من الصلاحيات ثم أعد المحاولة.');
            setIsScannerModalOpen(false);
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
  }, [isScannerModalOpen, storeSettings.inventoryScannerType]);

  useEffect(() => {
    if (isScannerModalOpen && deviceInputRef.current) {
      deviceInputRef.current.focus();
    }
  }, [isScannerModalOpen, storeSettings.inventoryScannerType]);

  barcodeScanCallbackRef.current = (barcode) => {
    void handleBarcodeScanned(barcode, 'device');
  };

  useEffect(() => {
    return attachBarcodeKeyboardListener((barcode) => barcodeScanCallbackRef.current(barcode));
  }, []);

  const handleDeviceScan = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const input = e.currentTarget;
      const barcode = normalizeBarcodeValue(input.value);
      input.value = '';
      if (barcode) await handleBarcodeScanned(barcode);
    }
  };

  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const barcode = normalizeBarcodeValue(mainSearchInputRef.current?.value);
    if (!barcode) return;
    
    // Check if what was entered/scanned is an exact barcode match - optimized lookup
    const dbProducts = await getPosRecords<Product>('products');
    const barcodeMatch = findProductBarcodeMatch(dbProducts, barcode);
    if (barcodeMatch) {
      handleOpenModal(barcodeMatch.product);
      if (mainSearchInputRef.current) {
        mainSearchInputRef.current.value = '';
        setSearchQuery('');
      }
    } else if (/^\d+$/.test(barcode) && barcode.length >= 4) {
      setConfirmState({
        isOpen: true,
        title: 'منتج غير مسجل',
        message: `الباركود (${barcode}) غير مسجل في المخزون. هل تريد إضافة منتج جديد بهذا الرمز؟`,
        confirmLabel: 'إضافة منتج',
        variant: 'primary',
        action: () => {
          handleOpenModal(undefined, barcode);
          if (mainSearchInputRef.current) {
            mainSearchInputRef.current.value = '';
            setSearchQuery('');
          }
        },
      });
    }
  };

  const handleOpenCategoryModal = (category?: Category) => {
    if (category) {
      setEditingCategory(category);
      setCategoryFormData({
        name: category.name,
        color: category.color || 'bg-indigo-500'
      });
    } else {
      setEditingCategory(null);
      setCategoryFormData({
        name: '',
        color: 'bg-indigo-500'
      });
    }
    setIsCategoryModalOpen(true);
  };

  const handleCloseCategoryModal = () => {
    setIsCategoryModalOpen(false);
    setEditingCategory(null);
  };

  const handleCategorySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const now = new Date().toISOString();
      if (editingCategory && editingCategory.id) {
        await dispatchOperation(
          'entity_upsert',
          {
            table: 'categories',
            record: {
              ...editingCategory,
              name: categoryFormData.name,
              color: categoryFormData.color,
              updatedAt: now,
            },
          },
          user?.branchId
        );
        await logAction(user?.name || 'Unknown', 'تحديث تصنيف', 'category', `تم تحديث التصنيف: ${categoryFormData.name}`, 0, 0);
        toast.success('تم تحديث التصنيف بنجاح');
      } else {
        await dispatchOperation(
          'entity_upsert',
          {
            table: 'categories',
            record: {
              id: makeTempNumericId(),
              name: categoryFormData.name,
              color: categoryFormData.color,
              createdAt: now,
              updatedAt: now,
            },
          },
          user?.branchId
        );
        await logAction(user?.name || 'Unknown', 'إضافة تصنيف', 'category', `تمت إضافة التصنيف: ${categoryFormData.name}`, 0, 0);
        toast.success('تمت إضافة التصنيف بنجاح');
      }
      handleCloseCategoryModal();
    } catch (error) {
      console.error(error);
      toast.error('حدث خطأ أثناء حفظ التصنيف');
    }
  };

  const handleDeleteCategory = (id: number) => {
    setConfirmState({
      isOpen: true,
      title: 'حذف التصنيف',
      message: 'هل أنت متأكد من حذف هذا التصنيف؟ سيتم حذف جميع المنتجات المرتبطة به!',
      confirmLabel: 'حذف نهائي',
      variant: 'danger',
      action: async () => {
        try {
          const category = await getPosRecord<any>('categories', id);
          const productsToDelete = await getPosRecordsWhereEquals<any>('products', 'categoryId', id);
          for (const p of productsToDelete) {
            if (p.id !== undefined) {
              await dispatchOperation('entity_delete', { table: 'products', id: p.id }, user?.branchId);
            }
          }
          await dispatchOperation('entity_delete', { table: 'categories', id }, user?.branchId);
          await logAction(user?.name || 'Unknown', 'حذف تصنيف', 'category', `تم حذف التصنيف: ${category?.name || id}`, 0, 0);
          toast.success('تم حذف التصنيف بنجاح');
        } catch (error) {
          console.error(error);
          toast.error('حدث خطأ أثناء حذف التصنيف');
        }
      },
    });
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imageUrl = await compressProductImage(file);
      setFormData((current) => ({ ...current, imageUrl }));
    } catch (error) {
      console.error('Product image processing failed:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر تجهيز صورة المنتج');
    } finally {
      // Allow selecting the same file again after a failed or completed attempt.
      e.target.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingProductRef.current) return;
    isSavingProductRef.current = true;

    try {
      const now = new Date().toISOString();
      const validUnits = extraUnits.filter((u) => u.name.trim() && Number(u.conversionFactor) > 0);
      if (formData.itemType === 'service_with_materials' && !recipeRows.some((row) => Number(row.ingredientProductId) > 0 && Number(row.quantity) > 0)) {
        throw new Error('الخدمة ذات المواد تحتاج إلى إضافة مادة خام واحدة على الأقل قبل الحفظ');
      }
      const currentFxRate = Number(storeSettings.exchangeRate || 0);
      const hasLinkedPrice = sellingFxLinked || (costFxLinked && formData.itemType !== 'service' && formData.itemType !== 'service_with_materials');
      if (hasLinkedPrice && currentFxRate <= 0) {
        throw new Error('يجب تسجيل سعر صرف الدولار مقابل الجنيه السوداني قبل ربط أسعار المنتجات به، أو أوقف الربط لحفظ سعر ثابت بالجنيه');
      }
      const pricingAnchors = buildProductPricingAnchors({
        costPrice: Number(formData.costPrice) || 0,
        sellingPrice: Number(formData.sellingPrice) || 0,
        costLinked: costFxLinked && formData.itemType !== 'service' && formData.itemType !== 'service_with_materials',
        sellingLinked: sellingFxLinked,
        exchangeRate: currentFxRate,
      });
      const productData: any = {
        barcode: formData.barcode,
        name: formData.name,
        categoryId: Number(formData.categoryId),
        costPrice: Number(formData.costPrice) || 0,
        sellingPrice: Number(formData.sellingPrice) || 0,
        // SDG is the entered/display currency; retain the foreign-currency anchors for future approved FX changes.
        ...pricingAnchors,
        stockQuantity: formData.itemType === 'service' || formData.itemType === 'service_with_materials' ? 0 : roundQty(Number(formData.stockQuantity) || 0),
        minStockLevel: Number(formData.minStockLevel) || 0,
        vatRate: Number(formData.vatRate) || 0,
        imageUrl: formData.imageUrl,
        expiryDate: formData.expiryDate || undefined,
        batchNumber: formData.batchNumber || undefined,
        unit: formData.unit || 'piece',
        baseUnitCode: getBaseUnitDimension(formData.unit),
        conversionFactor: editingProduct?.conversionFactor || 1,
        itemType: formData.itemType,
        allowFractions: formData.allowFractions,
        unitsJson: JSON.stringify(buildProductUnitFxAnchors(validUnits, sellingFxLinked, currentFxRate)),
        branchId: editingProduct?.branchId ?? user?.branchId,
        updatedAt: now,
      };

      let savedParentId = editingProduct?.id;
      if (editingProduct && editingProduct.id) {
        const res = await dispatchOperation(
          'entity_upsert',
          {
            table: 'products',
            allowProductPriceUpdate: true,
            record: {
              ...editingProduct,
              ...productData,
              id: editingProduct.id,
            },
          },
          user?.branchId
        );
        savedParentId = res?.result?.id || editingProduct.id;
        await logAction(user?.name || 'Unknown', 'تحديث منتج', 'product', `تم تحديث المنتج: ${formData.name}`, 0, Number(formData.sellingPrice), formData.name).catch((auditError) => console.warn('Product saved; audit log will be retried separately:', auditError));
      } else {
        const tempId = makeTempNumericId();
        const res = await dispatchOperation(
          'entity_upsert',
          {
            table: 'products',
            allowProductPriceUpdate: true,
            record: {
              ...productData,
              id: tempId,
              createdAt: now,
            },
          },
          user?.branchId
        );
        savedParentId = res?.result?.id || tempId;
        await logAction(user?.name || 'Unknown', 'إضافة منتج', 'product', `تمت إضافة المنتج: ${formData.name}`, 0, Number(formData.sellingPrice), formData.name).catch((auditError) => console.warn('Product saved; audit log will be retried separately:', auditError));
      }

      // Re-read the full authoritative catalog after the write. This avoids
      // stale in-memory lists and primary-key type mismatches hiding a committed product.
      const persistedProducts = await getPosRecords<Product>('products');
      const persistedProduct = persistedProducts.find(
        (item) => String(item.id) === String(savedParentId)
      );
      if (!persistedProduct) {
        throw new Error(`تم إرسال حفظ المنتج لكن لم يظهر في قراءة قاعدة البيانات: ${String(savedParentId)}`);
      }
      useInventoryStore.getState().updateProducts(persistedProducts);

      // Persist service recipes if applicable
      if (savedParentId) {
        for (const delId of removedRecipeIds) {
          await dispatchOperation('entity_delete', { table: 'serviceRecipes', id: delId }, user?.branchId);
        }
        if (formData.itemType === 'service_with_materials' || formData.itemType === 'bundle') {
          for (const row of recipeRows) {
            const qty = roundQty(Number(row.quantity || 0));
            if (!row.ingredientProductId || qty <= 0) continue;
            const ingProd = allProducts.find((p) => p.id === Number(row.ingredientProductId));
            const recPayload: ServiceRecipe = {
              id: row.id || generateUUID(),
              parentProductId: Number(savedParentId),
              ingredientProductId: Number(row.ingredientProductId),
              ingredientName: ingProd?.name || row.ingredientName,
              quantity: qty,
              unit: row.unit || ingProd?.unit || 'piece',
              syncStatus: 'pending',
              updatedAt: now,
            };
            await dispatchOperation(
              'entity_upsert',
              { table: 'serviceRecipes', record: recPayload },
              user?.branchId
            );
          }
        }
      }

      toast.success(editingProduct ? 'تم تحديث المنتج بنجاح' : 'تمت إضافة المنتج بنجاح');
      handleCloseModal();
    } catch (error) {
      console.error('Product save failed:', error);
      toast.error(error instanceof Error ? error.message : 'حدث خطأ أثناء حفظ المنتج');
    } finally {
      isSavingProductRef.current = false;
    }
  };

  const handleDelete = (id: number) => {
    setConfirmState({
      isOpen: true,
      title: 'حذف المنتج',
      message: 'هل أنت متأكد من حذف هذا المنتج؟',
      confirmLabel: 'حذف المنتج',
      variant: 'danger',
      action: async () => {
        try {
          const product = await getPosRecord<any>('products', id);
          await dispatchOperation('entity_delete', { table: 'products', id }, user?.branchId);
          await logAction(user?.name || 'Unknown', 'حذف منتج', 'product', `تم حذف المنتج: ${product?.name || id}`, 0, 0, product?.name);
          toast.success('تم حذف المنتج بنجاح');
        } catch (error) {
          console.error(error);
          toast.error('حدث خطأ أثناء حذف المنتج');
        }
      },
    });
  };

  const handleExportCSV = () => {
    const headers = ['الباركود', 'اسم المنتج', 'التكلفة', 'سعر البيع', 'الكمية', 'نسبة الضريبة'];
    const csvContent = [
      headers.join(','),
      ...products.map(p => 
        [p.barcode, `"${p.name}"`, p.costPrice, p.sellingPrice, p.stockQuantity, p.vatRate].join(',')
      )
    ].join('\n');

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `inventory_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleImportCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;
        // Remove BOM if present
        const cleanText = text.replace(/^\uFEFF/, '');
        const lines = cleanText.split('\n').filter(line => line.trim() !== '');
        
        if (lines.length <= 1) {
          toast.error('الملف فارغ أو لا يحتوي على بيانات');
          return;
        }

        const newProducts: Product[] = [];
        const defaultCategory = categories.length > 0 ? categories[0].id! : 1;

        // Skip header row
        for (let i = 1; i < lines.length; i++) {
          // Robust CSV parser that handles quoted fields with commas
          const row: string[] = [];
          let currentField = '';
          let inQuotes = false;
          const line = lines[i];
          
          for (let j = 0; j < line.length; j++) {
            const char = line[j];
            if (char === '"') {
              inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
              row.push(currentField.trim());
              currentField = '';
            } else {
              currentField += char;
            }
          }
          row.push(currentField.trim());

          if (row.length >= 5) {
            const barcode = row[0].replace(/^"|"$/g, '').trim();
            const name = row[1].replace(/^"|"$/g, '').trim();
            const costPrice = parseFloat(row[2].replace(/^"|"$/g, ''));
            const sellingPrice = parseFloat(row[3].replace(/^"|"$/g, ''));
            const stockQuantity = parseInt(row[4].replace(/^"|"$/g, ''), 10);
            const vatRate = row.length >= 6 ? parseFloat(row[5].replace(/^"|"$/g, '')) : storeSettings.taxRate;

            if (barcode && name && !isNaN(costPrice) && !isNaN(sellingPrice) && !isNaN(stockQuantity)) {
              // Check if barcode already exists
              const existing = products.find(p => p.barcode === barcode);
              if (!existing) {
                newProducts.push({
                  barcode,
                  name,
                  categoryId: defaultCategory,
                  costPrice,
                  sellingPrice,
                  stockQuantity,
                  vatRate,
                  updatedAt: new Date().toISOString()
                } as Product);
              }
            }
          }
        }

        if (newProducts.length > 0) {
          const baseTs = Date.now() * 1000;
          for (let idx = 0; idx < newProducts.length; idx++) {
            const np = newProducts[idx];
            await dispatchOperation(
              'entity_upsert',
              {
                table: 'products',
                record: {
                  ...np,
                  id: baseTs + idx,
                  minStockLevel: 5,
                  unit: 'piece',
                  conversionFactor: 1,
                  branchId: user?.branchId,
                  createdAt: np.updatedAt,
                },
              },
              user?.branchId
            );
          }
          toast.success(`تم استيراد ${newProducts.length} منتج بنجاح`);
        } else {
          toast.error('لم يتم العثور على منتجات جديدة صالحة للاستيراد');
        }
      } catch (error) {
        console.error('Error importing CSV:', error);
        toast.error('حدث خطأ أثناء استيراد الملف');
      }
      // Reset file input
      if (e.target) e.target.value = '';
    };
    reader.readAsText(file);
  };

  const totalCostValue = products.reduce((sum, p) => sum + (p.itemType === 'service' ? 0 : p.costPrice * p.stockQuantity), 0);
  const totalRetailValue = products.reduce((sum, p) => sum + (p.itemType === 'service' ? 0 : p.sellingPrice * p.stockQuantity), 0);
  const lowStockCount = products.filter(p => (p.itemType || 'stock') === 'stock' && p.stockQuantity <= (p.minStockLevel || 5)).length;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-[var(--app-bg)] p-3 sm:p-6" dir="rtl">
      <div className="mb-4 flex shrink-0 flex-col items-stretch justify-between gap-3 sm:mb-6 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">إدارة المخزون</h2>
          <p className="text-gray-500 text-sm mt-1">إدارة المنتجات، التصنيفات، والأسعار</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {activeTab === 'products' ? (
            <>
              <label className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-colors shadow-sm cursor-pointer">
                <Upload className="w-5 h-5" />
                استيراد CSV
                <input 
                  type="file" 
                  accept=".csv" 
                  className="hidden" 
                  onChange={handleImportCSV} 
                />
              </label>
              <button 
                onClick={handleExportCSV}
                className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-colors shadow-sm"
              >
                <Download className="w-5 h-5" />
                تصدير CSV
              </button>
              {hasPermission('add_product') && (
                <>
                  <button 
                    onClick={() => setIsScannerModalOpen(true)}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-colors shadow-sm"
                  >
                    <ScanLine className="w-5 h-5" />
                    إضافة عبر الباركود
                  </button>
                  <button 
                    onClick={() => handleOpenModal()}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-colors shadow-sm"
                  >
                    <Plus className="w-5 h-5" />
                    إضافة منتج جديد
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              {hasPermission('manage_categories') && (
                <button 
                  onClick={() => handleOpenCategoryModal()}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-colors shadow-sm"
                >
                  <Plus className="w-5 h-5" />
                  إضافة تصنيف جديد
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex shrink-0 gap-2 overflow-x-auto border-b border-gray-200 pb-2 sm:mb-6">
        <button
          onClick={() => setActiveTab('products')}
          className={`px-6 py-2.5 rounded-xl font-bold text-sm transition-colors flex items-center gap-2 ${
            activeTab === 'products' 
              ? 'bg-indigo-50 text-indigo-700' 
              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
          }`}
        >
          <Package className="w-5 h-5" />
          المنتجات
        </button>
        <button
          onClick={() => setActiveTab('categories')}
          className={`px-6 py-2.5 rounded-xl font-bold text-sm transition-colors flex items-center gap-2 ${
            activeTab === 'categories' 
              ? 'bg-indigo-50 text-indigo-700' 
              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
          }`}
        >
          <Tags className="w-5 h-5" />
          التصنيفات
        </button>
      </div>

      {activeTab === 'products' && (
        <>
        <div className="mb-4 grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:mb-6 lg:grid-cols-3 lg:gap-4">
        <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm">
          <p className="text-gray-500 text-sm mb-1">إجمالي قيمة المخزون (تكلفة)</p>
          <p className="text-xl font-bold text-gray-900 tabular-nums">{formatMoney(totalCostValue, storeSettings.currency, storeSettings.currencyDecimals)}</p>
        </div>
        <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm">
          <p className="text-gray-500 text-sm mb-1">إجمالي قيمة المخزون (بيع)</p>
          <p className="text-xl font-bold text-emerald-600 tabular-nums">{formatMoney(totalRetailValue, storeSettings.currency, storeSettings.currencyDecimals)}</p>
        </div>
        <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm">
          <p className="text-gray-500 text-sm mb-1">منتجات تحت حد الطلب</p>
          <p className={`text-xl font-bold ${lowStockCount > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{lowStockCount} منتج</p>
        </div>
      </div>

      <div className="flex min-h-[24rem] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        {/* Toolbar */}
        <div className="p-4 border-b border-gray-200 flex flex-col sm:flex-row gap-4 shrink-0 bg-gray-50/50">
          <form onSubmit={handleSearchSubmit} className="relative flex-1 max-w-md">
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="text"
              ref={mainSearchInputRef}
              defaultValue={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus={storeSettings.inventoryScannerType === 'usb'}
              className="block w-full pl-3 pr-10 py-2 border border-gray-300 rounded-lg leading-5 bg-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              placeholder="بحث برقم الباركود أو اسم المنتج..."
            />
          </form>
          <div className="flex flex-wrap items-center gap-2">
            {(user?.role === 'admin' || hasPermission('manage_inventory')) && (
              <button type="button" onClick={() => setIsPriceManagerOpen(true)}
                className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-700 hover:bg-indigo-100">
                إدارة أسعار البيع
              </button>
            )}
            <label className="flex items-center cursor-pointer">
              <div className="relative">
                <input 
                  type="checkbox" 
                  className="sr-only" 
                  checked={showLowStockOnly}
                  onChange={(e) => setShowLowStockOnly(e.target.checked)}
                />
                <div className={`block w-10 h-6 rounded-full transition-colors ${showLowStockOnly ? 'bg-indigo-600' : 'bg-gray-300'}`}></div>
                <div className={`dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${showLowStockOnly ? 'transform -translate-x-4' : ''}`}></div>
              </div>
              <div className="mr-3 text-sm font-medium text-gray-700">
                عرض النواقص فقط (20 فأقل)
              </div>
            </label>
          </div>
        </div>

        {/* Table */}
        <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
          <table className="min-w-[760px] divide-y divide-gray-200 text-right sm:min-w-full">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">المنتج</th>
                <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">الباركود</th>
                <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">التكلفة</th>
                <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">سعر البيع</th>
                <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">المرجع بالدولار</th>
                <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">الربح</th>
                <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">الكمية</th>
                {storeSettings.businessType === 'pharmacy' && (
                  <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">تاريخ الانتهاء</th>
                )}
                <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">الحالة</th>
                <th scope="col" className="relative px-6 py-3"><span className="sr-only">إجراءات</span></th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {products.map((product) => (
                <tr key={product.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="flex-shrink-0 h-10 w-10 bg-gray-100 rounded-lg flex items-center justify-center overflow-hidden">
                        {product.imageUrl ? (
                          <img src={product.imageUrl} alt={product.name} className="w-full h-full object-cover" />
                        ) : (
                          <Package className="h-5 w-5 text-gray-500" />
                        )}
                      </div>
                      <div className="mr-4">
                        <div className="text-sm font-bold text-gray-900 flex items-center gap-2">
                          <span>{product.name}</span>
                          {product.itemType && product.itemType !== 'stock' && (
                            <span className="text-[10px] px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-100 font-bold">
                              {product.itemType === 'service'
                                ? 'خدمة'
                                : product.itemType === 'service_with_materials'
                                ? 'خدمة بمواد'
                                : 'باقة'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">
                    {product.barcode}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 tabular-nums">
                    {formatMoney(product.costPrice, storeSettings.currency, storeSettings.currencyDecimals)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-indigo-600 tabular-nums">
                    {formatMoney(product.sellingPrice, storeSettings.currency, storeSettings.currencyDecimals)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 tabular-nums">
                    {product.priceInUSD ? `$${formatMoney(product.priceInUSD, undefined, storeSettings.currencyDecimals)}` : '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-emerald-600 font-bold tabular-nums">
                    {formatMoney(product.sellingPrice - product.costPrice, undefined, storeSettings.currencyDecimals)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {product.itemType === 'service' ? (
                      <span className="px-2.5 py-1 inline-flex text-xs font-bold rounded-lg bg-slate-100 text-slate-600 border border-slate-200">
                        غير مخزوني (خدمة)
                      </span>
                    ) : (
                      <span className={`px-2.5 py-1 inline-flex text-xs leading-5 font-bold rounded-lg border tabular-nums ${
                        product.stockQuantity > (product.minStockLevel || 5) ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 
                        product.stockQuantity > 0 ? 'bg-amber-50 text-amber-700 border-amber-200' : 
                        'bg-rose-50 text-rose-700 border-rose-200'
                      }`}>
                        {formatQty(product.stockQuantity, storeSettings.quantityDecimals)} {product.unit === 'box' ? 'صندوق' : product.unit === 'piece' ? 'حبة' : product.unit}
                        {product.unit === 'box' && ` (${formatQty(product.conversionFactor)})`}
                      </span>
                    )}
                  </td>
                  {storeSettings.businessType === 'pharmacy' && (
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 tabular-nums">
                      {product.expiryDate ? (
                        <span className={new Date(product.expiryDate) < new Date() ? 'text-rose-600 font-bold' : ''}>
                          {new Date(product.expiryDate).toLocaleDateString('ar-SA')}
                        </span>
                      ) : '-'}
                    </td>
                  )}
                  <td className="px-6 py-4 whitespace-nowrap text-xs font-bold">
                    {product.syncStatus === 'synced' ? (
                      <span className="inline-flex px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200">متزامن</span>
                    ) : (
                      <span className="inline-flex px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 border border-amber-200">قيد المزامنة</span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-left text-sm font-medium">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setItemCardProduct(product)}
                        className="text-indigo-700 hover:bg-indigo-100 p-2 bg-indigo-50 rounded-lg"
                        title="بطاقة الصنف وسجل الحركات"
                      >
                        <History className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => openPrintBarcode(product)}
                        className="text-gray-600 hover:text-gray-900 p-2 bg-gray-100 rounded-lg"
                        title="طباعة باركود"
                      >
                        <Printer className="w-4 h-4" />
                      </button>
                      {hasPermission('edit_product') && (
                        <button 
                          onClick={() => handleOpenModal(product)}
                          className="text-indigo-600 hover:text-indigo-900 p-2 bg-indigo-50 rounded-lg"
                          title="تعديل"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                      )}
                      {hasPermission('delete_product') && (
                        <button 
                          onClick={() => handleDelete(product.id!)}
                          className="text-rose-600 hover:text-rose-900 p-2 bg-rose-50 rounded-lg"
                          title="حذف"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {products.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                    لا توجد منتجات مطابقة...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      </>
      )}

      {activeTab === 'categories' && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 flex-1 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-gray-200 bg-gray-50/50">
            <h3 className="font-bold text-gray-900">التصنيفات المتاحة</h3>
          </div>
          <div className="flex-1 overflow-auto p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {categories.map((category) => (
                <div key={category.id} className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm flex items-center justify-between group hover:border-indigo-200 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className={`w-4 h-4 rounded-full ${category.color || 'bg-gray-200'}`}></div>
                    <span className="font-bold text-gray-900">{category.name}</span>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {hasPermission('manage_categories') && (
                      <>
                        <button 
                          onClick={() => handleOpenCategoryModal(category)}
                          className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => category.id && handleDeleteCategory(category.id)}
                          className="p-2 text-rose-600 hover:bg-rose-50 rounded-lg"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Hidden Barcode for Printing */}
      <div className="absolute -left-[9999px]">
        <div ref={barcodeRef} className="p-4 flex flex-col items-center justify-center w-[200px] text-center bg-white">
          {printingProduct && (
            <>
              <p className="text-sm font-bold mb-1 truncate w-full">{printingProduct.name}</p>
              <Barcode 
                value={printingProduct.barcode} 
                width={1.5} 
                height={40} 
                fontSize={12} 
                margin={0}
                displayValue={true}
              />
              <p className="text-xs font-bold mt-1">{printingProduct.sellingPrice.toFixed(2)} {storeSettings.currency}</p>
            </>
          )}
        </div>
      </div>

      {/* Add/Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden">
            <div className="flex justify-between items-center p-6 border-b border-gray-100 shrink-0">
              <h3 className="text-xl font-bold text-gray-900">
                {editingProduct ? 'تعديل منتج / خدمة' : 'إضافة منتج / خدمة جديدة'}
              </h3>
              <button onClick={handleCloseModal} className="text-gray-400 hover:text-gray-600 transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="p-6 overflow-y-auto flex-1">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Image Upload Section */}
                <div className="md:col-span-1 flex flex-col items-center gap-4">
                  <div className="w-full aspect-square rounded-2xl border-2 border-dashed border-gray-200 flex items-center justify-center overflow-hidden bg-gray-50 group relative">
                    {formData.imageUrl ? (
                      <>
                        <img src={formData.imageUrl} alt="Product" className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <button 
                            type="button"
                            onClick={() => setFormData({...formData, imageUrl: ''})}
                            className="p-2 bg-rose-500 text-white rounded-full hover:bg-rose-600"
                          >
                            <X className="w-5 h-5" />
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col items-center text-gray-400">
                        <ImageIcon className="w-12 h-12 mb-2" />
                        <span className="text-xs">صورة المنتج</span>
                      </div>
                    )}
                  </div>
                  <label className="w-full cursor-pointer px-4 py-2.5 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 transition-colors text-sm font-medium text-center border border-gray-200">
                    تحميل صورة
                    <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                  </label>

                  <label className="w-full flex items-center justify-between p-3 bg-indigo-50/50 border border-indigo-100 rounded-xl cursor-pointer">
                    <span className="text-xs font-bold text-indigo-900">السماح بالكميات العشرية (أوزان/أمتار)</span>
                    <input
                      type="checkbox"
                      checked={formData.allowFractions}
                      onChange={(e) => setFormData({ ...formData, allowFractions: e.target.checked })}
                      className="w-4 h-4 accent-indigo-600"
                    />
                  </label>
                </div>

                {/* Product Info Section */}
                <div className="md:col-span-2 grid grid-cols-2 gap-4">
                  <div className="col-span-2 sm:col-span-1">
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">اسم الصنف</label>
                    <input 
                      type="text" 
                      required
                      value={formData.name}
                      onChange={e => setFormData({...formData, name: e.target.value})}
                      className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" 
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">نوع الصنف</label>
                    <select
                      value={formData.itemType}
                      onChange={(e) => setFormData({ ...formData, itemType: e.target.value as any })}
                      className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 outline-none font-medium"
                    >
                      <option value="stock">صنف مخزوني قياسي</option>
                      <option value="service">خدمة (بدون خصم مخزوني)</option>
                      <option value="service_with_materials">خدمة / وجبة بمواد مستهلكة</option>
                      <option value="bundle">باقة / تجميعة منتجات</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">رقم الباركود</label>
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        required
                        value={formData.barcode}
                        onChange={e => setFormData({...formData, barcode: e.target.value})}
                        className="flex-1 min-w-0 border border-gray-300 rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none font-mono text-sm" 
                      />
                      <button
                        type="button"
                        onClick={generateBarcode}
                        className="px-3 py-2 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 transition-colors flex items-center justify-center shrink-0"
                        title="توليد باركود عشوائي"
                      >
                        <RefreshCcw className="w-5 h-5" />
                      </button>
                      {formData.barcode && (
                        <button
                          type="button"
                          onClick={() => openPrintBarcode({ 
                            ...formData, 
                            id: editingProduct?.id,
                            costPrice: Number(formData.costPrice) || 0,
                            sellingPrice: Number(formData.sellingPrice) || 0,
                            costInUSD: 0,
                            priceInUSD: 0,
                            stockQuantity: Number(formData.stockQuantity) || 0,
                            minStockLevel: Number(formData.minStockLevel) || 0,
                            vatRate: Number(formData.vatRate) || 0,
                            conversionFactor: Number(formData.conversionFactor) || 1,
                            syncStatus: 'pending',
                            updatedAt: new Date().toISOString()
                          } as unknown as Product)}
                          className="px-3 py-2 bg-indigo-50 text-indigo-600 rounded-xl hover:bg-indigo-100 transition-colors flex items-center justify-center shrink-0"
                          title="طباعة الباركود"
                        >
                          <Printer className="w-5 h-5" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">التصنيف</label>
                    <select 
                      required
                      value={formData.categoryId}
                      onChange={e => setFormData({...formData, categoryId: Number(e.target.value)})}
                      className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    >
                      {categories.map(cat => (
                        <option key={cat.id} value={cat.id}>{cat.name}</option>
                      ))}
                    </select>
                  </div>
                  {formData.itemType !== 'service' && formData.itemType !== 'service_with_materials' && (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1.5">الكمية المتوفرة</label>
                        <input 
                          type="number" 
                          required
                          step={formData.allowFractions ? '0.001' : '1'}
                          min="0"
                          value={formData.stockQuantity}
                          onChange={e => setFormData({...formData, stockQuantity: e.target.value})}
                          className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" 
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1.5">حد التنبيه</label>
                        <input 
                          type="number" 
                          required
                          min="0"
                          value={formData.minStockLevel}
                          onChange={e => setFormData({...formData, minStockLevel: e.target.value})}
                          className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-rose-500 focus:border-rose-500 outline-none" 
                        />
                      </div>
                    </>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">وحدة المخزون الأساسية</label>
                    <select
                      required
                      value={formData.unit}
                      onChange={e => setFormData({...formData, unit: e.target.value})}
                      className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    >
                      <optgroup label="العدد والتعبئة">
                        <option value="piece">قطعة / حبة</option>
                        <option value="pair">زوج</option>
                        <option value="dozen">دستة (12 قطعة)</option>
                        <option value="set">طقم / مجموعة</option>
                        <option value="pack">عبوة</option>
                        <option value="bundle">ربطة</option>
                        <option value="ream">رزمة</option>
                        <option value="box">صندوق</option>
                        <option value="carton">كرتونة</option>
                        <option value="sack">شوال</option>
                        <option value="roll">لفة</option>
                      </optgroup>
                      <optgroup label="الوزن">
                        <option value="جرام">جرام</option>
                        <option value="كجم">كيلوجرام (كجم)</option>
                        <option value="طن">طن</option>
                      </optgroup>
                      <optgroup label="الحجم والسوائل">
                        <option value="ملليلتر">ملليلتر</option>
                        <option value="لتر">لتر</option>
                        <option value="متر مكعب">متر مكعب</option>
                      </optgroup>
                      <optgroup label="الطول والمساحة">
                        <option value="ملليمتر">ملليمتر</option>
                        <option value="سنتيمتر">سنتيمتر</option>
                        <option value="متر">متر</option>
                        <option value="كيلومتر">كيلومتر</option>
                        <option value="متر مربع">متر مربع</option>
                        <option value="سنتيمتر مربع">سنتيمتر مربع</option>
                      </optgroup>
                      <optgroup label="الزمن">
                        <option value="دقيقة">دقيقة</option>
                        <option value="ساعة">ساعة</option>
                        <option value="يوم">يوم</option>
                      </optgroup>
                    </select>
                    <p className="mt-1 text-xs leading-5 text-gray-500">المخزون يُحفظ بهذه الوحدة. إذا كنت تشتري بالقطعة وتبيع بالكرتونة، اجعل القطعة هي الوحدة الأساسية وأضف الكرتونة كوحدة بيع إضافية.</p>
                  </div>
                  <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-3 text-xs leading-6 text-indigo-800 sm:col-span-2">
                    أدخل تكلفة وسعر بيع المنتج بعملة النظام الأساسية ({storeSettings.baseCurrency || storeSettings.currency}). لا يلزم إدخال أي سعر بالدولار. تغيير سعر الصرف لا يغيّر سعر البيع المحلي تلقائيًا.
                  </div>
                  {formData.itemType !== 'service' && formData.itemType !== 'service_with_materials' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">تكلفة الوحدة الأساسية ({storeSettings.currency})</label>
                      <input
                        type="number"
                        required
                        step="0.01"
                        min="0"
                        value={formData.costPrice}
                        onChange={e => setFormData({...formData, costPrice: e.target.value})}
                        className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                      />
                      <label className="mt-2 flex items-center gap-2 text-xs text-gray-600">
                        <input type="checkbox" checked={costFxLinked} onChange={e => setCostFxLinked(e.target.checked)} className="rounded" />
                        ربط التكلفة بالدولار؛ ألغِ التحديد لتثبيتها بالجنيه
                      </label>
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">سعر البيع ({storeSettings.currency})</label>
                    <input 
                      type="number" 
                      required
                      step="0.01"
                      min="0"
                      value={formData.sellingPrice}
                      onChange={e => setFormData({...formData, sellingPrice: e.target.value})}
                      className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    />
                    <label className="mt-2 flex items-center gap-2 text-xs text-gray-600">
                      <input type="checkbox" checked={sellingFxLinked} onChange={e => setSellingFxLinked(e.target.checked)} className="rounded" />
                      ربط سعر البيع بالدولار؛ ألغِ التحديد لتثبيته بالجنيه
                    </label>
                    <p className="mt-1 text-xs text-gray-500">السعر المدخل هنا بالجنيه السوداني. يحتفظ النظام بالمقابل بالدولار تلقائيًا عند تفعيل الربط.</p>
                  </div>
                  {storeSettings.businessType === 'pharmacy' && (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1.5">تاريخ الانتهاء</label>
                        <input 
                          type="date" 
                          value={formData.expiryDate}
                          onChange={e => setFormData({...formData, expiryDate: e.target.value})}
                          className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" 
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1.5">رقم التشغيلة (Batch)</label>
                        <input 
                          type="text" 
                          value={formData.batchNumber}
                          onChange={e => setFormData({...formData, batchNumber: e.target.value})}
                          className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" 
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Multi-Unit Packaging Editor */}
              <div className="mt-6 pt-5 border-t border-gray-100">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-bold text-gray-800 flex items-center gap-2">
                    <Layers className="w-4 h-4 text-indigo-600" />
                    وحدات البيع الإضافية
                  </h4>
                  <button
                    type="button"
                    onClick={() =>
                      setExtraUnits([
                        ...extraUnits,
                        { name: 'كرتون', barcode: '', conversionFactor: 12, sellingPrice: (Number(formData.sellingPrice) || 0) * 12 },
                      ])
                    }
                    className="px-3 py-1.5 text-xs font-bold bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    إضافة وحدة
                  </button>
                </div>
                <p className="mb-3 text-xs leading-5 text-gray-500">مثال: إذا كانت الوحدة الأساسية «قطعة»، أدخل «كرتونة» ومعامل تحويل 12. عند بيع كرتونة واحدة يخصم النظام 12 قطعة. حدد سعر بيع الكرتونة بشكل مستقل إذا كان مختلفًا عن سعر 12 قطعة.</p>
                {extraUnits.length > 0 && (
                  <div className="space-y-2">
                    {extraUnits.map((u, idx) => (
                      <div key={idx} className="grid grid-cols-5 gap-2 items-center bg-gray-50 p-2.5 rounded-xl border border-gray-200">
                        <input
                          type="text"
                          value={u.name}
                          onChange={(e) => {
                            const next = [...extraUnits];
                            next[idx] = { ...u, name: e.target.value };
                            setExtraUnits(next);
                          }}
                          placeholder="اسم الوحدة"
                          className="px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs font-bold"
                        />
                        <input
                          type="text"
                          value={u.barcode || ''}
                          onChange={(e) => {
                            const next = [...extraUnits];
                            next[idx] = { ...u, barcode: e.target.value };
                            setExtraUnits(next);
                          }}
                          placeholder="باركود الوحدة"
                          className="px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs font-mono"
                        />
                        <input
                          type="number"
                          step="0.001"
                          min="0.001"
                          value={u.conversionFactor}
                          onChange={(e) => {
                            const next = [...extraUnits];
                            next[idx] = { ...u, conversionFactor: Number(e.target.value) };
                            setExtraUnits(next);
                          }}
                          placeholder="المعامل"
                          title="معامل التحويل للوحدة الأساسية"
                          className="px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs font-bold"
                        />
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={u.sellingPrice}
                          onChange={(e) => {
                            const next = [...extraUnits];
                            next[idx] = { ...u, sellingPrice: Number(e.target.value) };
                            setExtraUnits(next);
                          }}
                          placeholder="سعر البيع"
                          className="px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs font-bold"
                        />
                        <button
                          type="button"
                          onClick={() => setExtraUnits(extraUnits.filter((_, i) => i !== idx))}
                          className="p-1.5 text-rose-600 hover:bg-rose-50 rounded-lg justify-self-center"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Service / Bundle Recipe Builder */}
              {formData.itemType === 'service' && (
                <div className="mt-4 rounded-xl border border-sky-100 bg-sky-50 p-3 text-xs leading-6 text-sky-800">
                  الخدمة العادية لا تخصم كمية من المخزون. أدخل سعر البيع فقط؛ وإذا كانت لها تكاليف تشغيل مثل أجور الفنيين فسجلها في المصروفات. إذا كانت تستهلك مواد مخزنية فاختر «خدمة بمواد».
                </div>
              )}
              {formData.itemType === 'service_with_materials' && (
                <div className="mt-4 rounded-xl border border-amber-100 bg-amber-50 p-3 text-xs leading-6 text-amber-800">
                  هذه الخدمة لا تملك رصيدًا مخزنيًا مستقلًا؛ عند البيع يخصم النظام المواد المحددة في الوصفة ويحسب تكلفتها من دفعات FIFO. يجب إضافة مادة خام واحدة على الأقل.
                </div>
              )}
              {(formData.itemType === 'service_with_materials' || formData.itemType === 'bundle') && (
                <div className="mt-5 pt-5 border-t border-gray-100">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-bold text-gray-800">
                      مكونات الوصفة / المواد الخام المستهلكة تلقائياً عند البيع
                    </h4>
                    <button
                      type="button"
                      onClick={() => {
                        const firstStock = allProducts.find((p) => p.id !== editingProduct?.id && p.itemType !== 'service');
                        if (!firstStock?.id) {
                          toast.error('يرجى إضافة أصناف مخزونية أولاً لاختيارها كمكونات');
                          return;
                        }
                        setRecipeRows([
                          ...recipeRows,
                          {
                            ingredientProductId: firstStock.id,
                            ingredientName: firstStock.name,
                            quantity: '1',
                            unit: firstStock.unit || 'piece',
                          },
                        ]);
                      }}
                      className="px-3 py-1.5 text-xs font-bold bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 flex items-center gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      إضافة مادة خام
                    </button>
                  </div>
                  {recipeRows.length > 0 && (
                    <div className="space-y-2">
                      {recipeRows.map((row, idx) => (
                        <div key={idx} className="grid grid-cols-4 gap-2 items-center bg-emerald-50/40 p-2.5 rounded-xl border border-emerald-100">
                          <select
                            value={row.ingredientProductId}
                            onChange={(e) => {
                              const pid = Number(e.target.value);
                              const p = allProducts.find((x) => x.id === pid);
                              const next = [...recipeRows];
                              next[idx] = {
                                ...row,
                                ingredientProductId: pid,
                                ingredientName: p?.name || '',
                                unit: p?.unit || 'piece',
                              };
                              setRecipeRows(next);
                            }}
                            className="col-span-2 px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs font-bold"
                          >
                            {allProducts
                              .filter((p) => p.id !== editingProduct?.id && p.itemType !== 'service')
                              .map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} ({formatQty(p.stockQuantity)} {p.unit})
                                </option>
                              ))}
                          </select>
                          <input
                            type="number"
                            step="0.001"
                            min="0.001"
                            value={row.quantity}
                            onChange={(e) => {
                              const next = [...recipeRows];
                              next[idx] = { ...row, quantity: e.target.value };
                              setRecipeRows(next);
                            }}
                            placeholder="الكمية"
                            className="px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs font-bold"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              if (row.id) setRemovedRecipeIds((prev) => [...prev, row.id!]);
                              setRecipeRows(recipeRows.filter((_, i) => i !== idx));
                            }}
                            className="p-1.5 text-rose-600 hover:bg-rose-50 rounded-lg justify-self-center"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="mt-8 flex justify-end gap-3">
                <button 
                  type="button" 
                  onClick={handleCloseModal}
                  className="px-6 py-2.5 rounded-xl font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors"
                >
                  إلغاء
                </button>
                <button 
                  type="submit" 
                  className="px-6 py-2.5 rounded-xl font-medium text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
                >
                  {editingProduct ? 'حفظ التعديلات' : 'إضافة المنتج'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {isPriceManagerOpen && (
        <ProductPriceManager
          products={allProducts}
          branchId={user?.branchId}
          actorName={user?.name || 'System'}
          currency={storeSettings.currency}
          onClose={() => setIsPriceManagerOpen(false)}
        />
      )}

      {/* Category Modal */}
      {isCategoryModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="flex justify-between items-center p-6 border-b border-gray-100">
              <h3 className="text-xl font-bold text-gray-900">
                {editingCategory ? 'تعديل تصنيف' : 'إضافة تصنيف جديد'}
              </h3>
              <button onClick={handleCloseCategoryModal} className="text-gray-400 hover:text-gray-600 transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
            
            <form onSubmit={handleCategorySubmit} className="p-6">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">اسم التصنيف</label>
                  <input
                    type="text"
                    required
                    value={categoryFormData.name}
                    onChange={(e) => setCategoryFormData({...categoryFormData, name: e.target.value})}
                    className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">لون التصنيف</label>
                  <div className="flex flex-wrap gap-2">
                    {['bg-indigo-500', 'bg-emerald-500', 'bg-rose-500', 'bg-amber-500', 'bg-blue-500', 'bg-purple-500', 'bg-pink-500', 'bg-gray-500'].map(color => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setCategoryFormData({...categoryFormData, color})}
                        className={`w-8 h-8 rounded-full ${color} ${categoryFormData.color === color ? 'ring-2 ring-offset-2 ring-gray-800' : ''}`}
                      />
                    ))}
                  </div>
                </div>
              </div>
              
              <div className="mt-8 flex gap-3">
                <button
                  type="button"
                  onClick={handleCloseCategoryModal}
                  className="flex-1 px-4 py-3 border border-gray-300 text-gray-700 rounded-xl font-bold hover:bg-gray-50 transition-colors"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-3 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-colors"
                >
                  {editingCategory ? 'حفظ التعديلات' : 'إضافة التصنيف'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Barcode Scanner Modal */}
      {isScannerModalOpen && (
        <div className="barcode-scanner-modal fixed inset-0 bg-transparent flex items-center justify-center z-50 p-4">
          <div className="bg-slate-950/75 text-white rounded-2xl border border-white/20 shadow-xl w-full max-w-md overflow-hidden flex flex-col">
            <div className="flex justify-between items-center p-6 border-b border-white/20 bg-slate-950/80">
              <h3 className="text-xl font-bold text-white flex items-center gap-2">
                {storeSettings.inventoryScannerType === 'camera' ? (
                  <>
                    <Camera className="w-6 h-6 text-indigo-600" />
                    مسح الباركود بالكاميرا
                  </>
                ) : (
                  <>
                    <ScanLine className="w-6 h-6 text-indigo-600" />
                    انتظار مسح الباركود...
                  </>
                )}
              </h3>
              <button 
                onClick={() => setIsScannerModalOpen(false)} 
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
            
            <div className="p-8">
              {storeSettings.inventoryScannerType === 'camera' ? (
                <div className="space-y-4">
                  <div id="inventory-reader" className="w-full bg-transparent rounded-2xl overflow-hidden aspect-square" />
                  <p className="text-center text-sm text-white/80">
                    وجّه الكاميرا نحو الباركود أو استخدم الماسح الخارجي في الحقل التالي
                  </p>
                  <input
                    ref={deviceInputRef}
                    type="text"
                    autoFocus
                    autoComplete="off"
                    inputMode="none"
                    placeholder="الماسح الخارجي USB / Bluetooth"
                    onKeyDown={handleDeviceScan}
                    className="w-full rounded-xl border border-indigo-200 px-4 py-3 text-center font-mono text-base outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center text-center space-y-6">
                  <div className="w-24 h-24 bg-indigo-50 rounded-full flex items-center justify-center animate-pulse">
                    <ScanLine className="w-12 h-12 text-indigo-500" />
                  </div>
                  <div>
                    <h4 className="text-lg font-bold text-gray-900 mb-2">استخدم جهاز المسح الآن</h4>
                    <p className="text-gray-500 text-sm leading-relaxed">
                      تأكد من أن جهاز قارئ الباركود موصل بالكمبيوتر، ثم قم بمسح الباركود الخاص بالمنتج.
                    </p>
                  </div>
                  
                  <div className="w-full p-4 bg-emerald-50 rounded-2xl border border-emerald-100 flex items-center justify-center gap-3">
                    <div className="w-3 h-3 rounded-full bg-emerald-500 animate-ping"></div>
                    <span className="text-sm font-bold text-emerald-700">النظام جاهز لاستقبال بيانات المسح</span>
                  </div>

                  <input
                    ref={deviceInputRef}
                    type="text"
                    className="w-full px-4 py-3 bg-white border border-indigo-200 rounded-xl focus:ring-4 focus:ring-indigo-500/10 outline-none text-center font-mono text-lg"
                    placeholder="امسح الرمز بواسطة الجهاز..."
                    onKeyDown={handleDeviceScan}
                    autoFocus
                    onBlur={(e) => {
                      if (isScannerModalOpen && storeSettings.inventoryScannerType === 'usb') {
                        setTimeout(() => e.target.focus(), 50);
                      }
                    }}
                  />
                </div>
              )}

              <div className="mt-8 pt-6 border-t border-gray-100 text-center">
                <p className="text-xs text-gray-400">
                  سيتم البحث عن المنتج وإدخال بياناته بشكل آلي بمجرد التقاط الرمز
                </p>
              </div>
            </div>

            <div className="p-6 bg-slate-950/80 flex justify-center">
              <button
                onClick={() => setIsScannerModalOpen(false)}
                className="px-8 py-3 bg-white border border-gray-200 text-gray-700 rounded-xl font-bold hover:bg-gray-100 transition-colors shadow-sm"
              >
                إلغاء العملية
              </button>
            </div>
          </div>
        </div>
      )}

      <ItemCardModal product={itemCardProduct} onClose={() => setItemCardProduct(null)} />

      <ConfirmationModal
        isOpen={confirmState.isOpen}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        variant={confirmState.variant}
        onCancel={() => setConfirmState(prev => ({ ...prev, isOpen: false, action: null }))}
        onConfirm={async () => {
          const act = confirmState.action;
          setConfirmState(prev => ({ ...prev, isOpen: false, action: null }));
          if (act) await act();
        }}
      />
    </div>
  );
}
