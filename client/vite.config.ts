import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  server: {
    host: '127.0.0.1', port: 5174, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3100', '/health': 'http://127.0.0.1:3100' },
    fs: {
      strict: true,
      allow: ['.', '../shared', '../node_modules'].map(path => fileURLToPath(new URL(path, import.meta.url))),
      deny: ['.env', '.env.*', '**/*.{crt,pem}', '**/.git/**', '**/*.sqlite*', '**/.local/**', '**/phase1-management/**'],
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
