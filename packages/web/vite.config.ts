import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// ADR-0026。`@sec/core` はソースのまま解決される（ワークスペースのリンクなので
// Vite の変換を通る）。**core 側にビルド段を足さずに済むのはこのため。**
export default defineConfig({
  plugins: [react()],
});
