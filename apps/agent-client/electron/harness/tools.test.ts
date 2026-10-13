/**
 * Tools 模块单元测试。
 *
 * 测试工具注册、参数验证、执行管道。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from './context'
import { ToolRuntime, defineTool, validateArgs } from './tools'
import type { ToolDefinition } from './tools'

describe('validateArgs', () => {
  it('validates string type', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        name: { type: 'string' as const },
      },
    }
    expect(validateArgs({ name: 'hello' }, schema)).toEqual([])
    expect(validateArgs({ name: 123 }, schema)).toContain('args.name: expected string, got number')
  })

  it('validates number type', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        count: { type: 'number' as const },
      },
    }
    expect(validateArgs({ count: 42 }, schema)).toEqual([])
    expect(validateArgs({ count: 'abc' }, schema)).toContain('args.count: expected number, got string')
  })

  it('validates boolean type', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        flag: { type: 'boolean' as const },
      },
    }
    expect(validateArgs({ flag: true }, schema)).toEqual([])
    expect(validateArgs({ flag: 'yes' }, schema)).toContain('args.flag: expected boolean, got string')
  })

  it('validates required fields', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        name: { type: 'string' as const },
      },
      required: ['name'],
    }
    expect(validateArgs({ name: 'hello' }, schema)).toEqual([])
    expect(validateArgs({}, schema)).toContain('args.name: required field missing')
  })

  it('validates array type', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        items: { type: 'array' as const, items: { type: 'string' as const } },
      },
    }
    expect(validateArgs({ items: ['a', 'b'] }, schema)).toEqual([])
    expect(validateArgs({ items: 'not array' }, schema)).toContain('args.items: expected array, got string')
  })

  it('rejects non-object args', () => {
      const schema = { type: 'object' as const, properties: {} }
      expect(validateArgs(null, schema).length).toBeGreaterThan(0)
      expect(validateArgs(null, schema)[0]).toContain('expected object')
      expect(validateArgs('string', schema).length).toBeGreaterThan(0)
      expect(validateArgs('string', schema)[0]).toContain('expected object')
      expect(validateArgs(123, schema).length).toBeGreaterThan(0)
      expect(validateArgs(123, schema)[0]).toContain('expected object')
    })
})

describe('defineTool', () => {
  it('creates a tool definition', () => {
    const tool = defineTool({
      name: 'test_tool',
      description: 'A test tool',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'input value' },
        },
        required: ['input'],
        additionalProperties: false,
      },
      async execute(args) {
        return [{ type: 'text', text: `result: ${args.input}` }]
      },
    })

    expect(tool.name).toBe('test_tool')
    expect(tool.description).toBe('A test tool')
    expect(tool.parameters.type).toBe('object')
    expect(typeof tool.execute).toBe('function')
  })

  it('supports risk level', () => {
    const tool = defineTool({
      name: 'risky_tool',
      description: 'A risky tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => [{ type: 'text', text: 'done' }],
      risk: 'high',
    })
    expect(tool.risk).toBe('high')
  })

  it('supports timeoutMs', () => {
    const tool = defineTool({
      name: 'slow_tool',
      description: 'A slow tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => [{ type: 'text', text: 'done' }],
      timeoutMs: 5000,
    })
    expect(tool.timeoutMs).toBe(5000)
  })
})

describe('ToolRuntime', () => {
  let ctx: Context
  let tools: ToolRuntime

  beforeEach(() => {
    ctx = new Context()
    ctx.plugin(ToolRuntime as any)
    tools = (ctx as any).tools as ToolRuntime
  })

  describe('registration', () => {
    it('registers a tool', () => {
      const tool = defineTool({
        name: 'hello',
        description: 'says hello',
        parameters: { type: 'object', properties: {} },
        execute: async () => [{ type: 'text', text: 'hello' }],
      })
      tools.register(tool)
      expect(tools.has('hello')).toBe(true)
      expect(tools.get('hello')).toBeDefined()
    })

    it('throws on duplicate registration', () => {
      const tool = defineTool({
        name: 'dup',
        description: 'duplicate',
        parameters: { type: 'object', properties: {} },
        execute: async () => [{ type: 'text', text: 'x' }],
      })
      tools.register(tool)
      expect(() => tools.register(tool)).toThrow('already registered')
    })

    it('disposer unregisters the tool', () => {
      const tool = defineTool({
        name: 'temp',
        description: 'temporary',
        parameters: { type: 'object', properties: {} },
        execute: async () => [{ type: 'text', text: 'x' }],
      })
      const dispose = tools.register(tool)
      expect(tools.has('temp')).toBe(true)
      dispose()
      expect(tools.has('temp')).toBe(false)
    })

    it('list returns all tools', () => {
      tools.register(defineTool({
        name: 'tool1',
        description: 'first',
        parameters: { type: 'object', properties: {} },
        execute: async () => [{ type: 'text', text: '1' }],
      }))
      tools.register(defineTool({
        name: 'tool2',
        description: 'second',
        parameters: { type: 'object', properties: {} },
        execute: async () => [{ type: 'text', text: '2' }],
      }))
      expect(tools.list().length).toBe(2)
      expect(tools.list().map((t) => t.name)).toContain('tool1')
      expect(tools.list().map((t) => t.name)).toContain('tool2')
    })
  })

  describe('execution', () => {
    it('executes a tool successfully', async () => {
      tools.register(defineTool({
        name: 'echo',
        description: 'echoes input',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        execute: async (args) => [{ type: 'text', text: String(args.text) }],
      }))

      const result = await tools.execute('echo', { text: 'hello' }, { agentId: 'test' })
      expect(result.isError).toBe(false)
      expect(result.content[0].type).toBe('text')
      expect((result.content[0] as any).text).toBe('hello')
    })

    it('returns error for unknown tool', async () => {
      const result = await tools.execute('nonexistent', {}, { agentId: 'test' })
      expect(result.isError).toBe(true)
      expect((result.content[0] as any).text).toContain('unknown tool')
    })

    it('returns error for invalid arguments', async () => {
      tools.register(defineTool({
        name: 'needs_string',
        description: 'needs a string',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        execute: async () => [{ type: 'text', text: 'ok' }],
      }))

      const result = await tools.execute('needs_string', { text: 123 }, { agentId: 'test' })
      expect(result.isError).toBe(true)
      expect((result.content[0] as any).text).toContain('invalid arguments')
    })

    it('tools/result event is emitted', async () => {
      let resultEmitted = false
      ctx.on('tools/result', () => {
        resultEmitted = true
      })

      tools.register(defineTool({
        name: 'emit_test',
        description: 'test',
        parameters: { type: 'object', properties: {} },
        execute: async () => [{ type: 'text', text: 'ok' }],
      }))

      await tools.execute('emit_test', {}, { agentId: 'test' })
      expect(resultEmitted).toBe(true)
    })
  })

  describe('execution pipeline', () => {
    it('pre-execute waterfall can deny', async () => {
      tools.register(defineTool({
        name: 'denied',
        description: 'always denied',
        parameters: { type: 'object', properties: {} },
        execute: async () => [{ type: 'text', text: 'ok' }],
      }))

      ctx.on('tools/pre-execute', (_exec: any, next: any) => {
        return { kind: 'deny', reason: 'not allowed' }
      })

      const result = await tools.execute('denied', {}, { agentId: 'test' })
      expect(result.isError).toBe(true)
      expect((result.content[0] as any).text).toContain('Denied')
    })

    it('post-execute waterfall can replace result', async () => {
      tools.register(defineTool({
        name: 'replace_me',
        description: 'result will be replaced',
        parameters: { type: 'object', properties: {} },
        execute: async () => [{ type: 'text', text: 'original' }],
      }))

      ctx.on('tools/post-execute', (_exec: any, _result: any, next: any) => {
        return {
          kind: 'replace',
          result: {
            content: [{ type: 'text', text: 'replaced' }],
            isError: false,
          },
        }
      })

      const result = await tools.execute('replace_me', {}, { agentId: 'test' })
      expect(result.isError).toBe(false)
      expect((result.content[0] as any).text).toBe('replaced')
    })
  })

  describe('toModelFormat', () => {
    it('generates OpenAI format tool definitions', () => {
      tools.register(defineTool({
        name: 'test',
        description: 'a test tool',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string', description: 'input' } },
          required: ['input'],
          additionalProperties: false,
        },
        execute: async () => [{ type: 'text', text: 'ok' }],
      }))

      const modelFormat = tools.toModelFormat()
      expect(modelFormat.length).toBe(1)
      expect(modelFormat[0].type).toBe('function')
      expect(modelFormat[0].function.name).toBe('test')
      expect(modelFormat[0].function.description).toBe('a test tool')
      expect(modelFormat[0].function.parameters.type).toBe('object')
    })
  })
})
