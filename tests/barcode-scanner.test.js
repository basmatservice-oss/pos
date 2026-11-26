import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_BARCODE_CAMERA_CONFIG, PRODUCT_BARCODE_FORMATS, PRODUCT_BARCODE_VIDEO_CONSTRAINTS } from '../src/utils/barcodeScanner.ts';

test('camera scanner supports common retail and 2D barcode symbologies', () => {
  assert.ok(PRODUCT_BARCODE_FORMATS.length >= 15);
  assert.ok(PRODUCT_BARCODE_FORMATS.every((format) => Number.isInteger(format)));
});

test('small-label camera scan uses the full frame and requests high resolution after camera selection', () => {
  assert.equal(PRODUCT_BARCODE_VIDEO_CONSTRAINTS.width.ideal, 1920);
  assert.equal(PRODUCT_BARCODE_VIDEO_CONSTRAINTS.height.ideal, 1080);
  assert.equal(PRODUCT_BARCODE_CAMERA_CONFIG.fps, 10);
  assert.equal(PRODUCT_BARCODE_CAMERA_CONFIG.aspectRatio, 4 / 3);
  assert.equal('qrbox' in PRODUCT_BARCODE_CAMERA_CONFIG, false);
  assert.equal('videoConstraints' in PRODUCT_BARCODE_CAMERA_CONFIG, false);
});

import { attachBarcodeKeyboardListener, createBarcodeScanGate, normalizeBarcodeValue } from '../src/utils/barcodeScanner.ts';

test('barcode normalization removes scanner terminators but preserves leading zeroes', () => {
  assert.equal(normalizeBarcodeValue('  001234567890\r\n '), '001234567890');
  assert.equal(normalizeBarcodeValue('１２３４５'), '12345');
  assert.equal(normalizeBarcodeValue('٠٠١٢٣٤٥٦٧٨٩٠'), '001234567890');
  assert.equal(normalizeBarcodeValue('۰۱۲۳۴۵'), '012345');
});

test('scan gate rejects rapid duplicate frames but accepts a different barcode immediately', () => {
  const gate = createBarcodeScanGate(1200);
  assert.equal(gate('00123', 1000), true);
  assert.equal(gate('00123', 1500), false);
  assert.equal(gate('00999', 1501), true);
  assert.equal(gate('00123', 2301), true);
});


test('keyboard-wedge listener captures a fast scanner burst and preserves zeroes', () => {
  const originalDocument = globalThis.document;
  let listener;
  globalThis.document = {
    addEventListener: (_type, callback) => { listener = callback; },
    removeEventListener: () => {},
  };
  const received = [];
  const detach = attachBarcodeKeyboardListener((barcode) => received.push(barcode));
  const dispatch = (key) => listener({
    key,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: null,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
  try {
    for (const key of '001234567890') dispatch(key);
    dispatch('Enter');
    assert.deepEqual(received, ['001234567890']);
  } finally {
    detach();
    globalThis.document = originalDocument;
  }
});


import { Html5Qrcode } from 'html5-qrcode';
import { startProductBarcodeCamera } from '../src/utils/barcodeScanner.ts';

test('camera startup prefers a labelled rear camera and applies optional resolution', async () => {
  const originalGetCameras = Html5Qrcode.getCameras;
  const started = [];
  const applied = [];
  Html5Qrcode.getCameras = async () => [
    { id: 'front-id', label: 'Front Camera' },
    { id: 'rear-id', label: 'Back Camera' },
  ];
  try {
    const scanner = {
      start: async (source, config) => { started.push({ source, config }); },
      applyVideoConstraints: async (constraints) => { applied.push(constraints); },
    };
    const selected = await startProductBarcodeCamera(scanner, () => {}, () => {});
    assert.equal(started[0].source, 'rear-id');
    assert.equal(selected.id, 'rear-id');
    assert.equal(applied[0].width.ideal, 1920);
  } finally {
    Html5Qrcode.getCameras = originalGetCameras;
  }
});

test('camera startup uses rear-facing constraint when Android hides camera labels', async () => {
  const originalGetCameras = Html5Qrcode.getCameras;
  let selectedSource;
  Html5Qrcode.getCameras = async () => [
    { id: 'camera-0', label: '' },
    { id: 'camera-1', label: '' },
  ];
  try {
    const scanner = {
      start: async (source) => { selectedSource = source; },
      applyVideoConstraints: async () => {},
    };
    await startProductBarcodeCamera(scanner, () => {}, () => {});
    assert.deepEqual(selectedSource, { facingMode: { ideal: 'environment' } });
  } finally {
    Html5Qrcode.getCameras = originalGetCameras;
  }
});
