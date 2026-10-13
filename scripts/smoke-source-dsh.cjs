/**
 * Quick source verification: run dsh web directly from apps/cli (built source)
 * with a proper DSH_HOME prepared by the production launcher.
 *
 * This validates the source code path (compile + boot) without waiting for the
 * 519M runtime-closure copy or electron-builder.
 *
 * Run: SMOKE_PORT=5296 SMOKE_HOME=D:/_tmp_smoke_src2 node scripts/smoke-source-dsh.cjs
 */
const http = require('node:http')
const { resolve } = require('node:path')
const { prepareDshHome, resolveDshLaunch, spawnDshWeb } = require('../apps/agent-client/electron/plugin-host/dsh-web-launcher.cjs')

const PORT = process.env.SMOKE_PORT || '5296'
const HOME = process.env.SMOKE_HOME || 'D:/_tmp_smoke_src2'
const EXT = resolve('packages/extensions')
const CLI = resolve('apps/cli')

const launch = resolveDshLaunch({ cliDir: CLI })
if (!launch) {
  console.error('[smoke-src] FATAL: cannot resolve dsh launch from apps/cli')
  process.exit(2)
}
console.log(`[smoke-src] bin=${launch.bin} nodeArgs=${JSON.stringify(launch.nodeArgs)}`)

prepareDshHome({ extensionsDir: EXT, dshHome: HOME, profileName: 'web' })
console.log(`[smoke-src] DSH_HOME=${HOME} prepared with community plugins from ${EXT}`)

const child = spawnDshWeb({
  bin: launch.bin,
  nodeArgs: launch.nodeArgs,
  port: PORT,
  dshHome: HOME,
  extensionsDir: EXT,
  profileName: 'web',
  onLog: (msg) => process.stdout.write(msg + '\n'),
})

if (!child) {
  console.error('[smoke-src] FATAL: spawnDshWeb returned null')
  process.exit(2)
}

let out = ''
if (child.stdout) child.stdout.on('data', (b) => { out += b.toString() })
if (child.stderr) child.stderr.on('data', (b) => { out += b.toString() })

let done = false
function finish(code, msg) {
  if (done) return
  done = true
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  console.log(`\n[smoke-src] ${msg}`)
  setTimeout(() => process.exit(code), 200)
}

const MISSING_RE = /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/
const BOOT_RE = /(token=|Local:\s*http|http:\/\/localhost)/i

const start = Date.now()
const timer = setInterval(() => {
  if (MISSING_RE.test(out)) {
    clearInterval(timer)
    finish(3, 'FAILED: source runtime missing module at boot')
  }
  if (BOOT_RE.test(out)) {
    const url = `http://localhost:${PORT}/`
    http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        clearInterval(timer)
        const ok = res.statusCode >= 200 && res.statusCode < 500
        finish(ok ? 0 : 4, `source boot OK — HTTP ${res.statusCode}, ${body.length} bytes served`)
      })
    }).on('error', (e) => {
      clearInterval(timer)
      finish(5, `HTTP probe failed: ${e.message}`)
    })
    return
  }
  if (Date.now() - start > 90000) {
    clearInterval(timer)
    finish(6, 'TIMEOUT: no boot URL within 90s')
  }
}, 500)

child.on('exit', (c) => {
  if (!done) {
    clearInterval(timer)
    finish(7, `dsh process exited early (code=${c}) before boot`)
  }
})
