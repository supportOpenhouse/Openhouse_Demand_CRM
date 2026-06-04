import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: proxy the API to the local backend so the React app is same-origin
// (mirrors prod, where Vercel rewrites /api,/auth,/health to Render).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api':    { target: 'http://127.0.0.1:8011', changeOrigin: true },
      '/auth':   { target: 'http://127.0.0.1:8011', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8011', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
