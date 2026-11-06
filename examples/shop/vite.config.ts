import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The storefront dev server (8781) proxies /api to the shop backend (8780). In production the backend serves dist/.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8780' } },
  build: { chunkSizeWarningLimit: 600 },
});
