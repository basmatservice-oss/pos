import { registerPlugin } from '@capacitor/core';
import { isNativeAndroid } from './posLocalDatabase';

interface PosCameraPermissionPlugin {
  requestCameraPermission(): Promise<{ granted: boolean }>;
}

const PosCameraPermission = registerPlugin<PosCameraPermissionPlugin>('PosCameraPermission');

export async function ensureAndroidCameraPermission(): Promise<boolean> {
  if (!isNativeAndroid()) return true;
  const result = await PosCameraPermission.requestCameraPermission();
  return result.granted === true;
}
