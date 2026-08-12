import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // The integration-heavy App suite exercises full login, task, billing,
    // and SecureStore race flows. Keep a finite budget that also survives
    // loaded CI hosts running native mobile builds in parallel.
    testTimeout: 15_000,
  },
});
