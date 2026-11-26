import test from 'node:test';
import assert from 'node:assert/strict';
import { Html5Qrcode } from 'html5-qrcode';
import { startProductBarcodeCapture } from '../src/utils/productBarcodeCapture.ts';

test('desktop barcode capture starts and fully releases the ZXing camera session', async () => {
  const originalGetCameras = Html5Qrcode.getCameras;
  Html5Qrcode.getCameras = async () => [{ id: 'test-camera', label: 'Back Camera' }];
  const calls = [];
  const scanner = {
    isScanning: true,
    start: async () => { calls.push('start'); },
    applyVideoConstraints: async () => {},
    stop: async () => { calls.push('stop'); scanner.isScanning = false; },
    clear: async () => { calls.push('clear'); },
  };

  try {
    const session = await startProductBarcodeCapture(scanner, () => {}, () => {});
    assert.equal(session.engine, 'web-zxing');
    assert.deepEqual(calls, ['start']);
    await session.stop();
    assert.deepEqual(calls, ['start', 'stop', 'clear']);
  } finally {
    Html5Qrcode.getCameras = originalGetCameras;
  }
});
