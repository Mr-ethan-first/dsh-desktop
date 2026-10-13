/**
 * McpRuntime 单元测试。
 *
 * 测试 MCP 服务的核心功能：
 * - 服务器管理（添加、移除、更新）
 * - 工具注册和注销
 * - Schema 转换
 * - 连接状态管理
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Context } from './context'
import { ToolRuntime } from './tools'
import { McpRuntime } from './mcp'

// ============================================================
// Mock fetch 用于模拟 MCP 服务器响应
// ============================================================

function mockFetch(responses: Record<string, unknown>) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    const key = `${url}::${body.method}`
    const response = responses[key]

    if (response === undefined) {
      return {
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: body.id, result: {} }),
      }
    }

    if (response instanceof Error) {
      throw response
    }

    return {
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: body.id, result: response }),
    }
  })
}

// ============================================================
// 测试用例
// ============================================================

describe('McpRuntime', () => {
  let ctx: Context
  let mcp: McpRuntime

  beforeEach(() => {
    ctx = new Context()
    ctx.plugin(ToolRuntime as any)
    ctx.plugin(McpRuntime as any)
    mcp = (ctx as any).mcp as McpRuntime
  })

  describe('服务器管理', () => {
    it('添加服务器', () => {
      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: true,
      })

      const servers = mcp.listServers()
      expect(servers.length).toBe(1)
      expect(servers[0].id).toBe('test-server')
      expect(servers[0].name).toBe('Test Server')
    })

    it('重复添加服务器会报错', () => {
      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: true,
      })

      expect(() =>
        mcp.addServer({
          id: 'test-server',
          name: 'Duplicate',
          url: 'http://localhost:3001/mcp',
          enabled: true,
        }),
      ).toThrow('already exists')
    })

    it('移除服务器', () => {
      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: true,
      })

      mcp.removeServer('test-server')

      const servers = mcp.listServers()
      expect(servers.length).toBe(0)
    })

    it('更新服务器配置', () => {
      mcp.addServer({
        id: 'test-server',
        name: 'Old Name',
        url: 'http://localhost:3000/mcp',
        enabled: true,
      })

      mcp.updateServer('test-server', { name: 'New Name' })

      const servers = mcp.listServers()
      expect(servers[0].name).toBe('New Name')
    })

    it('列出所有服务器', () => {
      mcp.addServer({
        id: 'server-1',
        name: 'Server 1',
        url: 'http://localhost:3001/mcp',
        enabled: true,
      })
      mcp.addServer({
        id: 'server-2',
        name: 'Server 2',
        url: 'http://localhost:3002/mcp',
        enabled: false,
      })

      const servers = mcp.listServers()
      expect(servers.length).toBe(2)
    })
  })

  describe('连接状态', () => {
    it('初始状态为未连接', () => {
      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: false, // 不启用，不自动连接
      })

      const status = mcp.getConnectionStatus('test-server')
      expect(status).toBeDefined()
      expect(status?.connected).toBe(false)
    })

    it('获取不存在的服务器状态返回 undefined', () => {
      const status = mcp.getConnectionStatus('non-existent')
      expect(status).toBeUndefined()
    })

    it('getDiagnostics 返回已注册服务器的诊断信息', () => {
      mcp.addServer({
        id: 'diag-server',
        name: 'Diag Server',
        url: 'http://localhost:3099/mcp',
        enabled: false,
      })
      const diag = mcp.getDiagnostics()
      expect(diag.length).toBe(1)
      expect(diag[0].id).toBe('diag-server')
      expect(diag[0].name).toBe('Diag Server')
      expect(diag[0].url).toBe('http://localhost:3099/mcp')
      expect(diag[0].connected).toBe(false)
      expect(diag[0].toolCount).toBe(0)
    })
  })

  describe('Schema 转换', () => {
    it('正确转换简单字符串参数', async () => {
      const mockFetchFn = mockFetch({
        'http://localhost:3000/mcp::initialize': { serverInfo: { name: 'test', version: '1.0' } },
        'http://localhost:3000/mcp::tools/list': {
          tools: [
            {
              name: 'greet',
              description: 'Greet someone',
              inputSchema: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Name to greet' },
                },
                required: ['name'],
              },
            },
          ],
        },
      })

      vi.stubGlobal('fetch', mockFetchFn)

      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: true,
      })

      await mcp.refreshAllTools()

      const tools = mcp.listMcpTools()
      expect(tools.length).toBe(1)
      expect(tools[0].name).toBe('mcp__test-server__greet')
      expect(tools[0].description).toContain('Greet someone')

      vi.unstubAllGlobals()
    })

    it('正确转换多种参数类型', async () => {
      const mockFetchFn = mockFetch({
        'http://localhost:3000/mcp::initialize': { serverInfo: { name: 'test', version: '1.0' } },
        'http://localhost:3000/mcp::tools/list': {
          tools: [
            {
              name: 'complex_tool',
              description: 'A complex tool',
              inputSchema: {
                type: 'object',
                properties: {
                  str: { type: 'string' },
                  num: { type: 'number' },
                  int: { type: 'integer' },
                  bool: { type: 'boolean' },
                  arr: { type: 'array', items: { type: 'string' } },
                  obj: { type: 'object', properties: { nested: { type: 'string' } } },
                },
              },
            },
          ],
        },
      })

      vi.stubGlobal('fetch', mockFetchFn)

      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: true,
      })

      await mcp.refreshAllTools()

      const tools = mcp.listMcpTools()
      expect(tools.length).toBe(1)

      vi.unstubAllGlobals()
    })

    it('处理空 schema', async () => {
      const mockFetchFn = mockFetch({
        'http://localhost:3000/mcp::initialize': { serverInfo: { name: 'test', version: '1.0' } },
        'http://localhost:3000/mcp::tools/list': {
          tools: [
            {
              name: 'no_params',
              description: 'No parameters',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      })

      vi.stubGlobal('fetch', mockFetchFn)

      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: true,
      })

      await mcp.refreshAllTools()

      const tools = mcp.listMcpTools()
      expect(tools.length).toBe(1)

      vi.unstubAllGlobals()
    })
  })

  describe('工具注册', () => {
    it('工具注册到 ToolRuntime', async () => {
      const mockFetchFn = mockFetch({
        'http://localhost:3000/mcp::initialize': { serverInfo: { name: 'test', version: '1.0' } },
        'http://localhost:3000/mcp::tools/list': {
          tools: [
            { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object', properties: {} } },
            { name: 'tool_b', description: 'Tool B', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      })

      vi.stubGlobal('fetch', mockFetchFn)

      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: true,
      })

      const result = await mcp.refreshAllTools()
      expect(result.totalTools).toBe(2)

      const tools = mcp.listMcpTools()
      expect(tools.length).toBe(2)
      expect(tools.find((t) => t.name === 'mcp__test-server__tool_a')).toBeDefined()
      expect(tools.find((t) => t.name === 'mcp__test-server__tool_b')).toBeDefined()

      vi.unstubAllGlobals()
    })

    it('工具名称带命名空间前缀', async () => {
      const mockFetchFn = mockFetch({
        'http://localhost:3000/mcp::initialize': { serverInfo: { name: 'test', version: '1.0' } },
        'http://localhost:3000/mcp::tools/list': {
          tools: [
            { name: 'my_tool', description: 'My Tool', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      })

      vi.stubGlobal('fetch', mockFetchFn)

      mcp.addServer({
        id: 'my-server',
        name: 'My Server',
        url: 'http://localhost:3000/mcp',
        enabled: true,
      })

      await mcp.refreshAllTools()

      const tools = mcp.listMcpTools()
      expect(tools[0].name).toBe('mcp__my-server__my_tool')

      vi.unstubAllGlobals()
    })

    it('禁用服务器时注销工具', async () => {
      const mockFetchFn = mockFetch({
        'http://localhost:3000/mcp::initialize': { serverInfo: { name: 'test', version: '1.0' } },
        'http://localhost:3000/mcp::tools/list': {
          tools: [
            { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      })

      vi.stubGlobal('fetch', mockFetchFn)

      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: true,
      })

      await mcp.refreshAllTools()
      expect(mcp.listMcpTools().length).toBe(1)

      // 禁用服务器
      mcp.updateServer('test-server', { enabled: false })
      expect(mcp.listMcpTools().length).toBe(0)

      vi.unstubAllGlobals()
    })

    it('移除服务器时注销工具', async () => {
      const mockFetchFn = mockFetch({
        'http://localhost:3000/mcp::initialize': { serverInfo: { name: 'test', version: '1.0' } },
        'http://localhost:3000/mcp::tools/list': {
          tools: [
            { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      })

      vi.stubGlobal('fetch', mockFetchFn)

      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: true,
      })

      await mcp.refreshAllTools()
      expect(mcp.listMcpTools().length).toBe(1)

      mcp.removeServer('test-server')
      expect(mcp.listMcpTools().length).toBe(0)

      vi.unstubAllGlobals()
    })
  })

  describe('多服务器', () => {
    it('支持多个 MCP 服务器', async () => {
      const mockFetchFn = mockFetch({
        'http://localhost:3001/mcp::initialize': { serverInfo: { name: 'server1', version: '1.0' } },
        'http://localhost:3001/mcp::tools/list': {
          tools: [{ name: 'tool_1', description: 'Tool 1', inputSchema: { type: 'object', properties: {} } }],
        },
        'http://localhost:3002/mcp::initialize': { serverInfo: { name: 'server2', version: '1.0' } },
        'http://localhost:3002/mcp::tools/list': {
          tools: [{ name: 'tool_2', description: 'Tool 2', inputSchema: { type: 'object', properties: {} } }],
        },
      })

      vi.stubGlobal('fetch', mockFetchFn)

      mcp.addServer({
        id: 'server-1',
        name: 'Server 1',
        url: 'http://localhost:3001/mcp',
        enabled: true,
      })
      mcp.addServer({
        id: 'server-2',
        name: 'Server 2',
        url: 'http://localhost:3002/mcp',
        enabled: true,
      })

      const result = await mcp.refreshAllTools()
      expect(result.totalTools).toBe(2)

      const tools = mcp.listMcpTools()
      expect(tools.length).toBe(2)
      expect(tools.find((t) => t.serverId === 'server-1')).toBeDefined()
      expect(tools.find((t) => t.serverId === 'server-2')).toBeDefined()

      vi.unstubAllGlobals()
    })

    it('单个服务器失败不影响其他服务器', async () => {
      const mockFetchFn = mockFetch({
        'http://localhost:3001/mcp::initialize': { serverInfo: { name: 'server1', version: '1.0' } },
        'http://localhost:3001/mcp::tools/list': {
          tools: [{ name: 'tool_1', description: 'Tool 1', inputSchema: { type: 'object', properties: {} } }],
        },
        'http://localhost:3002/mcp::initialize': new Error('Connection refused'),
      })

      vi.stubGlobal('fetch', mockFetchFn)

      mcp.addServer({
        id: 'server-1',
        name: 'Server 1',
        url: 'http://localhost:3001/mcp',
        enabled: true,
      })
      mcp.addServer({
        id: 'server-2',
        name: 'Server 2',
        url: 'http://localhost:3002/mcp',
        enabled: true,
      })

      const result = await mcp.refreshAllTools()
      // server-1 成功，server-2 失败
      expect(result.totalTools).toBe(1)
      expect(result.errors.length).toBeGreaterThan(0)

      const tools = mcp.listMcpTools()
      expect(tools.length).toBe(1)
      expect(tools[0].serverId).toBe('server-1')

      vi.unstubAllGlobals()
    })
  })

  describe('事件', () => {
    it('添加服务器时触发事件', () => {
      const handler = vi.fn()
      ctx.on('mcp/server-added', handler)

      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: false,
      })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith('test-server', expect.any(Object))
    })

    it('移除服务器时触发事件', () => {
      const handler = vi.fn()

      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: false,
      })

      ctx.on('mcp/server-removed', handler)
      mcp.removeServer('test-server')

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith('test-server')
    })

    it('更新服务器时触发事件', () => {
      const handler = vi.fn()

      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: false,
      })

      ctx.on('mcp/server-updated', handler)
      mcp.updateServer('test-server', { name: 'New Name' })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith('test-server', expect.any(Object))
    })
  })

  describe('测试连接', () => {
    it('成功连接返回工具数量', async () => {
      const mockFetchFn = mockFetch({
        'http://localhost:3000/mcp::initialize': { serverInfo: { name: 'test', version: '1.0' } },
        'http://localhost:3000/mcp::tools/list': {
          tools: [
            { name: 'tool_1', description: 'Tool 1' },
            { name: 'tool_2', description: 'Tool 2' },
          ],
        },
      })

      vi.stubGlobal('fetch', mockFetchFn)

      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: false,
      })

      const result = await mcp.testConnection('test-server')
      expect(result.ok).toBe(true)
      expect(result.toolCount).toBe(2)

      vi.unstubAllGlobals()
    })

    it('连接失败返回错误', async () => {
      const mockFetchFn = mockFetch({
        'http://localhost:3000/mcp::initialize': new Error('Connection refused'),
      })

      vi.stubGlobal('fetch', mockFetchFn)

      mcp.addServer({
        id: 'test-server',
        name: 'Test Server',
        url: 'http://localhost:3000/mcp',
        enabled: false,
      })

      const result = await mcp.testConnection('test-server')
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()

      vi.unstubAllGlobals()
    })

    it('测试不存在的服务器', async () => {
      const result = await mcp.testConnection('non-existent')
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
    })
  })
})
