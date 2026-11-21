import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const nativeSqliteBuild = process.env.POS_NATIVE_SQLITE_BUILD === '1';
  const nativeDatabaseAdapter = {
    name: 'native-sqlite-database-adapter',
    enforce: 'pre' as const,
    resolveId(source: string) {
      if (/(?:^|\/)db\/db(?:\.ts)?$/.test(source)) {
        return path.resolve(process.cwd(), 'src/db/nativeRuntimeStub.ts');
      }
      return null;
    },
  };
  return {
    plugins: [react(), tailwindcss(), ...(nativeSqliteBuild ? [nativeDatabaseAdapter] : [])],
    base: './',
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
