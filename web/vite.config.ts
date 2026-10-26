import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// El proxy evita configuración extra en el front: /api → backend en :3000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
