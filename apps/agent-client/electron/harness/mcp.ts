/**
 * MCP（Model Context Protocol）工具集成服务。
 *
 * 遵循 deepseek-harness 设计原则：
 * - 服务化：McpRuntime 作为 Service 注册到 Context
 * - 事件驱动：工具注册/注销通过事件通知
 * - 动态扩展：MCP 工具动态注册到 ToolRuntime
 * - 容错：单个服务器故障不影响其他工具
 *
 * 支持 HTTP JSON-RPC 2.0 传输的 MCP 服务器。
 */

import type { Context } from './context.js'
import { Service } from './context.js'
import { defineTool, type ToolParameterSchema, type ParameterProperty } from './tools.js'
import type { ContentBlock } from './session.js'

// ============================================================
// 类型定义
// ============================================================

/** MCP 服务器配置 */
export interface McpServerConfig {
  /** 服务器唯一 ID */
  id: string
  /** 显示名称 */
  name: string
  /** MCP 服务端点（HTTP JSON-RPC） */
  url: string
  /** 是否启用 */
  enabled: boolean
  /** 附加请求头（如鉴权） */
  headers?: Record<string, string>
}

/** MCP 工具信息 */
export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  serverId: string
}

/** MCP 调用结果 */
export interface McpCallResult {
  ok: boolean
  content: string
  error?: string
}

// ============================================================
// 上下文类型声明合并
// ============================================================

declare module './context.js' {
  interface Context {
    mcp: McpRuntime
  }
}

// ============================================================
// JSON-RPC 客户端
// ============================================================

/**
 * 单个 MCP 服务器的 JSON-RPC 客户端。
 * 通过 HTTP POST 发送 JSON-RPC 2.0 请求。
 */
class McpJsonRpcClient {
  private seq = 0
  /** streamable-http 会话标识，initialize 后由服务端下发，需在后续请求中回传。 */
  private sessionId?: string

  constructor(private config: McpServerConfig) {}

  /**
   * 发送 JSON-RPC 请求。
   *
   * 兼容 streamable-http 传输：
   * - 捕获响应头中的 `Mcp-Session-Id` 并在后续请求回传（FastMCP 等要求）。
   * - 同时兼容 `application/json` 与 `text/event-stream`（SSE）两种响应体。
   */
  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = ++this.seq
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.config.headers ?? {}),
    }

    const response = await fetch(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })

    if (!response.ok) {
      throw new Error(`MCP ${this.config.name} 返回 ${response.status}`)
    }

    // 捕获并持久化会话标识
    const sid = response.headers?.get('mcp-session-id') ?? response.headers?.get('Mcp-Session-Id')
    if (sid) this.sessionId = sid

    const json = await this.parseJsonRpc<T>(response)

    if (json.error) {
      throw new Error(`MCP 错误 ${json.error.code}：${json.error.message}`)
    }

    return json.result as T
  }

  /**
   * 解析 JSON-RPC 响应体，支持 `application/json` 与 `text/event-stream`（SSE）。
   */
  private async parseJsonRpc<T>(response: Response): Promise<{
    jsonrpc: '2.0'
    id: number
    result?: T
    error?: { code: number; message: string }
  }> {
    const contentType = response.headers?.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      const raw = await response.text()
      let last: {
        jsonrpc: '2.0'
        id: number
        result?: T
        error?: { code: number; message: string }
      } | undefined
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice('data:'.length).trim()
        if (!data || data === '[DONE]') continue
        try {
          last = JSON.parse(data)
        } catch {
          /* 跳过非 JSON 的 SSE 行 */
        }
      }
      if (!last) throw new Error(`MCP ${this.config.name} 返回了空的 SSE 流`)
      return last
    }
    return (await response.json()) as {
      jsonrpc: '2.0'
      id: number
      result?: T
      error?: { code: number; message: string }
    }
  }

  /**
   * 初始化握手。
   */
  async initialize(): Promise<{ serverInfo?: { name?: string; version?: string } }> {
    return this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-harness', version: '0.1.0' },
    })
  }

  /**
   * 获取工具列表。
   */
  async listTools(): Promise<Array<{
    name: string
    description?: string
    inputSchema?: Record<string, unknown>
  }>> {
    const result = await this.request<{
      tools?: Array<{
        name: string
        description?: string
        inputSchema?: Record<string, unknown>
      }>
    }>('tools/list')
    return result.tools ?? []
  }

  /**
   * 调用工具。
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean }> {
    return this.request('tools/call', { name, arguments: args })
  }
}

// ============================================================
// Schema 转换工具
// ============================================================

/**
 * 将 MCP 的 JSON Schema 转换为 ToolParameterSchema。
 * MCP 使用 JSON Schema Draft 7，我们做简化映射。
 */
function convertSchema(
  inputSchema: Record<string, unknown> | undefined,
): ToolParameterSchema {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: true }
  }

  const schema = inputSchema as Record<string, unknown>

  // 提取 properties
  const properties: Record<string, ParameterProperty> = {}
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined
  if (props && typeof props === 'object') {
    for (const [key, prop] of Object.entries(props)) {
      properties[key] = convertProperty(prop)
    }
  }

  // 提取 required
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : undefined

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: schema.additionalProperties !== false,
  }
}

/**
 * 转换单个属性 schema。
 */
function convertProperty(prop: Record<string, unknown>): ParameterProperty {
  const type = mapType(prop.type as string | string[] | undefined)
  const result: ParameterProperty = {
    type,
    description: prop.description as string | undefined,
  }

  // enum
  if (Array.isArray(prop.enum)) {
    result.enum = prop.enum
  }

  // 数组 items
  if (type === 'array' && prop.items && typeof prop.items === 'object') {
    result.items = convertProperty(prop.items as Record<string, unknown>)
  }

  // 对象 properties
  if (type === 'object' && prop.properties && typeof prop.properties === 'object') {
    result.properties = {}
    for (const [key, p] of Object.entries(prop.properties as Record<string, Record<string, unknown>>)) {
      result.properties[key] = convertProperty(p)
    }
  }

  // default
  if ('default' in prop) {
    result.default = prop.default
  }

  return result
}

/**
 * 映射 JSON Schema 类型到我们的简化类型。
 */
function mapType(type: string | string[] | undefined): ParameterProperty['type'] {
  if (Array.isArray(type)) {
    // 多类型：取第一个非 null 的
    const nonNull = type.find((t) => t !== 'null')
    return mapType(nonNull)
  }

  switch (type) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'integer':
      return 'integer'
    case 'boolean':
      return 'boolean'
    case 'array':
      return 'array'
    case 'object':
      return 'object'
    case 'null':
      return 'null'
    default:
      return 'string' // 默认按字符串处理
  }
}

// ============================================================
// McpRuntime 服务
// ============================================================

/**
 * MCP 运行时服务。
 *
 * 负责：
 * - 管理 MCP 服务器配置
 * - 连接服务器并获取工具列表
 * - 将 MCP 工具注册到 ToolRuntime
 * - 路由工具调用到对应服务器
 * - 监控服务器连接状态
 */
export class McpRuntime extends Service {
  private servers = new Map<string, McpServerConfig>()
  private registeredTools = new Map<string, { serverId: string; disposer: () => void }>()
  private connectionStatus = new Map<string, { connected: boolean; error?: string; toolCount: number }>()
  /** 每个服务器的 JSON-RPC 客户端缓存：复用以持久化 streamable-http 的会话标识。 */
  private clients = new Map<string, McpJsonRpcClient>()

  constructor(ctx: Context) {
    super(ctx, 'mcp')

    // 声明事件
    ctx.declareEvent('mcp/server-added', 'emit')
    ctx.declareEvent('mcp/server-removed', 'emit')
    ctx.declareEvent('mcp/server-updated', 'emit')
    ctx.declareEvent('mcp/tools-refreshed', 'emit')
    ctx.declareEvent('mcp/tool-called', 'emit')
  }

  /** 获取（或创建）某服务器的 JSON-RPC 客户端，确保会话标识在多次请求间复用。 */
  private getClient(serverId: string): McpJsonRpcClient {
    let client = this.clients.get(serverId)
    if (!client) {
      const server = this.servers.get(serverId)
      if (!server) throw new Error(`MCP server "${serverId}" not found`)
      client = new McpJsonRpcClient(server)
      this.clients.set(serverId, client)
    }
    return client
  }

  // ========== 服务器管理 ==========

  /**
   * 添加 MCP 服务器。
   */
  addServer(config: McpServerConfig): void {
    if (this.servers.has(config.id)) {
      throw new Error(`MCP server "${config.id}" already exists`)
    }

    this.servers.set(config.id, { ...config })
    this.connectionStatus.set(config.id, { connected: false, toolCount: 0 })
    this.ctx.emit('mcp/server-added', config.id, config)

    // 如果启用，立即连接并注册工具
    if (config.enabled) {
      void this.refreshServerTools(config.id)
    }
  }

  /**
   * 移除 MCP 服务器。
   */
  removeServer(id: string): void {
    // 注销所有该服务器的工具
    this.unregisterServerTools(id)

    this.servers.delete(id)
    this.clients.delete(id)
    this.connectionStatus.delete(id)
    this.ctx.emit('mcp/server-removed', id)
  }

  /**
   * 更新服务器配置。
   */
  updateServer(id: string, updates: Partial<McpServerConfig>): void {
    const server = this.servers.get(id)
    if (!server) return

    const wasEnabled = server.enabled
    Object.assign(server, updates)

    this.ctx.emit('mcp/server-updated', id, server)

    // 启用状态变化时重新加载工具
    if (updates.enabled !== undefined && updates.enabled !== wasEnabled) {
      if (updates.enabled) {
        void this.refreshServerTools(id)
      } else {
        this.unregisterServerTools(id)
      }
    }
  }

  /**
   * 获取所有服务器配置。
   */
  listServers(): McpServerConfig[] {
    return [...this.servers.values()]
  }

  /**
   * 获取服务器连接状态。
   */
  getConnectionStatus(id: string): { connected: boolean; error?: string; toolCount: number } | undefined {
    return this.connectionStatus.get(id)
  }

  /**
   * 获取所有服务器的连接诊断信息。
   * 供主进程 `/healthz` 端点与本机无头自动化测试断言 exe 内部状态。
   */
  getDiagnostics(): Array<{
    id: string
    name: string
    url: string
    connected: boolean
    error?: string
    toolCount: number
  }> {
    const out: Array<{
      id: string
      name: string
      url: string
      connected: boolean
      error?: string
      toolCount: number
    }> = []
    for (const [id, server] of this.servers) {
      const status = this.connectionStatus.get(id)
      out.push({
        id,
        name: server.name,
        url: server.url,
        connected: status?.connected ?? false,
        error: status?.error,
        toolCount: status?.toolCount ?? 0,
      })
    }
    return out
  }

  // ========== 工具管理 ==========

  /**
   * 刷新指定服务器的工具列表。
   */
  async refreshServerTools(serverId: string): Promise<void> {
    const server = this.servers.get(serverId)
    if (!server || !server.enabled) return

    try {
      const client = this.getClient(server.id)
      await client.initialize()

      const tools = await client.listTools()

      // 先注销旧工具
      this.unregisterServerTools(serverId)

      // 注册新工具
      const toolsRuntime = (this.ctx as any).tools as { register: (def: any) => () => void }
      for (const tool of tools) {
        const toolName = this.makeToolName(serverId, tool.name)
        const schema = convertSchema(tool.inputSchema as Record<string, unknown> | undefined)

        const disposer = toolsRuntime.register(defineTool({
          name: toolName,
          description: tool.description
            ? `[MCP:${server.name}] ${tool.description}`
            : `[MCP:${server.name}] ${tool.name}`,
          parameters: schema,
          execute: async (args): Promise<ContentBlock[]> => {
            return this.callMcpTool(serverId, tool.name, args)
          },
          timeoutMs: 30000, // 30 秒超时
          risk: 'medium', // MCP 工具默认为中等风险
          isConcurrencySafe: false,
        }))

        this.registeredTools.set(toolName, { serverId, disposer })
      }

      this.connectionStatus.set(serverId, {
        connected: true,
        toolCount: tools.length,
      })

      this.ctx.emit('mcp/tools-refreshed', serverId, tools.length)
    } catch (error) {
      this.connectionStatus.set(serverId, {
        connected: false,
        error: error instanceof Error ? error.message : String(error),
        toolCount: 0,
      })
      console.error(`[mcp] Failed to refresh tools for server "${serverId}":`, error)
    }
  }

  /**
   * 刷新所有已启用服务器的工具。
   */
  async refreshAllTools(): Promise<{ totalTools: number; errors: string[] }> {
    const errors: string[] = []
    let totalTools = 0

    await Promise.all(
      [...this.servers.values()]
        .filter((s) => s.enabled)
        .map(async (server) => {
          await this.refreshServerTools(server.id)
          const status = this.connectionStatus.get(server.id)
          if (status?.connected) {
            totalTools += status.toolCount
          } else if (status?.error) {
            errors.push(`${server.name}：${status.error}`)
          }
        }),
    )

    return { totalTools, errors }
  }

  /**
   * 测试服务器连接。
   */
  async testConnection(serverId: string): Promise<{ ok: boolean; toolCount: number; error?: string }> {
    const server = this.servers.get(serverId)
    if (!server) {
      return { ok: false, toolCount: 0, error: '服务器不存在' }
    }

    try {
      const client = this.getClient(serverId)
      await client.initialize()
      const tools = await client.listTools()
      return { ok: true, toolCount: tools.length }
    } catch (error) {
      return {
        ok: false,
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 获取所有已注册的 MCP 工具信息。
   */
  listMcpTools(): McpToolInfo[] {
    const result: McpToolInfo[] = []
    for (const [name, { serverId }] of this.registeredTools) {
      const toolsRuntime = (this.ctx as any).tools as { get: (name: string) => any }
      const def = toolsRuntime.get(name)
      if (def) {
        result.push({
          name,
          description: def.description,
          serverId,
        })
      }
    }
    return result
  }

  // ========== 内部方法 ==========

  /**
   * 构造带命名空间的工具名。
   * 格式：mcp__<serverId>__<toolName>
   */
  private makeToolName(serverId: string, toolName: string): string {
    return `mcp__${serverId}__${toolName}`
  }

  /**
   * 解析工具名，提取 serverId 和原始工具名。
   */
  private parseToolName(fullName: string): { serverId: string; toolName: string } | null {
    const match = fullName.match(/^mcp__(.+?)__(.+)$/)
    if (!match) return null
    return { serverId: match[1], toolName: match[2] }
  }

  /**
   * 注销指定服务器的所有工具。
   */
  private unregisterServerTools(serverId: string): void {
    for (const [name, info] of this.registeredTools) {
      if (info.serverId === serverId) {
        info.disposer()
        this.registeredTools.delete(name)
      }
    }
  }

  /**
   * 调用 MCP 工具。供 Agent 运行时与自动化测试使用。
   */
  async callMcpTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ContentBlock[]> {
    const server = this.servers.get(serverId)
    if (!server) {
      return [{ type: 'text', text: `Error: MCP server "${serverId}" not found` }]
    }

    const client = this.getClient(serverId)

    try {
      const result = await client.callTool(toolName, args)
      const text = (result.content ?? [])
        .map((c) => c.text ?? '')
        .join('\n')

      if (result.isError) {
        return [{ type: 'text', text: `MCP Error: ${text || 'Unknown error'}` }]
      }

      this.ctx.emit('mcp/tool-called', serverId, toolName, { ok: true })

      return [{ type: 'text', text: text || '(empty result)' }]
    } catch (error) {
      this.ctx.emit('mcp/tool-called', serverId, toolName, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })

      return [
        {
          type: 'text',
          text: `MCP Call Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]
    }
  }
}
