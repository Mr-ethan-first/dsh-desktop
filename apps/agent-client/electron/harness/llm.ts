/**
 * LLM 服务：适配器注册表 + 流式调用 API。
 *
 * 遵循 deepseek-harness 能力缝设计：
 * - Service Definition: LlmRuntime（定义接口和事件）
 * - Service Provider: DeepSeekAdapter（具体实现）
 * - Consumer: agent-loop（消费 LLM 能力）
 *
 * 瀑布事件 llm/stream 支持重试、路由、缓存等扩展。
 */

import type { Context } from './context.js'
import { Service } from './context.js'
import type { ContentBlock } from './session.js'
import type { ToolParameterSchema } from './tools.js'

// ============================================================
// 类型定义
// ============================================================

/** 工具调用定义（模型侧） */
export interface ModelToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** 聊天消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >
  tool_calls?: ModelToolCall[]
  tool_call_id?: string
  name?: string
}

/** Token 使用量 */
export interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** 流式分块 */
export interface StreamChunk {
  type: 'content' | 'tool_call' | 'usage' | 'done'
  delta?: string
  toolCall?: {
    index: number
    id?: string
    name?: string
    arguments?: string
  }
  usage?: Usage
  model?: string
  finishReason?: string
}

/** 生成选项 */
export interface GenerateOptions {
  model: string
  messages: ChatMessage[]
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: ToolParameterSchema
    }
  }>
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  stream?: boolean
}

// ============================================================
// LLM 适配器抽象
// ============================================================

/**
 * LLM 适配器：具体提供商的实现。
 * 每个 Provider 实现此接口并注册到 LlmRuntime。
 */
export abstract class LlmAdapter {
  abstract readonly name: string

  /**
   * 流式生成。
   * 返回 AsyncIterable<StreamChunk>。
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

// ============================================================
// 上下文类型声明合并
// ============================================================

declare module './context.js' {
  interface Context {
    llm: LlmRuntime
  }
}

// ============================================================
// LlmRuntime 服务
// ============================================================

/**
 * LLM 运行时服务：管理适配器，提供统一的流式调用 API。
 *
 * 通过 llm/stream waterfall 事件支持扩展（重试、路由、缓存等）。
 */
export class LlmRuntime extends Service {
  private adapters = new Map<string, LlmAdapter>()
  private defaultAdapterName = ''

  constructor(ctx: Context) {
    super(ctx, 'llm')
    ctx.declareEvent('llm/stream', 'waterfall')
  }

  /**
   * 注册一个 LLM 适配器。
   * @param adapter - 适配器实例
   * @param isDefault - 是否设为默认适配器
   * @returns 注销函数
   */
  registerAdapter(adapter: LlmAdapter, isDefault = false): () => void {
    this.adapters.set(adapter.name, adapter)
    if (isDefault || this.adapters.size === 1) {
      this.defaultAdapterName = adapter.name
    }
    return () => {
      this.adapters.delete(adapter.name)
    }
  }

  /** 获取适配器 */
  getAdapter(name?: string): LlmAdapter | undefined {
    return this.adapters.get(name || this.defaultAdapterName)
  }

  /**
   * 流式生成。
   * 经过 llm/stream waterfall，支持扩展拦截。
   */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const adapter = this.getAdapter()
    if (!adapter) {
      throw new Error('No LLM adapter registered')
    }

    // 通过 waterfall 调用，允许扩展拦截
    const stream = await this.ctx.waterfall(
      'llm/stream',
      [options],
      async () => adapter.stream(options),
    )

    for await (const chunk of stream) {
      yield chunk
    }
  }

  /**
   * 非流式生成：收集所有分块后返回完整结果。
   */
  async generate(options: GenerateOptions): Promise<{
    content: string
    toolCalls: ModelToolCall[]
    usage: Usage
    model: string
  }> {
    let content = ''
    const toolCalls: ModelToolCall[] = []
    let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    let model = options.model

    for await (const chunk of this.stream({ ...options, stream: true })) {
      if (chunk.type === 'content' && chunk.delta) {
        content += chunk.delta
      } else if (chunk.type === 'tool_call' && chunk.toolCall) {
        const idx = chunk.toolCall.index
        while (toolCalls.length <= idx) {
          toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } })
        }
        if (chunk.toolCall.id) toolCalls[idx].id = chunk.toolCall.id
        if (chunk.toolCall.name) toolCalls[idx].function.name = chunk.toolCall.name
        if (chunk.toolCall.arguments) toolCalls[idx].function.arguments += chunk.toolCall.arguments
      } else if (chunk.type === 'usage' && chunk.usage) {
        usage = chunk.usage
      }
      if (chunk.model) model = chunk.model
    }

    return { content, toolCalls, usage, model }
  }
}

// ============================================================
// DeepSeek 适配器
// ============================================================

/**
 * LLM 请求整体超时（毫秒）。
 * EMFILE 根因修复（主进程侧）：当上游 API 不可达/挂起时，fetch 默认不带超时，
 * socket 会一直挂起 → FD 表耗尽 → 后续会话落盘 EMFILE。
 * 这里用「调用方 signal + 整体超时」组合信号：上游一旦在超时内无响应即 abort，
 * fetch 会释放底层 socket。该值是整体安全上限（正常流式响应通常远小于此），
 * 仅作为泄漏兜底；可见聊天走 /zhipu 代理（main.cjs 另有更精确的「连接超时」）。
 */
const PROVIDER_TIMEOUT_MS = 120_000;

/**
 * 模块级 FIFO 速率闸门：保证相邻 LLM 请求之间至少间隔 minIntervalMs。
 * 用于满足「调用频率不超过 1 次/60s」的限流要求（避免智谱/通义等 429 限流）。
 * 全局串行（一个 harness 进程一个适配器，agent 循环本就基本串行，故不会放大延迟）。
 */
let _rateChain: Promise<number> = Promise.resolve(0)
let _rateGateFirst = true
function acquireRateGate(minIntervalMs: number): Promise<void> {
  if (!minIntervalMs || minIntervalMs <= 0) return Promise.resolve()
  const prev = _rateChain
  let release!: (ts: number) => void
  const next = new Promise<number>((res) => {
    release = res
  })
  _rateChain = next
  return prev.then((lastStart) => {
    const now = Date.now()
    // 首次调用不等待：避免「发第一条消息先空转一个限流周期」的伪卡顿。
    const wait = _rateGateFirst ? 0 : Math.max(0, minIntervalMs - (now - lastStart))
    _rateGateFirst = false
    const fire = () => {
      const started = Date.now()
      release(started)
    }
    if (wait > 0) {
      return new Promise<void>((r) => setTimeout(r, wait)).then(fire)
    }
    fire()
  })
}

/**
 * 带重试的 fetch：应对智谱/通义等端点的瞬时限流（429）与容量过载（5xx / 1305）。
 * - 429 / 5xx：按 Retry-After 或指数退避重试（最多 maxAttempts 次）。
 * - 401 等不可重试错误：直接抛出。
 * 与 acquireRateGate 的 60s 限速配合使用，可显著降低自动化因瞬时 429 失败的概率。
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxAttempts = 3,
): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, init)
      if (resp.ok) return resp
      const status = resp.status
      if (status === 429 || status >= 500) {
        const retryAfterHdr = resp.headers.get('retry-after')
        const retryAfter = retryAfterHdr ? Number(retryAfterHdr) * 1000 : 0
        const backoff = Math.min(
          30_000,
          retryAfter > 0 ? retryAfter : Math.min(2 ** attempt * 3000, 15_000),
        )
        console.warn(`[harness] LLM 端点返回 ${status}，第 ${attempt}/${maxAttempts} 次重试，等待 ${Math.round(backoff)}ms`)
        await new Promise((r) => setTimeout(r, backoff))
        lastErr = new Error(`LLM API error ${status}`)
        continue
      }
      const text = await resp.text().catch(() => '')
      throw new Error(`LLM API error ${status}: ${text}`)
    } catch (e) {
      lastErr = e
      if (attempt < maxAttempts) {
        const backoff = Math.min(15_000, 2 ** attempt * 2000)
        console.warn(`[harness] LLM 请求异常，第 ${attempt}/${maxAttempts} 次重试，等待 ${backoff}ms:`, e)
        await new Promise((r) => setTimeout(r, backoff))
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** DeepSeek 适配器配置 */
export interface DeepSeekAdapterConfig {
  apiKey: string
  baseUrl: string
  defaultModel?: string
  /** 两次 LLM 请求的最小间隔（毫秒），用于限流；0 / 不传表示不限速。 */
  minIntervalMs?: number
}

/**
 * DeepSeek LLM 适配器。
 * 通过 DeepSeek API 实现流式对话。
 */
export class DeepSeekAdapter extends LlmAdapter {
  readonly name = 'deepseek'
  readonly defaultModel: string

  constructor(private config: DeepSeekAdapterConfig) {
    super()
    this.defaultModel = config.defaultModel || 'deepseek-chat'
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    // 限流闸门：相邻请求至少间隔 minIntervalMs（满足 ≤1 次/60s 要求，防 429）。
    await acquireRateGate(this.config.minIntervalMs ?? 0)

    const model = options.model || this.defaultModel
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`

    const body: Record<string, unknown> = {
      model,
      messages: options.messages,
      stream: true,
      // OpenAI 兼容协议在流式模式下**默认不返回 usage**（usage 恒为 null，
      // 最终 chunk 也不带）。必须显式 include_usage，否则「每次对话消耗多少
      // token」永远统计为 0。该字段是 OpenAI 官方协议字段，DeepSeek/智谱/通义
      // 等兼容端点均支持。
      stream_options: { include_usage: true },
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools
    }
    if (options.temperature !== undefined) {
      body.temperature = options.temperature
    }
    if (options.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens
    }

    // 组合「调用方取消信号 + 整体超时」：上游挂起时强制 abort，释放底层 socket（防 EMFILE）。
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('LLM request timeout')), PROVIDER_TIMEOUT_MS)
    const clearTimer = () => clearTimeout(timer)
    if (options.signal) {
      if (options.signal.aborted) ac.abort(options.signal.reason)
      else
        options.signal.addEventListener(
          'abort',
          () => ac.abort(options.signal!.reason),
          { once: true },
        )
    }

    let response: Response
    try {
      response = await fetchWithRetry(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
    } catch (e) {
      clearTimer()
      throw e
    }

    // 非 2xx（如 400 模型不存在 / 401 密钥失效 / 429 限流）必须显式抛出，
    // 否则会被当成空 SSE 流静默吞掉 → 表现为「转圈后无任何回复」。
    if (!response.ok) {
      clearTimer()
      let detail = `LLM HTTP ${response.status}`
      try {
        const errText = await response.text()
        if (errText) detail += `: ${errText.slice(0, 500)}`
      } catch {
        /* ignore */
      }
      throw new Error(detail)
    }

    if (!response.body) {
      clearTimer()
      throw new Error('No response body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue

          const data = trimmed.slice(6)
          if (data === '[DONE]') {
            yield { type: 'done' }
            clearTimer()
            return
          }

          try {
            const parsed = JSON.parse(data)
            const choice = parsed.choices?.[0]
            const delta = choice?.delta

            if (delta?.content) {
              yield {
                type: 'content',
                delta: delta.content,
                model: parsed.model,
              }
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                yield {
                  type: 'tool_call',
                  toolCall: {
                    index: tc.index,
                    id: tc.id,
                    name: tc.function?.name,
                    arguments: tc.function?.arguments,
                  },
                  model: parsed.model,
                }
              }
            }

            if (choice?.finish_reason) {
              yield {
                type: 'done',
                finishReason: choice.finish_reason,
                model: parsed.model,
              }
            }

            if (parsed.usage) {
              const p = Number(parsed.usage.prompt_tokens) || 0
              const c = Number(parsed.usage.completion_tokens) || 0
              const t = Number(parsed.usage.total_tokens) || 0
              yield {
                type: 'usage',
                usage: {
                  promptTokens: p,
                  completionTokens: c,
                  // 少数兼容端点只给分项不给合计，这里补算，避免出现 total=0
                  totalTokens: t || p + c,
                },
                model: parsed.model,
              }
            }
          } catch (e) {
            // 忽略解析错误
            console.warn('[harness] SSE parse error:', e)
          }
        }
      }
      clearTimer()
    } catch (e) {
      clearTimer()
      // 异常退出（含 abort/超时）：取消 reader 以释放底层 TCP socket，避免句柄泄漏。
      await reader.cancel().catch(() => {})
      throw e
    }
  }
}

/** 便捷函数：从文本创建内容块 */
export function textContent(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** 便捷函数：从内容块提取文本 */
export function contentToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}
