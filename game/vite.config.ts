import { defineConfig } from 'vite';
import { captureExport } from './scripts/capture-export.ts';
import { jevProxy } from './scripts/jev-proxy.ts';
export default defineConfig({ plugins: [captureExport(), jevProxy()], server: { host: '127.0.0.1', port: 5173, strictPort: true } });
