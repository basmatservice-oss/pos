/**
 * Shared numeric formatting for the POS interface.
 *
 * Storage and calculations must use raw numeric values; these helpers are
 * presentation-only and must never be used to persist formatted strings.
 */

/**
 * Format a monetary amount using the application's required separators:
 * comma for thousands and dot for decimals (for example, 1,000.00).
 *
 * @param {number|string|null|undefined} value
 * @param {{ minimumFractionDigits?: number, maximumFractionDigits?: number }} [options]
 * @returns {string}
 */
export function formatAmount(value, options = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';

  const minimumFractionDigits = options.minimumFractionDigits ?? 2;
  const maximumFractionDigits = options.maximumFractionDigits ?? 2;

  if (
    !Number.isInteger(minimumFractionDigits) ||
    !Number.isInteger(maximumFractionDigits) ||
    minimumFractionDigits < 0 ||
    maximumFractionDigits < minimumFractionDigits ||
    maximumFractionDigits > 20
  ) {
    throw new RangeError('Invalid fraction digit configuration');
  }

  return new Intl.NumberFormat('en-US', {
    useGrouping: true,
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(amount);
}

/**
 * Format an amount and append an optional ISO currency code.
 *
 * @param {number|string|null|undefined} value
 * @param {string} [currency]
 * @param {{ minimumFractionDigits?: number, maximumFractionDigits?: number }} [options]
 * @returns {string}
 */
export function formatCurrency(value, currency = '', options = {}) {
  const formatted = formatAmount(value, options);
  return currency ? `${formatted} ${currency.trim()}` : formatted;
}

/**
 * Format quantities independently from money. Quantities may be fractional.
 *
 * @param {number|string|null|undefined} value
 * @param {{ maximumFractionDigits?: number }} [options]
 * @returns {string}
 */
export function formatQuantity(value, options = {}) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity)) return '—';

  const maximumFractionDigits = options.maximumFractionDigits ?? 3;
  if (
    !Number.isInteger(maximumFractionDigits) ||
    maximumFractionDigits < 0 ||
    maximumFractionDigits > 20
  ) {
    throw new RangeError('Invalid quantity precision');
  }

  return new Intl.NumberFormat('en-US', {
    useGrouping: true,
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(quantity);
}
