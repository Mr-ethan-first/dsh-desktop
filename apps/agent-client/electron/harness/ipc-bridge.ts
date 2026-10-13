/**
 * IPC 桥接层：主进程侧。
 *
 * 将 harness 的会话事件通过 IPC 推送到渲染进程，
 * 并接收渲染进程的命令（创建会话、发送消息、取消等）。
 *
 * 遵循 deepseek-harness 事件驱动设计：
 * - 会话状态变更通过事件流传播
 * - 命令式操作通过 IPC handler 处理
 * - 渲染进程订阅事件流来更新 UI
 */

import type { BrowserWindow, IpcMain } from 'electron'
import { statSync } from 'node:fs'
import { dirname, normalize } from 'node:path'
import { spawn } from 'node:child_process'
import type { HarnessApp } from './app.js'
import type { Session, SessionEvent, Usage, UsageByModel } from './session.js'
import type { Agent } from './agent-loop.js'
import { addWorkspace, getRecentWorkspaces, removeWorkspace } from './workspace-history.js'

/** IPC 通道常量 */
export const IPC_CHANNELS = {
  /** 会话事件推送（主 → 渲染） */
  SESSION_EVENT: 'harness:session-event',
  /** 创建会话（渲染 → 主） */
  SESSION_CREATE: 'harness:session-create',
  /** 列出会话（渲染 → 主） */
  SESSION_LIST: 'harness:session-list',
  /** 发送消息（渲染 → 主） */
  SESSION_SEND: 'harness:session-send',
  /** 取消任务（渲染 → 主） */
  SESSION_CANCEL: 'harness:session-cancel',
  /** 获取会话详情（渲染 → 主） */
  SESSION_GET: 'harness:session-get',
  /** 重命名会话（渲染 → 主） */
  SESSION_RENAME: 'harness:session-rename',
  /** 删除会话（渲染 → 主） */
  SESSION_DELETE: 'harness:session-delete',
  /** 用系统资源管理器打开目录（渲染 → 主） */
  OPEN_FOLDER: 'harness:open-folder',
  /** 工作空间历史目录：读取（渲染 → 主） */
  WORKSPACE_HISTORY_GET: 'harness:workspace-history-get',
  /** 工作空间历史目录：新增（渲染 → 主） */
  WORKSPACE_HISTORY_ADD: 'harness:workspace-history-add',
  /** 工作空间历史目录：删除（渲染 → 主） */
  WORKSPACE_HISTORY_REMOVE: 'harness:workspace-history-remove',
  /** 设置 API Key（渲染 → 主） */
  SET_API_KEY: 'harness:set-api-key',
  /** 获取 API Key 状态（渲染 → 主） */
  GET_API_KEY: 'harness:get-api-key',
  // MCP 相关
  /** MCP 事件推送（主 → 渲染） */
  MCP_EVENT: 'harness:mcp-event',
  /** 列出 MCP 服务器（渲染 → 主） */
  MCP_LIST_SERVERS: 'harness:mcp-list-servers',
  /** 添加 MCP 服务器（渲染 → 主） */
  MCP_ADD_SERVER: 'harness:mcp-add-server',
  /** 移除 MCP 服务器（渲染 → 主） */
  MCP_REMOVE_SERVER: 'harness:mcp-remove-server',
  /** 更新 MCP 服务器（渲染 → 主） */
  MCP_UPDATE_SERVER: 'harness:mcp-update-server',
  /** 刷新 MCP 工具（渲染 → 主） */
  MCP_REFRESH_TOOLS: 'harness:mcp-refresh-tools',
  /** 列出 MCP 工具（渲染 → 主） */
  MCP_LIST_TOOLS: 'harness:mcp-list-tools',
  /** 测试 MCP 连接（渲染 → 主） */
  MCP_TEST_CONNECTION: 'harness:mcp-test-connection',
  /** 获取连接状态（渲染 → 主） */
  MCP_GET_STATUS: 'harness:mcp-get-status',
  // Skill 相关
  /** Skill 事件推送（主 → 渲染） */
  SKILL_EVENT: 'harness:skill-event',
  /** 列出技能（渲染 → 主） */
  SKILL_LIST: 'harness:skill-list',
  /** 获取技能（渲染 → 主） */
  SKILL_GET: 'harness:skill-get',
  /** 添加技能（渲染 → 主） */
  SKILL_ADD: 'harness:skill-add',
  /** 移除技能（渲染 → 主） */
  SKILL_REMOVE: 'harness:skill-remove',
  /** 更新技能（渲染 → 主） */
  SKILL_UPDATE: 'harness:skill-update',
  /** 启用技能（渲染 → 主） */
  SKILL_ENABLE: 'harness:skill-enable',
  /** 禁用技能（渲染 → 主） */
  SKILL_DISABLE: 'harness:skill-disable',
  /** 切换技能（渲染 → 主） */
  SKILL_TOGGLE: 'harness:skill-toggle',
  /** 获取技能提示（渲染 → 主） */
  SKILL_GET_PROMPT: 'harness:skill-get-prompt',
  /** 获取技能统计（渲染 → 主） */
  SKILL_GET_STATS: 'harness:skill-get-stats',
  /** 按分类列出技能（渲染 → 主） */
  SKILL_LIST_BY_CATEGORY: 'harness:skill-list-by-category',
} as const

/** 会话信息（用于列表展示） */
export interface SessionInfo {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  status: 'idle' | 'running'
  /** 会话锁定的工作目录（绝对路径），用于在左侧按「空间-目录-任务」分组。 */
  cwd?: string
  /** 累计 token 消耗（输入/输出/合计）。从事件日志派生，前端可直接展示。 */
  usage?: Usage
  /** 本次会话实际消耗过的模型列表（按消耗量降序）。 */
  models?: string[]
  /** 按模型拆分的用量明细。 */
  usageByModel?: UsageByModel[]
}

/** 序列化的会话事件（通过 IPC 传输） */
export interface SerializedSessionEvent {
  type: string
  seq: number
  data: unknown
}

/**
 * Harness IPC 桥接器。
 *
 * 在主进程中创建，连接 HarnessApp 和 BrowserWindow。
 */
export class HarnessIpcBridge {
  private agents = new Map<string, Agent>()

  constructor(
    private app: HarnessApp,
    private win: BrowserWindow,
    private ipcMain: IpcMain,
  ) {
    this.setupSessionListeners()
    this.setupMcpListeners()
    this.setupSkillListeners()
    this.setupIpcHandlers()
    this.setupMcpHandlers()
    this.setupSkillHandlers()
  }

  /**
   * 设置会话事件监听器：将 harness 事件转发到渲染进程。
   */
  private setupSessionListeners(): void {
    const ctx = this.app.ctx

    // 会话创建
    ctx.on('session/created', (session: Session) => {
      this.emit(IPC_CHANNELS.SESSION_EVENT, {
        type: 'session/created',
        sessionId: session.id,
        header: { ...session.header },
      })
    })

    // 会话标题变更（自动起名 / 手动重命名都会落到这里），推给渲染进程以便侧栏即时更新
    ctx.on('session/title-updated', (session: Session, title: string) => {
      this.emit(IPC_CHANNELS.SESSION_EVENT, {
        type: 'session/title-updated',
        sessionId: session.id,
        title,
        header: { ...session.header },
      })
    })

    // 会话事件
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.emit(IPC_CHANNELS.SESSION_EVENT, {
        type: 'session/event',
        sessionId: session.id,
        event: this.serializeEvent(event),
      })
    })

    // Agent 状态变更
    ctx.on('agent/status', (agent: Agent, status: string) => {
      this.emit(IPC_CHANNELS.SESSION_EVENT, {
        type: 'agent/status',
        sessionId: agent.id,
        status,
      })
    })
  }

  /**
   * 设置 MCP 事件监听器：将 MCP 事件转发到渲染进程。
   */
  private setupMcpListeners(): void {
    const ctx = this.app.ctx

    // 服务器添加
    ctx.on('mcp/server-added', (id: string, config: unknown) => {
      this.emitMcp({ type: 'mcp/server-added', serverId: id, config })
    })

    // 服务器移除
    ctx.on('mcp/server-removed', (id: string) => {
      this.emitMcp({ type: 'mcp/server-removed', serverId: id })
    })

    // 服务器更新
    ctx.on('mcp/server-updated', (id: string, config: unknown) => {
      this.emitMcp({ type: 'mcp/server-updated', serverId: id, config })
    })

    // 工具刷新
    ctx.on('mcp/tools-refreshed', (serverId: string, toolCount: number) => {
      this.emitMcp({ type: 'mcp/tools-refreshed', serverId, toolCount })
    })
  }

  /**
   * 发送 MCP 事件到渲染进程。
   */
  private emitMcp(payload: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(IPC_CHANNELS.MCP_EVENT, payload)
    }
  }

  /**
   * 序列化事件：将冻结的事件对象转为普通 JSON 对象。
   */
  private serializeEvent(event: SessionEvent): SerializedSessionEvent {
    return JSON.parse(JSON.stringify(event))
  }

  /**
   * 发送事件到渲染进程。
   */
  private emit(channel: string, payload: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload)
    }
  }

  /**
   * 设置 IPC handler：处理渲染进程的命令。
   */
  private setupIpcHandlers(): void {
    // 幂等注册（修复 2026-09-11）
    // --------------------------
    // 外层 electron/main.cjs 在模块顶层也注册了 `harness:open-folder` 等通道；Electron 对
    // 同一通道二次 `ipcMain.handle()` 会**直接抛错**（"Attempted to register a second
    // handler for 'harness:open-folder'"）。异常会中断本方法，导致 `open-folder` 之后声明的
    // 通道（workspace-history / mcp:* / skill:*）**全部没有注册**，并在日志里伪装成
    // “harness 初始化失败”。这里先摘掉同名旧 handler，保证桥接版本（能力更全，支持
    // 文件定位 / explorer 兜底）总能生效，且重复装配 / 热重载也安全。
    const ipcAny = this.ipcMain as unknown as { removeHandler?: (channel: string) => void }
    if (typeof ipcAny.removeHandler === 'function') {
      for (const channel of Object.values(IPC_CHANNELS)) {
        if (typeof channel !== 'string') continue
        try {
          ipcAny.removeHandler(channel)
        } catch {
          /* 从未注册过该通道：Electron 对 removeHandler 未注册通道不会抛错，这里仅防御 */
        }
      }
    }

    // 创建会话
    this.ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (_event, opts) => {
      const { cwd, title, model } = opts || {}
      const agent = this.app.createAgent({ cwd, title, model })
      this.agents.set(agent.id, agent)
      return this.sessionInfo(agent)
    })

    // 列出会话：合并 agent 注册表与会话存储（含重启后从持久化加载的历史会话）
    this.ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
      const agentById = new Map(this.app.listAgents().map((a) => [a.id, a]))
      return this.app
        .listSessions()
        .map((s) => {
          const agent = agentById.get(s.id)
          // 用量从 append-only 事件日志派生，历史会话重启后同样能算出真实消耗
          const summary = s.getUsageSummary()
          return {
            id: s.id,
            title: s.header.title || '新会话',
            createdAt: s.header.createdAt,
            updatedAt: s.header.createdAt,
            status: agent ? agent.status : 'idle',
            cwd: s.header.cwd,
            usage: {
              promptTokens: summary.promptTokens,
              completionTokens: summary.completionTokens,
              totalTokens: summary.totalTokens,
            },
            models: summary.byModel.map((m) => m.model),
            usageByModel: summary.byModel,
          } as SessionInfo
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
    })

    // 获取会话详情：历史会话（无 agent）先补建 agent，以便回放消息
    this.ipcMain.handle(IPC_CHANNELS.SESSION_GET, async (_event, sessionId) => {
      const agent = this.resolveAgent(sessionId)
      if (!agent) return null
      const session = agent.session
      const summary = session.getUsageSummary()
      return {
        info: this.sessionInfo(agent),
        messages: session.getMessages(),
        events: session.events.map((e) => this.serializeEvent(e)),
        usage: {
          promptTokens: summary.promptTokens,
          completionTokens: summary.completionTokens,
          totalTokens: summary.totalTokens,
        },
        usageByModel: summary.byModel,
      }
    })

    // 发送消息：会话缺失时才新建（正常应已有会话）
    this.ipcMain.handle(IPC_CHANNELS.SESSION_SEND, async (_event, sessionId, content) => {
      let agent = this.resolveAgent(sessionId)
      if (!agent) {
        agent = this.app.createAgent({})
        this.agents.set(agent.id, agent)
      }
      // content 可以是 string 或 ContentBlock[]；统一转为 ContentBlock[]
      if (typeof content === 'string') {
        agent.followup([{ type: 'text', text: content }])
      } else if (Array.isArray(content)) {
        agent.followup(content)
      } else {
        agent.followup([{ type: 'text', text: String(content ?? '') }])
      }
      return true
    })

    // 取消任务
    this.ipcMain.handle(IPC_CHANNELS.SESSION_CANCEL, async (_event, sessionId) => {
      const agent = this.resolveAgent(sessionId)
      if (!agent) return false
      agent.cancel({ kind: 'user-requested' })
      return true
    })

    // 重命名会话
    this.ipcMain.handle(IPC_CHANNELS.SESSION_RENAME, async (_event, sessionId, title) => {
      if (!this.resolveAgent(sessionId)) return { ok: false }
      const ok = this.app.renameAgent(sessionId, String(title || ''))
      return { ok }
    })

    // 删除会话
    this.ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, sessionId) => {
      // 先从本地 bridge 缓存里清掉，避免下次 IPC 把它复活
      this.agents.delete(sessionId)
      return { ok: this.app.deleteAgent(sessionId) }
    })

    // 用系统资源管理器打开目录
    this.ipcMain.handle(IPC_CHANNELS.OPEN_FOLDER, async (_event, dirPath) => {
      // electron 仅在真正调用时按需导入：顶部静态 import 会让模块在无头
      // Node（评估/单元测试）中无法加载。
      const { shell } = await import('electron')
      const p = String(dirPath || '').trim()
      if (!p) return { ok: false, error: 'empty path' }
      try {
        const stat = statSync(p)
        if (!stat.isDirectory()) {
          // 指向一个文件：用 shell.showItemInFolder 在资源管理器中高亮该文件，
          // 让「定位预览文件」的场景落在正确文件上（而不是打开父目录甚至项目根）。
          // shell.openPath 在文件上是「用默认程序打开文件」，不是用户想要的"定位"。
          try {
            shell.showItemInFolder(p)
            return { ok: true, mode: 'reveal-file' }
          } catch {
            // 极少数 Linux 平台 shell.showItemInFolder 不存在/抛错，回退到打开父目录
            const parent = dirname(p)
            await shell.openPath(parent)
            return { ok: true, mode: 'parent-fallback' }
          }
        }
        await shell.openPath(p)
        return { ok: true, mode: 'dir' }
      } catch (e) {
        // 兜底：用 explorer.exe /select 强制弹出资源管理器（Windows 专属）
        try {
          const isFile = (() => {
            try {
              return statSync(p).isFile()
            } catch {
              return false
            }
          })()
          if (isFile) {
            // explorer.exe /select,"<file>" 会打开父目录并选中目标文件
            spawn('explorer.exe', [`/select,${normalize(p)}`], { detached: true, stdio: 'ignore' }).unref()
            return { ok: true, mode: 'explorer-select' }
          }
          spawn('explorer.exe', [normalize(p)], { detached: true, stdio: 'ignore' }).unref()
          return { ok: true, mode: 'explorer' }
        } catch (e2) {
          return { ok: false, error: String((e2 as Error)?.message || e) }
        }
      }
    })

    // 工作空间历史目录（SQLite：<userData>/workspaces.db）
    this.ipcMain.handle(IPC_CHANNELS.WORKSPACE_HISTORY_GET, async () => getRecentWorkspaces())
    this.ipcMain.handle(IPC_CHANNELS.WORKSPACE_HISTORY_ADD, async (_event, dir: string) => addWorkspace(dir))
    this.ipcMain.handle(
      IPC_CHANNELS.WORKSPACE_HISTORY_REMOVE,
      async (_event, dir: string) => removeWorkspace(dir),
    )
  }

  /**
   * 设置 MCP IPC 处理器。
   */
  private setupMcpHandlers(): void {
    const mcp = (this.app.ctx as any).mcp

    // 列出服务器
    this.ipcMain.handle(IPC_CHANNELS.MCP_LIST_SERVERS, async () => {
      return mcp.listServers()
    })

    // 添加服务器
    this.ipcMain.handle(IPC_CHANNELS.MCP_ADD_SERVER, async (_event, config) => {
      try {
        mcp.addServer(config)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    })

    // 移除服务器
    this.ipcMain.handle(IPC_CHANNELS.MCP_REMOVE_SERVER, async (_event, id) => {
      mcp.removeServer(id)
      return { ok: true }
    })

    // 更新服务器
    this.ipcMain.handle(IPC_CHANNELS.MCP_UPDATE_SERVER, async (_event, id, updates) => {
      mcp.updateServer(id, updates)
      return { ok: true }
    })

    // 刷新工具
    this.ipcMain.handle(IPC_CHANNELS.MCP_REFRESH_TOOLS, async () => {
      const result = await mcp.refreshAllTools()
      return result
    })

    // 列出工具
    this.ipcMain.handle(IPC_CHANNELS.MCP_LIST_TOOLS, async () => {
      return mcp.listMcpTools()
    })

    // 测试连接
    this.ipcMain.handle(IPC_CHANNELS.MCP_TEST_CONNECTION, async (_event, serverId) => {
      return mcp.testConnection(serverId)
    })

    // 获取连接状态
    this.ipcMain.handle(IPC_CHANNELS.MCP_GET_STATUS, async (_event, serverId) => {
      return mcp.getConnectionStatus(serverId)
    })
  }

  /**
   * 设置 Skill IPC 处理器。
   */
  private setupSkillHandlers(): void {
    const skill = (this.app.ctx as any).skill

    // 列出技能
    this.ipcMain.handle(IPC_CHANNELS.SKILL_LIST, async () => {
      return skill.listSkills()
    })

    // 获取技能
    this.ipcMain.handle(IPC_CHANNELS.SKILL_GET, async (_event, id: string) => {
      return skill.getSkill(id)
    })

    // 添加技能
    this.ipcMain.handle(IPC_CHANNELS.SKILL_ADD, async (_event, skillData) => {
      try {
        const result = skill.addSkill(skillData)
        return { ok: true, skill: result }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    })

    // 移除技能
    this.ipcMain.handle(IPC_CHANNELS.SKILL_REMOVE, async (_event, id: string) => {
      try {
        const result = skill.removeSkill(id)
        return { ok: true, removed: result }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    })

    // 更新技能
    this.ipcMain.handle(IPC_CHANNELS.SKILL_UPDATE, async (_event, id: string, updates) => {
      const result = skill.updateSkill(id, updates)
      return { ok: true, skill: result }
    })

    // 启用技能
    this.ipcMain.handle(IPC_CHANNELS.SKILL_ENABLE, async (_event, id: string) => {
      const result = skill.enableSkill(id)
      return { ok: true, enabled: result }
    })

    // 禁用技能
    this.ipcMain.handle(IPC_CHANNELS.SKILL_DISABLE, async (_event, id: string) => {
      const result = skill.disableSkill(id)
      return { ok: true, disabled: result }
    })

    // 切换技能
    this.ipcMain.handle(IPC_CHANNELS.SKILL_TOGGLE, async (_event, id: string) => {
      const result = skill.toggleSkill(id)
      return { ok: true, enabled: result }
    })

    // 获取技能提示
    this.ipcMain.handle(IPC_CHANNELS.SKILL_GET_PROMPT, async () => {
      return skill.buildPrompt()
    })

    // 获取技能统计
    this.ipcMain.handle(IPC_CHANNELS.SKILL_GET_STATS, async () => {
      return skill.getStats()
    })

    // 按分类列出技能
    this.ipcMain.handle(IPC_CHANNELS.SKILL_LIST_BY_CATEGORY, async () => {
      return skill.listByCategory()
    })
  }

  /**
   * 设置 Skill 事件监听器：将技能事件转发到渲染进程。
   */
  private setupSkillListeners(): void {
    const ctx = this.app.ctx

    // 技能添加
    ctx.on('skill/added', (skill: unknown) => {
      this.emitSkill({ type: 'skill/added', skill })
    })

    // 技能移除
    ctx.on('skill/removed', (id: string) => {
      this.emitSkill({ type: 'skill/removed', skillId: id })
    })

    // 技能更新
    ctx.on('skill/updated', (skill: unknown) => {
      this.emitSkill({ type: 'skill/updated', skill })
    })

    // 技能启用
    ctx.on('skill/enabled', (id: string) => {
      this.emitSkill({ type: 'skill/enabled', skillId: id })
    })

    // 技能禁用
    ctx.on('skill/disabled', (id: string) => {
      this.emitSkill({ type: 'skill/disabled', skillId: id })
    })
  }

  /**
   * 发送 Skill 事件到渲染进程。
   */
  private emitSkill(payload: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(IPC_CHANNELS.SKILL_EVENT, payload)
    }
  }

  /**
   * 从 app 侧解析一个会话 ID 到 agent（存在则直接取，历史会话则补建）。
   */
  private resolveAgent(sessionId: string): Agent | undefined {
    return this.app.getOrCreateAgent(sessionId as never)
  }

  /**
   * 从 agent 生成会话信息对象。
   */
  private sessionInfo(agent: Agent): SessionInfo {
    const session = agent.session
    const summary = session.getUsageSummary()
    return {
      id: session.id,
      title: session.header.title || '新会话',
      createdAt: session.header.createdAt,
      updatedAt: session.header.createdAt, // TODO: 从事件中更新
      status: agent.status,
      cwd: session.header.cwd,
      usage: {
        promptTokens: summary.promptTokens,
        completionTokens: summary.completionTokens,
        totalTokens: summary.totalTokens,
      },
      models: summary.byModel.map((m) => m.model),
      usageByModel: summary.byModel,
    }
  }

  /**
   * 销毁桥接器：清理所有监听器。
   */
  dispose(): void {
    // IPC handlers 由 ipcMain 管理，这里不需要手动清理
    // （Electron 会在窗口关闭时自动清理）
    this.agents.clear()
  }
}
