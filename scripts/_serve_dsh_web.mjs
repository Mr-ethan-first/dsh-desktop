/**
 * 常驻启动 dsh web（供 UI 调试复用，避免每次重跑都要等启动）。
 * 用法：node scripts/_serve_dsh_web.mjs [port]
 * 就绪后把 token URL 写到 D:/WorkSpace/deepseek-harness-master/_tmp_dsh_token.txt
 */
import { createRequire } from 'node:module'
import { spawn, execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const EXE_ROOT = 'D:/DeepSeekAgent'
const DSH_DIR = path.join(EXE_ROOT, 'resources', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh')
const LAUNCHER = path.join(EXE_ROOT, 'resources', 'app.asar.unpacked', 'electron', 'plugin-host', 'dsh-web-launcher.cjs')
const DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home'
const PORT = Number(process.argv[2] || 5285)
const TOKEN_FILE = 'D:/WorkSpace/deepseek-harness-master/_tmp_dsh_token.txt'
const LOG = 'D:/WorkSpace/deepseek-harness-master/_tmp_dsh_serve.log'

const require2 = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/noop.js')
const launcher = require2(LAUNCHER)

const readMachineEnv = (n) => {
  try {
    return execSync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${n}','Machine')"`, { encoding: 'utf8' }).trim()
  } catch { return '' }
}

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME, CODEBUDDY_SAFE_DELETE_ENABLED: '0' }
delete env.NODE_OPTIONS
// settings.yaml 里的 provider 通过 apiKeyEnv 取 key，必须在子进程环境里可见
const KEY = readMachineEnv('AI_DASHSCOPE_API_KEY')
if (KEY) { env.AI_DASHSCOPE_API_KEY = KEY; console.log('injected AI_DASHSCOPE_API_KEY len=' + KEY.length) }
else console.log('WARN: AI_DASHSCOPE_API_KEY 未取到')

const launch = launcher.resolveDshLaunch({ cliDir: DSH_DIR })
const fd = fs.openSync(LOG, 'w')
let tokenUrl = null
const child = launcher.spawnDshWeb({
  bin: launch.bin,
  nodeArgs: ['--expose-internals', ...(launch.nodeArgs || [])],
  runtime: path.join(EXE_ROOT, 'DeepSeekAgent.exe'),
  port: PORT,
  dshHome: DSH_HOME,
  extensionsDir: path.join(EXE_ROOT, 'resources', 'packages', 'extensions'),
  baseEnv: env,
  childProcess: { spawn },
  onLog: (s) => {
    try { fs.writeSync(fd, s + '\n') } catch {}
    const m = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_.%-]+)/.exec(s)
    if (m && !tokenUrl) { tokenUrl = m[1]; fs.writeFileSync(TOKEN_FILE, tokenUrl); console.log('READY', tokenUrl) }
  },
})
console.log('spawned pid', child && child.pid, 'port', PORT)
child.on('exit', (c) => console.log('dsh web exit', c))
// 常驻，不主动退出（由外部 taskkill 结束）
setInterval(() => {}, 1 << 30)
