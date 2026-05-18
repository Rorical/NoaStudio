import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    headers: isolationHeaders,
  },
  preview: {
    port: 5173,
    headers: isolationHeaders,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        'audio-worklet': resolve(import.meta.dirname, 'src/engine/audio-worklet.ts'),
        'coordinator-worker': resolve(import.meta.dirname, 'src/coordinator/coordinator.worker.ts'),
        // The Service Worker emits at the build root with a stable filename so
        // navigator.serviceWorker.register('/plugin-cache-sw.js') resolves
        // identically in dev (Vite serves it under /src/...) and prod.
        'plugin-cache-sw': resolve(import.meta.dirname, 'src/sw/plugin-cache.sw.ts'),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'audio-worklet') return 'audio-worklet.js';
          if (chunk.name === 'coordinator-worker') return 'coordinator-worker.js';
          if (chunk.name === 'plugin-cache-sw') return 'plugin-cache-sw.js';
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
