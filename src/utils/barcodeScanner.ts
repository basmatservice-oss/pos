import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
// Build trigger: verified barcode capture, normalization, and camera tuning.

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
  // Keep the full camera frame: narrow labels are often missed by a cropped qrbox.
  fps: 10,
  aspectRatio: 4 / 3,
  disableFlip: true,
  // Do not put videoConstraints here: html5-qrcode gives them precedence over
  // the camera id passed to start(), which can silently defeat rear-camera selection.
};

export const PRODUCT_BARCODE_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};

/**
 * Start with a concrete rear-camera device id instead of relying on the
 * WebView's facingMode implementation. Try remaining devices if that camera
 * cannot be opened (common on older Android WebViews with incomplete labels).
 */
export async function startProductBarcodeCamera(
  scanner: {
    start: (
      cameraId: string | MediaTrackConstraints,
      config: typeof PRODUCT_BARCODE_CAMERA_CONFIG,
      onSuccess: (decodedText: string) => void,
      onError: (errorMessage: string) => void,
    ) => Promise<unknown>;
    applyVideoConstraints?: (constraints: MediaTrackConstraints) => Promise<void>;
  },
  onSuccess: (decodedText: string) => void,
  onDecodeFailure: (errorMessage: string) => void,
): Promise<{ id: string; label: string }> {
  const cameras = await Html5Qrcode.getCameras();
  if (!cameras?.length) throw new Error('لم يتم العثور على كاميرا متاحة');

  const rearCameraPattern = /back|rear|environment|خلفية|خلفي/i;
  const labelledRearCamera = cameras.find((camera) => rearCameraPattern.test(camera.label || ''));
  const ordered: Array<{ id: string; label: string; source: string | MediaTrackConstraints }> =
    labelledRearCamera
      ? [
          ...[labelledRearCamera, ...cameras.filter((camera) => camera.id !== labelledRearCamera.id)]
            .map((camera) => ({ id: camera.id, label: camera.label || 'Camera', source: camera.id })),
        ]
      : [
          // Older Android WebViews often hide camera labels until a stream is
          // active. Prefer the browser's rear-facing constraint in that case.
          { id: 'environment', label: 'Rear camera', source: { facingMode: { ideal: 'environment' } } },
          ...cameras.map((camera) => ({ id: camera.id, label: camera.label || 'Camera', source: camera.id })),
        ];

  let lastError: unknown;
  for (const camera of ordered) {
    try {
      await scanner.start(camera.source, PRODUCT_BARCODE_CAMERA_CONFIG, onSuccess, onDecodeFailure);
      try {
        await scanner.applyVideoConstraints?.(PRODUCT_BARCODE_VIDEO_CONSTRAINTS);
      } catch (error) {
        // Resolution is an enhancement; a camera that has already started
        // must remain usable when a device rejects optional constraints.
        console.debug('Optional barcode resolution request was rejected:', error);
      }
      return { id: camera.id, label: camera.label };
    } catch (error) {
      lastError = error;
      console.warn('Unable to start barcode camera:', camera.label || camera.id, error);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'تعذر تشغيل أي كاميرا'));
}

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



/**
 * Use camera controls only when the active device explicitly reports support.
 * Continuous focus and a modest zoom materially help narrow retail labels.
 */
export async function optimizeBarcodeCamera(scanner: unknown): Promise<void> {
  const camera = scanner as {
    getRunningTrackCapabilities?: () => MediaTrackCapabilities;
    applyVideoConstraints?: (constraints: MediaTrackConstraints) => Promise<void>;
  };
  if (typeof camera?.getRunningTrackCapabilities !== 'function' ||
      typeof camera?.applyVideoConstraints !== 'function') return;

  try {
    const capabilities = camera.getRunningTrackCapabilities();
    const advanced: Array<Record<string, unknown>> = [];
    const focusModes = (capabilities as any)?.focusMode;
    if (Array.isArray(focusModes) && focusModes.includes('continuous')) {
      advanced.push({ focusMode: 'continuous' });
    }
    const zoom = (capabilities as any)?.zoom;
    if (zoom && Number.isFinite(zoom.max) && Number.isFinite(zoom.min) && zoom.max > zoom.min) {
      advanced.push({ zoom: Math.min(2, zoom.max) });
    }
    if (advanced.length) {
      await camera.applyVideoConstraints({ advanced } as MediaTrackConstraints);
    }
  } catch (error) {
    // Unsupported or locked camera controls must never stop barcode scanning.
    console.debug('Optional barcode camera optimization unavailable:', error);
  }
}
