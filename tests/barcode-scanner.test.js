import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_BARCODE_CAMERA_CONFIG, PRODUCT_BARCODE_FORMATS } from '../src/utils/barcodeScanner.ts';

test('camera scanner supports common retail and 2D barcode symbologies', () => {
  assert.ok(PRODUCT_BARCODE_FORMATS.length >= 15);
  assert.ok(PRODUCT_BARCODE_FORMATS.every((format) => Number.isInteger(format)));
});

test('small-label camera scan uses the full frame and requests a high-resolution rear camera', () => {
  assert.equal(PRODUCT_BARCODE_CAMERA_CONFIG.videoConstraints.facingMode.ideal, 'environment');
  assert.equal(PRODUCT_BARCODE_CAMERA_CONFIG.videoConstraints.width.ideal, 1920);
  assert.equal(PRODUCT_BARCODE_CAMERA_CONFIG.videoConstraints.height.ideal, 1080);
  assert.equal(PRODUCT_BARCODE_CAMERA_CONFIG.fps, 15);
  assert.equal('qrbox' in PRODUCT_BARCODE_CAMERA_CONFIG, false);
});
