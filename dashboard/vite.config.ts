import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `new URL(...).pathname`, not node:path — this tree has no @types/node and the
// strict tsconfig type-checks vite.config.ts.
const srcDir = new URL('./src', import.meta.url).pathname;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': srcDir } },
  base: '/dashboard/static/',
  build: {
    // Sibling of `dist/dashboard/` (the host's compiled API handlers).
    // Sharing the dir caused Vite's emptyOutDir to wipe the host's
    // `dist/dashboard/index.js` and crash the service on next boot.
    outDir: '../dist/dashboard-spa',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
