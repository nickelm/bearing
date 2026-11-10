import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Keep Vite's dependency cache out of the project tree. Inside a synced folder
// (Dropbox, OneDrive) Vite's atomic rename of node_modules/.vite/deps fails with
// EBUSY, even when node_modules is excluded from sync. See docs/decisions.md.
const projectHash = createHash('sha1')
  .update(import.meta.dirname)
  .digest('hex')
  .slice(0, 8);

/** Shared with vitest.tools.config.ts. */
export const cacheDir = join(tmpdir(), 'vite-cache', `bearing-${projectHash}`);

export default defineConfig(({ command, isPreview }) => ({
  // Production is a GitHub Pages project site at /bearing/ (decision 40). The dev
  // server and Vitest stay at the root; `vite preview` serves the build under its base.
  base: command === 'build' || isPreview ? '/bearing/' : '/',
  cacheDir,
  build: {
    // WebGPU-only project: every supported browser handles modern syntax and top-level await.
    target: 'esnext',
    // three/webgpu alone is ~850 kB minified; revisit with code splitting in milestone 8.
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Grid-wide CPU tests share the machine with the Dawn GPU tests; 5 s is too tight.
    testTimeout: 30_000,
  },
}));
