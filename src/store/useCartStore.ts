import { create } from 'zustand';
import { generateUUID } from '../utils/uuid';
import { Product } from '../db/db';
import { calculateVatInclusiveOrder, ComputedOrderTaxSummary } from '../utils/tax';

export interface CartUnitSelection {
  unitCode: string;
  conversionToBase: number;
  label?: string;
  sellingPrice?: number | null;
}

export interface CartItem extends Product {
  cartItemId: string;
  cartQuantity: number;
  discount: number;
  discountType: 'percentage' | 'fixed';
  costPriceAtTimeOfSale: number;
  selectedUnit: string;
  selectedUnitCode?: string;
  selectedConversionToBase?: number;
  selectedUnitPrice?: number | null;
  selectedUnitLabel?: string;
}

interface CartState {
  items: CartItem[];
  globalDiscount: number;
  globalDiscountType: 'percentage' | 'fixed';
  offerDiscount: number;
  loyaltyDiscount: number;
  taxRate: number;

  // Actions
  addItem: (product: Product, unit?: string, unitSelection?: CartUnitSelection) => void;
  removeItem: (cartItemId: string) => void;
  updateQuantity: (cartItemId: string, quantity: number) => void;
  updateItemUnit: (cartItemId: string, unit: string, unitSelection?: CartUnitSelection) => void;
  updateItemDiscount: (cartItemId: string, discount: number, type: 'percentage' | 'fixed') => void;
  clearCart: () => void;
  loadCartState: (state: {
    items: CartItem[];
    globalDiscount?: number;
    globalDiscountType?: 'percentage' | 'fixed';
  }) => void;
  setGlobalDiscount: (discount: number, type: 'percentage' | 'fixed') => void;
  setOfferDiscount: (discount: number) => void;
  setLoyaltyDiscount: (discount: number) => void;
  setTaxRate: (rate: number) => void;

  // Computed (Getters) - VAT-Inclusive Model
  getTaxSummary: (loyaltyOverrideGross?: number) => ComputedOrderTaxSummary;
  getSubTotal: () => number; // Gross subtotal before discounts (VAT-inclusive)
  getTaxTotal: () => number; // Extracted VAT after discounts
  getDiscountTotal: () => number; // Gross discount total
  getGrandTotal: () => number; // Final gross total payable
}

export const getItemPrice = (item: CartItem) => {
  if (item.selectedUnitPrice !== undefined && item.selectedUnitPrice !== null) {
    return Math.max(0, Number(item.selectedUnitPrice) || 0);
  }
  const basePrice = Number(item.sellingPrice) || 0;
  const factor = item.selectedUnitCode
    ? Number(item.selectedConversionToBase || 1)
    : item.selectedUnit === 'box'
      ? Number(item.conversionFactor || 1)
      : 1;
  return basePrice * (Number.isFinite(factor) && factor > 0 ? factor : 1);
};

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  globalDiscount: 0,
  globalDiscountType: 'percentage',
  offerDiscount: 0,
  loyaltyDiscount: 0,
  taxRate: 15,

  addItem: (product, unit = 'piece', unitSelection) => {
    set((state) => {
      const existingItem = state.items.find(
        (item) => item.id === product.id &&
          (unitSelection?.unitCode
            ? item.selectedUnitCode === unitSelection.unitCode
            : !item.selectedUnitCode && item.selectedUnit === unit)
      );
      if (existingItem) {
        return {
          items: state.items.map((item) =>
            item.id === product.id &&
              (unitSelection?.unitCode
                ? item.selectedUnitCode === unitSelection.unitCode
                : !item.selectedUnitCode && item.selectedUnit === unit)
              ? { ...item, cartQuantity: item.cartQuantity + 1 }
              : item
          ),
        };
      }
      return {
        items: [
          ...state.items,
          {
            ...product,
            cartItemId: generateUUID(),
            cartQuantity: 1,
            discount: 0,
            discountType: 'percentage',
            costPriceAtTimeOfSale: product.costPrice,
            vatRate: state.taxRate,
            selectedUnit: unit,
            selectedUnitCode: unitSelection?.unitCode,
            selectedConversionToBase: unitSelection?.conversionToBase,
            selectedUnitPrice: unitSelection?.sellingPrice,
            selectedUnitLabel: unitSelection?.label,
          },
        ],
      };
    });
  },

  removeItem: (cartItemId) => {
    set((state) => ({
      items: state.items.filter((item) => item.cartItemId !== cartItemId),
    }));
  },

  updateQuantity: (cartItemId, quantity) => {
    set((state) => ({
      items: state.items.map((item) =>
        item.cartItemId === cartItemId ? { ...item, cartQuantity: Math.max(0.000001, Number.isFinite(quantity) ? quantity : 0) } : item
      ),
    }));
  },

  updateItemUnit: (cartItemId, unit, unitSelection) => {
    set((state) => ({
      items: state.items.map((item) =>
        item.cartItemId === cartItemId
          ? {
              ...item,
              selectedUnit: unit,
              selectedUnitCode: unitSelection?.unitCode,
              selectedConversionToBase: unitSelection?.conversionToBase,
              selectedUnitPrice: unitSelection?.sellingPrice,
              selectedUnitLabel: unitSelection?.label,
            }
          : item
      ),
    }));
  },

  updateItemDiscount: (cartItemId, discount, type) => {
    set((state) => ({
      items: state.items.map((item) =>
        item.cartItemId === cartItemId ? { ...item, discount, discountType: type } : item
      ),
    }));
  },

  clearCart: () => {
    set({
      items: [],
      globalDiscount: 0,
      globalDiscountType: 'percentage',
      offerDiscount: 0,
      loyaltyDiscount: 0,
    });
  },

  loadCartState: ({ items, globalDiscount = 0, globalDiscountType = 'percentage' }) => {
    const rate = get().taxRate;
    set({
      items: items.map((i) => ({ ...i, vatRate: rate })),
      globalDiscount,
      globalDiscountType,
      offerDiscount: 0,
      loyaltyDiscount: 0,
    });
  },

  setGlobalDiscount: (discount, type) => {
    set({ globalDiscount: discount, globalDiscountType: type });
  },

  setOfferDiscount: (discount) => {
    if (get().offerDiscount === discount) return;
    set({ offerDiscount: discount });
  },

  setLoyaltyDiscount: (discount) => {
    if (get().loyaltyDiscount === discount) return;
    set({ loyaltyDiscount: discount });
  },

  setTaxRate: (rate) => {
    set((state) => ({
      taxRate: rate,
      items: state.items.map((item) => ({ ...item, vatRate: rate })),
    }));
  },

  getTaxSummary: (loyaltyOverrideGross) => {
    const { items, globalDiscount, globalDiscountType, offerDiscount, loyaltyDiscount, taxRate } =
      get();
    return calculateVatInclusiveOrder({
      items: items.map((item) => ({
        quantity: Number(item.cartQuantity) || 0,
        unitPrice: getItemPrice(item),
        discount: Number(item.discount) || 0,
        discountType: item.discountType,
        vatRate: taxRate !== undefined ? taxRate : Number(item.vatRate) || 0,
      })),
      globalDiscount,
      globalDiscountType,
      offerDiscountGross: offerDiscount,
      loyaltyDiscountGross:
        loyaltyOverrideGross !== undefined ? loyaltyOverrideGross : loyaltyDiscount,
      defaultTaxRate: taxRate,
    });
  },

  getSubTotal: () => get().getTaxSummary().grossSubtotal,

  getTaxTotal: () => get().getTaxSummary().taxAmount,

  getDiscountTotal: () => get().getTaxSummary().grossDiscountTotal,

  getGrandTotal: () => get().getTaxSummary().netAmount,
}));
