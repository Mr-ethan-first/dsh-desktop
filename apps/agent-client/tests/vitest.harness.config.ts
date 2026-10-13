import { defineConfig } from 'vitest/config'

// 隔离配置：仅跑 harness 单元测试（纯 Node、零外部依赖）。
// 不引入仓库根 vitest.config.ts 的全局 setup（其依赖未安装的 cordis 包）。
export default defineConfig({
  test: {
    include: ['apps/agent-client/electron/harness/agent-loop.secure.test.ts'],
    environment: 'node',
    poolOptions: { threads: { singleThread: true } },
  },
})
