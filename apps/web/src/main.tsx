import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

try {
  const storedMode = localStorage.getItem('kai.color-mode.v1');
  document.documentElement.dataset.colorMode = storedMode === 'light' || storedMode === 'dark'
    ? storedMode
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
} catch {
  document.documentElement.dataset.colorMode = 'light';
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

if ('serviceWorker' in navigator && import.meta.env.PROD && /^https?:$/.test(window.location.protocol)) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // A failed offline cache must never stop chat or login.
    });
  });
}
