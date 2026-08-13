import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { resolveDesktopDevelopmentEndpoints } from '../../scripts/desktop-dev-config.mjs';

export default defineConfig(() => {
  const { renderer, controlPlane } = resolveDesktopDevelopmentEndpoints(process.env);
  return {
    // Relative assets are required when the same build is loaded from Electron
    // and Capacitor instead of from the root of an HTTP origin.
    base: './',
    plugins: [react()],
    server: {
      host: renderer.hostname,
      port: Number(renderer.port),
      strictPort: true,
      proxy: {
        '/api': { target: controlPlane.origin },
        '/v1': { target: controlPlane.origin },
      },
    },
    build: {
      sourcemap: false,
      rollupOptions: {
        input: {
          landing: resolve(__dirname, 'index.html'),
          app: resolve(__dirname, 'app/index.html'),
          compute: resolve(__dirname, 'compute/index.html'),
        },
      },
    },
  };
});
