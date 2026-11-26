/** Pure helpers for explicit, manual selling-price maintenance. */
export function calculateAdjustedSellingPrice(currentPrice, mode, value) {
  const current = Number(currentPrice);
  const amount = Number(value);
  if (!Number.isFinite(current) || current < 0) throw new Error('السعر الحالي غير صالح');
  if (!Number.isFinite(amount) || amount < 0) throw new Error('قيمة التعديل يجب أن تكون رقمًا موجبًا أو صفرًا');
  let next;
  if (mode === 'set') next = amount;
  else if (mode === 'percent_increase') next = current * (1 + amount / 100);
  else if (mode === 'percent_decrease') next = current * (1 - amount / 100);
  else if (mode === 'amount_increase') next = current + amount;
  else if (mode === 'amount_decrease') next = current - amount;
  else throw new Error('طريقة تعديل السعر غير معروفة');
  if (!Number.isFinite(next) || next < 0) throw new Error('التعديل ينتج سعرًا سالبًا أو غير صالح');
  return Math.round((next + Number.EPSILON) * 100) / 100;
}

/**
 * Manual price edits sever the FX selling-price anchor. Historical order lines,
 * FIFO allocations, returns and journal entries are deliberately not touched.
 */
export function buildManualSellingPriceUpdate(product, nextPrice, now = new Date().toISOString()) {
  const price = Number(nextPrice);
  if (!Number.isFinite(price) || price < 0) throw new Error('سعر البيع الجديد غير صالح');
  return {
    ...product,
    sellingPrice: Math.round((price + Number.EPSILON) * 100) / 100,
    priceInUSD: 0,
    updatedAt: now,
  };
}
