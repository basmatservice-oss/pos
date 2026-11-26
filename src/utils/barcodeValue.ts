/** Normalize scanner output while preserving significant leading zeroes. */
export function normalizeBarcodeValue(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\\u0000-\\u001F\\u007F]/g, '')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .trim();
}
