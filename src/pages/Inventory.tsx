import { useState, useEffect, useRef, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, Product, Category, ProductUnit, ServiceRecipe } from '../db/db';
import { useInventoryStore } from '../store/useInventoryStore';
import { Plus, Search, Edit, Trash2, Package, X, Download, Upload, RefreshCcw, Tags, ScanLine, Printer, Image as ImageIcon, Camera, History, Layers } from 'lucide-react';
import { toast } from 'react-hot-toast';
import Barcode from 'react-barcode';
import { useReactToPrint } from 'react-to-print';
import { Html5Qrcode } from 'html5-qrcode';
import { useSettings } from '../hooks/useSettings';
import { logAction } from '../services/auditService';
import { useAuth } from '../context/AuthContext';
import { dispatchOperation } from '../services/operationService';
import { apiService } from '../services/apiService';
import { formatMoney, formatQty, roundQty, roundAmount } from '../utils/format';
import { generateUUID } from '../utils/uuid';
import ConfirmationModal from '../components/ConfirmationModal';
import { ItemCardModal } from '../components/ItemCardModal';

interface FxReviewItem {
  product: Product;
  selected: boolean;
  newCost: number;
  currentPrice: number;
  suggestedPrice: number;
  targetPrice: number;
}

export default function Inventory() {
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [itemCardProduct, setItemCardProduct] = useState<Product | null>(null);
  const [showLowStockOnly, setShowLowStockOnly] = useState(false);
  const [activeTab, setActiveTab] = useState<'products' | 'categories'>('products');
  const [fxReviewItems, setFxReviewItems] = useState<FxReviewItem[] | null>(null);
  const [isApplyingFx, setIsApplyingFx] = useState(false);
  const { user } = useAuth();
  
  const hasPermission = (permission: string) => {
    return user?.role === 'admin' || user?.permissions?.includes(permission);
  };
  
  // Barcode Scanner State (Unified)
  const [isScannerModalOpen, setIsScannerModalOpen] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const mainSearchInputRef = useRef<HTMLInputElement>(null);
  const deviceInputRef = useRef<HTMLInputElement>(null);
  const lastScannedTimeRef = useRef<Record<string, number>>({});

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
  const liveProducts = useLiveQuery(() => db.products.toArray());
  useEffect(() => {
    if (liveProducts) {
      useInventoryStore.getState().updateProducts(liveProducts);
    }
  }, [liveProducts]);

  const suppliers = useLiveQuery(() => db.suppliers.toArray()) || [];
  
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
  const existingRecipes = useLiveQuery(() => db.serviceRecipes.toArray(), []) || [];

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

  useEffect(() => {
    if (storeSettings.taxRate !== undefined && !editingProduct && !isModalOpen) {
      setFormData(prev => ({ ...prev, vatRate: storeSettings.taxRate.toString() }));
    }
  }, [storeSettings.taxRate, editingProduct, isModalOpen]);

  const handleOpenModal = (product?: Product, initialBarcode?: string) => {
    setRemovedRecipeIds([]);
    if (product) {
      setEditingProduct(product);
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

  const handleBarcodeScanned = async (barcode: string) => {
    // Double scan protection
    const now = Date.now();
    if (lastScannedTimeRef.current[barcode] && (now - lastScannedTimeRef.current[barcode]) < 500) {
      return;
    }
    lastScannedTimeRef.current[barcode] = now;

    // Optimized lookup using memory cache
    const existingProduct = getProductByBarcode(barcode);
    setIsScannerModalOpen(false);
    
    if (existingProduct) {
      toast.success(`تم العثور على المنتج: ${existingProduct.name}`);
      handleOpenModal(existingProduct);
    } else {
      // Fallback to DB
      const dbProd = await db.products.where('barcode').equals(barcode).first();
      if (dbProd) {
        handleOpenModal(dbProd);
      } else {
        toast.success('منتج جديد، يرجى إكمال البيانات');
        handleOpenModal(undefined, barcode);
      }
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
      if (scannerRef.current) {
        try {
          if (scannerRef.current.isScanning) {
            await scannerRef.current.stop();
          }
          await scannerRef.current.clear();
        } catch (err) {
          console.error("Error stopping scanner:", err);
        }
        scannerRef.current = null;
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
          const html5QrCode = new Html5Qrcode("inventory-reader");
          scannerRef.current = html5QrCode;
          
          await html5QrCode.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            (decodedText) => {
              handleBarcodeScanned(decodedText);
            },
            () => {}
          );
        } catch (err) {
          console.error("Error starting camera scanner:", err);
          if (isMounted) {
            toast.error('تعذر الوصول للكاميرا. يرجى التحقق من الصلاحيات.');
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
    if (isScannerModalOpen && storeSettings.inventoryScannerType === 'usb' && deviceInputRef.current) {
      deviceInputRef.current.focus();
    }
  }, [isScannerModalOpen, storeSettings.inventoryScannerType]);

  const handleDeviceScan = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const barcode = e.currentTarget.value.trim();
      if (barcode) {
        await handleBarcodeScanned(barcode);
      }
      e.currentTarget.value = '';
    }
  };

  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const barcode = mainSearchInputRef.current?.value?.trim();
    if (!barcode) return;
    
    // Check if what was entered/scanned is an exact barcode match - optimized lookup
    const existingProduct = await db.products.where('barcode').equals(barcode).first();
    if (existingProduct) {
      handleOpenModal(existingProduct);
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
          const category = await db.categories.get(id);
          const productsToDelete = await db.products.where('categoryId').equals(id).toArray();
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

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setFormData({ ...formData, imageUrl: reader.result as string });
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const now = new Date().toISOString();
      const validUnits = extraUnits.filter((u) => u.name.trim() && Number(u.conversionFactor) > 0);
      const productData: any = {
        barcode: formData.barcode,
        name: formData.name,
        categoryId: Number(formData.categoryId),
        costPrice: Number(formData.costPrice) || 0,
        sellingPrice: Number(formData.sellingPrice) || 0,
        costInUSD: formData.costInUSD ? Number(formData.costInUSD) : undefined,
        priceInUSD: formData.priceInUSD ? Number(formData.priceInUSD) : undefined,
        stockQuantity: formData.itemType === 'service' ? 0 : roundQty(Number(formData.stockQuantity) || 0),
        minStockLevel: Number(formData.minStockLevel) || 0,
        vatRate: Number(formData.vatRate) || 0,
        imageUrl: formData.imageUrl,
        expiryDate: formData.expiryDate || undefined,
        batchNumber: formData.batchNumber || undefined,
        unit: formData.unit || 'piece',
        conversionFactor: Number(formData.conversionFactor) || 1,
        itemType: formData.itemType,
        allowFractions: formData.allowFractions,
        unitsJson: validUnits.length > 0 ? JSON.stringify(validUnits) : undefined,
        branchId: editingProduct?.branchId ?? user?.branchId,
        updatedAt: now,
      };

      let savedParentId = editingProduct?.id;
      if (editingProduct && editingProduct.id) {
        const res = await dispatchOperation(
          'entity_upsert',
          {
            table: 'products',
            record: {
              ...editingProduct,
              ...productData,
              id: editingProduct.id,
            },
          },
          user?.branchId
        );
        savedParentId = res?.result?.id || editingProduct.id;
        await logAction(user?.name || 'Unknown', 'تحديث منتج', 'product', `تم تحديث المنتج: ${formData.name}`, 0, Number(formData.sellingPrice), formData.name);
        toast.success('تم تحديث المنتج بنجاح');
      } else {
        const tempId = makeTempNumericId();
        const res = await dispatchOperation(
          'entity_upsert',
          {
            table: 'products',
            record: {
              ...productData,
              id: tempId,
              createdAt: now,
            },
          },
          user?.branchId
        );
        savedParentId = res?.result?.id || tempId;
        await logAction(user?.name || 'Unknown', 'إضافة منتج', 'product', `تمت إضافة المنتج: ${formData.name}`, 0, Number(formData.sellingPrice), formData.name);
        toast.success('تمت إضافة المنتج بنجاح');
      }

      // Persist service recipes if applicable
      if (savedParentId) {
        for (const delId of removedRecipeIds) {
          await apiService.deleteServiceRecipe(delId).catch(() => {});
          await db.serviceRecipes.delete(delId).catch(() => {});
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

      handleCloseModal();
    } catch (error) {
      console.error(error);
      toast.error('حدث خطأ أثناء حفظ المنتج');
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
          const product = await db.products.get(id);
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

  const handleUpdatePricesFromExchangeRate = () => {
    const rate = Number(storeSettings.exchangeRate || 0);
    if (!rate || rate <= 0) {
      toast.error('يرجى تعيين سعر صرف صحيح في الإعدادات أولاً');
      return;
    }

    const productsToUpdate = allProducts.filter(p => p.priceInUSD || p.costInUSD);
    if (productsToUpdate.length === 0) {
      toast('لا توجد منتجات مسعرة بالدولار لتحديثها', { icon: 'ℹ️' });
      return;
    }

    const marginRatio = Math.min(0.9, Math.max(0, Number(storeSettings.targetProfitMargin ?? 25) / 100));
    const reviewList: FxReviewItem[] = productsToUpdate.map((p) => {
      const newCost = p.costInUSD
        ? roundAmount(Number(p.costInUSD) * rate, storeSettings.currencyDecimals)
        : Number(p.costPrice || 0);
      const suggested = p.priceInUSD
        ? roundAmount(Number(p.priceInUSD) * rate, storeSettings.currencyDecimals)
        : roundAmount(marginRatio < 1 ? newCost / (1 - marginRatio) : newCost * 1.25, storeSettings.currencyDecimals);
      return {
        product: p,
        selected: true,
        newCost,
        currentPrice: Number(p.sellingPrice || 0),
        suggestedPrice: suggested,
        targetPrice: suggested,
      };
    });

    setFxReviewItems(reviewList);
  };

  const handleApplyFxReview = async () => {
    if (!fxReviewItems) return;
    const selected = fxReviewItems.filter((item) => item.selected);
    if (selected.length === 0) {
      setFxReviewItems(null);
      return;
    }
    setIsApplyingFx(true);
    try {
      const now = new Date().toISOString();
      for (const item of selected) {
        const updatedProduct: any = {
          ...item.product,
          costPrice: item.newCost,
          sellingPrice: Number(item.targetPrice) || item.suggestedPrice,
          updatedAt: now,
        };
        await dispatchOperation(
          'entity_upsert',
          { table: 'products', record: updatedProduct },
          user?.branchId
        );
      }
      await logAction(
        user?.name || 'Unknown',
        'تحديث أسعار الصرف',
        'product',
        `تم اعتماد وتحديث أسعار ${selected.length} منتج حسب سعر الصرف ${storeSettings.exchangeRate}`,
        0,
        0
      );
      toast.success(`تم تحديث أسعار ${selected.length} منتج بنجاح`);
      setFxReviewItems(null);
    } catch (error) {
      console.error(error);
      toast.error('حدث خطأ أثناء تحديث الأسعار');
    } finally {
      setIsApplyingFx(false);
    }
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
    <div className="p-6 h-full flex flex-col bg-[var(--app-bg)]">
      <div className="flex justify-between items-center mb-6 shrink-0">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">إدارة المخزون</h2>
          <p className="text-gray-500 text-sm mt-1">إدارة المنتجات، التصنيفات، والأسعار</p>
        </div>
        <div className="flex gap-3">
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
              {hasPermission('edit_product') && (
                <button 
                  onClick={handleUpdatePricesFromExchangeRate}
                  className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 px-4 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-colors shadow-sm border border-indigo-200"
                  title={`تحديث الأسعار بناءً على سعر الصرف الحالي (${storeSettings.exchangeRate})`}
                >
                  <RefreshCcw className="w-5 h-5" />
                  تحديث الأسعار
                </button>
              )}
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
      <div className="flex gap-2 mb-6 border-b border-gray-200 pb-2">
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6 shrink-0">
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

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 flex-1 flex flex-col overflow-hidden">
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
          <div className="flex items-center">
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
        <div className="flex-1 overflow-auto">
          <table className="min-w-full divide-y divide-gray-200 text-right">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">المنتج</th>
                <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">الباركود</th>
                <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">التكلفة</th>
                <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">سعر البيع</th>
                <th scope="col" className="px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">السعر ($)</th>
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
                            costInUSD: formData.costInUSD ? Number(formData.costInUSD) : undefined,
                            priceInUSD: formData.priceInUSD ? Number(formData.priceInUSD) : undefined,
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
                  {formData.itemType !== 'service' && (
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
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">الوحدة الأساسية</label>
                    <select 
                      required
                      value={formData.unit}
                      onChange={e => setFormData({...formData, unit: e.target.value})}
                      className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    >
                      <option value="piece">قطعة / حبة</option>
                      <option value="box">صندوق / كرتون</option>
                      <option value="كجم">كيلوجرام (كجم)</option>
                      <option value="جرام">جرام</option>
                      <option value="لتر">لتر</option>
                      <option value="متر">متر</option>
                    </select>
                  </div>
                  {formData.unit === 'box' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">عدد القطع في الصندوق</label>
                      <input 
                        type="number" 
                        required
                        min="1"
                        value={formData.conversionFactor}
                        onChange={e => setFormData({...formData, conversionFactor: e.target.value})}
                        className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" 
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">التكلفة (بالدولار)</label>
                    <input 
                      type="number" 
                      step="0.01"
                      min="0"
                      value={formData.costInUSD}
                      onChange={e => {
                        const usd = e.target.value;
                        setFormData({
                          ...formData, 
                          costInUSD: usd,
                          costPrice: usd ? (Number(usd) * (storeSettings.exchangeRate || 1)).toFixed(2) : formData.costPrice
                        });
                      }}
                      className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" 
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">سعر البيع (بالدولار)</label>
                    <input 
                      type="number" 
                      step="0.01"
                      min="0"
                      value={formData.priceInUSD}
                      onChange={e => {
                        const usd = e.target.value;
                        setFormData({
                          ...formData, 
                          priceInUSD: usd,
                          sellingPrice: usd ? (Number(usd) * (storeSettings.exchangeRate || 1)).toFixed(2) : formData.sellingPrice
                        });
                      }}
                      className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" 
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">التكلفة ({storeSettings.currency})</label>
                    <input 
                      type="number" 
                      required
                      step="0.01"
                      min="0"
                      value={formData.costPrice}
                      onChange={e => setFormData({...formData, costPrice: e.target.value})}
                      className="w-full border border-gray-300 rounded-xl px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" 
                    />
                  </div>
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
                    وحدات القياس والبيع الإضافية (مثال: كرتون / درزن / نصف كيلو)
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col">
            <div className="flex justify-between items-center p-6 border-b border-gray-100">
              <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
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
                  <div id="inventory-reader" className="w-full bg-black rounded-2xl overflow-hidden aspect-square flex items-center justify-center text-white text-sm">
                    جاري تشغيل الكاميرا...
                  </div>
                  <p className="text-center text-sm text-gray-500">
                    وجه الكاميرا نحو الباركود للمسح تلقائياً
                  </p>
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

            <div className="p-6 bg-gray-50 flex justify-center">
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

      {/* Bulk FX Price Review Modal */}
      {fxReviewItems && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4" dir="rtl">
          <div className="bg-white w-full max-w-4xl max-h-[88vh] rounded-3xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden">
            <div className="p-6 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-black text-gray-900">مراجعة تسعير الإحلال حسب سعر الصرف ({storeSettings.exchangeRate})</h3>
                <p className="text-xs text-gray-500 mt-1">
                  مقترح بهامش ربح مستهدف {storeSettings.targetProfitMargin ?? 25}% — يمكنك تعديل السعر المستهدف أو إلغاء تحديد أي صنف قبل الاعتماد.
                </p>
              </div>
              <button onClick={() => setFxReviewItems(null)} className="p-2 text-gray-400 hover:text-gray-600 rounded-xl">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <table className="w-full text-xs text-right">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="p-3">تطبيق</th>
                    <th className="p-3">الصنف</th>
                    <th className="p-3">التكلفة الجديدة</th>
                    <th className="p-3">سعر البيع الحالي</th>
                    <th className="p-3">السعر المقترح</th>
                    <th className="p-3">السعر المعتمد</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {fxReviewItems.map((row, idx) => (
                    <tr key={row.product.id}>
                      <td className="p-3">
                        <input
                          type="checkbox"
                          checked={row.selected}
                          onChange={(e) => {
                            const next = [...fxReviewItems];
                            next[idx] = { ...row, selected: e.target.checked };
                            setFxReviewItems(next);
                          }}
                          className="w-4 h-4 accent-indigo-600"
                        />
                      </td>
                      <td className="p-3 font-bold text-gray-900">{row.product.name}</td>
                      <td className="p-3 tabular-nums font-bold">{formatMoney(row.newCost, storeSettings.currency, storeSettings.currencyDecimals)}</td>
                      <td className="p-3 tabular-nums text-gray-500">{formatMoney(row.currentPrice, storeSettings.currency, storeSettings.currencyDecimals)}</td>
                      <td className="p-3 tabular-nums font-bold text-emerald-700">{formatMoney(row.suggestedPrice, storeSettings.currency, storeSettings.currencyDecimals)}</td>
                      <td className="p-3">
                        <input
                          type="number"
                          step="0.01"
                          value={row.targetPrice}
                          onChange={(e) => {
                            const next = [...fxReviewItems];
                            next[idx] = { ...row, targetPrice: Number(e.target.value) };
                            setFxReviewItems(next);
                          }}
                          className="w-28 px-2.5 py-1.5 border border-indigo-200 rounded-lg font-bold text-indigo-700"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="p-5 border-t border-gray-100 bg-gray-50 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setFxReviewItems(null)}
                className="px-5 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-xl font-bold text-sm"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={isApplyingFx}
                onClick={handleApplyFxReview}
                className="px-6 py-2.5 bg-indigo-600 text-white rounded-xl font-bold text-sm hover:bg-indigo-700 disabled:opacity-50"
              >
                {isApplyingFx ? 'جاري التحديث...' : `اعتماد تحديث ${fxReviewItems.filter((i) => i.selected).length} صنف`}
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
