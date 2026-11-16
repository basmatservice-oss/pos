export function roundMoney(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export interface TaxCalculationItemInput {
  quantity: number;
  unitPrice: number; // Selling price is VAT-inclusive
  discount?: number;
  discountType?: 'percentage' | 'fixed';
  vatRate?: number;
}

export interface ComputedTaxLine {
  grossBeforeDiscount: number;
  itemDiscountGross: number;
  allocatedOrderDiscountGross: number;
  finalGross: number; // Inclusive of VAT after all discounts
  subTotalExclTax: number; // Before discounts, excl. VAT
  discountExclTax: number; // Effective line discount excl. VAT
  netExclTax: number; // Taxable revenue after discounts
  taxAmount: number; // Extracted VAT
}

export interface ComputedOrderTaxSummary {
  lines: ComputedTaxLine[];
  grossSubtotal: number; // Before discounts, VAT-inclusive
  grossDiscountTotal: number; // Total discounts in VAT-inclusive terms
  totalAmountExclTax: number; // Gross sales before discount, excl. VAT (Account 4100 credit)
  discountAmountExclTax: number; // Total discount excl. VAT (Account 4300 debit)
  netSalesExclTax: number; // Net revenue excl. VAT
  taxAmount: number; // Total VAT (Account 2200 credit)
  netAmount: number; // Final gross total payable by customer
}

/**
 * Extracts net revenue and VAT from a VAT-inclusive gross amount.
 */
export function extractVatFromGross(grossAmount: number, vatRatePercent: number): {
  netExclTax: number;
  vatAmount: number;
} {
  const gross = roundMoney(grossAmount);
  const rate = Number(vatRatePercent) || 0;
  if (gross <= 0 || rate <= 0) {
    return { netExclTax: gross, vatAmount: 0 };
  }
  const netExclTax = roundMoney(gross / (1 + rate / 100));
  const vatAmount = roundMoney(gross - netExclTax);
  return { netExclTax, vatAmount };
}

/**
 * Computes complete VAT-inclusive cart/order totals with proportional order-level
 * discount allocation across line items and exact penny reconciliation.
 */
export function calculateVatInclusiveOrder(params: {
  items: TaxCalculationItemInput[];
  globalDiscount?: number;
  globalDiscountType?: 'percentage' | 'fixed';
  offerDiscountGross?: number;
  loyaltyDiscountGross?: number;
  defaultTaxRate?: number;
}): ComputedOrderTaxSummary {
  const {
    items,
    globalDiscount = 0,
    globalDiscountType = 'percentage',
    offerDiscountGross = 0,
    loyaltyDiscountGross = 0,
    defaultTaxRate = 15,
  } = params;

  if (!items || items.length === 0) {
    return {
      lines: [],
      grossSubtotal: 0,
      grossDiscountTotal: 0,
      totalAmountExclTax: 0,
      discountAmountExclTax: 0,
      netSalesExclTax: 0,
      taxAmount: 0,
      netAmount: 0,
    };
  }

  const prelim = items.map((item) => {
    const qty = Math.max(0, Number(item.quantity) || 0);
    const price = Math.max(0, Number(item.unitPrice) || 0);
    const grossBefore = roundMoney(qty * price);
    const discVal = Math.max(0, Number(item.discount) || 0);
    const itemDiscGross = roundMoney(
      item.discountType === 'fixed'
        ? Math.min(grossBefore, discVal)
        : Math.min(grossBefore, grossBefore * (discVal / 100))
    );
    const afterItemGross = roundMoney(Math.max(0, grossBefore - itemDiscGross));
    const vatRate = item.vatRate !== undefined ? Number(item.vatRate) : Number(defaultTaxRate);
    return { grossBefore, itemDiscGross, afterItemGross, vatRate };
  });

  const grossSubtotal = roundMoney(prelim.reduce((s, l) => s + l.grossBefore, 0));
  const afterItemSum = roundMoney(prelim.reduce((s, l) => s + l.afterItemGross, 0));

  const gDisc = Math.max(0, Number(globalDiscount) || 0);
  const globalDiscGross = roundMoney(
    globalDiscountType === 'percentage'
      ? afterItemSum * (gDisc / 100)
      : Math.min(afterItemSum, gDisc)
  );
  const extraDiscGross = roundMoney(Math.max(0, Number(offerDiscountGross) || 0) + Math.max(0, Number(loyaltyDiscountGross) || 0));
  const orderLevelDiscountGross = roundMoney(Math.min(afterItemSum, globalDiscGross + extraDiscGross));

  // Distribute orderLevelDiscountGross proportionally with penny reconciliation on last positive item
  let remainingOrderDiscount = orderLevelDiscountGross;
  const lastPositiveIdx = prelim.reduce((acc, l, idx) => (l.afterItemGross > 0 ? idx : acc), -1);

  const lines: ComputedTaxLine[] = prelim.map((l, idx) => {
    let allocatedOrderDisc = 0;
    if (orderLevelDiscountGross > 0 && afterItemSum > 0 && l.afterItemGross > 0) {
      if (idx === lastPositiveIdx) {
        allocatedOrderDisc = roundMoney(Math.min(l.afterItemGross, remainingOrderDiscount));
      } else {
        allocatedOrderDisc = roundMoney((l.afterItemGross / afterItemSum) * orderLevelDiscountGross);
        allocatedOrderDisc = Math.min(l.afterItemGross, allocatedOrderDisc);
        remainingOrderDiscount = roundMoney(remainingOrderDiscount - allocatedOrderDisc);
      }
    }

    const finalGross = roundMoney(Math.max(0, l.afterItemGross - allocatedOrderDisc));
    const { netExclTax: preDiscNet } = extractVatFromGross(l.grossBefore, l.vatRate);
    const { netExclTax: finalNet, vatAmount: lineTax } = extractVatFromGross(finalGross, l.vatRate);
    const discountExclTax = roundMoney(Math.max(0, preDiscNet + lineTax - finalGross));

    return {
      grossBeforeDiscount: l.grossBefore,
      itemDiscountGross: l.itemDiscGross,
      allocatedOrderDiscountGross: allocatedOrderDisc,
      finalGross,
      subTotalExclTax: preDiscNet,
      discountExclTax,
      netExclTax: finalNet,
      taxAmount: lineTax,
    };
  });

  const netAmount = roundMoney(lines.reduce((s, l) => s + l.finalGross, 0));
  const taxAmount = roundMoney(lines.reduce((s, l) => s + l.taxAmount, 0));
  const totalAmountExclTax = roundMoney(lines.reduce((s, l) => s + l.subTotalExclTax, 0));
  const netSalesExclTax = roundMoney(netAmount - taxAmount);
  const discountAmountExclTax = roundMoney(Math.max(0, totalAmountExclTax + taxAmount - netAmount));
  const grossDiscountTotal = roundMoney(Math.max(0, grossSubtotal - netAmount));

  return {
    lines,
    grossSubtotal,
    grossDiscountTotal,
    totalAmountExclTax,
    discountAmountExclTax,
    netSalesExclTax,
    taxAmount,
    netAmount,
  };
}
