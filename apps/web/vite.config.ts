import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative assets are required when the same build is loaded from Electron
  // and Capacitor instead of from the root of an HTTP origin.
  base: './',
  plugins: [react()],
  build: {
    sourcemap: false,
  },
});
