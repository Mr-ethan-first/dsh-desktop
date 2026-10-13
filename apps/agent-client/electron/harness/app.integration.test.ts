/**
 * Harness 集成测试。
 *
 * 测试完整的 HarnessApp 组装和运行流程，
 * 验证所有核心服务协同工作正常。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { HarnessApp } from './app'
import { defineTool } from './tools'
import { LlmAdapter } from './llm'
import type { GenerateOptions, StreamChunk } from './llm'

/**
 * Mock LLM 适配器，用于集成测试。
 */
class TestAdapter extends LlmAdapter {
  readonly name = 'test'
  private responses: string[] = []
  private callIndex = 0

  setResponses(responses: string[]): void {
    this.responses = responses
    this.callIndex = 0
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const response = this.responses[this.callIndex] || 'done'
    this.callIndex++

    for (const char of response) {
      yield { type: 'content', delta: char }
    }

    yield {
      type: 'usage',
      usage: {
        promptTokens: options.messages.length * 5,
        completionTokens: response.length,
        totalTokens: options.messages.length * 5 + response.length,
      },
    }

    yield { type: 'done' }
  }
}

describe('HarnessApp Integration', () => {
  let app: HarnessApp

  beforeEach(() => {
    app = new HarnessApp({
      workDir: '/tmp/test-workdir',
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      maxParallelToolCalls: 2,
    })
  })

  describe('app lifecycle', () => {
    it('starts and stops successfully', async () => {
      await app.start()
      expect(app.ctx).toBeDefined()
      await app.stop()
    })

    it('start is idempotent', async () => {
      await app.start()
      await app.start() // 第二次调用应该是幂等的
      await app.stop()
    })
  })

  describe('service composition', () => {
    it('has all required services after start', async () => {
      await app.start()

      const ctx = app.ctx as any
      expect(ctx.sessions).toBeDefined()
      expect(ctx.tools).toBeDefined()
      expect(ctx.llm).toBeDefined()
      expect(ctx.agents).toBeDefined()
      expect(ctx.agentLoop).toBeDefined()

      await app.stop()
    })

    it('has fs tools registered', async () => {
      await app.start()

      const tools = (app.ctx as any).tools
      expect(tools.has('fs__write_file')).toBe(true)
      expect(tools.has('fs__read_file')).toBe(true)
      expect(tools.has('fs__list_dir')).toBe(true)
      expect(tools.has('fs__delete_file')).toBe(true)

      await app.stop()
    })

    it('has DeepSeek adapter registered', async () => {
      await app.start()

      const llm = (app.ctx as any).llm
      expect(llm.getAdapter()?.name).toBe('deepseek')

      await app.stop()
    })
  })

  describe('agent creation', () => {
    it('creates an agent', async () => {
      await app.start()

      const agent = app.createAgent({ title: 'Test Agent' })
      expect(agent.id).toBeDefined()
      expect(agent.status).toBe('idle')
      expect(agent.session.header.title).toBe('Test Agent')

      await app.stop()
    })

    it('lists agents', async () => {
      await app.start()

      const agent1 = app.createAgent({ title: 'Agent 1' })
      const agent2 = app.createAgent({ title: 'Agent 2' })

      const agents = app.listAgents()
      expect(agents.length).toBe(2)
      expect(agents.map((a) => a.id)).toContain(agent1.id)
      expect(agents.map((a) => a.id)).toContain(agent2.id)

      await app.stop()
    })

    it('gets agent by id', async () => {
      await app.start()

      const agent = app.createAgent({ title: 'Find Me' })
      const found = app.getAgent(agent.id)
      expect(found).toBeDefined()
      expect(found?.id).toBe(agent.id)

      await app.stop()
    })

    it('returns undefined for missing agent', async () => {
      await app.start()

      const found = app.getAgent('nonexistent-id')
      expect(found).toBeUndefined()

      await app.stop()
    })
  })

  describe('full conversation flow', () => {
    it('processes a user message and generates response', async () => {
      // 使用自定义 mock 适配器
      const adapter = new TestAdapter()
      adapter.setResponses(['Hello from harness!'])

      const testApp = new HarnessApp({
        workDir: '/tmp/test',
        apiKey: '',
        baseUrl: '',
        model: 'test',
      })
      await testApp.start()

      // 替换默认适配器为测试适配器
      const llm = (testApp.ctx as any).llm
      llm.registerAdapter(adapter, true)

      const agent = testApp.createAgent({})
      agent.followup([{ type: 'text', text: 'Hi there' }])

      // 等待处理完成
      await new Promise<void>((resolve) => {
        const check = () => {
          if (agent.status === 'idle' && agent.session.events.length > 2) {
            resolve()
          } else {
            setTimeout(check, 10)
          }
        }
        check()
      })

      const messages = agent.session.getMessages()
      expect(messages.length).toBe(2) // user + assistant
      expect(messages[0].role).toBe('user')
      expect(messages[1].role).toBe('assistant')

      const usage = agent.session.getTotalUsage()
      expect(usage.totalTokens).toBeGreaterThan(0)

      await testApp.stop()
    })

    it('tracks events in order', async () => {
      const adapter = new TestAdapter()
      adapter.setResponses(['Response'])

      const testApp = new HarnessApp({
        workDir: '/tmp/test',
        apiKey: '',
        baseUrl: '',
        model: 'test',
      })
      await testApp.start()

      const llm = (testApp.ctx as any).llm
      llm.registerAdapter(adapter, true)

      const agent = testApp.createAgent({})
      agent.followup([{ type: 'text', text: 'Hello' }])

      await new Promise<void>((resolve) => {
        const check = () => {
          // followup 异步启动：仅看 status==='idle' 会在处理开始前即满足（竞态）。
          // 必须等证据 turn/end 出现，才代表本轮真正结束。
          if (agent.status === 'idle' && agent.session.events.some((e) => e.type === 'turn/end')) {
            resolve()
          } else {
            setTimeout(check, 10)
          }
        }
        check()
      })

      const events = agent.session.events
      const eventTypes = events.map((e) => e.type)

      // 验证事件顺序：turn/start -> user/message -> assistant/message -> turn/end
      expect(eventTypes).toContain('turn/start')
      expect(eventTypes).toContain('user/message')
      expect(eventTypes).toContain('assistant/message')
      expect(eventTypes).toContain('turn/end')

      // turn/start 应该在 assistant/message 之前
      const turnStartIdx = eventTypes.indexOf('turn/start')
      const assistantIdx = eventTypes.indexOf('assistant/message')
      const turnEndIdx = eventTypes.indexOf('turn/end')

      expect(turnStartIdx).toBeLessThan(assistantIdx)
      expect(assistantIdx).toBeLessThan(turnEndIdx)

      await testApp.stop()
    })
  })

  describe('tool integration', () => {
    it('can register and use custom tools', async () => {
      let toolExecuted = false

      const adapter = new (class extends LlmAdapter {
        readonly name = 'tool-test'
        async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
          // 第一次调用返回工具调用
          if (options.messages.length <= 2) {
            yield {
              type: 'tool_call',
              toolCall: {
                index: 0,
                id: 'call_1',
                name: 'custom_tool',
                arguments: '{"input":"test"}',
              },
            }
          }
          yield { type: 'content', delta: 'Done with tools' }
          yield {
            type: 'usage',
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          }
          yield { type: 'done' }
        }
      })()

      const testApp = new HarnessApp({
        workDir: '/tmp/test',
        apiKey: '',
        baseUrl: '',
        model: 'test',
      })
      await testApp.start()

      const llm = (testApp.ctx as any).llm
      llm.registerAdapter(adapter, true)

      // 注册自定义工具
      const tools = (testApp.ctx as any).tools
      tools.register(defineTool({
        name: 'custom_tool',
        description: 'A custom test tool',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
          additionalProperties: false,
        },
        execute: async (args) => {
          toolExecuted = true
          return [{ type: 'text', text: `Custom tool result: ${args.input}` }]
        },
      }))

      const agent = testApp.createAgent({})
      agent.followup([{ type: 'text', text: 'Use the custom tool' }])

      await new Promise<void>((resolve) => {
        const check = () => {
          // followup 异步启动：仅看 status==='idle' 会在处理开始前即满足（竞态）。
          // 必须等工具真正执行完（toolExecuted）且本轮结束，避免提前 resolve 拿到空结果。
          if (agent.status === 'idle' && toolExecuted) {
            resolve()
          } else {
            setTimeout(check, 10)
          }
        }
        check()
      })

      expect(toolExecuted).toBe(true)
      const messages = agent.session.getMessages()
      // user + assistant(with tool call) + tool result + assistant(final)
      expect(messages.length).toBeGreaterThanOrEqual(3)

      await testApp.stop()
    })
  })
})
