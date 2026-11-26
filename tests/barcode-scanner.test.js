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

import { createBarcodeScanGate, normalizeBarcodeValue } from '../src/utils/barcodeScanner.ts';

test('barcode normalization removes scanner terminators but preserves leading zeroes', () => {
  assert.equal(normalizeBarcodeValue('  001234567890\\r\\n '), '001234567890');
  assert.equal(normalizeBarcodeValue('１２３４５'), '12345');
});

test('scan gate rejects rapid duplicate frames but accepts a different barcode immediately', () => {
  const gate = createBarcodeScanGate(1200);
  assert.equal(gate('00123', 1000), true);
  assert.equal(gate('00123', 1500), false);
  assert.equal(gate('00999', 1501), true);
  assert.equal(gate('00123', 2301), true);
});
