/**
 * 工具注册与执行管道。
 *
 * 遵循 deepseek-harness 设计原则：
 * - 工具通过 defineTool 声明式定义（名称、描述、参数 schema、执行函数）
 * - 执行管道：pre-execute(权限/审批) → execute(执行) → post-execute(结果处理) → result(通知)
 * - 每个阶段都是 waterfall 事件，支持插件扩展
 * - 参数 JSON Schema 验证
 * - 作用域支持：agent-scoped 工具
 */

import type { Context } from './context.js'
import { Service } from './context.js'
import type { ContentBlock } from './session.js'

// ============================================================
// 工具定义类型
// ============================================================

/** 工具参数 JSON Schema（简化版） */
export interface ToolParameterSchema {
  type: 'object'
  properties: Record<string, ParameterProperty>
  required?: string[]
  additionalProperties?: boolean
}

/** 参数属性定义 */
export interface ParameterProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null'
  description?: string
  enum?: unknown[]
  items?: ParameterProperty
  properties?: Record<string, ParameterProperty>
  default?: unknown
}

/** 工具执行上下文 */
export interface ToolRunContext {
  /** 调用 ID */
  callId: string
  /** 调用者 agent 的 ID */
  agentId: string
  /** 取消信号 */
  signal: AbortSignal
}

/** 工具执行结果 */
export interface ToolExecutionResult {
  /** 结果内容块 */
  content: ContentBlock[]
  /** 是否为错误结果 */
  isError: boolean
  /** 原始值（用于程序化处理） */
  value?: unknown
}

/** 工具定义 */
export interface ToolDefinition {
  /** 工具名称（唯一） */
  name: string
  /** 人类可读描述 */
  description: string
  /** 参数 schema */
  parameters: ToolParameterSchema
  /** 执行函数 */
  execute: (args: Record<string, unknown>, ctx: ToolRunContext) => Promise<ContentBlock[]>
  /** 超时时间（毫秒） */
  timeoutMs?: number
  /** 风险等级 */
  risk?: 'low' | 'medium' | 'high'
  /** 是否并发安全 */
  isConcurrencySafe?: boolean
}

/** 执行中的工具调用 */
export interface ToolExecution {
  /** 调用 ID */
  callId: string
  /** 工具名 */
  name: string
  /** 解析后的参数 */
  args: Record<string, unknown>
  /** 调用者 agent ID */
  agentId: string
  /** 取消信号 */
  signal: AbortSignal
}

/** 预执行决定 */
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; prompt: string }

/** 后执行决定 */
export type PostToolDecision =
  | { kind: 'accept'; result: ToolExecutionResult }
  | { kind: 'replace'; result: ToolExecutionResult }
  | { kind: 'block'; reason: string }

// ============================================================
// 上下文类型声明合并
// ============================================================

declare module './context.js' {
  interface Context {
    tools: ToolRuntime
  }
}

// ============================================================
// JSON Schema 验证（简化版）
// ============================================================

function validateValue(
  value: unknown,
  schema: ParameterProperty,
  path: string,
): string[] {
  const errors: string[] = []

  // type 检查
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push(`${path}: expected string, got ${typeof value}`)
      }
      break
    case 'number':
      if (typeof value !== 'number') {
        errors.push(`${path}: expected number, got ${typeof value}`)
      }
      break
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`${path}: expected integer, got ${typeof value}`)
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(`${path}: expected boolean, got ${typeof value}`)
      }
      break
    case 'null':
      if (value !== null) {
        errors.push(`${path}: expected null, got ${typeof value}`)
      }
      break
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array, got ${typeof value}`)
      } else if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          errors.push(...validateValue(value[i], schema.items, `${path}[${i}]`))
        }
      }
      break
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: expected object, got ${typeof value}`)
      } else if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          const propValue = (value as Record<string, unknown>)[key]
          if (propValue !== undefined) {
            errors.push(...validateValue(propValue, propSchema, `${path}.${key}`))
          }
        }
      }
      break
  }

  // enum 检查
  if (schema.enum && schema.enum.length > 0 && !schema.enum.includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`)
  }

  return errors
}

/** 验证工具参数 */
export function validateArgs(
  args: unknown,
  schema: ToolParameterSchema,
): string[] {
  const errors: string[] = []

  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['args: expected object']
  }

  const obj = args as Record<string, unknown>

  // 必填字段检查
  if (schema.required) {
    for (const req of schema.required) {
      if (obj[req] === undefined) {
        errors.push(`args.${req}: required field missing`)
      }
    }
  }

  // 属性验证
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (obj[key] !== undefined) {
        errors.push(...validateValue(obj[key], propSchema, `args.${key}`))
      }
    }
  }

  return errors
}

// ============================================================
// 便捷工具：defineTool
// ============================================================

/**
 * 定义一个工具。
 * 提供类型友好的声明式 API，返回 ToolDefinition。
 */
export function defineTool(
  options: {
    name: string
    description: string
    parameters: ToolParameterSchema
    execute: (args: Record<string, unknown>, ctx: ToolRunContext) => Promise<ContentBlock[]> | ContentBlock[]
    timeoutMs?: number
    risk?: 'low' | 'medium' | 'high'
    isConcurrencySafe?: boolean
  },
): ToolDefinition {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    execute: async (args, ctx) => options.execute(args, ctx),
    timeoutMs: options.timeoutMs,
    risk: options.risk,
    isConcurrencySafe: options.isConcurrencySafe,
  }
}

// ============================================================
// ToolRuntime 服务
// ============================================================

/**
 * 工具运行时服务：注册工具、管理执行管道。
 *
 * 执行管道（waterfall 事件）：
 * 1. tools/pre-execute: 权限检查、审批门控
 * 2. tools/execute: 实际执行（含超时、重试包装）
 * 3. tools/post-execute: 结果处理、内容替换
 * 4. tools/result: 结果通知（emit）
 */
export class ToolRuntime extends Service {
  private tools = new Map<string, ToolDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
    // 声明管道事件
    ctx.declareEvent('tools/pre-execute', 'waterfall')
    ctx.declareEvent('tools/execute', 'waterfall')
    ctx.declareEvent('tools/post-execute', 'waterfall')
    ctx.declareEvent('tools/result', 'emit')
    ctx.declareEvent('tools/registered', 'emit')
    ctx.declareEvent('tools/unregistered', 'emit')
  }

  /**
   * 注册一个工具。
   * @returns 注销函数
   */
  register(definition: ToolDefinition): () => void {
    const name = definition.name

    if (this.tools.has(name)) {
      throw new Error(`tool "${name}" is already registered`)
    }

    // 验证参数 schema
    if (!definition.parameters || definition.parameters.type !== 'object') {
      throw new Error(`tool "${name}": parameters must be an object schema`)
    }

    this.tools.set(name, definition)
    this.ctx.emit('tools/registered', name, definition)

    return () => {
      this.tools.delete(name)
      this.ctx.emit('tools/unregistered', name)
    }
  }

  /** 获取工具定义 */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  /** 列出所有工具 */
  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  /** 检查工具是否存在 */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * 执行工具调用。
   * 经过完整的执行管道：pre-execute → execute → post-execute → result。
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    opts: { agentId: string; signal?: AbortSignal },
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Error: unknown tool "${name}"` }],
        isError: true,
      }
    }

    // 参数验证
    const validationErrors = validateArgs(args, tool.parameters)
    if (validationErrors.length > 0) {
      return {
        content: [{ type: 'text', text: `Error: invalid arguments: ${validationErrors.join('; ')}` }],
        isError: true,
      }
    }

    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const signal = opts.signal ?? new AbortController().signal
    const exec: ToolExecution = {
      callId,
      name,
      args,
      agentId: opts.agentId,
      signal,
    }

    try {
      // Phase 1: pre-execute（权限/审批）
      const preDecision = await this.ctx.waterfall(
        'tools/pre-execute',
        [exec],
        async (): Promise<PreToolDecision> => ({ kind: 'allow' }),
      )

      if (preDecision.kind === 'deny') {
        return {
          content: [{ type: 'text', text: `Denied: ${preDecision.reason}` }],
          isError: true,
        }
      }

      if (preDecision.kind === 'ask') {
        return {
          content: [{ type: 'text', text: `Approval required: ${preDecision.prompt}` }],
          isError: true,
        }
      }

      // Phase 2: execute（实际执行）
      const result = await this.ctx.waterfall(
        'tools/execute',
        [exec],
        async (): Promise<ToolExecutionResult> => {
          // 超时处理
          if (tool.timeoutMs) {
            const timeoutPromise = new Promise<never>((_, reject) => {
              const timer = setTimeout(() => {
                reject(new Error(`tool "${name}" timed out after ${tool.timeoutMs}ms`))
              }, tool.timeoutMs)
              signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
            })

            const resultPromise = tool.execute(args, {
              callId,
              agentId: opts.agentId,
              signal,
            })

            const content = await Promise.race([resultPromise, timeoutPromise])
            return { content, isError: false, value: content }
          }

          const content = await tool.execute(args, {
            callId,
            agentId: opts.agentId,
            signal,
          })
          return { content, isError: false, value: content }
        },
      )

      // Phase 3: post-execute（结果处理）
      const postDecision = await this.ctx.waterfall(
        'tools/post-execute',
        [exec, result],
        async (): Promise<PostToolDecision> => ({ kind: 'accept', result }),
      )

      let finalResult: ToolExecutionResult = {
        content: [{ type: 'text', text: 'Unknown tool execution error' }],
        isError: true,
      }
      switch (postDecision.kind) {
        case 'accept':
          finalResult = postDecision.result
          break
        case 'replace':
          finalResult = postDecision.result
          break
        case 'block':
          finalResult = {
            content: [{ type: 'text', text: `Blocked: ${postDecision.reason}` }],
            isError: true,
          }
          break
      }

      // Phase 4: result（通知）
      this.ctx.emit('tools/result', exec, finalResult)

      return finalResult
    } catch (error) {
      const errorResult: ToolExecutionResult = {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
      this.ctx.emit('tools/result', exec, errorResult)
      return errorResult
    }
  }

  /**
   * 生成模型可用的工具定义列表（OpenAI 格式）。
   */
  toModelFormat(): Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: ToolParameterSchema
    }
  }> {
    return this.list().map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))
  }
}
