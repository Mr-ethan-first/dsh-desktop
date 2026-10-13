/**
 * 会话持久化层。
 *
 * 遵循 deepseek-harness 设计原则：
 * - 事件溯源：持久化 append-only 事件日志
 * - 可插拔后端：支持 SQLite（生产）和 JSON 文件（开发/测试）
 * - 写时追加：所有变更通过追加事件实现
 * - 启动时重放：从持久化存储重建内存中的会话状态
 *
 * 持久化提供器接口：SessionPersistenceProvider
 *   - SQLitePersistence：基于 better-sqlite3 的生产级持久化
 *   - FilePersistence：基于 JSON 文件的简单持久化（无需原生依赖）
 */

import type { Session, SessionEvent, SessionHeader, SessionId } from './session.js'
import { SESSION_FORMAT_VERSION } from './session.js'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Database as SqlJsDatabase } from 'sql.js'

// ============================================================
// 持久化提供器接口
// ============================================================

/**
 * 会话持久化提供器接口。
 *
 * 所有持久化后端都实现此接口。
 * 遵循事件溯源模式：只追加事件，不修改已有数据。
 */
export interface SessionPersistenceProvider {
  /** 初始化：创建表/目录等 */
  initialize(): void

  /** 关闭：释放资源 */
  close(): void

  /** 保存会话元数据 */
  saveSession(header: SessionHeader): void

  /** 追加事件到会话日志 */
  appendEvent(sessionId: SessionId, event: SessionEvent): void

  /** 批量追加事件 */
  appendEvents(sessionId: SessionId, events: SessionEvent[]): void

  /** 加载所有会话的元数据 */
  loadAllSessions(): SessionHeader[]

  /** 加载指定会话的所有事件 */
  loadEvents(sessionId: SessionId): SessionEvent[]

  /** 删除会话（元数据 + 事件） */
  deleteSession(sessionId: SessionId): void

  /** 检查会话是否存在 */
  hasSession(sessionId: SessionId): boolean

  /** 获取会话数量 */
  countSessions(): number
}

// ============================================================
// SQLite 持久化
// ============================================================

/**
 * SQLite 持久化提供器。
 *
 * 使用 better-sqlite3 实现生产级持久化。
 * 表结构：
 *   - sessions: 会话元数据
 *   - session_events: append-only 事件日志
 *
 * 注意：需要安装 better-sqlite3 包。
 * 如果未安装，会抛出错误，调用方应回退到 FilePersistence。
 */
export class SQLitePersistence implements SessionPersistenceProvider {
  private db: any = null
  private dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  initialize(): void {
    let Database: any
    try {
      // 动态导入 better-sqlite3
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      Database = require('better-sqlite3')
    } catch {
      throw new Error(
        'better-sqlite3 is not installed. Run: pnpm add better-sqlite3',
      )
    }

    // 确保目录存在
    const dir = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'))
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    this.createSchema()
  }

  /**
   * 创建数据库 schema。
   * 遵循事件溯源设计：sessions 表存元数据，session_events 表存事件日志。
   */
  private createSchema(): void {
    const db = this.db

    // 会话表
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        cwd TEXT,
        title TEXT,
        version INTEGER NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0
      )
    `)

    // 事件表：append-only
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `)

    // 索引
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_session_id ON session_events(session_id)
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC)
    `)
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  saveSession(header: SessionHeader): void {
    const now = Date.now()
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, created_at, updated_at, cwd, title, version, event_count)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT event_count FROM sessions WHERE id = ?), 0))
    `)
    stmt.run(
      header.id,
      header.createdAt,
      now,
      header.cwd ?? null,
      header.title ?? null,
      header.version,
      header.id,
    )
  }

  appendEvent(sessionId: SessionId, event: SessionEvent): void {
    const now = Date.now()
    const stmt = this.db.prepare(`
      INSERT INTO session_events (session_id, seq, type, data, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    stmt.run(
      sessionId,
      event.seq,
      event.type,
      JSON.stringify(event.data),
      now,
    )

    // 更新会话的 updated_at 和 event_count
    const updateStmt = this.db.prepare(`
      UPDATE sessions SET updated_at = ?, event_count = event_count + 1 WHERE id = ?
    `)
    updateStmt.run(now, sessionId)
  }

  appendEvents(sessionId: SessionId, events: SessionEvent[]): void {
    if (events.length === 0) return

    const now = Date.now()
    const insertStmt = this.db.prepare(`
      INSERT INTO session_events (session_id, seq, type, data, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    const transaction = this.db.transaction((evts: SessionEvent[]) => {
      for (const event of evts) {
        insertStmt.run(
          sessionId,
          event.seq,
          event.type,
          JSON.stringify(event.data),
          now,
        )
      }
      // 更新会话的 updated_at 和 event_count
      this.db.prepare(`
        UPDATE sessions SET updated_at = ?, event_count = event_count + ? WHERE id = ?
      `).run(now, evts.length, sessionId)
    })

    transaction(events)
  }

  loadAllSessions(): SessionHeader[] {
    const rows = this.db.prepare(`
      SELECT id, created_at, cwd, title, version FROM sessions ORDER BY updated_at DESC
    `).all()

    return rows.map((row: any) => ({
      id: row.id as SessionId,
      createdAt: row.created_at,
      cwd: row.cwd ?? undefined,
      title: row.title ?? undefined,
      version: row.version,
    }))
  }

  loadEvents(sessionId: SessionId): SessionEvent[] {
    const rows = this.db.prepare(`
      SELECT seq, type, data FROM session_events WHERE session_id = ? ORDER BY seq ASC
    `).all(sessionId)

    return rows.map((row: any) => ({
      seq: row.seq,
      type: row.type,
      data: JSON.parse(row.data),
    } as SessionEvent))
  }

  deleteSession(sessionId: SessionId): void {
    // 由于 ON DELETE CASCADE，删除会话会自动删除事件
    const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?')
    stmt.run(sessionId)
  }

  hasSession(sessionId: SessionId): boolean {
    const row = this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)
    return !!row
  }

  countSessions(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM sessions').get()
    return row.count
  }
}

// ============================================================
// SQLite 持久化（sql.js 实现）
// ============================================================

/**
 * 基于 sql.js（SQLite 纯 WASM 移植，零原生编译依赖）的会话持久化。
 *
 * 与 workspace-history.ts 同级：项目当前未安装 better-sqlite3，而 Electron
 * 主进程加载原生模块需按运行时 ABI 重新编译，Windows 上易踩坑。sql.js 是纯
 * JS + wasm，主进程 Node 模式下自动加载同目录的 sql-wasm.wasm，产物是标准
 * SQLite .db 文件，完全满足「会话持久化到 SQLite」的需求。
 *
 * sql.js 是异步初始化（initSqlJs 返回 Promise），因此本类不自行打开数据库，
 * 而是由调用方先 initSqlJsSessionPersistence() 准备好「已就绪的 db + 路径」，
 * 再以同步接口实现 SessionPersistenceProvider，从而与 SessionStore 的同步
 * 调用约定（initialize / saveSession / appendEvent / loadEvents）兼容。
 *
 * sql.js 的内存数据库不会自动落盘，必须显式 db.export() 写回文件；因此每次
 * 变更后立即写盘，避免进程异常退出（历史 OOM / SIGABRT）丢数据。
 */
export class SqlJsSessionPersistence implements SessionPersistenceProvider {
  private db: SqlJsDatabase
  private readonly dbPath: string

  constructor(db: SqlJsDatabase, dbPath: string) {
    this.db = db
    this.dbPath = dbPath
  }

  initialize(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        cwd TEXT,
        title TEXT,
        version INTEGER NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      )
    `)
    this.db.run('CREATE INDEX IF NOT EXISTS idx_events_session_id ON session_events(session_id)')
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC)')
    this.flush()
  }

  close(): void {
    try {
      this.flush()
      this.db.close()
    } catch {
      /* 关闭失败不影响主流程 */
    }
  }

  saveSession(header: SessionHeader): void {
    this.db.run(
      `INSERT OR REPLACE INTO sessions (id, created_at, updated_at, cwd, title, version, event_count)
       VALUES (?, ?, ?, ?, ?, ?,
         COALESCE((SELECT event_count FROM sessions WHERE id = ?), 0))`,
      [
        header.id,
        header.createdAt,
        Date.now(),
        header.cwd ?? null,
        header.title ?? null,
        header.version,
        header.id,
      ],
    )
    this.flush()
  }

  appendEvent(sessionId: SessionId, event: SessionEvent): void {
    const now = Date.now()
    this.db.run(
      'INSERT INTO session_events (session_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)',
      [sessionId, event.seq, event.type, JSON.stringify(event.data), now],
    )
    this.db.run(
      'UPDATE sessions SET updated_at = ?, event_count = event_count + 1 WHERE id = ?',
      [now, sessionId],
    )
    this.flush()
  }

  appendEvents(sessionId: SessionId, events: SessionEvent[]): void {
    if (events.length === 0) return
    const now = Date.now()
    for (const event of events) {
      this.db.run(
        'INSERT INTO session_events (session_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)',
        [sessionId, event.seq, event.type, JSON.stringify(event.data), now],
      )
    }
    this.db.run(
      'UPDATE sessions SET updated_at = ?, event_count = event_count + ? WHERE id = ?',
      [now, events.length, sessionId],
    )
    this.flush()
  }

  loadAllSessions(): SessionHeader[] {
    const stmt = this.db.prepare(
      'SELECT id, created_at, cwd, title, version FROM sessions ORDER BY updated_at DESC',
    )
    const headers: SessionHeader[] = []
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>
        headers.push({
          id: row.id as SessionId,
          createdAt: Number(row.created_at),
          cwd: row.cwd ? String(row.cwd) : undefined,
          title: row.title ? String(row.title) : undefined,
          version: Number(row.version),
        })
      }
    } finally {
      stmt.free()
    }
    return headers
  }

  loadEvents(sessionId: SessionId): SessionEvent[] {
    const stmt = this.db.prepare('SELECT seq, type, data FROM session_events WHERE session_id = ? ORDER BY seq ASC')
    const events: SessionEvent[] = []
    try {
      stmt.bind([sessionId])
      while (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>
        events.push({
          seq: Number(row.seq),
          type: String(row.type),
          data: JSON.parse(String(row.data)),
        } as SessionEvent)
      }
    } finally {
      stmt.free()
    }
    return events
  }

  deleteSession(sessionId: SessionId): void {
    this.db.run('DELETE FROM session_events WHERE session_id = ?', [sessionId])
    this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId])
    this.flush()
  }

  hasSession(sessionId: SessionId): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM sessions WHERE id = ?')
    try {
      stmt.bind([sessionId])
      return stmt.step()
    } finally {
      stmt.free()
    }
  }

  countSessions(): number {
    const res = this.db.exec('SELECT COUNT(*) AS count FROM sessions')
    if (!res.length) return 0
    return Number(res[0].values[0]?.[0] ?? 0)
  }

  /** 把内存数据库写回 .db 文件（sql.js 需显式 export）。 */
  private flush(): void {
    try {
      writeFileSync(this.dbPath, Buffer.from(this.db.export()))
    } catch {
      /* 落盘失败不影响内存态；下次变更会再尝试 */
    }
  }
}

/**
 * 同步地打开（或创建）sql.js 会话数据库，返回就绪的 SqlJsSessionPersistence。
 * sql.js 不可用（未打包）时返回 null，由调用方回退到 FilePersistence。
 * @param dbPath SQLite 数据库文件路径
 */
export async function initSqlJsSessionPersistence(
  dbPath: string,
): Promise<SqlJsSessionPersistence | null> {
  try {
    const mod = await import('sql.js')
    const SQL = await mod.default()
    if (!existsSync(dbPath)) mkdirSync(dirname(dbPath), { recursive: true })
    const db = existsSync(dbPath)
      ? new SQL.Database(readFileSync(dbPath))
      : new SQL.Database()
    return new SqlJsSessionPersistence(db, dbPath)
  } catch (e) {
    console.error('[session-persistence] sql.js 不可用，回退到文件持久化：', (e as Error)?.message || e)
    return null
  }
}

// ============================================================
// JSON 文件持久化
// ============================================================

/**
 * JSON 文件持久化提供器。
 *
 * 每个会话存储为一个 JSON 文件，格式与事件溯源一致。
 * 无需原生依赖，适合开发和测试环境。
 *
 * 目录结构：
 *   {baseDir}/
 *     sessions.json          # 会话索引（元数据列表）
 *     events/
 *       {sessionId}.json     # 会话事件日志
 */
export class FilePersistence implements SessionPersistenceProvider {
  private baseDir: string
  private eventsDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.eventsDir = join(baseDir, 'events')
  }

  initialize(): void {
    mkdirSync(this.baseDir, { recursive: true })
    mkdirSync(this.eventsDir, { recursive: true })

    // 确保索引文件存在
    const indexPath = join(this.baseDir, 'sessions.json')
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, JSON.stringify([]))
    }
  }

  close(): void {
    // 文件持久化不需要关闭
  }

  private getIndexPath(): string {
    return join(this.baseDir, 'sessions.json')
  }

  private getEventsPath(sessionId: string): string {
    return join(this.eventsDir, `${sessionId}.json`)
  }

  private readIndex(): SessionHeader[] {
    const path = this.getIndexPath()
    if (!existsSync(path)) return []
    try {
      const raw = readFileSync(path, 'utf-8')
      return JSON.parse(raw) as SessionHeader[]
    } catch {
      return []
    }
  }

  private writeIndex(sessions: SessionHeader[]): void {
    writeFileSync(this.getIndexPath(), JSON.stringify(sessions, null, 2))
  }

  saveSession(header: SessionHeader): void {
    const sessions = this.readIndex()
    const existingIndex = sessions.findIndex((s) => s.id === header.id)

    if (existingIndex >= 0) {
      sessions[existingIndex] = header
    } else {
      sessions.push(header)
    }

    // 按创建时间倒序
    sessions.sort((a, b) => b.createdAt - a.createdAt)

    this.writeIndex(sessions)
  }

  appendEvent(sessionId: SessionId, event: SessionEvent): void {
    const events = this.readEvents(sessionId)
    events.push(event)
    writeFileSync(this.getEventsPath(sessionId), JSON.stringify(events))
  }

  appendEvents(sessionId: SessionId, events: SessionEvent[]): void {
    if (events.length === 0) return
    const existing = this.readEvents(sessionId)
    const merged = [...existing, ...events]
    writeFileSync(this.getEventsPath(sessionId), JSON.stringify(merged))
  }

  loadAllSessions(): SessionHeader[] {
    return this.readIndex()
  }

  loadEvents(sessionId: SessionId): SessionEvent[] {
    return this.readEvents(sessionId)
  }

  private readEvents(sessionId: SessionId): SessionEvent[] {
    const path = this.getEventsPath(sessionId)
    if (!existsSync(path)) return []
    try {
      const raw = readFileSync(path, 'utf-8')
      return JSON.parse(raw) as SessionEvent[]
    } catch {
      return []
    }
  }

  deleteSession(sessionId: SessionId): void {
    // 从索引中移除
    const sessions = this.readIndex().filter((s) => s.id !== sessionId)
    this.writeIndex(sessions)

    // 删除事件文件
    const eventsPath = this.getEventsPath(sessionId)
    if (existsSync(eventsPath)) {
      try {
        unlinkSync(eventsPath)
      } catch {
        // 忽略删除失败
      }
    }
  }

  hasSession(sessionId: SessionId): boolean {
    return this.readIndex().some((s) => s.id === sessionId)
  }

  countSessions(): number {
    return this.readIndex().length
  }
}

// ============================================================
// 工厂函数
// ============================================================

/**
 * 创建持久化提供器。
 *
 * 优先尝试 SQLite，如果不可用则回退到文件持久化。
 */
export function createPersistenceProvider(options: {
  type?: 'sqlite' | 'file' | 'auto'
  sqlitePath?: string
  fileDir?: string
}): SessionPersistenceProvider {
  const type = options.type ?? 'auto'

  if (type === 'sqlite') {
    return new SQLitePersistence(options.sqlitePath!)
  }

  if (type === 'file') {
    return new FilePersistence(options.fileDir!)
  }

  // auto: 先尝试 SQLite
  try {
    const provider = new SQLitePersistence(options.sqlitePath!)
    provider.initialize()
    return provider
  } catch {
    // SQLite 不可用，回退到文件
    return new FilePersistence(options.fileDir!)
  }
}
