#!/usr/bin/env node
/**
 * DeepSeek 智能体客户端 · exe 全功能自动化测试（无头）
 *
 * 流程：
 *   1. （可选）构建 harness 类型产物 (tsc) → 构建前端 (vite) → 打包 exe (dir + nsis)
 *   2. 启动内置 mock MCP 服务器（streamable-http），模拟办公自动化服务
 *   3. 以无头模式启动 exe，通过 DSH_MCP_SERVERS 注入 mock 服务器
 *   4. 轮询 /healthz 直到 harness 就绪，断言 MCP 配置已注入
 *   5. 功能验证：通过 /test/mcp/call 真实调用 mock 工具，断言请求参数正确回传
 *   6. 关闭 exe，输出 PASS / FAIL
 *
 * 选项 / 环境变量：
 *   --no-pack              跳过构建与打包，直接测已存在的 exe
 *   DSH_TEST_OFFICE=1      额外要求至少一个外部办公 MCP 服务器 connected=true（需先 pnpm office:mcp:start）
 *   DSH_FUNCTIONAL=0       跳过内置 mock 功能测试（仅做冒烟）
 *   DSH_EXPECT_MCP=N       期望注入的 MCP 服务器数量（默认按运行时推断）
 *
 * 说明：本脚本所有断言失败均输出明确原因，不会"没 bug 就当通过"。
 */
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = 5183
const MOCK_PORT = 8799
const noPack = process.argv.includes('--no-pack')
const testOffice = process.env.DSH_TEST_OFFICE === '1'
const functional = process.env.DSH_FUNCTIONAL !== '0'

function log(...a) {
  console.log('[automated-test-exe]', ...a)
}
function step(n, msg) {
  console.log(`\n[${n}/6] ${msg}`)
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts })
  if (r.error || (r.status !== 0 && !opts.allowFail)) {
    throw new Error(`${cmd} 失败: ${r.error?.message ?? 'exit ' + r.status}`)
  }
  return r
}

function findExe() {
  // 候选目录（含本地绕过监控软件锁的临时输出目录）；返回 mtime 最新的 exe，避免选中旧包。
  // 注意：Windows 下 path.join(ROOT, 'D:/tmp/eb-out') 不会把第二个参数当绝对路径，
  // 会拼成 `ROOT/D:/tmp/eb-out`（不存在）。绝对路径需直接采用，否则用 ROOT 拼接。
  // 注意：dir 目标产出的真实 exe 位于 release/win-unpacked/ 下（已在候选目录中）；
  // win-unpacked/resources/app 是诊断用的 trivial app，不能选它，这里按 mtime 选最新的真实 exe。
  const dirs = ['release-build', 'release', 'release/win-unpacked', 'D:/tmp/eb-out']
  let best = null
  let bestTime = -1
  for (const dirName of dirs) {
    const dir = path.isAbsolute(dirName) ? dirName : path.join(ROOT, dirName)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.exe')) continue
      const fp = path.join(dir, f)
      try {
        const m = fs.statSync(fp).mtimeMs
        if (m > bestTime) {
          bestTime = m
          best = fp
        }
      } catch {
        /* 忽略无法 stat 的文件 */
      }
    }
  }
  return best
}

/** 启动一个实现了 MCP streamable-http 子集的 mock 服务器，用于离线全链路功能验证。 */
function startMockMcpServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end()
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        let rpc
        try {
          rpc = JSON.parse(body || '{}')
        } catch {
          res.statusCode = 400
          res.end()
          return
        }
        const id = rpc.id
        // 通知类（如 notifications/initialized）无需响应体
        if (typeof rpc.method === 'string' && rpc.method.startsWith('notifications/')) {
          res.statusCode = 202
          res.end()
          return
        }
        let result
        if (rpc.method === 'initialize') {
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'mock-office', version: '1.0' },
          }
        } else if (rpc.method === 'tools/list') {
          result = {
            tools: [
              {
                name: 'echo_tool',
                description: '回显输入参数，供自动化测试断言',
                inputSchema: {
                  type: 'object',
                  properties: { msg: { type: 'string' } },
                  required: ['msg'],
                },
              },
            ],
          }
        } else if (rpc.method === 'tools/call') {
          const params = rpc.params || {}
          result = {
            content: [
              { type: 'text', text: 'ECHO:' + JSON.stringify(params.arguments || {}) },
            ],
            isError: false,
          }
        } else {
          // 未知方法返回空结果，避免客户端抛错中断握手
          result = {}
        }
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.statusCode = 200
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
      })
    })
    server.listen(MOCK_PORT, () => {
      log(`mock MCP server 监听 http://127.0.0.1:${MOCK_PORT}/mcp`)
      resolve(server)
    })
  })
}

function healthz() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/healthz`, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(d))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(1500, () => {
      req.destroy()
      resolve(null)
    })
  })
}

function postJson(pathname, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d) })
          } catch {
            resolve({ status: res.statusCode, body: null })
          }
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(8000, () => {
      req.destroy()
      reject(new Error('call timeout'))
    })
    req.write(data)
    req.end()
  })
}

async function waitReady(timeoutMs) {
  const end = Date.now() + timeoutMs
  let last = null
  while (Date.now() < end) {
    last = await healthz()
    if (last?.harness?.ready) return last
    await new Promise((r) => setTimeout(r, 1000))
  }
  return last
}

const failReasons = []
function assert(cond, msg) {
  if (cond) {
    log('  ✓', msg)
  } else {
    log('  ✗', msg)
    failReasons.push(msg)
  }
}

async function main() {
  const mockServer = functional ? await startMockMcpServer() : null

  if (!noPack) {
    step(1, '构建 harness 类型产物 (tsc)')
    run('npx', ['tsc', '-p', 'electron/harness/tsconfig.json'])
    step(2, '构建前端 (vite build)')
    run('npx', ['vite', 'build'])
    step(3, '打包 exe (electron-builder: dir + nsis)')
    run('npx', ['electron-builder', '--win', 'dir', 'nsis', '--publish', 'never'])
  } else {
    step(1, '跳过构建/打包 (--no-pack)')
  }

  const exe = findExe()
  if (!exe) throw new Error('未找到 release 下的 exe，请先打包 (dir 目标在 release/win-unpacked)')
  step(4, `启动 exe（无头）: ${path.basename(exe)}`)

  const mcpServers = [
    { id: 'mock-office', name: 'Mock Office（自动化测试）', url: `http://127.0.0.1:${MOCK_PORT}/mcp` },
  ]
  const env = { ...process.env }
  // 关键修复：本机可能由 ICUBE/TRAE 等工具注入 ELECTRON_RUN_AS_NODE=1，
  // 这会导致 electron 二进制以纯 Node 模式运行（require('electron') 失败、app 完全不加载）。
  // 自动化测试前必须清除该变量，使 exe 以真实 electron 进程启动。
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ICUBE_ELECTRON_PATH
  env.DSH_MCP_SERVERS = JSON.stringify(mcpServers)
  if (!env.DEEPSEEK_API_KEY && !env.DSH_NO_KEY) {
    env.DEEPSEEK_API_KEY = 'dummy-for-build-test'
  }
  // 自动化测试默认无头（不弹窗口）；设 DSH_SHOW_WINDOW=1 可显示窗口
  if (!env.DSH_SHOW_WINDOW) env.DSH_HEADLESS = '1'

  const child = spawn(exe, [], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })

  let status = null
  try {
    step(5, '等待 /healthz 就绪（最多 120s）并断言配置注入')
    status = await waitReady(120000)
    if (!status) {
      failReasons.push('/healthz 无响应或 harness 未就绪（exe 可能启动失败）')
    } else if (status.harness?.error) {
      failReasons.push('harness 初始化报错: ' + status.harness.error)
    } else {
      log('healthz:', JSON.stringify(status, null, 2))
    }

    // 断言 1：MCP 配置已注入
    const injected = status?.mcpServers ?? []
    const count = injected.length
    const expected = Number(
      process.env.DSH_EXPECT_MCP || (functional ? 1 : 0),
    )
    assert(count >= expected, `MCP 配置已注入（${count} 个 ≥ 期望 ${expected}）`)
    if (functional && status) {
      const mock = injected.find((s) => s.id === 'mock-office')
      assert(!!mock, '注入的服务器包含 mock-office')
      assert(!!mock && mock.connected === true, 'mock-office 已成功连接（connected=true）')
      assert(!!mock && mock.toolCount >= 1, `mock-office 工具发现数 ≥ 1（实际 ${mock?.toolCount}）`)
    }

    if (testOffice) {
      const connected = injected.filter((s) => s.connected).length
      assert(connected >= 1, `外部办公 MCP 已连接（${connected} 个）`)
    }

    // 步骤 6：功能验证 —— 真实调用工具，断言全链路
    if (functional && status) {
      step(6, '功能验证：通过 /test/mcp/call 真实调用 MCP 工具')
      const callRes = await postJson('/test/mcp/call', {
        serverId: 'mock-office',
        tool: 'echo_tool',
        args: { msg: 'office-automation-e2e' },
      })
      assert(callRes.status === 200, `/test/mcp/call 返回 200（实际 ${callRes.status}）`)
      assert(
        callRes.body?.ok === true,
        `/test/mcp/call 业务成功（body.ok=${callRes.body?.ok}）`,
      )
      const text = callRes.body?.content?.map((c) => c.text || '').join('') || ''
      assert(
        text.includes('office-automation-e2e'),
        `工具调用回传参数正确（回传内容含 'office-automation-e2e'）`,
      )
    }
  } catch (e) {
    failReasons.push('测试执行异常: ' + (e?.message || String(e)))
  } finally {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
      } else {
        process.kill(-child.pid, 'SIGKILL')
      }
    } catch {
      /* 忽略清理失败 */
    }
    if (mockServer) {
      try {
        mockServer.close()
      } catch {
        /* 忽略 */
      }
    }
  }

  // 把结论同时写到文件，避免 process.exit 截断管道 stdout 导致丢失 RESULT 行
  const resultLine = failReasons.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL'
  const summary = [
    resultLine,
    failReasons.length ? '失败原因:' : '全部断言通过',
    ...failReasons.map((r) => '  - ' + r),
  ].join('\n')
  console.log('\n' + summary)
  try {
    fs.writeFileSync(path.join(ROOT, 'scripts', '.exe-test-result.txt'), summary + '\n')
  } catch {
    /* 忽略写文件失败 */
  }
  // 用 exitCode 自然退出，确保 stdout 全部冲刷
  process.exitCode = failReasons.length === 0 ? 0 : 1
}

main().catch((e) => {
  const msg = 'ERROR: ' + e.message
  console.error(msg)
  try {
    fs.writeFileSync(path.join(ROOT, 'scripts', '.exe-test-result.txt'), msg + '\n')
  } catch {
    /* ignore */
  }
  process.exitCode = 1
})
