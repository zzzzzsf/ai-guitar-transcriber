import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { alphaTab } from '@coderline/alphatab-vite';

// alphaTab 官方 Vite 插件：自动把乐谱字体与 sonivox 音源拷贝到 public/alphatab/，
// 保证渲染与播放 100% 本地离线可用（与 docs/吉他扒谱-细化方案 v4.1.md 的离线优先原则一致）。
export default defineConfig({
  plugins: [alphaTab(), react(), tailwindcss()],
  server: { port: 5173 },
});
