/**
 * 调试：dsh web 启动后，定位「选择工作区」下拉弹层的真实 DOM 结构与点击方式。
 * 不做任何 LLM 调用。
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const PW_ROOT = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules'
const require2 = createRequire(path.join(PW_ROOT, 'noop.js'))
const { chromium } = require2('playwright')

const EXE_ROOT = 'D:/DeepSeekAgent'
const DSH_DIR = path.join(EXE_ROOT, 'resources', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh')
const LAUNCHER = path.join(EXE_ROOT, 'resources', 'app.asar.unpacked', 'electron', 'plugin-host', 'dsh-web-launcher.cjs')
const DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home'
const PORT = 5284
const SCR = 'D:/WorkSpace/deepseek-harness-master/_tmp_bailian_screens'
fs.mkdirSync(SCR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[debug-ws]', ...a)
const launcher = require2(LAUNCHER)

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME, CODEBUDDY_SAFE_DELETE_ENABLED: '0' }
delete env.NODE_OPTIONS

const launch = launcher.resolveDshLaunch({ cliDir: DSH_DIR })
let tokenUrl = null
const child = launcher.spawnDshWeb({
  bin: launch.bin,
  nodeArgs: ['--expose-internals', ...(launch.nodeArgs || [])],
  runtime: path.join(EXE_ROOT, 'DeepSeekAgent.exe'),
  port: PORT,
  dshHome: DSH_HOME,
  baseEnv: env,
  childProcess: { spawn },
  onLog: (s) => {
    const m = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_.%-]+)/.exec(s)
    if (m && !tokenUrl) { tokenUrl = m[1]; log('token', tokenUrl) }
  },
})
const deadline = Date.now() + 120000
while (Date.now() < deadline && !tokenUrl) await sleep(800)
if (!tokenUrl) { console.error('no token'); process.exit(2) }
await sleep(3000)

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
page.on('console', (m) => { if (m.type() === 'error') log('console.err', m.text().slice(0, 120)) })
await page.goto(tokenUrl, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto', e.message))
await sleep(9000)
await page.screenshot({ path: path.join(SCR, 'dbg-01-home.png') })

// 1) 打开下拉
await page.getByText('选择工作区', { exact: false }).first().click({ timeout: 5000 }).catch((e) => log('click trigger err', e.message))
await sleep(2000)
await page.screenshot({ path: path.join(SCR, 'dbg-02-dropdown.png') })

// 2) dump 弹层候选
const dump = await page.evaluate(() => {
  const out = []
  const walk = (root, depth) => {
    if (out.length > 60 || depth > 12) return
    for (const el of root.children) {
      const r = el.getBoundingClientRect()
      const txt = (el.innerText || '').trim()
      if (txt && txt.length < 40 && r.width > 0 && r.x > 250) {
        out.push({ tag: el.tagName, role: el.getAttribute('role') || '', cls: (el.className || '').toString().slice(0, 40), text: txt, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), childCount: el.children.length })
      }
      walk(el, depth + 1)
    }
  }
  walk(document.body, 0)
  return out
})
log('候选元素:')
for (const d of dump.slice(0, 40)) log('  ', JSON.stringify(d))

// 3) 尝试点击文本为 algs4-master 且 x>250 的元素
const clickRes = await page.evaluate(() => {
  const all = [...document.querySelectorAll('body *')]
  const hit = all.find((e) => {
    const r = e.getBoundingClientRect()
    return (e.innerText || '').trim() === 'algs4-master' && r.x > 250 && r.width > 0
  })
  if (!hit) return { ok: false }
  const r = hit.getBoundingClientRect()
  hit.click()
  return { ok: true, tag: hit.tagName, x: Math.round(r.x), y: Math.round(r.y) }
})
log('点击结果:', JSON.stringify(clickRes))
await sleep(3500)
await page.screenshot({ path: path.join(SCR, 'dbg-03-afterpick.png') })

const state = await page.evaluate(() => {
  const c = document.querySelector('[contenteditable]:not([contenteditable="false"]), [role="textbox"], textarea')
  return {
    body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 220),
    composer: c ? { tag: c.tagName, ph: c.getAttribute('placeholder'), hint: (c.innerText || '').slice(0, 30), rect: c.getBoundingClientRect().width } : null,
    textboxes: [...document.querySelectorAll('[contenteditable], [role="textbox"], textarea')].map((e) => ({ tag: e.tagName, ce: e.getAttribute('contenteditable'), ph: e.getAttribute('placeholder') || '', w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height), y: Math.round(e.getBoundingClientRect().y) })).slice(0, 8),
  }
})
log('状态:', JSON.stringify(state, null, 2))

// 4) 若 composer 就绪，输入文本并观察发送按钮
if (state.composer && !/选择一个工作区开始/.test((state.composer.ph || '') + (state.composer.hint || ''))) {
  log('composer 就绪，试输入')
  const el = page.locator('[contenteditable]:not([contenteditable="false"]), [role="textbox"], textarea').first()
  await el.click().catch(() => {})
  await el.type('你好', { delay: 20 })
  await sleep(1200)
  await page.screenshot({ path: path.join(SCR, 'dbg-04-typed.png') })
  const btns = await page.evaluate(() => [...document.querySelectorAll('button, [role="button"]')]
    .map((b) => ({ aria: b.getAttribute('aria-label') || '', title: b.getAttribute('title') || '', text: (b.innerText || '').trim().slice(0, 20), x: Math.round(b.getBoundingClientRect().x), y: Math.round(b.getBoundingClientRect().y), disabled: b.disabled || b.getAttribute('aria-disabled') === 'true' }))
    .filter((b) => b.y > 250).slice(0, 20))
  log('主区按钮:', JSON.stringify(btns, null, 1))
}

await browser.close().catch(() => {})
try { child.kill('SIGKILL') } catch {}
setTimeout(() => process.exit(0), 500)
