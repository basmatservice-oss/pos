import { Html5QrcodeSupportedFormats } from 'html5-qrcode';

/** Normalize scanner output without removing significant leading zeroes. */
export function normalizeBarcodeValue(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
}

/** Ignore repeated decoder frames while allowing a different code immediately. */
export function createBarcodeScanGate(windowMs = 1200) {
  let lastCode = '';
  let lastTime = 0;
  return (value: unknown, now = Date.now()): boolean => {
    const code = normalizeBarcodeValue(value);
    if (!code) return false;
    if (code === lastCode && now - lastTime < windowMs) return false;
    lastCode = code;
    lastTime = now;
    return true;
  };
}

/**
 * Keep one broad symbology profile for unknown retail labels. The full frame
 * remains available for narrow labels; the decoder is throttled to avoid
 * saturating lower-powered Android devices.
 */
export const PRODUCT_BARCODE_FORMATS = [
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.CODE_93,
  Html5QrcodeSupportedFormats.ITF,
  Html5QrcodeSupportedFormats.CODABAR,
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.DATA_MATRIX,
  Html5QrcodeSupportedFormats.PDF_417,
  Html5QrcodeSupportedFormats.AZTEC,
  Html5QrcodeSupportedFormats.MAXICODE,
  Html5QrcodeSupportedFormats.RSS_14,
  Html5QrcodeSupportedFormats.RSS_EXPANDED,
  Html5QrcodeSupportedFormats.UPC_EAN_EXTENSION,
];

export const PRODUCT_BARCODE_CAMERA_CONFIG = {
  fps: 12,
  aspectRatio: 16 / 9,
  disableFlip: false,
  videoConstraints: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
};
