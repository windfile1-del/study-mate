import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({
  root: resolve('apps/mobile/reader'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      'decode-named-character-reference': resolve('node_modules/decode-named-character-reference/index.js'),
      'hast-util-from-html-isomorphic': resolve('node_modules/hast-util-from-html-isomorphic/lib/index.js'),
    },
  },
  worker: { format: 'es', plugins: () => [] },
  build: {
    target: 'chrome100',
    outDir: resolve('apps/mobile/android/app/src/main/assets/reader'),
    emptyOutDir: true,
  },
});
