import { create } from 'zustand';
import { db, Product, Category } from '../db/db';

interface InventoryState {
  products: Product[];
  categories: Category[];
  isLoaded: boolean;
  productMap: Map<string, Product>; // Barcode to Product map
  idMap: Map<number, Product>;      // ID to Product map
  
  // Actions
  initialize: () => Promise<void>;
  updateProducts: (products: Product[]) => void;
  updateCategories: (categories: Category[]) => void;
  getProductByBarcode: (barcode: string) => Product | undefined;
  getProductById: (id: number) => Product | undefined;
}

export const useInventoryStore = create<InventoryState>((set, get) => ({
  products: [],
  categories: [],
  isLoaded: false,
  productMap: new Map(),
  idMap: new Map(),

  initialize: async () => {
    if (get().isLoaded) return;
    
    try {
      const [products, categories] = await Promise.all([
        db.products.toArray(),
        db.categories.toArray()
      ]);
      
      const pMap = new Map();
      const iMap = new Map();
      
      products.forEach(p => {
        if (p.barcode) pMap.set(p.barcode, p);
        if (p.id) iMap.set(p.id, p);
      });
      
      set({ 
        products, 
        categories, 
        productMap: pMap, 
        idMap: iMap,
        isLoaded: true 
      });
    } catch (error) {
      console.error('Failed to initialize Inventory Store:', error);
    }
  },

  updateProducts: (products) => {
    const pMap = new Map();
    const iMap = new Map();
    
    products.forEach(p => {
      if (p.barcode) pMap.set(p.barcode, p);
      if (p.id) iMap.set(p.id, p);
    });
    
    set({ products, productMap: pMap, idMap: iMap });
  },

  updateCategories: (categories) => {
    set({ categories });
  },

  getProductByBarcode: (barcode) => {
    return get().productMap.get(barcode);
  },

  getProductById: (id) => {
    return get().idMap.get(id);
  },

  setLoaded: (loaded: boolean) => set({ isLoaded: loaded })
}));
