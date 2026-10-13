/**
 * 事件溯源会话服务：append-only 会话日志 + 派生消息历史。
 *
 * 遵循 deepseek-harness 设计原则：
 * - 模型可见 ⟺ 已记录：任何到达模型请求的内容都必须能从会话日志中重建
 * - 事件溯源：所有状态变更都通过追加事件实现，不直接修改状态
 * - 派生状态：消息历史等派生数据从事件日志计算得出
 * - 不可变事件：追加后不可修改，保证审计和回放能力
 *
 * 事件类型（SessionEventMap）：
 * - user/message: 用户消息
 * - assistant/message: 助手消息
 * - tool/call: 工具调用
 * - tool/result: 工具结果
 * - turn/start: 轮次开始
 * - turn/end: 轮次结束
 */

import type { Context } from './context.js'
import { Service } from './context.js'
import { randomUUID } from 'node:crypto'
import type { ModelToolCall } from './llm.js'

/** 会话 ID 类型（branded，避免普通字符串混用） */
export type SessionId = string & { readonly __brand: 'SessionId' }

/** 创建会话 ID */
export function createSessionId(): SessionId {
  return randomUUID() as SessionId
}

// ============================================================
// 内容块类型
// ============================================================

/** 文本内容块 */
export interface TextContentBlock {
  type: 'text'
  text: string
}

/** 思考内容块 */
export interface ThinkingContentBlock {
  type: 'thinking'
  thinking: string
}

/** 图片内容块（base64 编码，兼容 DeepSeek/OpenAI vision 格式） */
export interface ImageContentBlock {
  type: 'image'
  mimeType: string
  data: string
  name?: string
}

/** 内容块联合类型 */
export type ContentBlock = TextContentBlock | ThinkingContentBlock | ImageContentBlock

// ============================================================
// 会话事件类型
// ============================================================

/** 用户消息事件 */
export interface UserMessageEvent {
  type: 'user/message'
  seq: number
  data: {
    content: ContentBlock[]
  }
}

/** 助手消息事件 */
export interface AssistantMessageEvent {
  type: 'assistant/message'
  seq: number
  data: {
    message: {
      role: 'assistant'
      content: ContentBlock[]
      /** 助手请求并行发起的工具调用（OpenAI 协议要求跟随在助手消息上）。 */
      tool_calls?: ModelToolCall[]
    }
    usage?: {
      promptTokens: number
      completionTokens: number
      totalTokens: number
    }
    /**
     * 产出该次响应的模型名。用于「每次对话消耗了什么模型」的统计。
     * 旧事件没有该字段（持久化历史），统计时归入 `unknown`。
     */
    model?: string
  }
}

/** Token 使用量（一次或累计）。 */
export interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** 单个模型的累计用量（含调用次数，便于看「哪个模型消耗最多」）。 */
export interface UsageByModel extends Usage {
  /** 模型名；历史无模型字段的事件归入 `'unknown'`。 */
  model: string
  /** 该模型产生过多少次带 usage 的响应。 */
  calls: number
}

/** 会话级用量汇总：合计 + 按模型拆分。 */
export interface UsageSummary extends Usage {
  byModel: UsageByModel[]
}

/** 工具调用事件 */
export interface ToolCallEvent {
  type: 'tool/call'
  seq: number
  data: {
    toolCallId: string
    name: string
    args: Record<string, unknown>
  }
}

/** 工具结果事件 */
export interface ToolResultEvent {
  type: 'tool/result'
  seq: number
  data: {
    toolCallId: string
    name: string
    message: {
      role: 'tool'
      content: ContentBlock[]
    }
  }
}

/** 轮次开始事件 */
export interface TurnStartEvent {
  type: 'turn/start'
  seq: number
  data: {
    turn: number
  }
}

/** 轮次结束事件 */
export interface TurnEndEvent {
  type: 'turn/end'
  seq: number
  data: {
    turn: number
    reason: 'completed' | 'cancelled' | 'error' | 'max-tokens'
  }
}

/** 会话事件联合类型 */
export type SessionEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | TurnStartEvent
  | TurnEndEvent

/** 会话事件类型映射（支持声明合并扩展） */
export interface SessionEventMap {
  'user/message': UserMessageEvent
  'assistant/message': AssistantMessageEvent
  'tool/call': ToolCallEvent
  'tool/result': ToolResultEvent
  'turn/start': TurnStartEvent
  'turn/end': TurnEndEvent
}

// ============================================================
// 会话头（元数据）
// ============================================================

/** 会话头：不可变的创建元数据 */
export interface SessionHeader {
  /** 会话 ID */
  id: SessionId
  /** 创建时间戳 */
  createdAt: number
  /** 工作目录（绝对路径） */
  cwd?: string
  /** 标题 */
  title?: string
  /** 会话格式版本 */
  version: number
}

/** 当前会话格式版本 */
export const SESSION_FORMAT_VERSION = 0

// ============================================================
// Session 类
// ============================================================

/**
 * 会话：事件溯源的消息容器。
 *
 * 所有状态变更都通过 appendEvent() 追加事件实现。
 * 消息历史等派生数据通过 events 动态计算。
 */
export class Session {
  /** 会话头（不可变元数据）。标题会变，其余字段不变；每次变更都以新的冻结对象替换。 */
  private _header: SessionHeader
  get header(): SessionHeader {
    return this._header
  }

  /** 事件日志：append-only */
  private _events: SessionEvent[] = []

  /** 下一个事件序列号 */
  private nextSeq = 0

  constructor(header: SessionHeader) {
    this._header = Object.freeze({ ...header })
  }

  /**
   * 更新会话标题。以一份新的冻结 header 替换旧 header，其余元数据保持不变。
   * 变更后调用方需负责持久化（SessionStore.renameTitle 会同步写库）。
   */
  updateTitle(title: string): void {
    this._header = Object.freeze({ ...this._header, title })
  }

  /** 事件列表（只读视图） */
  get events(): readonly SessionEvent[] {
    return this._events
  }

  /** 会话 ID */
  get id(): SessionId {
    return this.header.id
  }

  /**
   * 追加一个事件。
   * 事件会被冻结以保证不可变性。
   * @returns 追加后的事件（已冻结）
   */
  appendEvent<T extends SessionEvent>(event: Omit<T, 'seq'>): T {
    const seq = this.nextSeq++
    const fullEvent = { ...event, seq } as T
    // 深度冻结事件对象，保证不可变性
    Object.freeze(fullEvent)
    if (fullEvent.data && typeof fullEvent.data === 'object') {
      Object.freeze(fullEvent.data)
    }
    this._events.push(fullEvent)
    return fullEvent
  }

  /**
   * 派生：获取所有消息（按顺序）。
   * 从事件日志中提取 user/assistant/tool 消息。
   */
  getMessages(): Array<{
    role: 'user' | 'assistant' | 'tool'
    content: ContentBlock[]
    toolCallId?: string
    toolName?: string
    tool_calls?: ModelToolCall[]
  }> {
    const messages: Array<{
      role: 'user' | 'assistant' | 'tool'
      content: ContentBlock[]
      toolCallId?: string
      toolName?: string
      tool_calls?: ModelToolCall[]
    }> = []

    for (const event of this._events) {
      switch (event.type) {
        case 'user/message':
          messages.push({ role: 'user', content: event.data.content })
          break
        case 'assistant/message':
          messages.push({
            role: 'assistant',
            content: event.data.message.content,
            ...(event.data.message.tool_calls
              ? { tool_calls: event.data.message.tool_calls }
              : {}),
          })
          break
        case 'tool/result':
          messages.push({
            role: 'tool',
            content: event.data.message.content,
            toolCallId: event.data.toolCallId,
            toolName: event.data.name,
          })
          break
      }
    }

    return messages
  }

  /** 获取累计 token 使用量 */
  getTotalUsage(): Usage {
    const { promptTokens, completionTokens, totalTokens } = this.getUsageSummary()
    return { promptTokens, completionTokens, totalTokens }
  }

  /**
   * 获取会话级用量汇总：合计 + 按模型拆分。
   *
   * 数据源是 append-only 事件日志（每个 assistant/message 事件上的 `usage` +
   * `model`），因此重启后从持久化回放同样能得到一致结果，无需额外存一份统计。
   * 早期事件没有 `model` 字段，统一归入 `UNKNOWN_MODEL`。
   */
  getUsageSummary(): UsageSummary {
    let promptTokens = 0
    let completionTokens = 0
    let totalTokens = 0
    const byModelMap = new Map<string, UsageByModel>()

    for (const event of this._events) {
      if (event.type !== 'assistant/message') continue
      const usage = event.data.usage as Usage | undefined
      if (!usage) continue

      const p = Number(usage.promptTokens) || 0
      const c = Number(usage.completionTokens) || 0
      const t = Number(usage.totalTokens) || 0
      promptTokens += p
      completionTokens += c
      totalTokens += t

      const raw = (event.data as { model?: unknown }).model
      const model =
        typeof raw === 'string' && raw.trim() ? raw.trim() : UNKNOWN_MODEL_LABEL
      const entry = byModelMap.get(model)
      if (entry) {
        entry.promptTokens += p
        entry.completionTokens += c
        entry.totalTokens += t
        entry.calls += 1
      } else {
        byModelMap.set(model, {
          model,
          promptTokens: p,
          completionTokens: c,
          totalTokens: t,
          calls: 1,
        })
      }
    }

    // 消耗多的模型排前面，同名模型保持首次出现顺序（稳定排序）
    const byModel = [...byModelMap.values()].sort(
      (a, b) => b.totalTokens - a.totalTokens,
    )

    return { promptTokens, completionTokens, totalTokens, byModel }
  }
}

/** 历史事件缺少 model 字段时的占位模型名。 */
export const UNKNOWN_MODEL_LABEL = 'unknown'

// ============================================================
// 上下文类型声明合并
// ============================================================

declare module './context.js' {
  interface Context {
    sessions: SessionStore
  }
}

// ============================================================
// SessionStore 服务
// ============================================================

/** 创建会话选项 */
export interface CreateSessionOptions {
  /** 工作目录 */
  cwd?: string
  /** 标题 */
  title?: string
  /** 初始事件 */
  initialEvents?: SessionEvent[]
}

/** SessionStore 配置 */
export interface SessionStoreConfig {
  /** 持久化提供器（可选，不提供则为内存模式） */
  persistence?: import('./session-persistence.js').SessionPersistenceProvider
  /** 是否在启动时自动加载持久化的会话 */
  autoLoad?: boolean
}

/**
 * 会话存储服务：管理所有活跃会话。
 *
 * 遵循 harness 模式：
 * - 会话通过 create() 创建并发布
 * - 创建时触发 session/created 事件
 * - 事件通过 session/event 事件广播
 * - 可选持久化：配置 persistence 后自动保存/加载
 */
export class SessionStore extends Service {
  private store = new Map<SessionId, Session>()
  private persistence: import('./session-persistence.js').SessionPersistenceProvider | null = null
  private autoLoad: boolean

  constructor(ctx: Context, config: SessionStoreConfig = {}) {
    super(ctx, 'sessions')
    ctx.declareEvent('session/created', 'emit')
    ctx.declareEvent('session/title-updated', 'emit')
    ctx.declareEvent('session/disposed', 'emit')
    ctx.declareEvent('session/event', 'emit')
    ctx.declareEvent('session/flush', 'parallel')
    ctx.declareEvent('session/loaded', 'emit')
    ctx.declareEvent('persistence/ready', 'emit')

    this.persistence = config.persistence ?? null
    this.autoLoad = config.autoLoad ?? true

    // 初始化持久化
    if (this.persistence) {
      this.persistence.initialize()
      ctx.emit('persistence/ready')

      if (this.autoLoad) {
        this.loadAllFromPersistence()
      }
    }
  }

  /**
   * 从持久化存储加载所有会话。
   */
  private loadAllFromPersistence(): void {
    if (!this.persistence) return

    const headers = this.persistence.loadAllSessions()
    let loadedCount = 0

    for (const header of headers) {
      const events = this.persistence.loadEvents(header.id)
      const session = this.createFromPersistence(header, events)
      loadedCount++
    }

    this.ctx.emit('session/loaded', loadedCount)
  }

  /**
   * 从持久化数据创建会话（内部方法，不触发 created 事件）。
   */
  private createFromPersistence(header: SessionHeader, events: SessionEvent[]): Session {
    const session = new Session(header)

    // 重放事件
    for (const event of events) {
      session.appendEvent(event as any)
    }

    this.store.set(header.id, session)
    return session
  }

  /**
   * 创建一个新会话。
   * @throws 如果 ID 已存在则抛出错误
   */
  create(id: SessionId, options: CreateSessionOptions = {}): Session {
    if (this.store.has(id)) {
      throw new Error(`session "${id}" already exists`)
    }

    const header: SessionHeader = {
      id,
      createdAt: Date.now(),
      version: SESSION_FORMAT_VERSION,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.title ? { title: options.title } : {}),
    }

    const session = new Session(header)

    // 追加初始事件
    if (options.initialEvents) {
      for (const event of options.initialEvents) {
        session.appendEvent(event as any)
      }
    }

    this.store.set(id, session)

    // 持久化
    if (this.persistence) {
      this.persistence.saveSession(header)
      if (options.initialEvents && options.initialEvents.length > 0) {
        this.persistence.appendEvents(id, session.events as SessionEvent[])
      }
    }

    // 触发创建事件
    this.ctx.emit('session/created', session)

    return session
  }

  /** 获取会话 */
  get(id: SessionId): Session | undefined {
    return this.store.get(id)
  }

  /** 检查会话是否存在 */
  has(id: SessionId): boolean {
    return this.store.has(id)
  }

  /**
   * 向会话追加事件并广播。
   */
  appendEvent(sessionId: SessionId, event: Omit<SessionEvent, 'seq'>): SessionEvent {
    const session = this.store.get(sessionId)
    if (!session) {
      throw new Error(`session "${sessionId}" not found`)
    }

    const appended = session.appendEvent(event as any)
    this.ctx.emit('session/event', session, appended)

    // 持久化
    if (this.persistence) {
      this.persistence.appendEvent(sessionId, appended)
    }

    return appended
  }

  /** 列出所有会话 */
  list(): Session[] {
    return [...this.store.values()]
  }

  /** 销毁会话 */
  dispose(id: SessionId): boolean {
    const session = this.store.get(id)
    if (!session) return false
    this.store.delete(id)

    // 持久化删除
    if (this.persistence) {
      this.persistence.deleteSession(id)
    }

    this.ctx.emit('session/disposed', session)
    return true
  }

  /** 是否启用持久化 */
  hasPersistence(): boolean {
    return this.persistence !== null
  }

  /**
   * 重命名会话标题：更新内存中的 header，并持久化（写库）以便重启后保留。
   * 标题变更会广播 `session/title-updated` 事件（桥接层转发给渲染进程）。
   * @returns 是否真的重命名成功（会话存在且标题有变化）
   */
  renameTitle(id: SessionId, rawTitle: string): boolean {
    const session = this.store.get(id)
    if (!session) return false
    const next = String(rawTitle ?? '').trim().slice(0, 80) || '新会话'
    const current = session.header.title || ''
    session.updateTitle(next)
    if (this.persistence) {
      this.persistence.saveSession(session.header)
    }
    this.ctx.emit('session/title-updated', session, next)
    return current !== next
  }

  /** 获取持久化提供器 */
  getPersistence(): import('./session-persistence.js').SessionPersistenceProvider | null {
    return this.persistence
  }

  /** 手动触发加载持久化会话 */
  loadFromPersistence(): number {
    if (!this.persistence) return 0
    this.loadAllFromPersistence()
    return this.store.size
  }
}
