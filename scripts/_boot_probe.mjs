/**
 * 最小 boot 探针：直接用部署运行时的 dsh CLI 起 web，观察是否能正常 listen。
 * 不消耗任何 API 调用（不触发对话）。
 */
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const EXE = 'D:/DeepSeekAgent/DeepSeekAgent.exe'
const CLI = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'
const DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home'
const LOG = 'D:/WorkSpace/deepseek-harness-master/_tmp_boot_probe.log'
const PORT = 5299

const readMachineEnv = (n) => {
  try { return execSync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${n}','Machine')"`, { encoding: 'utf8' }).trim() } catch { return '' }
}

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME, AI_DASHSCOPE_API_KEY: readMachineEnv('AI_DASHSCOPE_API_KEY'), CODEBUDDY_SAFE_DELETE_ENABLED: '0' }
delete env.NODE_OPTIONS

const fd = fs.openSync(LOG, 'w')
const child = spawn(EXE, ['--expose-internals', CLI, 'web', '--port', String(PORT), '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let token = null
const onData = (d) => {
  const s = d.toString()
  fs.writeSync(fd, s)
  const m = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_.%-]+)/.exec(s)
  if (m && !token) { token = m[1]; console.log('TOKEN:', token) }
  if (/Cannot find package|failed to import loader entry/.test(s)) console.log('ERR:', s.trim().slice(0, 300))
}
child.stdout.on('data', onData)
child.stderr.on('data', onData)
child.on('exit', (c) => console.log('exit code=', c))

const deadline = Date.now() + 120000
while (Date.now() < deadline && !token) await new Promise((r) => setTimeout(r, 1000))

if (token) {
  await new Promise((resolve) => {
    http.get(token, (res) => { console.log('HTTP', res.statusCode); res.resume(); res.on('end', resolve) }).on('error', (e) => { console.log('http err', e.message); resolve() })
  })
  console.log('BOOT OK')
} else {
  console.log('BOOT FAILED — 见 ' + LOG)
}
try { child.kill('SIGKILL') } catch {}
setTimeout(() => process.exit(token ? 0 : 1), 500)
