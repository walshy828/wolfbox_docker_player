import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the UI runs on Vite and the service on uvicorn. Point
    // WOLFBOX_API elsewhere to develop against the Docker container instead
    // (docker-compose publishes it on 8088).
    proxy: { '/api': process.env.WOLFBOX_API ?? 'http://localhost:8080' },
  },
  build: { outDir: 'dist' },
});
