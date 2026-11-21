/** Normalize Arabic-Indic and Persian digits for numeric form controls. */
export function normalizeNumericInput(value: string): string {
  return String(value ?? '')
    .replace(/[٠-٩۰-۹]/g, (digit) => {
      const code = digit.charCodeAt(0);
      return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
    })
    .replace(/[٫]/g, '.')
    .replace(/[٬]/g, ',');
}
