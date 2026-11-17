export function getBasePerDocumentUnit(rate, documentCurrencyCode, baseCurrencyCode) {
  const value = Number(rate?.rate);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('Exchange rate must be a positive finite number');
  }
  if (rate.baseCurrencyCode === documentCurrencyCode && rate.quoteCurrencyCode === baseCurrencyCode) {
    return value;
  }
  if (rate.baseCurrencyCode === baseCurrencyCode && rate.quoteCurrencyCode === documentCurrencyCode) {
    return 1 / value;
  }
  throw new RangeError('Exchange rate currency pair does not match the purchase currencies');
}
