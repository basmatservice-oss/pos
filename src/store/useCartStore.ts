import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { generateUUID } from '../utils/uuid';
import type { Product, ProductUnit } from '../db/db';
import { calculateVatInclusiveOrder } from '../utils/tax';
import type { ComputedOrderTaxSummary } from '../utils/tax';
import { roundQty } from '../utils/format';

export interface CartItem extends Product {
  cartItemId: string;
  cartQuantity: number;
  discount: number;
  discountType: 'percentage' | 'fixed';
  costPriceAtTimeOfSale: number;
  selectedUnit: string;
  selectedConversionFactor?: number;
  selectedUnitPrice?: number;
}

export function getProductUnits(product: Product): ProductUnit[] {
  const baseUnitName = product.unit || 'piece';
  const base: ProductUnit = {
    name: baseUnitName,
    barcode: product.barcode,
    conversionFactor: 1,
    sellingPrice: Number(product.sellingPrice || 0),
    costPrice: Number(product.costPrice || 0),
    allowFractions: Boolean(product.allowFractions),
  };

  const extra: ProductUnit[] = [];
  if (product.unitsJson) {
    try {
      const parsed = JSON.parse(product.unitsJson);
      if (Array.isArray(parsed)) {
        for (const u of parsed) {
          if (u && u.name && Number(u.conversionFactor) > 0) {
            extra.push({
              name: String(u.name),
              barcode: u.barcode ? String(u.barcode) : undefined,
              conversionFactor: Number(u.conversionFactor),
              sellingPrice: Number(u.sellingPrice ?? Number(product.sellingPrice || 0) * Number(u.conversionFactor)),
              costPrice: u.costPrice !== undefined ? Number(u.costPrice) : undefined,
              allowFractions: Boolean(u.allowFractions),
            });
          }
        }
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  // Legacy box support when unitsJson has no 'box' and conversionFactor > 1
  if (
    Number(product.conversionFactor || 1) > 1 &&
    !extra.some((u) => u.name === 'box')
  ) {
    extra.push({
      name: 'box',
      conversionFactor: Number(product.conversionFactor),
      sellingPrice: Number(product.sellingPrice || 0) * Number(product.conversionFactor),
      costPrice: Number(product.costPrice || 0) * Number(product.conversionFactor),
      allowFractions: false,
    });
  }

  // Ensure base unit ('piece' or product.unit) is available alongside extra units
  const list = [base, ...extra.filter((u) => u.name !== base.name && u.name !== 'piece')];
  if (base.name !== 'piece' && !list.some((u) => u.name === 'piece')) {
    list.unshift({ ...base, name: 'piece' });
  }
  return list;
}

export function getItemUnitFactor(item: CartItem): number {
  const units = getProductUnits(item);
  const matched = units.find((u) => u.name === item.selectedUnit);
  if (matched && matched.conversionFactor > 0) return matched.conversionFactor;
  if (item.selectedUnit === 'box' && item.conversionFactor) {
    return Number(item.conversionFactor) || 1;
  }
  return Number(item.selectedConversionFactor || 1) || 1;
}

export const getItemPrice = (item: CartItem) => {
  const units = getProductUnits(item);
  const matched = units.find((u) => u.name === item.selectedUnit);
  if (matched && matched.sellingPrice >= 0) {
    return Number(matched.sellingPrice) || 0;
  }
  if (item.selectedUnitPrice !== undefined && item.selectedUnitPrice >= 0) {
    return Number(item.selectedUnitPrice) || 0;
  }
  const basePrice = Number(item.sellingPrice) || 0;
  if (item.selectedUnit === 'box' && item.conversionFactor) {
    return basePrice * (Number(item.conversionFactor) || 1);
  }
  return basePrice;
};

interface CartState {
  items: CartItem[];
  globalDiscount: number;
  globalDiscountType: 'percentage' | 'fixed';
  offerDiscount: number;
  loyaltyDiscount: number;
  taxRate: number;

  // Actions
  addItem: (product: Product, unit?: string, initialQuantity?: number) => void;
  removeItem: (cartItemId: string) => void;
  updateQuantity: (cartItemId: string, quantity: number) => void;
  updateItemUnit: (cartItemId: string, unit: string) => void;
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
  getSubTotal: () => number;
  getTaxTotal: () => number;
  getDiscountTotal: () => number;
  getGrandTotal: () => number;
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      globalDiscount: 0,
      globalDiscountType: 'percentage',
      offerDiscount: 0,
      loyaltyDiscount: 0,
      taxRate: 15,

      addItem: (product, unit, initialQuantity = 1) => {
        const targetUnit = unit || 'piece';
        const units = getProductUnits(product);
        const unitMeta = units.find((u) => u.name === targetUnit);
        const qtyToAdd = roundQty(Math.max(0.001, initialQuantity));

        set((state) => {
          const existingItem = state.items.find(
            (item) => item.id === product.id && item.selectedUnit === targetUnit
          );
          if (existingItem) {
            return {
              items: state.items.map((item) =>
                item.id === product.id && item.selectedUnit === targetUnit
                  ? { ...item, cartQuantity: roundQty(item.cartQuantity + qtyToAdd) }
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
                cartQuantity: qtyToAdd,
                discount: 0,
                discountType: 'percentage',
                costPriceAtTimeOfSale: unitMeta?.costPrice ?? product.costPrice,
                vatRate: state.taxRate,
                selectedUnit: targetUnit,
                selectedConversionFactor: unitMeta?.conversionFactor ?? 1,
                selectedUnitPrice: unitMeta?.sellingPrice ?? product.sellingPrice,
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
          items: state.items.map((item) => {
            if (item.cartItemId !== cartItemId) return item;
            const units = getProductUnits(item);
            const matched = units.find((u) => u.name === item.selectedUnit);
            const isFractional = Boolean(item.allowFractions) || Boolean(matched?.allowFractions);
            const cleanQty = isFractional
              ? Math.max(0.001, roundQty(quantity))
              : Math.max(1, Math.round(quantity || 1));
            return { ...item, cartQuantity: cleanQty };
          }),
        }));
      },

      updateItemUnit: (cartItemId, unit) => {
        set((state) => ({
          items: state.items.map((item) => {
            if (item.cartItemId !== cartItemId) return item;
            const units = getProductUnits(item);
            const matched = units.find((u) => u.name === unit);
            return {
              ...item,
              selectedUnit: unit,
              selectedConversionFactor: matched?.conversionFactor ?? (unit === 'box' ? item.conversionFactor || 1 : 1),
              selectedUnitPrice: matched?.sellingPrice,
            };
          }),
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
    }),
    {
      name: 'davinci-pos-cart-draft',
      partialize: (state) => ({
        items: state.items,
        globalDiscount: state.globalDiscount,
        globalDiscountType: state.globalDiscountType,
        offerDiscount: state.offerDiscount,
        loyaltyDiscount: state.loyaltyDiscount,
        taxRate: state.taxRate,
      }),
    }
  )
);
