import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Dev-mode shim: serve the plugin-cache Service Worker at the same URL the
 * production build emits (`/plugin-cache-sw.js`) so `registerSW` can use one
 * stable path. Vite would otherwise leave `/plugin-cache-sw.js` to the SPA
 * fallback and reply with index.html, which fails MIME-type validation.
 */
function pluginCacheSwDev() {
  return {
    name: 'noa-plugin-cache-sw-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (url !== '/plugin-cache-sw.js' && !url.startsWith('/plugin-cache-sw.js?')) {
          return next();
        }
        try {
          const transformed = await server.transformRequest('/src/sw/plugin-cache.sw.ts');
          if (!transformed) return next();
          res.setHeader('Content-Type', 'application/javascript');
          res.setHeader('Service-Worker-Allowed', '/');
          res.setHeader('Cache-Control', 'no-store');
          res.end(transformed.code);
        } catch (err) {
          server.config.logger.error('[noa-plugin-cache-sw-dev] transform failed: ' + err);
          next(err);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), pluginCacheSwDev()],
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
