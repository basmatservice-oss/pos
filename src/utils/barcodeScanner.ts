import { Html5QrcodeSupportedFormats } from 'html5-qrcode';

/**
 * Product labels vary widely in size and symbology. Keep one broad format
 * profile for every camera entry point so POS, inventory and mobile sales
 * behave consistently.
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
];

/**
 * Do not crop the camera frame with qrbox: narrow/short retail labels can
 * otherwise fall outside the decode region. Prefer a high-resolution rear
 * camera stream; use the native BarcodeDetector path where supported.
 */
export const PRODUCT_BARCODE_CAMERA_CONFIG = {
  fps: 15,
  aspectRatio: 16 / 9,
  disableFlip: false,
  videoConstraints: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
};
