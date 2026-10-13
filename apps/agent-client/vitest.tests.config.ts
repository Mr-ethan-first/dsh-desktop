import { defineConfig } from 'vitest/config';

// 覆盖 apps/agent-client/tests/** 下的规格测试（应用外壳层：dsh-web 启动器、
// 插件宿主扫描、cordis host、工作台前置条件等）。
//
// 这些用例原先未被任何配置 include：本地 vitest.config.ts 只收
// `src/**/*.test.ts` 与 `electron/harness/**/*.test.ts`，而 tests/ 目录已随
// 旧兜底 SPA 一并失去 src/ 归属，导致「跑了测试但实际 0 用例」。本配置显式收编，
// 使 `vitest run -c vitest.tests.config.ts` 成为外壳层的门禁。
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    includeSource: [],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
