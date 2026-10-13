/**
 * Agent Loop：驱动会话的 turn/step 循环。
 *
 * 遵循 deepseek-harness 设计原则：
 * - Turn = 一次用户输入触发的完整处理周期
 * - Step = 一次模型请求 + 工具调用
 * - 事件驱动：所有状态变更通过会话事件传播
 * - 收件箱（Inbox）：排队的用户输入，按 turn 消费
 * - 取消支持：AbortSignal 贯穿整个执行链
 *
 * 生命周期：
 * 1. 用户消息进入 inbox
 * 2. wakeDriver 启动一个 turn
 * 3. turn 内循环 step：模型生成 → 工具调用 → 模型生成 → ...
 * 4. turn 结束（无工具调用或达到限制）
 */

import type { Context } from './context.js'
import { Service } from './context.js'
import type { Session, SessionId, ContentBlock } from './session.js'
import { createSessionId } from './session.js'
import type { ToolRuntime } from './tools.js'
import type { LlmRuntime, ChatMessage, ModelToolCall, Usage } from './llm.js'
import { bridgeImagesToText, type ModlensConfig } from './modlens.js'

// ============================================================
// Agent 状态
// ============================================================

/** Agent 状态 */
export type AgentStatus = 'idle' | 'running'

/** Agent 取消原因 */
export interface AgentCancelCause {
  kind: 'user-requested' | 'disposed' | 'error'
  reason?: string
}

// ============================================================
// Agent 接口
// ============================================================

/**
 * Agent 接口：由 agent-loop 实现，消费者通过此接口与 agent 交互。
 */
export interface Agent {
  /** Agent ID（与会话 ID 相同） */
  readonly id: SessionId
  /** 关联的会话 */
  readonly session: Session
  /** 当前状态 */
  readonly status: AgentStatus
  /** Agent 作用域上下文 */
  readonly ctx: Context

  /**
   * 发送消息并唤醒 agent（下一个 turn）。
   */
  followup(content: ContentBlock[]): void

  /**
   * 取消当前执行。
   */
  cancel(cause: AgentCancelCause): void
}

// ============================================================
// 上下文类型声明合并
// ============================================================

declare module './context.js' {
  interface Context {
    agents: AgentRegistry
    agentLoop: AgentLoop
  }
}

// ============================================================
// Agent 注册中心
// ============================================================

/**
 * Agent 注册中心：跟踪所有活跃的 agent。
 * 提供 setFactory 让 agent-loop 注册创建工厂。
 */
export class AgentRegistry extends Service {
  private agents = new Map<SessionId, Agent>()
  private factory: ((id: SessionId, options: AgentOptions, session: Session) => Agent) | null = null

  constructor(ctx: Context) {
    super(ctx, 'agents')
    ctx.declareEvent('agent/status', 'emit')
    ctx.declareEvent('agent/created', 'emit')
    ctx.declareEvent('agent/disposed', 'emit')
  }

  /**
   * 设置 agent 工厂。由 agent-loop 在启动时调用。
   * @returns 注销函数
   */
  setFactory(factory: (id: SessionId, options: AgentOptions, session: Session) => Agent): () => void {
    if (this.factory) {
      throw new Error('agent factory is already registered')
    }
    this.factory = factory
    return () => {
      this.factory = null
    }
  }

  /** 注册一个 agent */
  register(agent: Agent): void {
    this.agents.set(agent.id, agent)
    this.ctx.emit('agent/created', agent)
  }

  /** 注销一个 agent */
  unregister(id: SessionId): void {
    const agent = this.agents.get(id)
    if (agent) {
      this.agents.delete(id)
      this.ctx.emit('agent/disposed', agent)
    }
  }

  /** 获取 agent */
  get(id: SessionId): Agent | undefined {
    return this.agents.get(id)
  }

  /** 列出所有 agent */
  list(): Agent[] {
    return [...this.agents.values()]
  }

  /** 创建 agent（通过工厂） */
  create(id: SessionId, options: AgentOptions, session: Session): Agent {
    if (!this.factory) {
      throw new Error('no agent factory registered')
    }
    const agent = this.factory(id, options, session)
    this.register(agent)
    return agent
  }
}

// ============================================================
// Agent 选项
// ============================================================

/** Agent 配置选项 */
export interface AgentOptions {
  /** 模型名称 */
  model?: string
  /** 最大工具步数 */
  maxToolSteps?: number
  /** 最大 token 数 */
  maxTokens?: number
  /** 温度 */
  temperature?: number
  /** 系统提示 */
  systemPrompt?: string
  /** modlens 视觉桥接配置（注入给 agent 实例） */
  modlens?: ModlensConfig
}

// ============================================================
// ReactLoopAgent
// ============================================================

/**
 * 响应式 Agent 驱动：基于 turn/step 循环。
 *
 * 每个 turn 处理一个用户消息，可能包含多个 step（模型调用 → 工具调用 → ...）。
 * 所有状态变更通过 session 事件传播，UI 订阅 session/event 更新。
 */
export class ReactLoopAgent implements Agent {
  readonly id: SessionId
  readonly session: Session
  readonly ctx: Context

  private _status: AgentStatus = 'idle'
  private abortController: AbortController | null = null
  private activityDone: Promise<void> = Promise.resolve()
  private pendingMessages: ContentBlock[][] = []
  /** 已在启动 turn（含异步 admit 窗口）的同步守卫：避免连续 followup 在状态尚未切到
   *  running 时被判为 idle 而双开 turn，导致第二条消息丢失（其 wakeDriver 因状态已 running 早退）。 */
  private starting = false
  private maxToolSteps: number
  private model: string
  private temperature: number
  private maxTokens: number | undefined
  private systemPrompt: string
  /** modlens 视觉桥接配置（可能为 undefined，表示未启用） */
  private modlensConfig?: ModlensConfig

  constructor(
    private loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
  ) {
    this.id = id
    this.session = session
    this.ctx = loopCtx.extend({ agent: this })
    this.maxToolSteps = options.maxToolSteps ?? 8
    this.model = options.model || 'deepseek-chat'
    this.temperature = options.temperature ?? 0.7
    this.maxTokens = options.maxTokens
    this.systemPrompt = options.systemPrompt || this.getDefaultSystemPrompt()
    this.modlensConfig = options.modlens
  }

  get status(): AgentStatus {
    return this._status
  }

  private setStatus(status: AgentStatus): void {
    if (this._status !== status) {
      this._status = status
      this.loopCtx.emit('agent/status', this, status)
    }
  }

  private getDefaultSystemPrompt(): string {
    const cwd = this.session?.header?.cwd && String(this.session.header.cwd).trim()
      ? String(this.session.header.cwd).trim()
      : ''
    const cwdLine = cwd
      ? `当前工作目录（所有文件读写操作都必须相对此目录进行）：\n${cwd}`
      : '当前未绑定工作目录（请先提示用户选择工作目录，或先用 fs__list_dir 查看可用目录）'
    return `你是一个有帮助的 AI 助手。请仔细思考用户的问题，提供准确、有用的回答。
你可以使用提供的工具来获取信息或执行操作。

${cwdLine}

重要约束：
1. 凡是需要"生成 / 写出"的内容（文档、代码、说明、报告、页面等），必须在对话最终回复之前，用 fs__write_file 工具真正写入磁盘；只口头描述"已写好"而不调用写入工具，视为失败。
2. fs__write_file / fs__read_file / fs__list_dir / fs__delete_file 都只接受相对工作目录的路径（禁止盘符绝对路径，禁止 ..）。
3. 写入后应立即用 fs__list_dir 或 fs__read_file 复核文件确实存在且内容正确；发现未落盘或内容有误要主动修复，直到真实落盘成功为止。
4. 若写入失败（权限不足 / 路径越界 / 磁盘错误），应如实报告失败原因并向用户说明，不得谎称成功。
5. 使用工具时，请先思考需要做什么，然后调用合适的工具。`
  }

  /**
   * 发送消息并唤醒 agent。
   * 如果 agent 正在运行，消息会排队到下一个 turn。
   *
   * 遵循 deepseek-harness 设计：
   * - 空闲时：立即追加事件并启动 turn
   * - 运行时：仅排队，不追加事件（消息在 turn 开始时才被 admitted）
   */
  followup(content: ContentBlock[]): void {
    if (this._status === 'running' || this.starting) {
      // 运行时或正在启动（异步 admit 窗口）：排队，等当前 turn 结束后再处理
      this.pendingMessages.push(content)
    } else {
      // 空闲且未在启动窗口：启动守卫由 admitUserMessage 在进入异步窗口时负责标记，
      // 这里只负责把消息交给它（含 pending 重放路径也是同一入口）。
      void this.admitUserMessage(content)
    }
  }

  /**
   * 接收一条用户消息：先把其中的图片经 modlens 视觉桥接转成文字证据，
   * 再把（可能已转换的）消息作为 user/message 事件追加到会话，并唤醒驱动。
   * 全程异步：视觉识别是网络调用，不阻塞调用方。
   */
  private async admitUserMessage(content: ContentBlock[]): Promise<void> {
    // 进入异步 admit 窗口：标记 starting 守卫，避免并发同步 followup 在状态尚未切到
    // running 前被判为 idle 而双开 turn（第二条消息的 wakeDriver 会因状态已 running 早退丢消息）。
    // 该窗口同时覆盖「直接 followup」与「wakeDriver 重放 pending 消息」两条入口。
    this.starting = true
    try {
      const converted = await bridgeImagesToText(
        content,
        this.modlensConfig,
        this.model,
        this.abortController?.signal,
      )
      this.admitTitleFromFirstMessage(converted)
      this.loopCtx.sessions.appendEvent(this.id, {
        type: 'user/message',
        data: { content: converted },
      })
      this.wakeDriver()
    } finally {
      // wakeDriver 已同步把状态切到 running（或早退，说明已有 turn 在跑）；
      // 之后并发 followup 由状态本身判定，复位 starting 让空闲窗口的新消息能正确开新 turn。
      this.starting = false
    }
  }

  /**
   * 用会话的第一条用户消息自动起标题（若尚未命名）。
   * 标题派生后经 SessionStore.renameTitle 持久化，重启后仍保留。
   */
  private admitTitleFromFirstMessage(content: ContentBlock[]): void {
    const current = this.session.header.title || ''
    if (current && current !== '新会话') return
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    if (!text) return
    // 去掉「[深度研究工作流] 」这类前缀
    const clean = text.replace(/^\[[^\]]*\]\s*/, '').trim()
    if (!clean) return
    const title = clean.slice(0, 24) + (clean.length > 24 ? '…' : '')
    this.loopCtx.sessions.renameTitle(this.id, title)
  }

  /** 取消当前执行 */
  cancel(cause: AgentCancelCause): void {
    if (this.abortController) {
      this.abortController.abort(cause)
    }
    this.pendingMessages = []
  }

  /**
   * 启动驱动：开始处理一个 turn。
   */
  private wakeDriver(): void {
    if (this._status !== 'idle') return

    this.setStatus('running')
    this.abortController = new AbortController()

    const driver = this.runTurn(this.abortController.signal)
    this.activityDone = driver
      .catch((e) => {
        console.error('[harness] agent turn error:', e)
      })
      .finally(() => {
        this.setStatus('idle')
        this.abortController = null

        // 如果有排队的消息，追加事件并启动下一个 turn
        if (this.pendingMessages.length > 0) {
          const next = this.pendingMessages.shift()!
          // 图片同样先经 modlens 转成文字证据再落库，并唤醒驱动
          void this.admitUserMessage(next)
        }
      })
  }

  /**
   * 执行一个 turn。
   * 一个 turn 包含多个 step（模型调用 + 工具调用）。
   */
  private async runTurn(signal: AbortSignal): Promise<void> {
    const llm = this.loopCtx.llm as LlmRuntime
    const tools = this.loopCtx.tools as ToolRuntime

    let step = 0
    const maxSteps = this.maxToolSteps

    // turn 开始事件
    this.loopCtx.sessions.appendEvent(this.id, {
      type: 'turn/start',
      data: { turn: Date.now() },
    })

    let turnEndReason: 'completed' | 'cancelled' | 'error' | 'max-tokens' = 'completed'

    try {
      while (step < maxSteps) {
        if (signal.aborted) {
          turnEndReason = 'cancelled'
          break
        }

        // 构建消息历史
        const messages = this.buildChatMessages()

        // 工具定义
        const toolDefs = tools.toModelFormat()

        // 调用模型
        const result = await llm.generate({
          model: this.model,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          temperature: this.temperature,
          maxTokens: this.maxTokens,
          signal,
        })

        // 追加助手消息事件
        this.loopCtx.sessions.appendEvent(this.id, {
          type: 'assistant/message',
          data: {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: result.content }],
              // OpenAI 协议：工具调用紧跟在助手消息上，否则下游模型回合与
              // 会话日志都无法重建工具的发起者。
              ...(result.toolCalls && result.toolCalls.length > 0
                ? { tool_calls: result.toolCalls }
                : {}),
            },
            usage: result.usage,
            // 记录本次响应实际使用的模型：会话级 token 统计要按模型拆分，
            // 而单纯看配置无法还原「中途切模型 / 图片走视觉模型」的真实消耗。
            model: this.model,
          },
        })

        // 如果没有工具调用，turn 结束
        if (!result.toolCalls || result.toolCalls.length === 0) {
          break
        }

        step++

        // 执行工具调用
        for (const tc of result.toolCalls) {
          if (signal.aborted) break

          // 工具调用事件
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(tc.function.arguments)
          } catch {
            // 解析失败，传空对象
          }

          this.loopCtx.sessions.appendEvent(this.id, {
            type: 'tool/call',
            data: {
              toolCallId: tc.id,
              name: tc.function.name,
              args,
            },
          })

          // 执行工具
          const toolResult = await tools.execute(tc.function.name, args, {
            agentId: this.id,
            signal,
          })

          // 工具结果事件
          this.loopCtx.sessions.appendEvent(this.id, {
            type: 'tool/result',
            data: {
              toolCallId: tc.id,
              name: tc.function.name,
              message: {
                role: 'tool',
                content: toolResult.content,
              },
            },
          })
        }
      }

      if (step >= maxSteps) {
        turnEndReason = 'max-tokens' // 用这个表示达到步数限制
      }
    } catch (e) {
      if (signal.aborted) {
        turnEndReason = 'cancelled'
      } else {
        turnEndReason = 'error'
        console.error('[harness] agent step error:', e)
      }
    }

    // turn 结束事件
    this.loopCtx.sessions.appendEvent(this.id, {
      type: 'turn/end',
      data: {
        turn: Date.now(),
        reason: turnEndReason,
      },
    })
  }

  /**
   * 从会话事件构建聊天消息列表。
   */
  private buildChatMessages(): ChatMessage[] {
    const messages: ChatMessage[] = []

    // 系统提示
    if (this.systemPrompt) {
      messages.push({ role: 'system', content: this.systemPrompt })
    }

    // 从会话事件派生消息
    const sessionMessages = this.session.getMessages()
    for (const msg of sessionMessages) {
      // 提取文本和图片块，构建多模态 content
      const textBlocks = msg.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      const imageBlocks = msg.content.filter((b): b is { type: 'image'; mimeType: string; data: string; name?: string } => b.type === 'image')
      const text = textBlocks.map((b) => b.text).join('')

      if (msg.role === 'tool') {
        // 工具消息始终用纯文本
        messages.push({
          role: 'tool',
          content: text,
          tool_call_id: msg.toolCallId || '',
          name: msg.toolName,
        })
      } else if (imageBlocks.length > 0) {
        // 含图片的用户消息：构建 OpenAI 多模态 content 数组
        const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
        if (text) parts.push({ type: 'text', text })
        for (const img of imageBlocks) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType};base64,${img.data}` },
          })
        }
        messages.push({
          role: msg.role,
          content: parts,
          ...((msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0)
            ? { tool_calls: msg.tool_calls }
            : {}),
        })
      } else {
        messages.push({
          role: msg.role,
          content: text,
          ...((msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0)
            ? { tool_calls: msg.tool_calls }
            : {}),
        })
      }
    }

    return messages
  }
}

// ============================================================
// AgentLoop 服务
// ============================================================

/** AgentLoop 配置 */
export interface AgentLoopConfig {
  /** 预配置的 agents */
  agents?: Array<{ id: string; model?: string }>
  /** 最大并行工具调用数 */
  maxParallelToolCalls?: number
  /**
   * 高风险工具默认护栏（安全增强）。
   * - 'allow'（默认）：不拦截，沿用历史行为（高风险工具无审批即可执行）
   * - 'ask'：pre-execute 返回 ask，交由上层确认流程
   * - 'deny'：pre-execute 直接拒绝高风险工具（risk==='high'）
   */
  secureHighRiskTools?: 'allow' | 'ask' | 'deny'
  /**
   * modlens 视觉桥接配置：为纯文本模型外挂图片识别能力。
   * 当用户消息含图片、且主模型本身不支持视觉时，把图片转成文字证据再发给模型。
   */
  modlens?: ModlensConfig
}

/**
 * Agent Loop 服务：创建和管理 agent 实例。
 *
 * 这是能力缝的 Consumer 侧：消费 LlmRuntime、ToolRuntime、SessionStore。
 */
export class AgentLoop extends Service {
  private config: AgentLoopConfig

  constructor(ctx: Context, config: AgentLoopConfig = {}) {
    super(ctx, 'agentLoop')
    this.config = config

    // 可选：高风险工具默认护栏（安全增强）
    const mode = config.secureHighRiskTools
    if (mode && mode !== 'allow') {
      ctx.on('tools/pre-execute', (exec: { name: string }, next: () => unknown) => {
        const tool = (this.ctx.tools as ToolRuntime | undefined)?.get(exec.name)
        if (tool && tool.risk === 'high') {
          if (mode === 'deny') {
            return { kind: 'deny', reason: `high-risk tool "${exec.name}" requires explicit approval` }
          }
          return { kind: 'ask', prompt: `确认执行高风险工具 "${exec.name}"？` }
        }
        return next()
      })
    }

    // 注册 agent 工厂
    ctx.effect(() => {
      const dispose = ctx.agents.setFactory((id, options, session) => {
        // 把服务级的 modlens 配置注入到每个 agent（调用方可不关心）
        return new ReactLoopAgent(ctx, id, { ...options, modlens: this.config.modlens }, session)
      })
      return dispose
    })
  }

  /**
   * 创建一个新的 agent 和会话。
   * @param id - 会话/agent ID
   * @param options - agent 选项
   * @param meta - 会话元数据
   * @returns 创建的 agent
   */
  create(
    id: SessionId,
    options: AgentOptions = {},
    meta: { cwd?: string; title?: string } = {},
  ): Agent {
    // 创建会话
    const session = this.ctx.sessions.create(id, {
      cwd: meta.cwd,
      title: meta.title,
    })

    // 创建 agent
    const agent = this.ctx.agents.create(id, options, session)
    return agent
  }

  /**
   * 用新 ID 创建 agent。
   */
  createNew(
    options: AgentOptions = {},
    meta: { cwd?: string; title?: string } = {},
  ): Agent {
    const id = createSessionId()
    return this.create(id, options, meta)
  }

  /**
   * 为一个「已存在的会话」挂载 agent（不新创建会话）。
   *
   * 重启恢复场景：SessionStore 会自动加载持久化的会话，但 AgentRegistry 为空；
   * 调用方（App.getOrCreateAgent）据此为历史会话补建 agent，附带正确的模型等选项，
   * 从而让消息历史可继续回放、可继续对话。
   * @throws 如果对应会话不存在
   */
  attach(id: SessionId, options: AgentOptions = {}): Agent {
    const session = this.ctx.sessions.get(id)
    if (!session) {
      throw new Error(`session "${id}" not found for attach`)
    }
    const agent = this.ctx.agents.create(id, options, session)
    return agent
  }
}
