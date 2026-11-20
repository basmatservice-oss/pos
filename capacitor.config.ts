import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.smartpos.studio',
  appName: 'Smart POS Studio',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
  },
};

export default config;
