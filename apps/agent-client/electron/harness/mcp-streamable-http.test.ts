/**
 * McpRuntime × streamable-http 端到端测试。
 *
 * 启动一个进程内的最小 MCP 服务器（真实 HTTP，监听随机端口）：
 * - 在 `initialize` 响应头返回 `Mcp-Session-Id`
 * - 要求后续 `tools/list` / `tools/call` 带相同会话标识
 *
 * 验证：
 * 1. 客户端能发现并注册工具；
 * 2. 会话标识被捕获并在后续请求中回传（真实 server 连接的必要前提）；
 * 3. 工具调用能正确路由并返回内容。
 *
 * 不依赖任何外部网络 / Office 环境，可离线全自动化运行。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Context } from './context'
import { ToolRuntime } from './tools'
import { McpRuntime } from './mcp'

interface Call {
  method: string
  sessionId?: string | undefined
}

function startTestServer(): Promise<{ port: number; calls: Call[]; close: () => void }> {
  const calls: Call[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const rpc = body ? JSON.parse(body) : {}
      calls.push({ method: rpc.method, sessionId: req.headers['mcp-session-id'] as string | undefined })
      const reply = (result: unknown, sessionId?: string) => {
        if (sessionId) res.setHeader('Mcp-Session-Id', sessionId)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
      }
      if (rpc.method === 'initialize') {
        reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 't', version: '1.0' } }, 'sess-xyz')
      } else if (rpc.method === 'tools/list') {
        reply({
          tools: [
            {
              name: 'make_sheet',
              description: 'Create a sheet',
              inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
            },
          ],
        })
      } else if (rpc.method === 'tools/call') {
        reply({ content: [{ type: 'text', text: 'ok' }] })
      } else {
        reply({})
      }
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ port, calls, close: () => server.close() })
    })
  })
}

describe('McpRuntime streamable-http', () => {
  let ctx: Context
  let mcp: McpRuntime
  const servers: Array<{ close: () => void }> = []

  afterEach(() => {
    for (const s of servers) s.close()
    servers.length = 0
  })

  function setup() {
    ctx = new Context()
    ctx.plugin(ToolRuntime as any)
    ctx.plugin(McpRuntime as any)
    mcp = (ctx as any).mcp as McpRuntime
  }

  it('发现并注册工具，且会话标识在 tools/list 中回传', async () => {
    const srv = await startTestServer()
    servers.push(srv)
    setup()

    mcp.addServer({ id: 'office', name: 'Office', url: `http://127.0.0.1:${srv.port}/mcp`, enabled: true })
    const result = await mcp.refreshAllTools()

    expect(result.totalTools).toBe(1)
    expect(mcp.listMcpTools()[0].name).toBe('mcp__office__make_sheet')
    expect(mcp.getConnectionStatus('office')?.connected).toBe(true)

    // initialize 不带会话；tools/list 必须带上服务端下发的 sess-xyz
    const listCall = srv.calls.find((c) => c.method === 'tools/list')
    expect(listCall?.sessionId).toBe('sess-xyz')
  })

  it('工具调用路由到服务器并复用会话标识', async () => {
    const srv = await startTestServer()
    servers.push(srv)
    setup()

    mcp.addServer({ id: 'office', name: 'Office', url: `http://127.0.0.1:${srv.port}/mcp`, enabled: true })
    await mcp.refreshAllTools()

    const tool = (ctx as any).tools.get('mcp__office__make_sheet')
    expect(tool).toBeDefined()
    const out = await tool.execute({ name: '报表' })

    expect(out).toEqual([{ type: 'text', text: 'ok' }])
    const call = srv.calls.find((c) => c.method === 'tools/call')
    expect(call?.sessionId).toBe('sess-xyz')
  })
})
