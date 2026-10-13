/**
 * 启动链验证：用 electron/main.cjs 同款参数拉起 dsh web，确认能稳定 listen 并响应 HTTP。
 * 不消耗任何 LLM 调用额度。
 */
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'

const EXE = 'D:/DeepSeekAgent/DeepSeekAgent.exe'
const CLI = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'
const DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home'
const LOG = 'D:/WorkSpace/deepseek-harness-master/_tmp_boot_verify.log'
const PORT = 5301

const readMachineEnv = (n) => {
  try { return execSync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${n}','Machine')"`, { encoding: 'utf8' }).trim() } catch { return '' }
}

// 先释放端口
try {
  const out = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8' })
  for (const line of out.split('\n')) {
    const t = line.trim().split(/\s+/)
    if (t.length >= 5 && /LISTENING/i.test(t[3])) {
      try { execSync(`taskkill /PID ${t[4]} /T /F`, { stdio: 'ignore' }); console.log('释放端口, 杀 PID', t[4]) } catch {}
    }
  }
} catch {}

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME, AI_DASHSCOPE_API_KEY: readMachineEnv('AI_DASHSCOPE_API_KEY'), CODEBUDDY_SAFE_DELETE_ENABLED: '0' }
delete env.NODE_OPTIONS

const fd = fs.openSync(LOG, 'w')
// 与 main.cjs 完全一致的参数次序
const child = spawn(EXE, ['--expose-internals', CLI, 'web', '--port', String(PORT), '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let token = null
let fatal = null
const onData = (d) => {
  const s = d.toString()
  fs.writeSync(fd, s)
  const m = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_.%-]+)/.exec(s)
  if (m && !token) { token = m[1]; console.log('TOKEN:', token) }
  if (/Error:|EADDRINUSE|expose-internals/.test(s)) fatal = (fatal || '') + s.slice(0, 200)
}
child.stdout.on('data', onData)
child.stderr.on('data', onData)
let exitCode = null
child.on('exit', (c) => { exitCode = c; console.log('child exit=', c) })

const deadline = Date.now() + 180000
while (Date.now() < deadline && !token && exitCode === null) await new Promise((r) => setTimeout(r, 1000))

/** 单次 GET；autoFollow=true 时跟随 3xx（带 cookie），返回最终响应体。 */
function getOnce(url, { cookie = '', follow = true } = {}) {
  return new Promise((res) => {
    const req = http.get(url, { headers: cookie ? { cookie } : {} }, (rs) => {
      const sc = rs.headers['set-cookie']
      const nextCookie = sc ? sc.map((c) => c.split(';')[0]).join('; ') : cookie
      if (follow && rs.statusCode >= 300 && rs.statusCode < 400 && rs.headers.location) {
        rs.resume()
        const next = new URL(rs.headers.location, url).toString()
        return res(getOnce(next, { cookie: nextCookie, follow: true }))
      }
      let b = ''
      rs.on('data', (c) => (b += c))
      rs.on('end', () => res({ status: rs.statusCode, len: b.length, body: b, cookie: nextCookie }))
    })
    req.on('error', (e) => res({ status: 0, err: e.message }))
    req.setTimeout(15000, () => { req.destroy(); res({ status: 0, err: 'timeout' }) })
  })
}

let httpOk = false
if (token && exitCode === null) {
  // 连续探测 3 次确认稳定（首页会 303 -> 静态资源，跟随重定向拿真实 HTML）
  for (let i = 0; i < 3; i++) {
    const r = await getOnce(token)
    const hasHtml = typeof r.body === 'string' && /<html|<!doctype html|<div id=/i.test(r.body)
    const hasBoot = typeof r.body === 'string' && /__DSH_BOOT__|dsh/i.test(r.body)
    console.log(`HTTP 探测 #${i + 1}: status=${r.status} len=${r.len} html=${hasHtml} dshBoot=${hasBoot}${r.err ? ' err=' + r.err : ''}`)
    if (r.status === 200 && r.len > 100 && hasHtml) httpOk = true
    await new Promise((r2) => setTimeout(r2, 1500))
  }
}

console.log('\n=== 结论 ===')
console.log('token 捕获:', !!token)
console.log('进程存活:', exitCode === null)
console.log('HTTP 可访问:', httpOk)
if (fatal) console.log('错误片段:', fatal.slice(0, 400))
try {
  const logTxt = fs.readFileSync(LOG, 'utf8')
  const bad = logTxt.split('\n').filter((l) => /plugin tree failed|Cannot find package|ERR_MODULE_NOT_FOUND|EADDRINUSE/i.test(l))
  console.log('启动日志致命错误行数:', bad.length)
  for (const l of bad.slice(0, 5)) console.log('  !', l.slice(0, 220))
} catch {}

try { child.kill('SIGKILL') } catch {}
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {}
setTimeout(() => process.exit(token && httpOk ? 0 : 1), 800)
