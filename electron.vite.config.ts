import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { documentAdapter } from './scripts/document-adapter';

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve('apps/desktop/src/main/index.ts'),
          'knowledge-worker': resolve('apps/desktop/src/main/knowledge-worker.ts'),
          'asr-worker': resolve('apps/desktop/src/main/asr-worker.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      isolatedEntries: true,
      externalizeDeps: false,
      rollupOptions: {
        input: {
          shell: resolve('apps/desktop/src/preload/shell.ts'),
          observer: resolve('apps/desktop/src/preload/observer.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    optimizeDeps: {
      // Keep the pinned offline/rendering adapters active in development too.
      exclude: ['pptx-browser', '@huggingface/transformers', 'tesseract.js'],
      include: [
        'rehype-katex',
        'rehype-raw',
        'rehype-sanitize',
        'remark-frontmatter',
        'remark-gfm',
        'remark-math',
        'remark-parse',
        'remark-rehype',
        'unified',
      ],
    },
    resolve: {
      alias: {
        'decode-named-character-reference': resolve('node_modules/decode-named-character-reference/index.js'),
        'hast-util-from-html-isomorphic': resolve('node_modules/hast-util-from-html-isomorphic/lib/index.js'),
      },
    },
    root: resolve('apps/desktop/src/renderer'),
    plugins: [
      {
        name: 'local-recognition-assets',
        configResolved() {
          const base = resolve('apps/desktop/src/renderer/public/recognition-runtime');
          for (const dir of ['onnx', 'tesseract', 'languages'])
            mkdirSync(resolve(base, dir), { recursive: true });
          for (const file of readdirSync(resolve('node_modules/onnxruntime-web/dist')))
            if (/\.wasm$|^ort-wasm.*\.mjs$/.test(file))
              cpSync(resolve('node_modules/onnxruntime-web/dist', file), resolve(base, 'onnx', file));
          for (const file of readdirSync(resolve('node_modules/tesseract.js-core')))
            if (/\.wasm(?:\.js)?$/.test(file))
              cpSync(resolve('node_modules/tesseract.js-core', file), resolve(base, 'tesseract', file));
          cpSync(
            resolve('node_modules/tesseract.js/dist/worker.min.js'),
            resolve(base, 'tesseract/worker.min.js'),
          );
          for (const lang of ['chi_sim', 'eng'])
            cpSync(
              resolve('node_modules/@tesseract.js-data', lang, '4.0.0', lang + '.traineddata.gz'),
              resolve(base, 'languages', lang + '.traineddata.gz'),
            );
          cpSync(resolve('vendor/recognition/audio-worklet.js'), resolve(base, 'audio-worklet.js'));
        },
      },
      {
        name: 'local-document-assets',
        configResolved() {
          const target = resolve('apps/desktop/src/renderer/public/pdf-assets');
          mkdirSync(target, { recursive: true });
          for (const folder of ['cmaps', 'standard_fonts', 'wasm'])
            cpSync(resolve('node_modules/pdfjs-dist', folder), resolve(target, folder), { recursive: true });
        },
        transform: documentAdapter,
      },
      react(),
      {
        name: 'development-csp',
        apply: 'serve',
        transformIndexHtml(html: string) {
          return html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';");
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('apps/desktop/src/renderer/index.html'),
          player: resolve('apps/desktop/src/renderer/player.html'),
          decoder: resolve('apps/desktop/src/renderer/native-decoder.html'),
          documentEngine: resolve('apps/desktop/src/renderer/document-engine.html'),
          recognitionEngine: resolve('apps/desktop/src/renderer/recognition-engine.html'),
        },
      },
    },
  },
});
