import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { registerSW } from './sw/registerSW.js';
import { openOpfsPluginStore } from './sw/openOpfsPluginStore.js';
import { seedBuiltins } from './sw/seedBuiltins.js';
import './styles/styles.css';
import './styles/styles-components.css';

// Kick off SW registration before render so plugin UIs / wasm loads can await
// it. We don't block rendering — the promise resolves to null if the SW isn't
// available and consumers fall back to Blob URLs.
window.__noa = window.__noa ?? {};
window.__noa.swReady = registerSW();

// First-boot OPFS seed for the built-in plugins. Runs in parallel with SW
// registration since the OPFS layer is independent; consumers that need to
// fetch via the SW should await both `swReady` and `seedReady`.
window.__noa.seedReady = (async () => {
  try {
    const store = await openOpfsPluginStore();
    if (store) await seedBuiltins(store);
  } catch (err) {
    console.warn('[noa] OPFS seed failed:', err);
  }
})();

createRoot(document.getElementById('root')).render(<App />);
