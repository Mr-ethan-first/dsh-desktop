/**
 * Harness 应用配置。
 *
 * 从环境变量和 .env 文件中读取配置，提供类型安全的配置对象。
 * 遵循 harness 约定：配置在加载时验证，失败立即报错。
 */
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import type { McpServerConfig } from './mcp.js'
import type { PermissionLevel } from './tools/fs-tools.js'

export type PersistenceType = 'sqlite' | 'file' | 'memory'

export interface HarnessConfig {
  /** DSH 主目录，用于存储会话、技能、设置等。 */
  dshHome: string
  /** 默认工作目录。 */
  workDir: string
  /** 文件系统工具默认权限等级（read / write / execute）。 */
  permission?: PermissionLevel
  /** DeepSeek API Key。 */
  apiKey: string
  /** DeepSeek API Base URL。 */
  baseUrl: string
  /** 默认模型名称。 */
  model: string
  /** LLM 请求最小间隔（毫秒），用于限流；0 / 不传表示不限速。 */
  rateLimitMs?: number
  /** 最大并行工具调用数。 */
  maxParallelToolCalls: number
  /** MCP 服务器配置列表。 */
  mcpServers: McpServerConfig[]
  /** 持久化类型：sqlite / file / memory */
  persistenceType: PersistenceType
  /** SQLite 数据库路径（仅当 persistenceType=sqlite 时有效） */
  sqlitePath: string
  /** 会话持久化目录（仅当 persistenceType=file 时有效） */
  sessionsDir: string
  /** 是否在启动时自动加载持久化会话 */
  autoLoadSessions: boolean
}

/** 原生内置 DeepSeek：端点与默认模型对齐 dsh-llm-deepseek；不内置任何 API Key，Key 一律由用户配置（环境变量 / 应用内设置）。 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-v4-flash'
const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 4

/** 解析 DSH_HOME 路径，支持 ~ 展开。 */
function resolveDshHome(value: string | undefined): string {
  if (value && value.trim()) {
    const expanded = value.replace(/^~/, homedir())
    return resolve(expanded)
  }
  return resolve(homedir(), '.deepseek-harness')
}

/**
 * 加载并验证 harness 配置。
 * 配置来源：环境变量 > .env 文件 > 默认值
 * @throws 如果必填字段缺失或无效则抛出错误。
 */
export function loadHarnessConfig(env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const dshHome = resolveDshHome(env.DSH_HOME)
  const workDir = env.WORK_DIR ? resolve(env.WORK_DIR) : process.cwd()

  // 默认权限等级：允许文件读写与执行（本地开发智能体的合理默认）；
  // 可通过环境变量 HARNESS_PERMISSION 覆盖为 read / write。
  const permEnv = (env.HARNESS_PERMISSION || '').trim()
  const permission: PermissionLevel =
    permEnv === 'read' || permEnv === 'write' || permEnv === 'execute' ? permEnv : 'execute'

  // 默认走原生 DeepSeek 官方端点；Key 只来自用户配置（环境变量，无内建兜底）。
  // 历史 ZHIPU_* 变量继续作为可选覆盖：显式设置了 ZHIPU_API_KEY 时才整组切到该服务商。
  const deepseekKey = (env.DEEPSEEK_API_KEYS || env.DEEPSEEK_API_KEY || env.DSH_API_KEY || '')
    .split(',')[0]
    ?.trim()
  const zhipuKey = (env.ZHIPU_API_KEYS || env.ZHIPU_API_KEY || '').split(',')[0]?.trim()
  const apiKey = deepseekKey || zhipuKey || ''
  const baseUrl = deepseekKey
    ? (env.DEEPSEEK_BASE_URL || env.DSH_BASE_URL || DEFAULT_BASE_URL)
    : zhipuKey
      ? (env.ZHIPU_API_BASE || 'https://open.bigmodel.cn/api/paas/v4')
      : (env.DEEPSEEK_BASE_URL || env.DSH_BASE_URL || DEFAULT_BASE_URL)
  const model = deepseekKey
    ? (env.DEEPSEEK_MODEL || env.DSH_MODEL || DEFAULT_MODEL)
    : zhipuKey
      ? ((env.ZHIPU_PRIMARY_MODEL || env.ZHIPU_MODEL || '').split(',')[0]?.trim() || DEFAULT_MODEL)
      : (env.DEEPSEEK_MODEL || env.DSH_MODEL || DEFAULT_MODEL)

  const maxParallelStr = env.DSH_MAX_PARALLEL_TOOL_CALLS
  const maxParallelToolCalls = maxParallelStr
    ? parseInt(maxParallelStr, 10)
    : DEFAULT_MAX_PARALLEL_TOOL_CALLS

  if (!Number.isInteger(maxParallelToolCalls) || maxParallelToolCalls < 1) {
    throw new Error('DSH_MAX_PARALLEL_TOOL_CALLS must be a positive integer')
  }

  // LLM 限流：默认 60000ms（≤1 次/60s），可通过环境变量覆盖；0 / 负值表示关闭。
  const rateLimitRaw = env.DSH_RATE_LIMIT_MS
  const rateLimitMs =
    rateLimitRaw !== undefined && rateLimitRaw !== ''
      ? Math.max(0, parseInt(rateLimitRaw, 10) || 0)
      : 60_000

  // 持久化配置：默认 SQLite（sql.js 实现，纯 WASM 已在打包中分发）；可覆盖为 file / memory
  const persistenceType = (env.DSH_PERSISTENCE as PersistenceType) || 'sqlite'
  const sqlitePath = env.DSH_SQLITE_PATH || join(dshHome, 'sessions.db')
  const sessionsDir = env.DSH_SESSIONS_DIR || join(dshHome, 'sessions')
  const autoLoadSessions = env.DSH_AUTO_LOAD_SESSIONS !== 'false'

  return {
    dshHome,
    workDir,
    permission,
    apiKey,
    baseUrl,
    model,
    rateLimitMs,
    maxParallelToolCalls,
    mcpServers: resolveMcpServers(env),
    persistenceType,
    sqlitePath,
    sessionsDir,
    autoLoadSessions,
  }
}

/**
 * 从环境变量或本地文件解析 MCP 服务器列表。
 *
 * 来源优先级（前者覆盖后者）：
 * 1. 环境变量 `DSH_MCP_SERVERS`：JSON 数组字符串。便于在 exe 旁通过启动脚本注入。
 * 2. 文件 `mcp-servers.json`：依次尝试
 *    - `<cwd>/config/mcp-servers.json`（开发约定目录）
 *    - `<cwd>/mcp-servers.json`
 *    - `<exe 同级>/mcp-servers.json`（分发 exe 时放在 exe 旁边）
 *
 * 每条记录需包含 `id` / `name` / `url` / `enabled`，缺字段将被忽略并告警。
 * 解析失败时返回空数组，不影响主程序启动。
 */
export function resolveMcpServers(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): McpServerConfig[] {
  const fromEnv = parseMcpServersFromText(env.DSH_MCP_SERVERS)
  if (fromEnv) return fromEnv

  const candidates = [
    join(cwd, 'config', 'mcp-servers.json'),
    join(cwd, 'mcp-servers.json'),
    join(dirname(process.execPath), 'mcp-servers.json'),
  ]

  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const parsed = parseMcpServersFromText(readFileSync(file, 'utf8'))
      if (parsed) return parsed
    } catch (e) {
      console.error(`[config] 读取 MCP 配置文件 ${file} 失败，已忽略：`, e)
    }
  }

  return []
}

/** 把一段文本（JSON 字符串或文件内容）解析为 McpServerConfig[]；非法返回 null。 */
function parseMcpServersFromText(raw: string | undefined): McpServerConfig[] | null {
  if (!raw || !raw.trim()) return null
  try {
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return null
    const result: McpServerConfig[] = []
    for (const item of data) {
      if (
        item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.url === 'string'
      ) {
        result.push({
          id: item.id,
          name: item.name,
          url: item.url,
          enabled: item.enabled !== false,
          headers: item.headers && typeof item.headers === 'object' ? item.headers : undefined,
        })
      } else {
        console.warn('[config] 跳过非法 MCP 服务器配置项：', item)
      }
    }
    return result
  } catch (e) {
    console.error('[config] 解析 MCP 服务器配置失败：', e)
    return null
  }
}
