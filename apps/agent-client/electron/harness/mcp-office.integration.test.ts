/**
 * 办公 MCP 真实集成测试（门控）。
 *
 * 默认跳过。仅在本地先启动办公 MCP 服务后，设置 `DSH_TEST_OFFICE=1` 运行：
 *
 *   OFFICE_ROOT=/path/to/docs node scripts/start-office-mcp.mjs   # 另开终端
 *   DSH_TEST_OFFICE=1 npx vitest run electron/harness/mcp-office.integration.test.ts
 *
 * 验证 exe 通过配置连接的三个办公服务（Excel/Word/PowerPoint）均可发现工具。
 * 不依赖任何外部网络 / Office 环境时自动跳过，保证 CI / 沙箱可全绿。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from './context'
import { ToolRuntime } from './tools'
import { McpRuntime } from './mcp'

const RUN = process.env.DSH_TEST_OFFICE === '1'

const SERVERS = [
  { id: 'office-excel', name: 'Excel', url: process.env.EXCEL_URL || 'http://127.0.0.1:8017/mcp' },
  { id: 'office-word', name: 'Word', url: process.env.WORD_URL || 'http://127.0.0.1:8020/mcp' },
  { id: 'office-ppt', name: 'PowerPoint', url: process.env.PPT_URL || 'http://127.0.0.1:8021/mcp' },
]

describe.skipIf(!RUN)('办公 MCP 集成（需本地已启动服务）', () => {
  let ctx: Context
  let mcp: McpRuntime

  beforeEach(() => {
    ctx = new Context()
    ctx.plugin(ToolRuntime as any)
    ctx.plugin(McpRuntime as any)
    mcp = (ctx as any).mcp as McpRuntime
  })

  for (const s of SERVERS) {
    it(`${s.name}（${s.url}）可连接并发现工具`, async () => {
      mcp.addServer({ id: s.id, name: s.name, url: s.url, enabled: true })
      const status = await mcp.testConnection(s.id)
      expect(status.ok, `${s.name} 连接失败：${status.error}`).toBe(true)
      expect(status.toolCount).toBeGreaterThan(0)
    })
  }
})
