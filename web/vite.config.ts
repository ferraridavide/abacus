import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.BACKEND_URL || 'http://localhost:8080';

export default defineConfig(({ mode }) => ({
  // the demo is a static site that may be served from a subpath, such as GitHub Pages' /<repo>/
  base: mode === 'demo' ? './' : '/',
  plugins: [react()],
  server: {
    // Tailscale serve proxies to 127.0.0.1, which is not the same socket as ::1.
    host: '127.0.0.1',
    port: 5173,
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api': backend,
      '/files': backend,
      '/thumbs': backend,
      '/quick-add': backend,
    },
  },
}));
