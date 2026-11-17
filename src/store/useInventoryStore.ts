import { create } from 'zustand';
import { db, Product, Category, ProductUnit } from '../db/db';

export interface BarcodeMatch {
  product: Product;
  matchedUnit?: ProductUnit;
}

function parseUnits(unitsJson?: string): ProductUnit[] {
  if (!unitsJson) return [];
  try {
    const parsed = JSON.parse(unitsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

interface InventoryState {
  products: Product[];
  categories: Category[];
  isLoaded: boolean;
  productMap: Map<string, Product>; // Barcode to Product map
  unitBarcodeMap: Map<string, BarcodeMatch>; // All barcodes (base + unitsJson)
  idMap: Map<number, Product>; // ID to Product map

  // Actions
  initialize: () => Promise<void>;
  updateProducts: (products: Product[]) => void;
  updateCategories: (categories: Category[]) => void;
  getProductByBarcode: (barcode: string) => Product | undefined;
  getMatchByBarcode: (barcode: string) => BarcodeMatch | undefined;
  getProductById: (id: number) => Product | undefined;
  setLoaded: (loaded: boolean) => void;
}

function buildMaps(products: Product[]) {
  const pMap = new Map<string, Product>();
  const uMap = new Map<string, BarcodeMatch>();
  const iMap = new Map<number, Product>();

  products.forEach((p) => {
    if (p.barcode) {
      pMap.set(p.barcode, p);
      uMap.set(p.barcode, { product: p });
    }
    if (p.id) iMap.set(p.id, p);

    for (const u of parseUnits(p.unitsJson)) {
      if (u.barcode) {
        if (!pMap.has(u.barcode)) pMap.set(u.barcode, p);
        uMap.set(u.barcode, { product: p, matchedUnit: u });
      }
    }
  });

  return { pMap, uMap, iMap };
}

export const useInventoryStore = create<InventoryState>((set, get) => ({
  products: [],
  categories: [],
  isLoaded: false,
  productMap: new Map(),
  unitBarcodeMap: new Map(),
  idMap: new Map(),

  initialize: async () => {
    if (get().isLoaded) return;

    try {
      const [products, categories] = await Promise.all([
        db.products.toArray(),
        db.categories.toArray(),
      ]);

      const { pMap, uMap, iMap } = buildMaps(products);

      set({
        products,
        categories,
        productMap: pMap,
        unitBarcodeMap: uMap,
        idMap: iMap,
        isLoaded: true,
      });
    } catch (error) {
      console.error('Failed to initialize Inventory Store:', error);
    }
  },

  updateProducts: (products) => {
    const { pMap, uMap, iMap } = buildMaps(products);
    set({ products, productMap: pMap, unitBarcodeMap: uMap, idMap: iMap });
  },

  updateCategories: (categories) => {
    set({ categories });
  },

  getProductByBarcode: (barcode) => {
    return get().productMap.get(barcode) || get().unitBarcodeMap.get(barcode)?.product;
  },

  getMatchByBarcode: (barcode) => {
    return get().unitBarcodeMap.get(barcode);
  },

  getProductById: (id) => {
    return get().idMap.get(id);
  },

  setLoaded: (loaded: boolean) => set({ isLoaded: loaded }),
}));
