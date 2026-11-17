/**
 * Unified numeric & currency formatter enforcing Western numerals,
 * comma thousands separators, and dot decimal point (e.g., 1,000.00).
 */

export function roundQty(n: number): number {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

export function roundAmount(n: number, decimals = 2): number {
  const factor = Math.pow(10, Math.max(0, Math.min(4, decimals)));
  return Math.round((Number(n) || 0) * factor) / factor;
}

export function formatNumber(
  value: number | string | null | undefined,
  decimals = 2,
  minDecimals = decimals
): string {
  const num = Number(value);
  const safeNum = Number.isFinite(num) ? num : 0;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: Math.max(0, minDecimals),
    maximumFractionDigits: Math.max(0, decimals),
    useGrouping: true,
  }).format(safeNum);
}

export function formatMoney(
  value: number | string | null | undefined,
  currency?: string,
  decimals = 2
): string {
  const formatted = formatNumber(value, decimals, decimals);
  return currency ? `${formatted} ${currency}` : formatted;
}

export function formatQty(
  value: number | string | null | undefined,
  maxDecimals = 3
): string {
  const num = Number(value);
  const safeNum = Number.isFinite(num) ? roundQty(num) : 0;
  const hasDecimals = Math.abs(safeNum - Math.round(safeNum)) > 1e-6;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: hasDecimals ? Math.max(1, maxDecimals) : 0,
    useGrouping: true,
  }).format(safeNum);
}

export function formatPercent(value: number | string | null | undefined, decimals = 1): string {
  const num = Number(value);
  const safeNum = Number.isFinite(num) ? num : 0;
  return `${formatNumber(safeNum, decimals, decimals)}%`;
}
