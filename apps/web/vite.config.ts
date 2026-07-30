import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind a todas las interfaces (IPv4 + IPv6). En Windows, si no se setea,
    // Vite solo escucha en [::1] (IPv6) y los navegadores que resuelven
    // localhost a 127.0.0.1 (IPv4) obtienen ERR_CONNECTION_REFUSED.
    host: true,
    proxy: {
      // Proxy de la API en dev para evitar CORS y compartir cookies.
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
