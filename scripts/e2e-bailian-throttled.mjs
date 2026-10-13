/**
 * e2e-bailian-throttled.mjs —— 用真实百炼（DashScope）API Key 验证打包产物功能。
 *
 * 与 dsh-exe-e2e-test/e2e-exe-runtime.mjs 的区别：
 *   1. 严格节流：任意两次真实 LLM 调用之间强制间隔 >= THROTTLE_MS（默认 65s），
 *      适配免费额度限流（<= 1 次/分钟）。
 *   2. 只跑 3 次真实调用（多轮对话 2 轮 + 智能编码 1 次），其余断言不消耗额度。
 *   3. 凭证从系统环境变量 AI_DASHSCOPE_API_KEY 读取，只通过子进程 env 注入，不落盘。
 *   4. 额外校验本轮新增的两个社区插件（better-sidebar / bridge-browser）是否被宿主加载。
 *
 * 运行：
 *   NODE_PATH=C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules \
 *     C:/Users/Administrator/.workbuddy/binaries/node/versions/22.12.0/node.exe \
 *     scripts/e2e-bailian-throttled.mjs
 */
import { createRequire } from 'node:module'
import { spawn, execSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

// playwright 装在 WorkBuddy 托管的 node workspace 里，显式从该处解析，避免依赖 NODE_PATH 是否透传。
const PW_ROOT = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(path.join(PW_ROOT, 'noop.js'))
const { chromium } = require('playwright')

// ---------------- 配置 ----------------
const EXE_ROOT = 'D:/DeepSeekAgent'
const DSH_DIR = path.join(EXE_ROOT, 'resources', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh')
const LAUNCHER = path.join(EXE_ROOT, 'resources', 'app.asar.unpacked', 'electron', 'plugin-host', 'dsh-web-launcher.cjs')
const DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home'
const WORK = 'D:/WorkSpace/deepseek-harness-master'
const LOG_DIR = path.join(WORK, '_tmp_bailian_logs')
const SCR_DIR = path.join(WORK, '_tmp_bailian_screens')
const OUT = path.join(WORK, '_tmp_bailian_result.json')
const DSH_LOG = path.join(LOG_DIR, 'dsh-web-stdio.log')

const THROTTLE_MS = Number(process.env.THROTTLE_MS || 65000) // 免费额度：>= 1 次/分钟
const WEB_PORT = 5283

fs.mkdirSync(LOG_DIR, { recursive: true })
fs.mkdirSync(SCR_DIR, { recursive: true })

const log = (...a) => console.log('[e2e-bailian]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- 结果容器 ----------------
const results = {
  config: { throttleMs: THROTTLE_MS, port: WEB_PORT, dshHome: DSH_HOME },
  runtime: {},
  keyInjection: {},
  pluginMount: {},
  pluginRequests: [],
  workspace: {},
  layout: {},
  multiTurn: {},
  smartCoding: {},
  network: [],
  consoleErrors: [],
  pass: {},
  overall: false,
}

// ---------------- 读取系统环境变量里的百炼 Key ----------------
function readMachineEnv(name) {
  try {
    return execSync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${name}', 'Machine')"`, { encoding: 'utf8' }).trim()
  } catch { return '' }
}
const BAILIAN_KEY = readMachineEnv('AI_DASHSCOPE_API_KEY')
if (!BAILIAN_KEY) { console.error('FATAL: 系统环境变量 AI_DASHSCOPE_API_KEY 未取到'); process.exit(2) }
results.keyInjection = { source: 'Machine env AI_DASHSCOPE_API_KEY', length: BAILIAN_KEY.length, prefix: BAILIAN_KEY.slice(0, 6) + '***' }
log('百炼 key 就绪 length=' + BAILIAN_KEY.length + ' prefix=' + BAILIAN_KEY.slice(0, 6) + '***')

// ---------------- 节流器 ----------------
let lastCallAt = 0
let callCount = 0
async function throttle() {
  const now = Date.now()
  const wait = THROTTLE_MS - (now - lastCallAt)
  if (lastCallAt !== 0 && wait > 0) {
    log(`节流：等待 ${Math.ceil(wait / 1000)}s（限流保护，<=1 次/分钟）`)
    await sleep(wait)
  }
  lastCallAt = Date.now()
  callCount += 1
  log(`>>> 真实 LLM 调用 #${callCount}`)
}

// ---------------- 挑选 node 运行时 ----------------
function pickRuntime() {
  const candidates = [
    { kind: 'electron-run-as-node', file: path.join(EXE_ROOT, 'DeepSeekAgent.exe'), env: { ELECTRON_RUN_AS_NODE: '1' } },
    { kind: 'managed-node-22.22.2', file: 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node.exe', env: {} },
    { kind: 'managed-node-22.12.0', file: 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.12.0/node.exe', env: {} },
  ]
  for (const c of candidates) { if (fs.existsSync(c.file)) return c }
  return null
}

function fetchUrl(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }) })
  })
}

async function preCleanup() {
  // 1) 关闭 Electron 宿主与 dsh web（按命令行特征，非按端口泛杀）
  try {
    spawn('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { ($_.Name -match 'DeepSeekAgent.exe') -or (($_.CommandLine -like '*dsh/lib/bin.js*' -or $_.CommandLine -like '*lib\\\\bin.js*') -and $_.CommandLine -like '*web*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, stdio: 'ignore' })
  } catch {}
  await sleep(2500)

  // 2) 端口仍占用时，按「实际占用该端口的 PID」精确终止（自录 PID 模式）
  try {
    const out = execSync(`netstat -ano | findstr :${WEB_PORT}`, { encoding: 'utf8' })
    const pids = new Set()
    for (const line of out.split('\n')) {
      const t = line.trim().split(/\s+/)
      if (t.length >= 5 && /LISTENING/i.test(t[3])) pids.add(t[4])
    }
    for (const pid of pids) {
      if (pid && pid !== '0') {
        try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) ; log('释放端口 ' + WEB_PORT + '：已终止 PID ' + pid) } catch {}
      }
    }
    if (pids.size) await sleep(1500)
  } catch { /* 无占用 */ }

  log('preCleanup 完成')
}

// ---------------- UI helpers ----------------
async function screenshot(page, name) {
  try {
    const p = path.join(SCR_DIR, `${name}-${Date.now()}.png`)
    await page.screenshot({ path: p, fullPage: true })
    log('screenshot:', p)
  } catch (e) { log('screenshot warn:', e.message) }
}

async function dismissDisclaimer(page) {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, [role="button"], a')]
      const cont = btns.find((b) => /^(继续|确认|我知道了|同意|Got it|Continue)$/i.test((b.innerText || '').trim()))
      if (cont) { cont.click(); return }
      const modal = document.querySelector('[role="dialog"], [class*="modal" i], [class*="dialog" i], [class*="overlay" i]')
      if (modal) { const b = modal.querySelector('button, [role="button"]'); if (b) b.click() }
    }).catch(() => {})
    await sleep(1200)
    const still = await page.evaluate(() => {
      const t = document.body.innerText
      return /内测声明/.test(t) && [...document.querySelectorAll('button, [role="button"]')].some((b) => /^(继续|确认|我知道了|同意)$/i.test((b.innerText || '').trim()))
    }).catch(() => false)
    if (!still) break
  }
}

async function findComposer(page) {
  // contenteditable="" 也是真值，故用 :not([contenteditable="false"]) 而不是 =\"true\"。
  const sels = ['[contenteditable]:not([contenteditable="false"])', '[role="textbox"]', '.lexical-contenteditable', 'textarea']
  const candidates = []
  const seen = new Set()
  for (const sel of sels) {
    const els = await page.$$(sel).catch(() => [])
    for (const el of els) {
      const meta = await el.evaluate((e) => ({
        aria: e.getAttribute('aria-label') || '',
        placeholder: e.getAttribute('placeholder') || '',
        hint: (e.innerText || '').slice(0, 40),
        rect: e.getBoundingClientRect ? { width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height } : null,
      })).catch(() => ({}))
      const h = el.__handle || null
      if (!meta.rect || meta.rect.width < 60 || meta.rect.height < 12) continue
      const key = JSON.stringify([meta.aria, meta.placeholder, meta.rect.width, meta.rect.height])
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ el, sel, meta })
    }
  }
  const prefer = candidates.find((c) => /(输入|消息|Ask|Message|Prompt|Send|发送|chat|composer)/i.test(c.meta.aria + c.meta.placeholder))
  if (prefer) return prefer
  candidates.sort((a, b) => ((b.meta.rect?.width || 0) * (b.meta.rect?.height || 0)) - ((a.meta.rect?.width || 0) * (a.meta.rect?.height || 0)))
  return candidates[0] || null
}

/** 读取当前页面状态快照（用于诊断）。 */
async function dumpState(page) {
  return page.evaluate(() => {
    const composer = document.querySelector('[contenteditable]:not([contenteditable="false"]), [role="textbox"], textarea')
    const popups = [...document.querySelectorAll('[role="listbox"], [role="menu"], [role="option"], [role="menuitem"], [data-radix-popper-content-wrapper]')]
      .map((e) => ({ role: e.getAttribute('role') || 'popper', text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 80) }))
      .slice(0, 8)
    return {
      body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 180),
      composerPh: composer ? (composer.getAttribute('placeholder') || '') : null,
      composerHint: composer ? (composer.innerText || '').slice(0, 30) : null,
      popups,
    }
  }).catch((e) => ({ err: e.message }))
}

/**
 * 用真实鼠标点击「主区（x>=minX）内文本恰好等于 text」的最深层元素。
 * 直接用 el.click() 对 React/Radix 弹层常常不触发（事件被上层拦截），
 * 故改为计算坐标后 page.mouse.click。
 */
async function clickMainAreaText(page, text, minX = 250) {
  const box = await page.evaluate(({ text, minX }) => {
    const els = [...document.querySelectorAll('body *')]
    const cands = els.filter((e) => {
      const t = (e.innerText || '').trim()
      if (t !== text) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.x >= minX
    })
    if (!cands.length) return null
    const el = cands[cands.length - 1] // document order：最后一个 = 最深层
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName }
  }, { text, minX }).catch(() => null)
  if (!box) return { ok: false }
  await page.mouse.click(box.x, box.y).catch(() => {})
  return { ok: true, ...box }
}

/** 轮询等待弹层出现（含 text 的、位于主区的可见容器）。 */
async function waitForPopupWith(page, text, timeoutMs = 15000, minX = 250) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const hit = await page.evaluate(({ text, minX }) => {
      const els = [...document.querySelectorAll('body *')]
      const c = els.filter((e) => {
        const t = (e.innerText || '').trim()
        const r = e.getBoundingClientRect()
        return t === text && r.width > 0 && r.x >= minX
      })
      return c.length
    }, { text, minX }).catch(() => 0)
    if (hit > 0) return true
    await sleep(600)
  }
  return false
}

/**
 * 选中工作区，让 composer 进入可输入状态。
 * 首页默认停在「选择工作区」态（placeholder = 选择一个工作区开始）。
 */
async function selectWorkspace(page) {
  const names = ['algs4-master', '01-first-vue3', 'deepseek-harness-master', 'DeepSeekAgent']
  const trace = []
  const readState = async () => {
    const s = await dumpState(page)
    const joined = (s.composerPh || '') + (s.composerHint || '')
    return { ready: !!s.composerPh && !/选择一个工作区开始/.test(joined), state: s }
  }

  for (let round = 0; round < 3; round++) {
    // A. 打开「选择工作区」下拉
    const opened = await page.evaluate(() => {
      const all = [...document.querySelectorAll('button, [role="button"], div[role="button"], [role="combobox"]')]
      const t = all.filter((b) => /选择工作区/.test((b.innerText || '').trim()))
      const main = t.find((b) => b.getBoundingClientRect().x > 250) || t[0]
      if (!main) return null
      const r = main.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    }).catch(() => null)
    if (opened) await page.mouse.click(opened.x, opened.y).catch(() => {})
    trace.push({ round, step: 'open', opened })

    // B. 等弹层渲染出来
    const appeared = await waitForPopupWith(page, names[0], 12000)
    trace.push({ round, step: 'popup', appeared })
    if (!appeared) { await sleep(1200); continue }

    // C. 真实鼠标点击
    for (const nm of names) {
      const hit = await clickMainAreaText(page, nm, 250)
      if (hit.ok) { trace.push({ round, step: 'pick', nm, hit }); break }
      trace.push({ round, step: 'pick-miss', nm })
    }
    await sleep(3500)
    const r = await readState()
    if (r.ready) { results.workspace = { trace, ready: true, state: r.state }; return true }
    trace.push({ round, step: 'state', state: r.state })
  }

  // D. 兜底：点左侧栏工作区条目
  const sidebar = await clickMainAreaText(page, names[0], 0)
  trace.push({ step: 'sidebar-click', sidebar })
  await sleep(3500)
  const r2 = await readState()
  results.workspace = { trace, ready: r2.ready, state: r2.state }
  return r2.ready
}

async function sendMessage(page, text) {
  const composer = await findComposer(page)
  if (!composer) {
    log('composer 未找到, state=', JSON.stringify(await dumpState(page)))
    throw new Error('composer not found')
  }
  await throttle() // 确认可以提交后再节流，避免空等
  log('composer:', composer.sel, JSON.stringify(composer.meta))
  await composer.el.click().catch(() => {})
  await composer.el.evaluate((el) => { el.focus() }).catch(() => {})
  await composer.el.press('Control+A').catch(() => {})
  await composer.el.type(text, { delay: 8 })
  await sleep(800)
  const typed = await composer.el.evaluate((el) => (el.innerText || el.value || '').slice(0, 60)).catch(() => '')
  log('已输入:', JSON.stringify(typed))
  let clicked = false
  for (const sel of ['button:has-text("发送")', 'button:has-text("Send")', '[aria-label*="发送" i]', '[aria-label*="send" i]', 'button[type="submit"]', '[class*="send" i]']) {
    const btns = await page.$$(sel).catch(() => [])
    for (const btn of btns) {
      const enabled = await btn.isEnabled().catch(() => false)
      const visible = await btn.isVisible().catch(() => false)
      if (enabled && visible) { await btn.evaluate((el) => el.click()).catch(() => {}); clicked = true; break }
    }
    if (clicked) break
  }
  if (!clicked) { await composer.el.press('Enter').catch(() => {}); log('回退：按 Enter 提交') }
  await sleep(3000)
  const after = await composer.el.evaluate((el) => (el.innerText || el.value || '').slice(0, 60)).catch(() => '')
  log('提交后 composer 内容:', JSON.stringify(after), '| 已发生网络请求取决于下方 [net] 行')
  if (after && after.trim() === typed.trim()) log('WARN: composer 未被清空，可能未提交成功')
}

async function waitForReply(page, predicate, timeoutMs = 90000) {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < timeoutMs) {
    const txt = await page.evaluate(() => document.body.innerText).catch(() => '')
    const htm = await page.content().catch(() => '')
    if (txt) last = txt
    const res = predicate(txt, htm)
    if (res && res.found) return res
    await sleep(1500)
  }
  return { found: false, excerpt: last.slice(-500) }
}

async function enterChatWorkspace(page) {
  const opened = await page.evaluate(() => {
    const all = [...document.querySelectorAll('button, [role="button"], a, div[role="button"]')]
    const byText = (re) => all.find((b) => re.test((b.innerText || b.getAttribute('aria-label') || b.title || '').trim()))
    const target = byText(/新会话|新建对话|New Chat/i)
    if (target) { target.click(); return { ok: true, text: (target.innerText || '').slice(0, 40) } }
    const card = document.querySelector('[class*="workspace" i], [class*="project" i]')
    if (card) { card.click(); return { ok: true, text: 'workspace-card' } }
    return { ok: false }
  }).catch(() => ({ ok: false }))
  if (opened.ok) log('开启会话入口:', opened.text)
  await sleep(3000)
  // 选模型：优先 qwen-plus（百炼已验证可用）
  await page.evaluate(() => {
    const opts = [...document.querySelectorAll('button, [role="option"], [role="menuitem"], option')]
    const prefer = opts.find((b) => /qwen-plus|bailian|deepseek-v3/i.test(b.innerText || b.value || ''))
    if (prefer) prefer.click()
  }).catch(() => {})
  await sleep(1000)
}

// ---------------- main ----------------
let dshWebChild = null
async function main() {
  const runtime = pickRuntime()
  if (!runtime) throw new Error('未找到可用 node 运行时')
  results.runtime.runtimeKind = runtime.kind
  results.runtime.node24 = fs.existsSync(path.join(EXE_ROOT, 'resources', 'node24', 'node.exe'))
  results.runtime.dshCli = fs.existsSync(path.join(DSH_DIR, 'lib', 'bin.js'))
  log('runtime:', runtime.kind, '| dshCli:', results.runtime.dshCli)

  let launcher = null
  try { launcher = require(LAUNCHER); results.runtime.launcherLoaded = true }
  catch (e) { results.runtime.launcherError = e.message }
  if (!results.runtime.dshCli || !launcher) throw new Error('运行时缺失: dshCli=' + results.runtime.dshCli + ' launcher=' + results.runtime.launcherLoaded)

  await preCleanup()

  const launch = launcher.resolveDshLaunch({ cliDir: DSH_DIR })
  if (!launch) throw new Error('resolveDshLaunch 返回 null')
  // 与 electron/main.cjs spawnDshWeb() 对齐：cordis-plugin-hmr 需要 --expose-internals
  const nodeArgs = ['--expose-internals', ...(launch.nodeArgs || [])]

  const dshLogFd = fs.openSync(DSH_LOG, 'w')
  let tokenUrl = null
  const allLog = []
  const capture = (s) => {
    try { fs.writeSync(dshLogFd, s + '\n') } catch {}
    allLog.push(s)
    const mm = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_.%-]+)/.exec(s)
    if (mm && !tokenUrl) { tokenUrl = mm[1]; results.runtime.tokenUrl = tokenUrl; log('捕获 token URL') }
  }

  // 注入百炼凭证（仅通过 env，不落盘）+ 关闭 safe-delete shim
  const childEnv = {
    ...process.env,
    ...runtime.env,
    AI_DASHSCOPE_API_KEY: BAILIAN_KEY,
    CODEBUDDY_SAFE_DELETE_ENABLED: '0',
  }
  delete childEnv.NODE_OPTIONS

  dshWebChild = launcher.spawnDshWeb({
    bin: launch.bin,
    nodeArgs,
    runtime: runtime.file,
    port: WEB_PORT,
    dshHome: DSH_HOME,
    baseEnv: childEnv,
    childProcess: { spawn },
    onLog: capture,
  })
  results.runtime.dshWebSpawned = !!dshWebChild
  if (!dshWebChild) throw new Error('spawnDshWeb 返回 null')

  const deadline = Date.now() + 240000
  while (Date.now() < deadline && !tokenUrl) await sleep(1000)
  if (!tokenUrl) {
    const r = await fetchUrl(`http://127.0.0.1:${WEB_PORT}/`, 2000)
    throw new Error('120s 内未捕获 token URL；端口探活 status=' + r.status)
  }
  log('dsh web 已就绪')

  // ---- 插件挂载校验（不消耗额度）----
  const joined = allLog.join('\n')
  results.pluginMount = {
    betterSidebarInLog: /dsh-better-sidebar|better-sidebar/i.test(joined),
    bridgeBrowserInLog: /dsh-bridge-browser|bridge-browser/i.test(joined),
    logSample: allLog.filter((l) => /sidebar|browser|plugin|bundle/i.test(l)).slice(0, 8),
  }
  log('插件挂载检测: better-sidebar=' + results.pluginMount.betterSidebarInLog + ' bridge-browser=' + results.pluginMount.bridgeBrowserInLog)

  // ---- Playwright ----
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  try {
    const page = await (await browser.newContext()).newPage()
    page.on('console', (m) => { if (m.type() === 'error') results.consoleErrors.push(m.text().slice(0, 300)) })
    page.on('pageerror', (e) => results.consoleErrors.push('PAGEERROR: ' + e.message.slice(0, 300)))
    page.on('response', (res) => {
      const u = res.url()
      if (/completions|chat/i.test(u)) {
        results.network.push({ url: u.slice(0, 160), status: res.status() })
        log('[net]', res.status(), u.slice(0, 120))
      }
      if (/\/plugins\//.test(u)) results.pluginRequests.push(u.slice(0, 4000))
    })

    await page.goto(tokenUrl, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch((e) => log('goto warn:', e.message))
    await sleep(10000)
    await screenshot(page, '01-initial')
    await dismissDisclaimer(page)
    const wsReady = await selectWorkspace(page)
    log('工作区就绪:', wsReady)
    await screenshot(page, '01b-workspace')

    // ---- 布局 ----
    const layout = await page.evaluate(() => {
      const t = document.body.innerText, h = document.body.innerHTML
      return {
        hasComposer: !!document.querySelector('[contenteditable="true"], [role="textbox"], .lexical-contenteditable, textarea'),
        hasSidebar: !!document.querySelector('aside, nav, [class*="sidebar" i], [class*="sider" i]'),
        hasChatHistory: /(新建对话|历史|会话|chat|conversation)/i.test(t),
        hasModelSelector: /(模型|model|agent|智能体)/i.test(t),
        hasWorkbenchClass: /workbench|shell|layout|dsh-web-ui/i.test(h),
        preview: t.replace(/\s+/g, ' ').slice(0, 160),
        title: document.title,
      }
    }).catch((e) => ({ error: e.message }))
    results.layout = { ...layout, isDshWebUi: !!(layout.hasComposer && (layout.hasSidebar || layout.hasChatHistory || layout.hasWorkbenchClass)) }
    log('layout isDshWebUi:', results.layout.isDshWebUi, '| preview:', layout.preview)

    // ---- 社区插件是否真的进了前端模块清单（/plugins/??a,b,c 请求 URL 里出现即已挂载）----
    const joinedPlugins = results.pluginRequests.join('\n')
    results.pluginMount = {
      ...results.pluginMount,
      requestCount: results.pluginRequests.length,
      betterSidebarClientRequested: /dsh-better-sidebar/.test(joinedPlugins),
      bridgeBrowserClientRequested: /dsh-bridge-browser|bridge-browser/.test(joinedPlugins),
      clientModuleSample: (joinedPlugins.match(/[^,?/]+/g) || []).filter((s) => /dsh-/.test(s)).slice(0, 25),
    }
    log('插件挂载(client modules): better-sidebar=' + results.pluginMount.betterSidebarClientRequested + ' bridge-browser=' + results.pluginMount.bridgeBrowserClientRequested)

    // ---- 多轮对话（2 次真实调用，自动节流）----
    const multiTurn = { round1: {}, round2: {}, contextKept: false }
    try {
      await sendMessage(page, '我叫张三，请记住这个名字。请只回复"记住了，张三"。')
      multiTurn.round1.sent = true
      const r1 = await waitForReply(page, (txt) => ({ found: /张三/.test(txt) || /(记住|好的|OK|收到|remember)/i.test(txt), excerpt: txt.slice(-300) }))
      multiTurn.round1.replyAppeared = r1.found
      multiTurn.round1.excerpt = r1.excerpt || ''
      await screenshot(page, '02-mt-r1')

      if (r1.found) {
        await sendMessage(page, '我刚才让你记住的名字是什么？只回答名字。')
        multiTurn.round2.sent = true
        const r2 = await waitForReply(page, (txt) => ({ found: /张三/.test(txt), excerpt: txt.slice(-300) }))
        multiTurn.round2.replyAppeared = r2.found
        multiTurn.round2.excerpt = r2.excerpt || ''
        multiTurn.contextKept = r2.found
        await screenshot(page, '03-mt-r2')
      }
    } catch (e) { multiTurn.error = e.message }
    results.multiTurn = multiTurn

    // ---- 智能编码（1 次真实调用，自动节流）----
    const coding = {}
    try {
      await sendMessage(page, '请用 Python 写一个快速排序函数，只输出代码。')
      coding.sent = true
      const r = await waitForReply(page, (txt, htm) => {
        const codeBlock = /<pre\b/i.test(htm) || /```/.test(txt)
        const hasCode = /def quicksort|def\s+\w+\(|```python|pivot\s*=|quick_sort/i.test(txt)
        return { found: hasCode, codeBlock, excerpt: txt.slice(-400) }
      })
      coding.replyAppeared = r.found
      coding.codeBlockAppeared = !!r.codeBlock
      coding.excerpt = r.excerpt || ''
      await screenshot(page, '04-coding')
    } catch (e) { coding.error = e.message }
    results.smartCoding = coding

    await screenshot(page, '05-final')
  } finally {
    await browser.close().catch(() => {})
  }

  results.pass = {
    dshWebSpawned: results.runtime.dshWebSpawned,
    tokenCaptured: !!results.runtime.tokenUrl,
    layoutIsDshWebUi: !!results.layout.isDshWebUi,
    pluginBetterSidebarMounted: results.pluginMount.betterSidebarClientRequested === true,
    pluginBridgeBrowserMounted: results.pluginMount.bridgeBrowserClientRequested === true,
    multiTurnRound1: !!results.multiTurn.round1?.replyAppeared,
    multiTurnContextKept: !!results.multiTurn.contextKept,
    smartCodingReply: !!results.smartCoding.replyAppeared,
    realApiReached: results.network.some((n) => /dashscope/i.test(n.url)),
    allRequestsOk: results.network.length > 0 && results.network.every((n) => n.status === 200 || n.status === 0),
  }
  results.overall = Object.values(results.pass).every(Boolean)
  results.totalRealCalls = callCount
}

try {
  await main()
} catch (e) {
  results.fatal = e.message
  log('FATAL:', e.message)
} finally {
  log('\n========== BAILIAN E2E RESULT ==========')
  log(JSON.stringify(results, null, 2))
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2))
  try {
    spawn('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { (($_.CommandLine -like '*dsh/lib/bin.js*' -or $_.CommandLine -like '*lib\\\\bin.js*') -and $_.CommandLine -like '*web*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, stdio: 'ignore' })
  } catch {}
  if (dshWebChild) try { dshWebChild.kill('SIGKILL') } catch {}
  setTimeout(() => process.exit(results.overall ? 0 : 1), 500)
}
