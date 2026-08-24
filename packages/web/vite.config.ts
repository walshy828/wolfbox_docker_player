import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the UI runs on Vite and the transcoder on uvicorn.
    proxy: { '/api': 'http://localhost:8080' },
  },
  build: { outDir: 'dist' },
});
