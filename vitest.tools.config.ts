import { defineConfig } from 'vitest/config';
import base from './vite.config';

/** Runs offline tools under tools/ (e.g. `npm run maps`), not part of `npm test`. */
export default defineConfig({
  cacheDir: base.cacheDir,
  test: {
    environment: 'node',
    include: ['tools/**/*.preview.ts'],
    testTimeout: 600_000,
  },
});
