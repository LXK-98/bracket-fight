import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Keep the browser's Host header (changeOrigin: false) so the server builds
// join links / QR codes for the address the host screen was opened on.
const backend = { target: `http://localhost:${process.env.PORT ?? 3000}`, changeOrigin: false };

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
      '/socket.io': { ...backend, ws: true },
    },
  },
});
