import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { registerSW } from './sw/registerSW.js';
import './styles/styles.css';
import './styles/styles-components.css';

// Kick off SW registration before render so plugin UIs / wasm loads can await
// it. We don't block rendering — the promise resolves to null if the SW isn't
// available and consumers fall back to Blob URLs.
window.__noa = window.__noa ?? {};
window.__noa.swReady = registerSW();

createRoot(document.getElementById('root')).render(<App />);
