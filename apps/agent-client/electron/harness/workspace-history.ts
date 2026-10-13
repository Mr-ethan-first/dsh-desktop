/**
 * 工作空间历史目录的持久化存储。
 *
 * 使用 sql.js（SQLite 的纯 WASM 移植，零原生编译依赖）把历史工作目录
 * 存成标准 SQLite 数据库文件：<userData>/workspaces.db
 *
 * 之所以不用 better-sqlite3：本项目当前未安装它，而 Electron 主进程加载
 * 原生模块需要针对运行时的 ABI 重新编译，在 Windows 上易踩坑。sql.js 是
 * 纯 JS + wasm，主进程 Node 模式下会自动加载同目录的 sql-wasm.wasm，
 * 生成的 .db 文件是标准 SQLite 格式，完全满足「历史目录存 SQLite」的需求。
 */
import fs from 'node:fs'
import path from 'node:path'

// electron 只在被真正调用时按需导入：顶部静态 import 'electron' 会让整个
// harness 在无头 Node（评价/单元测试）里无法加载，即使从未用到工作空间历史。
let userDataDirOverride: string | undefined

/** 覆盖 SQLite 落盘目录（无头评估/测试注入 fake userData，隔离真实环境）。 */
export function setWorkspacesDbDir(dir: string): void {
  userDataDirOverride = dir
  dbPromise = null
}

/** 数据库里多保留一些，UI 取前 N 条展示。 */
const MAX_STORED = 50

async function userDataDir(): Promise<string> {
  if (userDataDirOverride) return userDataDirOverride
  const { app } = await import('electron')
  return app.getPath('userData')
}

let dbPromise: Promise<{ db: import('sql.js').Database; dir: string } | null> | null = null
let sqlJsModule: typeof import('sql.js') | null | undefined
let sqlInitError: Error | null = null

/** 惰性加载 sql.js；缺失打包（纯 js/wasm 运行时可选依赖）时返回 null，工作区历史降级为禁用，绝不让整个 harness 启动失败。 */
async function resolveSqlJs(): Promise<typeof import('sql.js') | null> {
  if (sqlJsModule !== undefined) return sqlJsModule
  try {
    sqlJsModule = await import('sql.js')
  } catch (e) {
    sqlInitError = e as Error
    sqlJsModule = null
    console.error('[workspace-history] sql.js 不可用，工作区历史降级为禁用：', (e as Error)?.message || e)
  }
  return sqlJsModule
}

async function getDb(): Promise<{ db: import('sql.js').Database; dir: string } | null> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const mod = await resolveSqlJs()
      if (!mod || sqlInitError) return null
      const dir = await userDataDir()
      const file = path.join(dir, 'workspaces.db')
      const SQL = await mod.default()
      let db: import('sql.js').Database
      if (fs.existsSync(file)) {
        db = new SQL.Database(fs.readFileSync(file))
      } else {
        db = new SQL.Database()
      }
      db.run(
        'CREATE TABLE IF NOT EXISTS workspaces (path TEXT PRIMARY KEY, last_used INTEGER NOT NULL)',
      )
      return { db, dir }
    })()
  }
  return dbPromise
}

function save(db: import('sql.js').Database, dir: string): void {
  fs.writeFileSync(path.join(dir, 'workspaces.db'), Buffer.from(db.export()))
}

export async function getRecentWorkspaces(limit = 10): Promise<string[]> {
  const g = await getDb()
  if (!g) return []
  const { db } = g
  const res = db.exec(`SELECT path FROM workspaces ORDER BY last_used DESC LIMIT ${Number(limit)}`)
  if (!res.length) return []
  const col = res[0].columns.indexOf('path')
  return res[0].values.map((row: unknown[]) => String(row[col])).filter(Boolean)
}

export async function addWorkspace(dir: string): Promise<string[]> {
  const d = String(dir || '').trim()
  if (!d) return getRecentWorkspaces()
  const g = await getDb()
  if (!g) return []
  const { db, dir: baseDir } = g
  db.run(
    'INSERT INTO workspaces (path, last_used) VALUES (?, ?) ' +
      'ON CONFLICT(path) DO UPDATE SET last_used = excluded.last_used',
    [d, Date.now()],
  )
  save(db, baseDir)
  return getRecentWorkspaces()
}

export async function removeWorkspace(dir: string): Promise<string[]> {
  const d = String(dir || '').trim()
  if (!d) return getRecentWorkspaces()
  const g = await getDb()
  if (!g) return []
  const { db, dir: baseDir } = g
  db.run('DELETE FROM workspaces WHERE path = ?', [d])
  save(db, baseDir)
  return getRecentWorkspaces()
}