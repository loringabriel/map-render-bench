import { defineConfig } from 'vite';

export default defineConfig({
  // MapLibre 6 ships its worker as a sibling module resolved from import.meta.url;
  // keep it out of the dep pre-bundle so that sibling exists in dev.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
