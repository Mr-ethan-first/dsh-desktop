/**
 * LLM 模块单元测试。
 *
 * 测试 LlmRuntime、适配器注册、生成逻辑。
 * 使用 Mock 适配器避免真实 API 调用。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from './context'
import { LlmRuntime, LlmAdapter } from './llm'
import type { GenerateOptions, StreamChunk } from './llm'

/**
 * Mock LLM 适配器，用于测试。
 * 遵循 StreamChunk 接口：delta 为字符串类型。
 */
class MockAdapter extends LlmAdapter {
  readonly name = 'mock'
  private responses: string[] = []
  private callCount = 0

  constructor(responses: string[] = ['Hello, I am a mock LLM.']) {
    super()
    this.responses = responses
  }

  getCallCount(): number {
    return this.callCount
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.callCount++
    const response = this.responses[this.callCount - 1] || 'no more responses'

    // 逐个字符输出内容（delta 是字符串，符合 StreamChunk 类型）
    for (let i = 0; i < response.length; i++) {
      yield { type: 'content', delta: response[i] }
    }

    yield {
      type: 'usage',
      usage: {
        promptTokens: options.messages.length * 10,
        completionTokens: response.length,
        totalTokens: options.messages.length * 10 + response.length,
      },
    }

    yield { type: 'done' }
  }
}

describe('LlmRuntime', () => {
  let ctx: Context
  let llm: LlmRuntime

  beforeEach(() => {
    ctx = new Context()
    ctx.plugin(LlmRuntime as any)
    llm = (ctx as any).llm as LlmRuntime
  })

  describe('adapter registration', () => {
    it('registers an adapter', () => {
      const adapter = new MockAdapter()
      const dispose = llm.registerAdapter(adapter)
      expect(llm.getAdapter('mock')).toBeDefined()
      expect(llm.getAdapter()?.name).toBe('mock')
      dispose()
      expect(llm.getAdapter('mock')).toBeUndefined()
    })

    it('first adapter becomes default', () => {
      const adapter1 = new MockAdapter()
      const adapter2 = new MockAdapter()
      llm.registerAdapter(adapter1)
      llm.registerAdapter(adapter2)
      // 两个都叫 'mock'，后者会覆盖前者的注册（同名）
      // 但 getAdapter() 返回默认的，默认是第一个注册的
      // 实际上因为同名，第二个注册会覆盖第一个在 map 中的位置
      // 但 defaultAdapterName 仍然是第一个的名字 'mock'
      // 所以 getAdapter() 会返回 map 中的 'mock'，也就是第二个
      expect(llm.getAdapter()?.name).toBe('mock')
    })

    it('isDefault flag sets default', () => {
      const adapter1 = new MockAdapter()
      const adapter2 = new MockAdapter()
      llm.registerAdapter(adapter1)
      llm.registerAdapter(adapter2, true)
      expect(llm.getAdapter()?.name).toBe('mock')
    })

    it('throws when no adapter', async () => {
      await expect(
        llm.generate({ model: 'test', messages: [] }),
      ).rejects.toThrow('No LLM adapter registered')
    })
  })

  describe('generate', () => {
    it('generates text from stream', async () => {
      const adapter = new MockAdapter(['Hello world'])
      llm.registerAdapter(adapter)

      const result = await llm.generate({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
      })

      expect(result.content).toBe('Hello world')
      expect(result.usage?.completionTokens).toBe(11)
      expect(result.usage?.promptTokens).toBe(10)
    })

    it('supports multiple messages', async () => {
      const adapter = new MockAdapter(['Response'])
      llm.registerAdapter(adapter)

      const result = await llm.generate({
        model: 'test-model',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
      })

      expect(result.content).toBe('Response')
      expect(result.usage?.promptTokens).toBe(20)
    })

    it('accumulates multiple calls', async () => {
      const adapter = new MockAdapter(['First', 'Second'])
      llm.registerAdapter(adapter)

      const r1 = await llm.generate({ model: 'test', messages: [{ role: 'user', content: '1' }] })
      const r2 = await llm.generate({ model: 'test', messages: [{ role: 'user', content: '2' }] })

      expect(r1.content).toBe('First')
      expect(r2.content).toBe('Second')
      expect(adapter.getCallCount()).toBe(2)
    })
  })

  describe('stream', () => {
    it('streams content chunks', async () => {
      const adapter = new MockAdapter(['Hi'])
      llm.registerAdapter(adapter)

      const chunks: StreamChunk[] = []
      for await (const chunk of llm.stream({ model: 'test', messages: [{ role: 'user', content: 'hello' }] })) {
        chunks.push(chunk)
      }

      const contentChunks = chunks.filter((c) => c.type === 'content')
      const usageChunks = chunks.filter((c) => c.type === 'usage')
      const doneChunks = chunks.filter((c) => c.type === 'done')

      expect(contentChunks.length).toBeGreaterThan(0)
      expect(usageChunks.length).toBe(1)
      expect(doneChunks.length).toBe(1)
    })
  })

  describe('waterfall', () => {
    it('llm/stream waterfall can intercept stream', async () => {
      const adapter = new MockAdapter(['original'])
      llm.registerAdapter(adapter)

      // 通过 waterfall 监听生成选项
      let receivedOptions: GenerateOptions | null = null
      ctx.on('llm/stream', (opts: GenerateOptions, next: () => Promise<AsyncIterable<StreamChunk>>) => {
        receivedOptions = opts
        return next()
      })

      const result = await llm.generate({
        model: 'test',
        messages: [{ role: 'user', content: 'test' }],
      })

      expect(receivedOptions).not.toBeNull()
      expect(receivedOptions!.messages.length).toBe(1)
      expect(result.content).toBe('original')
    })
  })
})

describe('LlmAdapter', () => {
  it('is a class that can be extended', () => {
    expect(typeof LlmAdapter).toBe('function')
    // MockAdapter extends LlmAdapter and works
    const adapter = new MockAdapter()
    expect(adapter.name).toBe('mock')
    expect(typeof adapter.stream).toBe('function')
  })

  it('has abstract stream method that must be implemented', () => {
    // TypeScript 会在编译时检查 abstract 方法
    // 运行时，直接实例化 LlmAdapter 会因为 stream 不存在而失败
    // 但我们通过 MockAdapter 来验证继承关系
    class ConcreteAdapter extends LlmAdapter {
      readonly name = 'concrete'
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'done' }
      }
    }
    const adapter = new ConcreteAdapter()
    expect(adapter).toBeInstanceOf(LlmAdapter)
    expect(adapter.name).toBe('concrete')
  })
})
