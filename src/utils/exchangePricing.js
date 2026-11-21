/** Currency-linked product prices are stored as a foreign-currency anchor.
 * Product prices shown and sold remain in the system base currency (SDG).
 */
export function toForeignPriceAnchor(baseAmount, basePerForeignRate, precision = 6) {
  const amount = Number(baseAmount);
  const rate = Number(basePerForeignRate);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('قيمة السعر غير صالحة');
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('يجب اعتماد سعر صرف صحيح قبل ربط السعر');
  return Number((amount / rate).toFixed(precision));
}

export function fromForeignPriceAnchor(foreignAmount, basePerForeignRate, precision = 2) {
  const amount = Number(foreignAmount);
  const rate = Number(basePerForeignRate);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('بيانات تحويل العملة غير صالحة');
  }
  return Number((amount * rate).toFixed(precision));
}

export function buildProductPricingAnchors({ costPrice, sellingPrice, costLinked, sellingLinked, exchangeRate }) {
  return {
    costInUSD: costLinked ? toForeignPriceAnchor(costPrice, exchangeRate) : 0,
    priceInUSD: sellingLinked ? toForeignPriceAnchor(sellingPrice, exchangeRate) : 0,
  };
}

export function repriceLinkedProduct(product, nextRate, precision = 2) {
  const updated = { ...product };
  const linkedCost = Number(product.costInUSD || 0) > 0;
  const linkedSelling = Number(product.priceInUSD || 0) > 0;
  if (linkedCost) updated.costPrice = fromForeignPriceAnchor(product.costInUSD, nextRate, precision);
  if (linkedSelling) updated.sellingPrice = fromForeignPriceAnchor(product.priceInUSD, nextRate, precision);
  if (product.unitsJson) {
    try {
      const units = JSON.parse(product.unitsJson);
      if (Array.isArray(units)) {
        updated.unitsJson = JSON.stringify(units.map((unit) => (
          Number(unit?.priceInUSD || 0) > 0
            ? { ...unit, sellingPrice: fromForeignPriceAnchor(unit.priceInUSD, nextRate, precision) }
            : unit
        )));
      }
    } catch {
      // Preserve malformed legacy unit metadata; do not destroy it during FX repricing.
      updated.unitsJson = product.unitsJson;
    }
  }
  return updated;
}

export function getFxLinkedProductCount(products = []) {
  return products.filter((product) => Number(product?.priceInUSD || 0) > 0 || Number(product?.costInUSD || 0) > 0).length;
}

export function buildProductUnitFxAnchors(units = [], linked, exchangeRate) {
  return units.map((unit) => ({
    ...unit,
    priceInUSD: linked && Number(unit?.sellingPrice) > 0
      ? toForeignPriceAnchor(unit.sellingPrice, exchangeRate)
      : 0,
  }));
}
