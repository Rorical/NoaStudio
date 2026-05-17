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
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'audio-worklet'
            ? 'audio-worklet.js'
            : 'assets/[name]-[hash].js',
      },
    },
  },
});
