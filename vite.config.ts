import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    // heic2any (~1.3 MB) is lazy-loaded only when an iPhone HEIC photo needs converting.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': backend,
      '/uploads': backend,
      '/health': backend,
      '/socket.io': { target: backend, ws: true },
    },
  },
});
