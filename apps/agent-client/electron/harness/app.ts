/**
 * Harness 应用入口。
 *
 * 组装所有核心服务：
 * - LlmRuntime + DeepSeekAdapter（LLM 能力缝）
 * - SessionStore（事件溯源会话）
 * - ToolRuntime（工具执行管道）
 * - AgentRegistry + AgentLoop（Agent 生命周期管理）
 *
 * 遵循 deepseek-harness 组合模式：通过 ctx.plugin() 按顺序挂载服务。
 */

import { join } from 'node:path'
import { Context } from './context.js'
import { SessionStore, type SessionId } from './session.js'
import { ToolRuntime } from './tools.js'
import { LlmRuntime, DeepSeekAdapter, type DeepSeekAdapterConfig } from './llm.js'
import { AgentRegistry, AgentLoop } from './agent-loop.js'
import { loadModlensConfig } from './modlens.js'
import { McpRuntime } from './mcp.js'
import { SkillRuntime } from './skill.js'
import { registerFsTools, type WorkspaceState, type PermissionLevel } from './tools/fs-tools.js'
import type { HarnessConfig } from './config.js'

export { loadHarnessConfig, type HarnessConfig, type PersistenceType } from './config.js'
export type { Context } from './context.js'
export { SessionStore, type Session, type SessionEvent, type SessionId, createSessionId } from './session.js'
export {
  createPersistenceProvider,
  SQLitePersistence,
  SqlJsSessionPersistence,
  initSqlJsSessionPersistence,
  FilePersistence,
  type SessionPersistenceProvider,
} from './session-persistence.js'
export { ToolRuntime, defineTool, type ToolDefinition } from './tools.js'
export { LlmRuntime, DeepSeekAdapter, type StreamChunk, type Usage } from './llm.js'
export { AgentLoop, type Agent, type AgentStatus, type AgentOptions } from './agent-loop.js'
export { McpRuntime, type McpServerConfig, type McpToolInfo, type McpCallResult } from './mcp.js'
export { SkillRuntime, type Skill } from './skill.js'
export { registerFsTools } from './tools/fs-tools.js'
export { HarnessIpcBridge } from './ipc-bridge.js'

/**
 * Harness 应用：封装完整的 harness 运行时。
 *
 * 使用方式：
 * ```ts
 * const app = new HarnessApp(config)
 * await app.start()
 * const agent = app.createAgent({ cwd: '...' })
 * agent.followup([{ type: 'text', text: 'hello' }])
 * ```
 */
export class HarnessApp {
  readonly ctx: Context
  private config: HarnessConfig
  /** 与 DeepSeekAdapter 共享引用的配置对象；setApiKey 就地更新后，后续请求即用新 Key。 */
  private llmAdapterConfig?: DeepSeekAdapterConfig
  /** LLM 适配器是否已注册（无 Key 启动时延迟到用户填入 Key 再注册）。 */
  private llmAdapterRegistered = false
  /** 可变的工作区状态（工作目录 + 权限等级）。fs 工具在每次执行时读取它，
   * 因此运行时切换工作目录或权限等级会立即对所有后续工具调用生效。
   * 在 start() 中初始化（此时才拿到 config.workDir）。 */
  private workspace!: WorkspaceState
  private started = false

  constructor(config: HarnessConfig) {
    this.config = config
    this.ctx = new Context()
  }

  /**
   * 启动 harness 应用：挂载所有服务。
   * 幂等：多次调用只启动一次。
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    const ctx = this.ctx
    const config = this.config

    // 1. 会话存储（带持久化）
    let persistence: import('./session-persistence.js').SessionPersistenceProvider | undefined
    if (config.persistenceType !== 'memory') {
      const { FilePersistence } = await import('./session-persistence.js')
      // 兜底默认值：精简 / 测试配置可能未显式给出持久化路径，从工作目录派生，
      // 避免 join(undefined) 崩溃。生产路径（loadHarnessConfig）始终提供，行为不变。
      const persistBase = config.workDir || config.dshHome || process.cwd()
      const sessionsDir = config.sessionsDir || join(persistBase, '.sessions')
      const sqlitePath = config.sqlitePath || join(persistBase, 'sessions.db')
      if (config.persistenceType === 'file') {
        persistence = new FilePersistence(sessionsDir)
      } else {
        // sqlite / auto：优先 sql.js（纯 WASM，已在打包中分发），不可用回退文件。
        const { initSqlJsSessionPersistence } = await import('./session-persistence.js')
        persistence =
          (await initSqlJsSessionPersistence(sqlitePath)) ??
          new FilePersistence(sessionsDir)
      }
    }

    ctx.plugin(SessionStore as any, {
      persistence,
      autoLoad: config.autoLoadSessions,
    })

    // 2. 工具运行时
    ctx.plugin(ToolRuntime as any)

    // 3. LLM 运行时 + DeepSeek 适配器
    ctx.plugin(LlmRuntime as any)
    this.llmAdapterConfig = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.model,
      minIntervalMs: config.rateLimitMs ?? 0,
    }
    if (config.apiKey) {
      const llm = (ctx as any).llm as LlmRuntime
      llm.registerAdapter(new DeepSeekAdapter(this.llmAdapterConfig), true)
      this.llmAdapterRegistered = true
    }

    // 4. Agent 注册中心
    ctx.plugin(AgentRegistry as any)

    // 5. Agent Loop
    const modlens = loadModlensConfig(process.env, {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    })
    ctx.plugin(AgentLoop as any, {
      agents: [],
      maxParallelToolCalls: config.maxParallelToolCalls,
      modlens,
    })

    // 6. 注册文件系统工具（共享可变工作区状态：运行时可切换目录/权限）
    this.workspace = {
      workDir: config.workDir,
      permission: config.permission || 'execute',
    }
    registerFsTools(ctx, this.workspace)

    // 7. MCP 运行时
    ctx.plugin(McpRuntime as any)

    // 8. 加载配置中的 MCP 服务器
    if (config.mcpServers && config.mcpServers.length > 0) {
      const mcp = (ctx as any).mcp as McpRuntime
      for (const server of config.mcpServers) {
        mcp.addServer(server)
      }
    }

    // 9. Skill 运行时
    ctx.plugin(SkillRuntime as any)
  }

  /**
   * 创建一个新的 agent。
   */
  createAgent(opts: {
    cwd?: string
    title?: string
    model?: string
    maxToolSteps?: number
  } = {}): import('./agent-loop.js').Agent {
    const loop = (this.ctx as any).agentLoop as AgentLoop
    return loop.createNew(
      {
        model: opts.model || this.config.model,
        maxToolSteps: opts.maxToolSteps,
      },
      {
        cwd: opts.cwd || this.config.workDir,
        title: opts.title,
      },
    )
  }

  /**
   * 获取 agent。
   */
  getAgent(id: string): import('./agent-loop.js').Agent | undefined {
    return (this.ctx as any).agents.get(id)
  }

  /**
   * 运行时应用用户输入的 DeepSeek API Key（包内不内置任何 Key，Key 一律来自用户配置）。
   *
   * 适配器与本方法共享同一个配置对象引用：更新其 apiKey 后，所有后续 LLM 请求
   * 立即携带新 Key；若启动时没有任何 Key（适配器未注册），填入后即时完成注册。
   * @param key 用户提供的 DeepSeek API Key（空串视为清除）
   * @returns 是否已应用到运行时（start() 之前调用返回 false）
   */
  setApiKey(key: string): boolean {
    const trimmed = (key || '').trim()
    if (!this.llmAdapterConfig) return false
    this.llmAdapterConfig.apiKey = trimmed
    this.config.apiKey = trimmed
    if (trimmed && !this.llmAdapterRegistered) {
      const llm = (this.ctx as any).llm as LlmRuntime
      llm.registerAdapter(new DeepSeekAdapter(this.llmAdapterConfig), true)
      this.llmAdapterRegistered = true
    }
    return true
  }

  /**
   * 读取当前工作区状态（工作目录 + 权限等级）的副本。
   */
  getWorkspace(): WorkspaceState {
    return { ...this.workspace }
  }

  /**
   * 运行时更新工作区（工作目录 / 权限等级）。
   *
   * 由于 fs 工具捕获的是同一个 WorkspaceState 对象引用，直接修改其字段即可
   * 让所有后续工具调用立即生效，无需重建工具。
   * 同时更新 config.workDir，使新建的 agent 默认 cwd 也跟随变化。
   *
   * @returns 更新后的工作区副本
   */
  setWorkspace(p: Partial<WorkspaceState>): WorkspaceState {
    if (p.workDir !== undefined && p.workDir !== null && String(p.workDir).trim()) {
      this.workspace.workDir = String(p.workDir).trim()
    }
    if (p.permission !== undefined && p.permission !== null) {
      const perm = String(p.permission) as PermissionLevel
      if (perm === 'read' || perm === 'write' || perm === 'execute') {
        this.workspace.permission = perm
      }
    }
    this.config.workDir = this.workspace.workDir
    return { ...this.workspace }
  }

  /**
   * 诊断信息：暴露 harness 就绪状态与 MCP 服务器连接诊断。
   * 供主进程 `/healthz` 端点与本机无头自动化测试断言 exe 内部状态。
   */
  diagnosis(): { ready: boolean; mcpServers: ReturnType<McpRuntime['getDiagnostics']> } {
    const mcp = (this.ctx as any).mcp as McpRuntime | undefined
    return { ready: this.started, mcpServers: mcp ? mcp.getDiagnostics() : [] }
  }

  /**
   * 重命名 agent 的标题。
   *
   * 标题持久化到 session.header（含 SQLite/文件存储的 header），避免旧的
   * 「直接改冻结 header」方式既不生效也不落盘；改完广播 `session/title-updated`，
   * 桥接层转发给渲染进程，下一个拉取列表即可看到新名字。
   */
  renameAgent(id: string, title: string): boolean {
    const sessions = this.ctx.sessions as SessionStore | undefined
    if (!sessions) return false
    return sessions.renameTitle(id as SessionId, String(title || ''))
  }

  /**
   * 删除一个 agent：从 AgentLoop 注册表注销并 cancel 任何在跑的循环，
   * 同时从 SessionStore 注销并清除持久化记录（否则下次启动会复活）。
   * 返回是否真的删除。
   */
  deleteAgent(id: string): boolean {
    const loop = (this.ctx as any).agentLoop as { unregister: (id: string) => void } | undefined
    if (!loop || typeof loop.unregister !== 'function') return false
    const existed = !!this.getAgent(id)
    try {
      this.getAgent(id)?.cancel?.({ kind: 'user-requested' })
    } catch {
      /* 取消失败不阻断注销 */
    }
    loop.unregister(id)
    try {
      const sessions = this.ctx.sessions as SessionStore | undefined
      if (sessions) sessions.dispose(id as SessionId)
    } catch {
      /* 会话销毁失败不阻断 */
    }
    return existed
  }

  /**
   * 获取 agent 当前标题。
   */
  getAgentTitle(id: string): string | undefined {
    const agent = (this.ctx as any).agents.get(id) as import('./agent-loop.js').Agent | undefined
    return agent?.session?.header?.title
  }

  /**
   * 列出所有 agent。
   */
  listAgents(): import('./agent-loop.js').Agent[] {
    return (this.ctx as any).agents.list()
  }

  /**
   * 列出所有会话（含仅从持久化加载、尚未存在 agent 的会话）。
   *
   * 重启后 SessionStore 会把持久化的会话自动加载进 store，但 AgentRegistry 仍为空；
   * 若桥接层只读 agent 注册表，这些会话就会「看起来消失了」。这里合并两者，
   * 按 agent 注册表优先去重，让重启后的历史任务正常展示。
   * @returns 去重后的会话列表（注册表优先）
   */
  listSessions(): import('./session.js').Session[] {
    const seen = new Map<import('./session.js').SessionId, import('./session.js').Session>()
    for (const agent of this.listAgents()) {
      if (agent?.session) seen.set(agent.id, agent.session)
    }
    const store = this.ctx.sessions as SessionStore | undefined
    if (store) for (const session of store.list()) seen.set(session.id, session)
    return [...seen.values()]
  }

  /**
   * 解析任意会话 ID 到它的 agent：
   * - agent 已存在 → 直接返回
   * - 会话已（从持久化）加载但无 agent → 为其重建一个 agent（复用已归档的消息历史）
   * - 均不存在 → 返回 undefined
   */
  getOrCreateAgent(
    id: import('./session.js').SessionId,
    opts: import('./agent-loop.js').AgentOptions = {},
  ): import('./agent-loop.js').Agent | undefined {
    const existing = this.getAgent(id)
    if (existing) return existing
    const store = this.ctx.sessions as SessionStore | undefined
    if (store?.has(id)) {
      const loop = this.ctx.agentLoop as AgentLoop
      return loop.attach(id, { model: this.config.model, ...opts })
    }
    return undefined
  }

  /** 获取当前配置的默认模型名。 */
  getDefaultModel(): string {
    return this.config.model
  }

  /**
   * 停止应用：清理所有资源。
   */
  async stop(): Promise<void> {
    await this.ctx.dispose()
    this.started = false
  }
}
