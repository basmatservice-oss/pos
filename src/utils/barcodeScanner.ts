import { Html5QrcodeSupportedFormats } from 'html5-qrcode';

import { normalizeBarcodeValue } from './barcodeValue';
export { normalizeBarcodeValue } from './barcodeValue';

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
 * saturating lower-powered Android devices. Camera and device input gates are
 * deliberately independent so fast consecutive hardware scans are not lost.
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

/**
 * Capture HID keyboard-wedge scanners even when a particular input is not focused.
 * Most USB/Bluetooth scanners type a burst of characters followed by Enter/Tab.
 * Ordinary human typing is ignored unless the characters arrive at scanner speed.
 */
export function attachBarcodeKeyboardListener(
  onBarcode: (barcode: string) => void,
  options: { maxInterKeyDelayMs?: number; minLength?: number; maxLength?: number } = {},
): () => void {
  const maxInterKeyDelayMs = options.maxInterKeyDelayMs ?? 120;
  const minLength = options.minLength ?? 4;
  const maxLength = options.maxLength ?? 128;
  let buffer = '';
  let lastKeyAt = 0;

  const reset = () => {
    buffer = '';
    lastKeyAt = 0;
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
      reset();
      return;
    }

    const now = Date.now();
    if (lastKeyAt && now - lastKeyAt > maxInterKeyDelayMs) reset();

    if (event.key === 'Enter' || event.key === 'Tab') {
      const barcode = normalizeBarcodeValue(buffer);
      if (barcode.length >= minLength) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const target = event.target as HTMLInputElement | HTMLTextAreaElement | null;
        if (target && typeof target.value === 'string' && buffer && target.value.endsWith(buffer)) {
          const nextValue = target.value.slice(0, -buffer.length);
          const prototype = target instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (valueSetter) valueSetter.call(target, nextValue);
          else target.value = nextValue;
          target.dispatchEvent(new Event('input', { bubbles: true }));
        }
        reset();
        onBarcode(barcode);
      } else {
        reset();
      }
      return;
    }

    if (event.key.length !== 1) {
      if (event.key === 'Escape') reset();
      return;
    }

    // Ignore whitespace and control characters, but preserve all printable
    // barcode characters including leading zeroes and punctuation.
    if (event.key.length === 1 && !/\s/u.test(event.key) && !/^[\u0000-\u001F\u007F]$/.test(event.key)) {
      buffer += event.key;
      lastKeyAt = now;
      if (buffer.length > maxLength) reset();
    } else {
      reset();
    }
  };

  document.addEventListener('keydown', handleKeyDown, true);
  return () => document.removeEventListener('keydown', handleKeyDown, true);
}

