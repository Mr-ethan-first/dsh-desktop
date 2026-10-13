/**
 * Agent Loop 模块单元测试。
 *
 * 测试 Agent 创建、消息跟随、turn/step 循环、取消逻辑。
 * 使用 Mock LLM 适配器避免真实 API 调用。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from './context'
import { SessionStore } from './session'
import { ToolRuntime, defineTool } from './tools'
import { LlmRuntime, LlmAdapter } from './llm'
import { AgentRegistry, AgentLoop } from './agent-loop'
import type { GenerateOptions, StreamChunk } from './llm'
import type { AgentStatus } from './agent-loop'

/**
 * Mock LLM 适配器，支持自定义响应序列。
 */
class MockAdapter extends LlmAdapter {
  readonly name = 'mock'
  private responses: Array<{
    content: string
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>
  }> = []
  private callIndex = 0

  setResponses(responses: Array<{
    content: string
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>
  }>): void {
    this.responses = responses
    this.callIndex = 0
  }

  getCallCount(): number {
    return this.callIndex
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const response = this.responses[this.callIndex] || { content: 'done' }
    this.callIndex++

    // Content (delta 是字符串，符合 StreamChunk 类型)
    for (const char of response.content) {
      yield { type: 'content', delta: char }
    }

    // Tool calls (必须包含 index 字段)
    if (response.toolCalls) {
      for (let i = 0; i < response.toolCalls.length; i++) {
        const tc = response.toolCalls[i]
        yield {
          type: 'tool_call',
          toolCall: {
            index: i,
            id: `call_${this.callIndex}_${i}`,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }
      }
    }

    yield {
      type: 'usage',
      usage: {
        promptTokens: options.messages.length * 5,
        completionTokens: response.content.length,
        totalTokens: options.messages.length * 5 + response.content.length,
      },
    }

    yield { type: 'done' }
  }
}

function setupTestContext(): {
  ctx: Context
  mockAdapter: MockAdapter
  tools: ToolRuntime
  loop: AgentLoop
} {
  const ctx = new Context()
  ctx.plugin(SessionStore as any)
  ctx.plugin(ToolRuntime as any)
  ctx.plugin(LlmRuntime as any)
  ctx.plugin(AgentRegistry as any)
  ctx.plugin(AgentLoop as any, { agents: [] })

  const mockAdapter = new MockAdapter()
  const llm = (ctx as any).llm as LlmRuntime
  llm.registerAdapter(mockAdapter, true)

  return {
    ctx,
    mockAdapter,
    tools: (ctx as any).tools as ToolRuntime,
    loop: (ctx as any).agentLoop as AgentLoop,
  }
}

describe('AgentLoop', () => {
  let ctx: Context
  let mockAdapter: MockAdapter
  let tools: ToolRuntime
  let loop: AgentLoop

  beforeEach(() => {
    const setup = setupTestContext()
    ctx = setup.ctx
    mockAdapter = setup.mockAdapter
    tools = setup.tools
    loop = setup.loop
  })

  describe('agent creation', () => {
    it('creates a new agent', () => {
      const agent = loop.createNew(
        { model: 'test-model' },
        { cwd: '/tmp/test', title: 'Test Agent' },
      )
      expect(agent.id).toBeDefined()
      expect(agent.status).toBe('idle')
      expect(agent.session.header.title).toBe('Test Agent')
      expect(agent.session.header.cwd).toBe('/tmp/test')
    })

    it('registers agent in registry', () => {
      const agent = loop.createNew({}, {})
      const registry = (ctx as any).agents as AgentRegistry
      expect(registry.get(agent.id)).toBe(agent)
    })
  })

  describe('message processing', () => {
    it('processes a simple user message', async () => {
      mockAdapter.setResponses([
        { content: 'Hello! How can I help you?' },
      ])

      const agent = loop.createNew({}, {})
      const statuses: AgentStatus[] = []
      ctx.on('agent/status', (_a: any, status: AgentStatus) => {
        statuses.push(status)
      })

      agent.followup([{ type: 'text', text: 'Hi there' }])

      // 等待 agent 完成
      await new Promise<void>((resolve) => {
        const check = () => {
          if (agent.status === 'idle' && statuses.includes('idle')) {
            resolve()
          } else {
            setTimeout(check, 10)
          }
        }
        check()
      })

      expect(agent.status).toBe('idle')
      const messages = agent.session.getMessages()
      expect(messages.length).toBe(2) // user + assistant
      expect(messages[0].role).toBe('user')
      expect(messages[1].role).toBe('assistant')
      expect((messages[1].content[0] as any).text).toBe('Hello! How can I help you?')
    })

    it('queues messages while running', async () => {
      mockAdapter.setResponses([
        { content: 'First response' },
        { content: 'Second response' },
      ])

      const agent = loop.createNew({}, {})
      agent.followup([{ type: 'text', text: 'First message' }])
      agent.followup([{ type: 'text', text: 'Second message' }])

      // 等待两个 turn 都完成
      await new Promise<void>((resolve) => {
        const check = () => {
          const messages = agent.session.getMessages()
          // 2 user + 2 assistant = 4 messages
          if (messages.length >= 4 && agent.status === 'idle') {
            resolve()
          } else {
            setTimeout(check, 10)
          }
        }
        check()
      })

      const messages = agent.session.getMessages()
      expect(messages.length).toBe(4)
      expect(messages[0].role).toBe('user')
      expect(messages[1].role).toBe('assistant')
      expect(messages[2].role).toBe('user')
      expect(messages[3].role).toBe('assistant')
    })
  })

  describe('tool calls', () => {
    it('executes a tool call and continues', async () => {
      let toolCalled = false
      tools.register(defineTool({
        name: 'get_weather',
        description: 'Gets weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        execute: async (args) => {
          toolCalled = true
          return [{ type: 'text', text: `Weather in ${args.city}: sunny, 25°C` }]
        },
      }))

      mockAdapter.setResponses([
        {
          content: "Let me check the weather.",
          toolCalls: [{ name: 'get_weather', arguments: { city: 'Beijing' } }],
        },
        { content: "The weather in Beijing is sunny, 25°C." },
      ])

      const agent = loop.createNew({}, {})
      agent.followup([{ type: 'text', text: 'What is the weather in Beijing?' }])

      await new Promise<void>((resolve) => {
        const check = () => {
          const messages = agent.session.getMessages()
          // user + assistant(with tool call) + tool result + assistant(final) = 4
          if (messages.length >= 4 && agent.status === 'idle') {
            resolve()
          } else {
            setTimeout(check, 10)
          }
        }
        check()
      })

      expect(toolCalled).toBe(true)
      const messages = agent.session.getMessages()
      expect(messages.length).toBeGreaterThanOrEqual(4)
    })

    it('respects maxToolSteps limit', async () => {
      tools.register(defineTool({
        name: 'infinite_tool',
        description: 'A tool that returns nothing useful',
        parameters: { type: 'object', properties: {} },
        execute: async () => [{ type: 'text', text: 'still going' }],
      }))

      // 模拟一个会不断调用工具的模型
      const responses = []
      for (let i = 0; i < 20; i++) {
        responses.push({
          content: `Step ${i}`,
          toolCalls: [{ name: 'infinite_tool', arguments: {} }],
        })
      }
      mockAdapter.setResponses(responses)

      const agent = loop.createNew(
        { maxToolSteps: 3 },
        {},
      )
      agent.followup([{ type: 'text', text: 'start' }])

      await new Promise<void>((resolve) => {
        const check = () => {
          if (agent.status === 'idle') {
            resolve()
          } else {
            setTimeout(check, 10)
          }
        }
        check()
      })

      // maxToolSteps = 3 意味着最多 3 次工具调用
      // 但模型每次都会调用工具，所以应该在达到限制后停止
      const toolResults = agent.session.getMessages().filter((m) => m.role === 'tool')
      expect(toolResults.length).toBeLessThanOrEqual(3)
    })
  })

  describe('cancellation', () => {
    it('cancels a running agent', async () => {
      // 模拟一个慢速响应
      mockAdapter.setResponses([
        { content: 'This will be cancelled' },
      ])

      // 覆盖 stream 方法，让它慢一点，并在收到 abort 信号时真正中断
      const originalStream = mockAdapter.stream.bind(mockAdapter)
      mockAdapter.stream = async function* (options: GenerateOptions) {
        await new Promise((r) => setTimeout(r, 100))
        if (options.signal?.aborted) {
          throw new Error('aborted by signal')
        }
        yield* originalStream(options)
      }

      const agent = loop.createNew({}, {})
      agent.followup([{ type: 'text', text: 'hello' }])

      // 等待异步 admit 完成、abortController 已建立、agent 真正进入 running，
      // 避免在「状态尚未切到 running」的窗口里 cancel（此时 abortController 还未建好，等于空操作）。
      await new Promise<void>((resolve) => {
        const check = () => {
          if (agent.status === 'running') {
            resolve()
          } else {
            setTimeout(check, 5)
          }
        }
        check()
      })

      // 此时取消应真正中断正在进行的 turn
      agent.cancel({ kind: 'user-requested' })

      await new Promise<void>((resolve) => {
        const check = () => {
          if (agent.status === 'idle') {
            resolve()
          } else {
            setTimeout(check, 5)
          }
        }
        check()
      })

      // 状态应该回到 idle
      expect(agent.status).toBe('idle')
    })
  })

  describe('session events', () => {
    it('emits turn/start and turn/end events', async () => {
      mockAdapter.setResponses([
        { content: 'Done' },
      ])

      const agent = loop.createNew({}, {})
      let turnStart = false
      let turnEnd = false
      let turnEndReason = ''

      ctx.on('session/event', (session: any, event: any) => {
        if (event.type === 'turn/start') turnStart = true
        if (event.type === 'turn/end') {
          turnEnd = true
          turnEndReason = event.data.reason
        }
      })

      agent.followup([{ type: 'text', text: 'hi' }])

      await new Promise<void>((resolve) => {
        const check = () => {
          if (turnEnd) resolve()
          else setTimeout(check, 10)
        }
        check()
      })

      expect(turnStart).toBe(true)
      expect(turnEnd).toBe(true)
      expect(turnEndReason).toBe('completed')
    })

    it('tracks token usage across turns', async () => {
      mockAdapter.setResponses([
        { content: 'First' },
        { content: 'Second' },
      ])

      const agent = loop.createNew({}, {})
      agent.followup([{ type: 'text', text: 'msg1' }])

      await new Promise<void>((resolve) => {
        const check = () => {
          if (agent.status === 'idle') resolve()
          else setTimeout(check, 10)
        }
        check()
      })

      agent.followup([{ type: 'text', text: 'msg2' }])

      await new Promise<void>((resolve) => {
        const check = () => {
          if (agent.status === 'idle') resolve()
          else setTimeout(check, 10)
        }
        check()
      })

      const usage = agent.session.getTotalUsage()
      expect(usage.totalTokens).toBeGreaterThan(0)
      expect(usage.promptTokens).toBeGreaterThan(0)
      expect(usage.completionTokens).toBeGreaterThan(0)
    })
  })
})

describe('AgentRegistry', () => {
  it('lists registered agents', () => {
    const ctx = new Context()
    ctx.plugin(AgentRegistry as any)
    const registry = (ctx as any).agents as AgentRegistry

    const agent1: any = { id: 'agent1', session: { id: 's1' }, status: 'idle' as const, cancel: () => {}, followup: () => {}, dispose: () => {} }
    const agent2: any = { id: 'agent2', session: { id: 's2' }, status: 'idle' as const, cancel: () => {}, followup: () => {}, dispose: () => {} }

    registry.register(agent1)
    registry.register(agent2)

    expect(registry.list().length).toBe(2)
    expect(registry.get('agent1')).toBe(agent1)
    expect(registry.get('agent2')).toBe(agent2)
  })
})
