import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
