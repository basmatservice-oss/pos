import { Capacitor } from '@capacitor/core';
import type { Html5Qrcode } from 'html5-qrcode';
import { normalizeBarcodeValue } from './barcodeValue';
import { startProductBarcodeCamera } from './barcodeScanner';

export type ProductBarcodeCaptureSession = {
  engine: 'android-mlkit' | 'web-zxing';
  stop: () => Promise<void>;
};

type BarcodeResult = {
  rawValue?: string | null;
  displayValue?: string | null;
};

function extractNativeBarcodeValues(event: any): string[] {
  const candidates: BarcodeResult[] = Array.isArray(event?.barcodes)
    ? event.barcodes
    : event?.barcode
      ? [event.barcode]
      : [];
  return candidates
    .map((barcode) => normalizeBarcodeValue(barcode?.rawValue || barcode?.displayValue))
    .filter(Boolean);
}

/**
 * Android uses CameraX + bundled Google ML Kit through the Capacitor native
 * plugin. Browser/Electron keeps the bundled ZXing html5-qrcode path.
 * The native preview is rendered behind the WebView, so the scanner surface
 * must be the only visible WebView layer while the native session is active.
 */
export async function startProductBarcodeCapture(
  webScanner: Html5Qrcode | null,
  onSuccess: (barcode: string) => void,
  onDecodeFailure: (message: string) => void,
): Promise<ProductBarcodeCaptureSession> {
  if (Capacitor.getPlatform() === 'android') {
    const { BarcodeScanner, BarcodeFormat, LensFacing, Resolution } =
      await import('@capacitor-mlkit/barcode-scanning');

    let active = true;
    const deliver = (event: unknown) => {
      if (!active) return;
      const barcode = extractNativeBarcodeValues(event)[0];
      if (barcode) onSuccess(barcode);
    };

    const pluralListener = await BarcodeScanner.addListener('barcodesScanned', deliver);
    const singularListener = await BarcodeScanner.addListener('barcodeScanned' as any, deliver);
    const errorListener = await BarcodeScanner.addListener('scanError', (event) => {
      if (active) onDecodeFailure(event.message || 'Native barcode scanner reported an error');
    });

    try {
      const support = await BarcodeScanner.isSupported();
      if (!support.supported) {
        throw new Error('لا توجد كاميرا متوافقة متاحة على هذا الجهاز.');
      }

      let permission = await BarcodeScanner.checkPermissions();
      if (permission.camera !== 'granted') {
        permission = await BarcodeScanner.requestPermissions();
      }
      if (permission.camera !== 'granted') {
        throw new Error('لم يتم منح إذن الكاميرا. اسمح للتطبيق باستخدام الكاميرا من إعدادات Android.');
      }

      document.body.classList.add('barcode-scanner-active');
      await BarcodeScanner.startScan({
        formats: [
          BarcodeFormat.Ean13,
          BarcodeFormat.Ean8,
          BarcodeFormat.UpcA,
          BarcodeFormat.UpcE,
          BarcodeFormat.Code128,
          BarcodeFormat.Code39,
          BarcodeFormat.Code93,
          BarcodeFormat.Codabar,
          BarcodeFormat.Itf,
          BarcodeFormat.QrCode,
          BarcodeFormat.DataMatrix,
          BarcodeFormat.Pdf417,
          BarcodeFormat.Aztec,
        ],
        lensFacing: LensFacing.Back,
        resolution: Resolution['1920x1080'],
      });
    } catch (error) {
      active = false;
      document.body.classList.remove('barcode-scanner-active');
      await Promise.allSettled([
        pluralListener.remove(),
        singularListener.remove(),
        errorListener.remove(),
        BarcodeScanner.stopScan(),
      ]);
      throw error;
    }

    return {
      engine: 'android-mlkit',
      stop: async () => {
        if (!active) return;
        active = false;
        document.body.classList.remove('barcode-scanner-active');
        await Promise.allSettled([
          pluralListener.remove(),
          singularListener.remove(),
          errorListener.remove(),
          BarcodeScanner.stopScan(),
        ]);
      },
    };
  }

  if (!webScanner) {
    throw new Error('Web barcode scanner was not initialized');
  }

  await startProductBarcodeCamera(webScanner, onSuccess, onDecodeFailure);
  return {
    engine: 'web-zxing',
    stop: async () => {
      try {
        if (webScanner.isScanning) await webScanner.stop();
      } finally {
        await webScanner.clear();
      }
    },
  };
}
