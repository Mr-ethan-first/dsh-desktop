/**
 * 启动办公自动化 MCP 服务（stdio → streamable-http 桥接）。
 *
 * 设计：本 exe 仅支持 HTTP(JSON-RPC) 形态的 MCP（见 electron/harness/mcp.ts）。
 * - Excel：excel-mcp-server 原生支持 streamable-http，直接以 uvx 拉起。
 * - Word / PowerPoint：mcp-office 仅支持 stdio，用 supergateway 桥接为 streamable-http。
 *
 * 启动后三个服务分别监听：
 *   Excel      http://127.0.0.1:8017/mcp
 *   Word       http://127.0.0.1:8020/mcp
 *   PowerPoint http://127.0.0.1:8021/mcp
 *
 * 然后在客户端配置（DSH_MCP_SERVERS 或 mcp-servers.json）指向上述地址即可。
 *
 * 前置依赖：
 *   - uv / uvx（https://github.com/astral-sh/uv）
 *   - python + pip install mcp-office（Word/PPT，需要 Windows + Python 3.11+）
 *   - npx（随 node 提供）；supergateway 会经 npx 自动拉取
 *
 * 环境变量（均可选）：
 *   OFFICE_ROOT  办公文件根目录（默认当前目录）。会作为各服务的 allowlist 根。
 *   EXCEL_PORT / WORD_PORT / PPT_PORT  各自监听端口。
 */
import { spawn } from 'node:child_process'

const OFFICE_ROOT = process.env.OFFICE_ROOT || process.cwd()
const EXCEL_PORT = process.env.EXCEL_PORT || '8017'
const WORD_PORT = process.env.WORD_PORT || '8020'
const PPT_PORT = process.env.PPT_PORT || '8021'

/** 启动一个子进程并记录日志，返回 child 以便统一退出。 */
function start(name, command, args, env) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d) => process.stdout.write(`[${name}] ${d}`))
  child.stderr?.on('data', (d) => process.stderr.write(`[${name}] ${d}`))
  child.on('error', (e) => console.error(`[${name}] 启动失败：${e.message}`))
  child.on('exit', (code) => console.log(`[${name}] 已退出，code=${code}`))
  return child
}

const children = []

// Excel：原生 streamable-http
children.push(
  start(
    'excel',
    'uvx',
    ['excel-mcp-server', 'streamable-http'],
    {
      EXCEL_FILES_PATH: `${OFFICE_ROOT}/excel_files`,
      FASTMCP_PORT: EXCEL_PORT,
    },
  ),
)

// Word：stdio → streamable-http（supergateway 桥接）
children.push(
  start(
    'word',
    'npx',
    [
      '-y', 'supergateway',
      '--stdio', 'python -m wordmcp.server',
      '--outputTransport', 'streamableHttp',
      '--port', WORD_PORT,
      '--stateful',
    ],
    {
      WORD_ALLOWLIST_ROOTS: OFFICE_ROOT,
      WORD_ENABLE_WRITE: 'true',
    },
  ),
)

// PowerPoint：stdio → streamable-http（supergateway 桥接）
children.push(
  start(
    'ppt',
    'npx',
    [
      '-y', 'supergateway',
      '--stdio', 'python -m pptmcp.server',
      '--outputTransport', 'streamableHttp',
      '--port', PPT_PORT,
      '--stateful',
    ],
    {
      PPT_ALLOWLIST_ROOTS: OFFICE_ROOT,
      PPT_ENABLE_WRITE: 'true',
    },
  ),
)

console.log('办公 MCP 服务启动中（Excel/Word/PowerPoint）…  Ctrl+C 停止全部。')
console.log(
  `端点：Excel http://127.0.0.1:${EXCEL_PORT}/mcp | Word http://127.0.0.1:${WORD_PORT}/mcp | PPT http://127.0.0.1:${PPT_PORT}/mcp`,
)

function shutdown() {
  for (const c of children) {
    try {
      c.kill()
    } catch {
      /* 忽略 */
    }
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
