/**
 * 会话持久化单元测试。
 *
 * 测试 FilePersistence 的核心功能：
 * - 会话元数据持久化
 * - 事件日志持久化
 * - 加载和重放
 * - 删除
 * - 计数和查询
 *
 * SQLitePersistence 需要 better-sqlite3，在测试环境中可能不可用，
 * 因此只测试 FilePersistence。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FilePersistence } from './session-persistence'
import { SESSION_FORMAT_VERSION, type SessionEvent, type SessionId } from './session'

function makeSessionId(id: string): SessionId {
  return id as SessionId
}

describe('FilePersistence', () => {
  let tempDir: string
  let persistence: FilePersistence

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-test-'))
    persistence = new FilePersistence(tempDir)
    persistence.initialize()
  })

  afterEach(() => {
    persistence.close()
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('初始化', () => {
    it('创建目录结构', () => {
      expect(existsSync(tempDir)).toBe(true)
      expect(existsSync(join(tempDir, 'events'))).toBe(true)
      expect(existsSync(join(tempDir, 'sessions.json'))).toBe(true)
    })

    it('初始为空', () => {
      expect(persistence.countSessions()).toBe(0)
      expect(persistence.loadAllSessions()).toEqual([])
    })
  })

  describe('会话元数据', () => {
    it('保存会话', () => {
      const header = {
        id: makeSessionId('session-1'),
        createdAt: Date.now(),
        version: SESSION_FORMAT_VERSION,
        title: '测试会话',
        cwd: '/tmp/test',
      }

      persistence.saveSession(header)
      expect(persistence.countSessions()).toBe(1)
      expect(persistence.hasSession(header.id)).toBe(true)
    })

    it('更新已存在的会话', () => {
      const id = makeSessionId('session-1')

      persistence.saveSession({
        id,
        createdAt: Date.now(),
        version: SESSION_FORMAT_VERSION,
        title: '旧标题',
      })

      persistence.saveSession({
        id,
        createdAt: Date.now(),
        version: SESSION_FORMAT_VERSION,
        title: '新标题',
      })

      expect(persistence.countSessions()).toBe(1)
      const sessions = persistence.loadAllSessions()
      expect(sessions[0].title).toBe('新标题')
    })

    it('hasSession 对不存在的会话返回 false', () => {
      expect(persistence.hasSession(makeSessionId('non-existent'))).toBe(false)
    })
  })

  describe('事件持久化', () => {
    const sessionId = makeSessionId('session-1')

    beforeEach(() => {
      persistence.saveSession({
        id: sessionId,
        createdAt: Date.now(),
        version: SESSION_FORMAT_VERSION,
        title: '测试',
      })
    })

    it('追加单个事件', () => {
      const event: SessionEvent = {
        type: 'user/message',
        seq: 0,
        data: {
          content: [{ type: 'text', text: '你好' }],
        },
      }

      persistence.appendEvent(sessionId, event)
      const events = persistence.loadEvents(sessionId)
      expect(events.length).toBe(1)
      expect(events[0].type).toBe('user/message')
      expect(events[0].seq).toBe(0)
    })

    it('追加多个事件', () => {
      const events: SessionEvent[] = [
        { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '消息1' }] } },
        { type: 'assistant/message', seq: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: '回复1' }] } } },
        { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '消息2' }] } },
      ]

      persistence.appendEvents(sessionId, events)
      const loaded = persistence.loadEvents(sessionId)
      expect(loaded.length).toBe(3)
      expect(loaded[0].seq).toBe(0)
      expect(loaded[1].seq).toBe(1)
      expect(loaded[2].seq).toBe(2)
    })

    it('事件按 seq 排序加载', () => {
      const events: SessionEvent[] = [
        { type: 'turn/start', seq: 0, data: { turn: 1 } },
        { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hi' }] } },
        { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } } },
        { type: 'turn/end', seq: 3, data: { turn: 1, reason: 'completed' } },
      ]

      persistence.appendEvents(sessionId, events)
      const loaded = persistence.loadEvents(sessionId)

      expect(loaded.length).toBe(4)
      for (let i = 0; i < loaded.length; i++) {
        expect(loaded[i].seq).toBe(i)
      }
    })

    it('空事件数组不做任何事', () => {
      persistence.appendEvents(sessionId, [])
      expect(persistence.loadEvents(sessionId).length).toBe(0)
    })

    it('不存在的会话加载返回空数组', () => {
      const events = persistence.loadEvents(makeSessionId('non-existent'))
      expect(events).toEqual([])
    })
  })

  describe('加载会话', () => {
    it('loadAllSessions 返回所有会话', () => {
      persistence.saveSession({
        id: makeSessionId('s1'),
        createdAt: 1000,
        version: SESSION_FORMAT_VERSION,
        title: '会话1',
      })
      persistence.saveSession({
        id: makeSessionId('s2'),
        createdAt: 2000,
        version: SESSION_FORMAT_VERSION,
        title: '会话2',
      })

      const sessions = persistence.loadAllSessions()
      expect(sessions.length).toBe(2)
    })

    it('会话按创建时间倒序排列', () => {
      persistence.saveSession({
        id: makeSessionId('old'),
        createdAt: 1000,
        version: SESSION_FORMAT_VERSION,
        title: '旧会话',
      })
      persistence.saveSession({
        id: makeSessionId('new'),
        createdAt: 3000,
        version: SESSION_FORMAT_VERSION,
        title: '新会话',
      })

      const sessions = persistence.loadAllSessions()
      expect(sessions[0].title).toBe('新会话')
      expect(sessions[1].title).toBe('旧会话')
    })

    it('加载的事件数据完整', () => {
      const sessionId = makeSessionId('test')
      persistence.saveSession({
        id: sessionId,
        createdAt: Date.now(),
        version: SESSION_FORMAT_VERSION,
      })

      const toolCallEvent: SessionEvent = {
        type: 'tool/call',
        seq: 0,
        data: {
          toolCallId: 'call_123',
          name: 'test_tool',
          args: { foo: 'bar', num: 42 },
        },
      }

      persistence.appendEvent(sessionId, toolCallEvent)
      const loaded = persistence.loadEvents(sessionId)[0] as any

      expect(loaded.type).toBe('tool/call')
      expect(loaded.data.toolCallId).toBe('call_123')
      expect(loaded.data.name).toBe('test_tool')
      expect(loaded.data.args.foo).toBe('bar')
      expect(loaded.data.args.num).toBe(42)
    })
  })

  describe('删除会话', () => {
    it('删除会话和事件', () => {
      const sessionId = makeSessionId('to-delete')

      persistence.saveSession({
        id: sessionId,
        createdAt: Date.now(),
        version: SESSION_FORMAT_VERSION,
      })
      persistence.appendEvent(sessionId, {
        type: 'user/message',
        seq: 0,
        data: { content: [{ type: 'text', text: 'test' }] },
      })

      expect(persistence.hasSession(sessionId)).toBe(true)
      expect(persistence.loadEvents(sessionId).length).toBe(1)

      persistence.deleteSession(sessionId)

      expect(persistence.hasSession(sessionId)).toBe(false)
      expect(persistence.loadEvents(sessionId).length).toBe(0)
      expect(persistence.countSessions()).toBe(0)
    })

    it('删除不存在的会话不报错', () => {
      expect(() => {
        persistence.deleteSession(makeSessionId('non-existent'))
      }).not.toThrow()
    })
  })

  describe('完整生命周期', () => {
    it('创建 - 追加事件 - 重载 - 验证', () => {
      const sessionId = makeSessionId('lifecycle-test')

      // 1. 创建会话
      persistence.saveSession({
        id: sessionId,
        createdAt: Date.now(),
        version: SESSION_FORMAT_VERSION,
        title: '生命周期测试',
        cwd: '/tmp/work',
      })

      // 2. 追加事件
      const events: SessionEvent[] = [
        { type: 'turn/start', seq: 0, data: { turn: 1 } },
        { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '你好' }] } },
        { type: 'assistant/message', seq: 2, data: {
          message: { role: 'assistant', content: [{ type: 'text', text: '你好！有什么可以帮你的？' }] },
          usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
        } },
        { type: 'turn/end', seq: 3, data: { turn: 1, reason: 'completed' } },
      ]
      persistence.appendEvents(sessionId, events)

      // 3. 重新加载验证
      const newPersistence = new FilePersistence(tempDir)
      newPersistence.initialize()

      expect(newPersistence.countSessions()).toBe(1)

      const loadedEvents = newPersistence.loadEvents(sessionId)
      expect(loadedEvents.length).toBe(4)
      expect(loadedEvents[0].type).toBe('turn/start')
      expect(loadedEvents[3].type).toBe('turn/end')

      const loadedSessions = newPersistence.loadAllSessions()
      expect(loadedSessions[0].title).toBe('生命周期测试')
      expect(loadedSessions[0].cwd).toBe('/tmp/work')

      newPersistence.close()
    })

    it('多会话独立存储', () => {
      const s1 = makeSessionId('session-1')
      const s2 = makeSessionId('session-2')

      persistence.saveSession({ id: s1, createdAt: 1000, version: SESSION_FORMAT_VERSION, title: '会话1' })
      persistence.saveSession({ id: s2, createdAt: 2000, version: SESSION_FORMAT_VERSION, title: '会话2' })

      persistence.appendEvent(s1, {
        type: 'user/message', seq: 0,
        data: { content: [{ type: 'text', text: '会话1的消息' }] },
      })
      persistence.appendEvent(s2, {
        type: 'user/message', seq: 0,
        data: { content: [{ type: 'text', text: '会话2的消息' }] },
      })

      const events1 = persistence.loadEvents(s1)
      const events2 = persistence.loadEvents(s2)

      expect(events1.length).toBe(1)
      expect(events2.length).toBe(1)
      expect((events1[0].data as any).content[0].text).toBe('会话1的消息')
      expect((events2[0].data as any).content[0].text).toBe('会话2的消息')
    })
  })
})

describe('createPersistenceProvider', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-test-'))
  })

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('file 类型创建 FilePersistence', async () => {
    const { createPersistenceProvider } = await import('./session-persistence')
    const provider = createPersistenceProvider({
      type: 'file',
      fileDir: join(tempDir, 'sessions'),
    })
    provider.initialize()
    expect(provider.countSessions()).toBe(0)
    provider.close()
  })

  it('auto 模式在没有 SQLite 时回退到 file', async () => {
    const { createPersistenceProvider } = await import('./session-persistence')
    // 由于测试环境没有 better-sqlite3，auto 模式应该回退到 file
    const provider = createPersistenceProvider({
      type: 'auto',
      sqlitePath: join(tempDir, 'test.db'),
      fileDir: join(tempDir, 'sessions'),
    })
    provider.initialize()
    expect(provider.countSessions()).toBe(0)
    provider.close()
  })
})
