import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GUI 渲染进程构建（Electron renderer）。
// - base './'：产物用 file:// 加载（生产模式 BrowserWindow.loadFile），不能依赖绝对根路径；
// - outDir dist/renderer：与主进程 bundle（dist/electron）分离，electron main 用相对路径引用。
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
