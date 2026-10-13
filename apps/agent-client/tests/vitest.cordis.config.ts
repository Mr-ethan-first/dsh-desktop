import { defineConfig } from 'vitest/config';

// 隔离配置：仅跑内嵌 Cordis 宿主的单测（纯 Node、依赖 vendoring 的 @cordisjs/core）。
export default defineConfig({
  test: {
    include: ['electron/cordis-host/**/*.test.ts'],
    environment: 'node',
    poolOptions: { threads: { singleThread: true } },
  },
});
