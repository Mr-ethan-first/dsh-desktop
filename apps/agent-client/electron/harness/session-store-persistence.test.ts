/**
 * SessionStore 持久化集成测试。
 *
 * 测试 SessionStore 与持久化层的集成：
 * - 持久化的会话能被正确加载
 * - 事件追加会被持久化
 * - 删除会话会从持久化中移除
 * - 重启后状态一致
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from './context'
import { SessionStore, createSessionId } from './session'
import { FilePersistence } from './session-persistence'

describe('SessionStore + Persistence 集成', () => {
  let tempDir: string
  let ctx: Context
  let store: SessionStore
  let persistence: FilePersistence

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-test-store-'))
    persistence = new FilePersistence(join(tempDir, 'sessions'))
    ctx = new Context()
    ctx.plugin(SessionStore as any, { persistence, autoLoad: false })
    store = (ctx as any).sessions as SessionStore
  })

  afterEach(() => {
    persistence.close()
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('持久化写入', () => {
    it('创建会话后持久化元数据', () => {
      const id = createSessionId()
      store.create(id, { title: '测试会话', cwd: '/tmp' })

      expect(persistence.hasSession(id)).toBe(true)
      expect(persistence.countSessions()).toBe(1)

      const headers = persistence.loadAllSessions()
      expect(headers[0].title).toBe('测试会话')
      expect(headers[0].cwd).toBe('/tmp')
    })

    it('追加事件后持久化事件', () => {
      const id = createSessionId()
      store.create(id)

      store.appendEvent(id, {
        type: 'user/message',
        data: { content: [{ type: 'text', text: '你好' }] },
      })

      const events = persistence.loadEvents(id)
      expect(events.length).toBe(1)
      expect(events[0].type).toBe('user/message')
      expect(events[0].seq).toBe(0)
    })

    it('删除会话后从持久化移除', () => {
      const id = createSessionId()
      store.create(id)
      store.appendEvent(id, {
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'test' }] },
      })

      expect(persistence.hasSession(id)).toBe(true)

      store.dispose(id)

      expect(persistence.hasSession(id)).toBe(false)
      expect(persistence.loadEvents(id).length).toBe(0)
    })
  })

  describe('持久化加载', () => {
    it('启动时自动加载持久化会话', () => {
      // 1. 先创建一个会话并持久化
      const id = createSessionId()
      store.create(id, { title: '持久化会话' })
      store.appendEvent(id, {
        type: 'user/message',
        data: { content: [{ type: 'text', text: '消息内容' }] },
      })
      store.appendEvent(id, {
        type: 'assistant/message',
        data: { message: { role: 'assistant', content: [{ type: 'text', text: '回复内容' }] } },
      })

      // 2. 创建新的 SessionStore，验证自动加载
      const newPersistence = new FilePersistence(join(tempDir, 'sessions'))
      const newCtx = new Context()
      newCtx.plugin(SessionStore as any, { persistence: newPersistence, autoLoad: true })
      const newStore = (newCtx as any).sessions as SessionStore

      expect(newStore.list().length).toBe(1)
      const session = newStore.get(id)
      expect(session).toBeDefined()
      expect(session?.header.title).toBe('持久化会话')
      expect(session?.events.length).toBe(2)

      // 验证事件内容
      const messages = session?.getMessages()
      expect(messages?.length).toBe(2)
      expect(messages?.[0].role).toBe('user')
      expect(messages?.[1].role).toBe('assistant')

      newPersistence.close()
    })

    it('加载的会话可以继续追加事件', () => {
      // 1. 创建并持久化
      const id = createSessionId()
      store.create(id, { title: '测试' })
      store.appendEvent(id, {
        type: 'user/message',
        data: { content: [{ type: 'text', text: '第一条' }] },
      })

      // 2. 加载到新 store
      const newPersistence = new FilePersistence(join(tempDir, 'sessions'))
      const newCtx = new Context()
      newCtx.plugin(SessionStore as any, { persistence: newPersistence, autoLoad: true })
      const newStore = (newCtx as any).sessions as SessionStore

      // 3. 追加新事件
      newStore.appendEvent(id, {
        type: 'assistant/message',
        data: { message: { role: 'assistant', content: [{ type: 'text', text: '回复' }] } },
      })

      // 4. 验证新事件也被持久化
      const events = newPersistence.loadEvents(id)
      expect(events.length).toBe(2)
      expect(events[1].type).toBe('assistant/message')

      newPersistence.close()
    })

    it('加载多个会话', () => {
      const id1 = createSessionId()
      const id2 = createSessionId()

      store.create(id1, { title: '会话1' })
      store.create(id2, { title: '会话2' })

      const newPersistence = new FilePersistence(join(tempDir, 'sessions'))
      const newCtx = new Context()
      newCtx.plugin(SessionStore as any, { persistence: newPersistence, autoLoad: true })
      const newStore = (newCtx as any).sessions as SessionStore

      expect(newStore.list().length).toBe(2)
      expect(newStore.has(id1)).toBe(true)
      expect(newStore.has(id2)).toBe(true)

      newPersistence.close()
    })
  })

  describe('事件重放正确性', () => {
    it('重放后消息历史一致', () => {
      const id = createSessionId()
      store.create(id)

      // 模拟一个完整的对话流程
      store.appendEvent(id, { type: 'turn/start', data: { turn: 1 } })
      store.appendEvent(id, {
        type: 'user/message',
        data: { content: [{ type: 'text', text: '你好' }] },
      })
      store.appendEvent(id, {
        type: 'tool/call',
        data: { toolCallId: 'c1', name: 'test_tool', args: {} },
      })
      store.appendEvent(id, {
        type: 'tool/result',
        data: {
          toolCallId: 'c1',
          name: 'test_tool',
          message: { role: 'tool', content: [{ type: 'text', text: 'result' }] },
        },
      })
      store.appendEvent(id, {
        type: 'assistant/message',
        data: {
          message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] },
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        },
      })
      store.appendEvent(id, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })

      // 加载并重放
      const newPersistence = new FilePersistence(join(tempDir, 'sessions'))
      const newCtx = new Context()
      newCtx.plugin(SessionStore as any, { persistence: newPersistence, autoLoad: true })
      const newStore = (newCtx as any).sessions as SessionStore
      const loadedSession = newStore.get(id)!

      // 验证消息
      const messages = loadedSession.getMessages()
      expect(messages.length).toBe(3) // user + tool + assistant
      expect(messages[0].role).toBe('user')
      expect(messages[1].role).toBe('tool')
      expect(messages[2].role).toBe('assistant')

      // 验证 token 统计
      const usage = loadedSession.getTotalUsage()
      expect(usage.promptTokens).toBe(100)
      expect(usage.completionTokens).toBe(50)
      expect(usage.totalTokens).toBe(150)

      newPersistence.close()
    })

    it('序列号正确递增', () => {
      const id = createSessionId()
      store.create(id)

      store.appendEvent(id, { type: 'turn/start', data: { turn: 1 } })
      store.appendEvent(id, {
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'hi' }] },
      })

      const session = store.get(id)!
      expect(session.events[0].seq).toBe(0)
      expect(session.events[1].seq).toBe(1)

      // 加载后序列号保持
      const newPersistence = new FilePersistence(join(tempDir, 'sessions'))
      const newCtx = new Context()
      newCtx.plugin(SessionStore as any, { persistence: newPersistence, autoLoad: true })
      const newStore = (newCtx as any).sessions as SessionStore
      const loaded = newStore.get(id)!

      expect(loaded.events[0].seq).toBe(0)
      expect(loaded.events[1].seq).toBe(1)

      // 追加新事件的序列号正确
      newStore.appendEvent(id, {
        type: 'assistant/message',
        data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      })

      const updated = newStore.get(id)!
      expect(updated.events.length).toBe(3)
      expect(updated.events[2].seq).toBe(2)

      newPersistence.close()
    })
  })

  describe('hasPersistence / getPersistence', () => {
    it('hasPersistence 返回 true', () => {
      expect(store.hasPersistence()).toBe(true)
    })

    it('getPersistence 返回提供器', () => {
      expect(store.getPersistence()).toBe(persistence)
    })

    it('没有持久化时 hasPersistence 返回 false', () => {
      const ctx2 = new Context()
      ctx2.plugin(SessionStore as any)
      const store2 = (ctx2 as any).sessions as SessionStore
      expect(store2.hasPersistence()).toBe(false)
      expect(store2.getPersistence()).toBeNull()
    })
  })

  describe('session/loaded 事件', () => {
    it('自动加载后触发 session/loaded 事件', () => {
      // 先创建一些数据
      const id1 = createSessionId()
      const id2 = createSessionId()
      store.create(id1)
      store.create(id2)

      // 加载时应该触发事件
      let loadedCount = 0
      const newPersistence = new FilePersistence(join(tempDir, 'sessions'))
      const newCtx = new Context()
      newCtx.on('session/loaded', (count: number) => {
        loadedCount = count
      })
      newCtx.plugin(SessionStore as any, { persistence: newPersistence, autoLoad: true })

      expect(loadedCount).toBe(2)

      newPersistence.close()
    })

    it('persistence/ready 事件在持久化就绪时触发', () => {
      let ready = false
      const newCtx = new Context()
      newCtx.on('persistence/ready', () => {
        ready = true
      })
      newCtx.plugin(SessionStore as any, { persistence, autoLoad: false })

      expect(ready).toBe(true)
    })
  })
})
