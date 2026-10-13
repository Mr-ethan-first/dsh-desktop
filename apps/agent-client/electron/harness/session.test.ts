/**
 * Session 模块单元测试。
 *
 * 测试事件溯源会话存储、事件追加、派生状态计算。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from './context'
import { SessionStore, Session, createSessionId, SESSION_FORMAT_VERSION } from './session'
import type { SessionId } from './session'

describe('Session', () => {
  describe('session creation', () => {
    it('creates session with header', () => {
      const id = createSessionId()
      const session = new Session({
        id,
        createdAt: 12345,
        version: SESSION_FORMAT_VERSION,
        title: 'Test Session',
        cwd: '/tmp/test',
      })
      expect(session.id).toBe(id)
      expect(session.header.title).toBe('Test Session')
      expect(session.header.cwd).toBe('/tmp/test')
      expect(session.events).toEqual([])
    })

    it('header is immutable', () => {
      const id = createSessionId()
      const session = new Session({
        id,
        createdAt: 12345,
        version: SESSION_FORMAT_VERSION,
      })
      expect(() => {
        ;(session.header as any).title = 'modified'
      }).toThrow()
    })
  })

  describe('event append', () => {
    let session: Session

    beforeEach(() => {
      const id = createSessionId()
      session = new Session({
        id,
        createdAt: Date.now(),
        version: SESSION_FORMAT_VERSION,
      })
    })

    it('appends user message event', () => {
      const event = session.appendEvent({
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: 'hello' }],
        },
      })
      expect(event.type).toBe('user/message')
      expect(event.seq).toBe(0)
      expect(session.events.length).toBe(1)
    })

    it('appends assistant message event', () => {
      const event = session.appendEvent({
        type: 'assistant/message',
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi there' }],
          },
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      })
      expect(event.type).toBe('assistant/message')
      expect(event.seq).toBe(0)
    })

    it('increments seq for each event', () => {
      session.appendEvent({
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'first' }] },
      })
      session.appendEvent({
        type: 'assistant/message',
        data: {
          message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
        },
      })
      session.appendEvent({
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'third' }] },
      })
      expect(session.events[0].seq).toBe(0)
      expect(session.events[1].seq).toBe(1)
      expect(session.events[2].seq).toBe(2)
    })

    it('individual events are immutable (frozen)', () => {
      session.appendEvent({
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'hello' }] },
      })
      const event = session.events[0]
      expect(() => {
        ;(event as any).type = 'modified'
      }).toThrow()
    })

    it('event data objects are frozen', () => {
      session.appendEvent({
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'hello' }] },
      })
      const event = session.events[0]
      expect(() => {
        ;(event.data as any).content = 'modified'
      }).toThrow()
    })
  })

  describe('derived state', () => {
    let session: Session

    beforeEach(() => {
      const id = createSessionId()
      session = new Session({
        id,
        createdAt: Date.now(),
        version: SESSION_FORMAT_VERSION,
      })
    })

    it('getMessages derives messages from events', () => {
      session.appendEvent({
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'hello' }] },
      })
      session.appendEvent({
        type: 'assistant/message',
        data: {
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        },
      })

      const messages = session.getMessages()
      expect(messages.length).toBe(2)
      expect(messages[0].role).toBe('user')
      expect(messages[0].content[0].text).toBe('hello')
      expect(messages[1].role).toBe('assistant')
      expect(messages[1].content[0].text).toBe('hi')
    })

    it('getTotalUsage sums all assistant message usages', () => {
      session.appendEvent({
        type: 'assistant/message',
        data: {
          message: { role: 'assistant', content: [] },
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      })
      session.appendEvent({
        type: 'assistant/message',
        data: {
          message: { role: 'assistant', content: [] },
          usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        },
      })

      const usage = session.getTotalUsage()
      expect(usage.promptTokens).toBe(30)
      expect(usage.completionTokens).toBe(15)
      expect(usage.totalTokens).toBe(45)
    })

    it('getUsageSummary aggregates by model and totals across models (Bug #7)', () => {
      session.appendEvent({
        type: 'assistant/message',
        data: {
          message: { role: 'assistant', content: [] },
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          model: 'glm-4.6v',
        },
      })
      session.appendEvent({
        type: 'assistant/message',
        data: {
          message: { role: 'assistant', content: [] },
          usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          model: 'glm-4.6v',
        },
      })
      session.appendEvent({
        type: 'assistant/message',
        data: {
          message: { role: 'assistant', content: [] },
          usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
          model: 'qwen-vl-plus',
        },
      })
      // 早期事件没有 model 字段，应归入 UNKNOWN_MODEL 仍被统计
      session.appendEvent({
        type: 'assistant/message',
        data: {
          message: { role: 'assistant', content: [] },
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        },
      })

      const summary = session.getUsageSummary()
      expect(summary.promptTokens).toBe(85)
      expect(summary.completionTokens).toBe(45)
      expect(summary.totalTokens).toBe(130)

      const byId = Object.fromEntries(summary.byModel.map((m) => [m.model, m]))
      expect(byId['glm-4.6v']).toEqual({
        model: 'glm-4.6v',
        promptTokens: 30,
        completionTokens: 15,
        totalTokens: 45,
        calls: 2,
      })
      expect(byId['qwen-vl-plus']).toEqual({
        model: 'qwen-vl-plus',
        promptTokens: 50,
        completionTokens: 25,
        totalTokens: 75,
        calls: 1,
      })
      expect(byId['unknown']).toEqual({
        model: 'unknown',
        promptTokens: 5,
        completionTokens: 5,
        totalTokens: 10,
        calls: 1,
      })
    })

    it('tool result messages are included', () => {
      session.appendEvent({
        type: 'tool/call',
        data: { toolCallId: 'call_1', name: 'test_tool', args: {} },
      })
      session.appendEvent({
        type: 'tool/result',
        data: {
          toolCallId: 'call_1',
          name: 'test_tool',
          message: { role: 'tool', content: [{ type: 'text', text: 'result' }] },
        },
      })

      const messages = session.getMessages()
      expect(messages.length).toBe(1)
      expect(messages[0].role).toBe('tool')
      expect(messages[0].toolName).toBe('test_tool')
    })
  })
})

describe('SessionStore', () => {
  let ctx: Context
  let store: SessionStore

  beforeEach(() => {
    ctx = new Context()
    ctx.plugin(SessionStore as any)
    store = (ctx as any).sessions as SessionStore
  })

  it('creates a session', () => {
    const id = createSessionId()
    const session = store.create(id, { title: 'Test' })
    expect(session.id).toBe(id)
    expect(session.header.title).toBe('Test')
    expect(store.has(id)).toBe(true)
  })

  it('throws on duplicate id', () => {
    const id = createSessionId()
    store.create(id)
    expect(() => store.create(id)).toThrow('already exists')
  })

  it('gets a session', () => {
    const id = createSessionId()
    const created = store.create(id)
    const got = store.get(id)
    expect(got).toBe(created)
  })

  it('returns undefined for missing session', () => {
    expect(store.get('nonexistent' as SessionId)).toBeUndefined()
  })

  it('lists all sessions', () => {
    const id1 = createSessionId()
    const id2 = createSessionId()
    store.create(id1)
    store.create(id2)
    const list = store.list()
    expect(list.length).toBe(2)
    expect(list.map((s) => s.id)).toContain(id1)
    expect(list.map((s) => s.id)).toContain(id2)
  })

  it('disposes a session', () => {
    const id = createSessionId()
    store.create(id)
    const result = store.dispose(id)
    expect(result).toBe(true)
    expect(store.has(id)).toBe(false)
  })

  it('appendEvent adds event and emits', () => {
    const id = createSessionId()
    store.create(id)

    let emitted = false
    ctx.on('session/event', () => {
      emitted = true
    })

    store.appendEvent(id, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'hello' }] },
    })

    expect(emitted).toBe(true)
    const session = store.get(id)!
    expect(session.events.length).toBe(1)
  })

  it('session/created event is emitted', () => {
    let createdSession: any = null
    ctx.on('session/created', (session: any) => {
      createdSession = session
    })

    const id = createSessionId()
    store.create(id)

    expect(createdSession).toBeDefined()
    expect(createdSession.id).toBe(id)
  })

  it('session/disposed event is emitted', () => {
    let disposed = false
    ctx.on('session/disposed', () => {
      disposed = true
    })

    const id = createSessionId()
    store.create(id)
    store.dispose(id)

    expect(disposed).toBe(true)
  })
})

describe('createSessionId', () => {
  it('creates unique session IDs', () => {
    const id1 = createSessionId()
    const id2 = createSessionId()
    expect(id1).not.toBe(id2)
    expect(typeof id1).toBe('string')
    expect(id1.length).toBeGreaterThan(0)
  })
})
