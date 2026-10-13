import { defineConfig } from 'vitest/config';

// 本应用的单元测试配置（覆盖 src/ 和 electron/harness/ 下的测试）。
// 与仓库根 vitest.config.ts 隔离，避免被其 include 规则忽略。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'electron/harness/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    includeSource: [],
  },
});
