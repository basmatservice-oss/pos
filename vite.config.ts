import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const nativeSqliteBuild = process.env.POS_NATIVE_SQLITE_BUILD === '1';
  return {
    plugins: [react(), tailwindcss()],
    base: './',
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: [
        { find: '@', replacement: path.resolve(__dirname, '.') },
        ...(nativeSqliteBuild
          ? [{
              // Native Android/Electron builds must not ship or execute Dexie.
              // Browser builds keep the legacy IndexedDB adapter unchanged.
              find: /(?:^|\/)db\/db$/,
              replacement: new URL('./src/db/nativeRuntimeStub.ts', import.meta.url).pathname,
            }]
          : []),
      ],
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
