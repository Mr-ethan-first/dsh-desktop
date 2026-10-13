/**
 * UI 调试：连到常驻 dsh web，逐步点击并 dump 状态，找出「绑定工作区 -> composer 可输入」的正确路径。
 * 不做任何 LLM 调用。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require2 = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/noop.js')
const { chromium } = require2('playwright')

const TOKEN_FILE = 'D:/WorkSpace/deepseek-harness-master/_tmp_dsh_token.txt'
const SCR = 'D:/WorkSpace/deepseek-harness-master/_tmp_bailian_screens'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[dbg]', ...a)

const token = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : ''
if (!token) { console.error('no token file'); process.exit(2) }

async function state(page) {
  return page.evaluate(() => {
    const composer = document.querySelector('[contenteditable]:not([contenteditable="false"]), [role="textbox"], textarea')
    const r = composer ? composer.getBoundingClientRect() : null
    return {
      body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 260),
      composer: composer ? { tag: composer.tagName, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), inner: (composer.innerText || '').slice(0, 20) } : null,
      sendButtons: [...document.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().y > 250).map((b) => ({ aria: b.getAttribute('aria-label') || '', text: (b.innerText || '').trim().slice(0, 12), x: Math.round(b.getBoundingClientRect().x), y: Math.round(b.getBoundingClientRect().y), disabled: b.disabled || b.getAttribute('aria-disabled') === 'true' })).slice(0, 14),
      allExact: [...document.querySelectorAll('body *')].filter((e) => ['algs4-master', '01-first-vue3', '新会话'].includes((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0).map((e) => ({ t: (e.innerText || '').trim(), tag: e.tagName, x: Math.round(e.getBoundingClientRect().x), y: Math.round(e.getBoundingClientRect().y), w: Math.round(e.getBoundingClientRect().width) })),
    }
  }).catch((e) => ({ err: e.message }))
}

async function clickExact(page, text, { side }) {
  const box = await page.evaluate(({ text, side }) => {
    const els = [...document.querySelectorAll('body *')]
    const cands = els.filter((e) => {
      const t = (e.innerText || '').trim()
      if (t !== text) return false
      const r = e.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return false
      if (side === 'left' && r.x >= 250) return false
      if (side === 'main' && r.x < 250) return false
      return true
    })
    if (!cands.length) return null
    const el = cands[cands.length - 1]
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName }
  }, { text, side }).catch(() => null)
  if (!box) return { ok: false }
  await page.mouse.click(box.x, box.y)
  return { ok: true, ...box }
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
page.on('console', (m) => { if (m.type() === 'error') log('console.err', m.text().slice(0, 140)) })
await page.goto(token, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto', e.message))
await sleep(9000)
await page.screenshot({ path: path.join(SCR, 'dbg-A-home.png') })
log('A 初始:', JSON.stringify(await state(page), null, 1))

// 点左侧栏工作区（展开）
const c1 = await clickExact(page, 'algs4-master', { side: 'left' })
log('点击侧栏工作区:', JSON.stringify(c1))
await sleep(3500)
await page.screenshot({ path: path.join(SCR, 'dbg-B-expanded.png') })
log('B 展开后:', JSON.stringify(await state(page), null, 1))

// 点该工作区下的一个真实会话
const sessions = await page.evaluate(() => {
  const set = []
  for (const e of document.querySelectorAll('body *')) {
    const t = (e.innerText || '').trim()
    const r = e.getBoundingClientRect()
    if (!t || t.length > 40 || r.x >= 250 || r.width <= 0) continue
    if (/^新会话$/.test(t)) continue
    if (/会话|助手|需求|方案|算法|专家|htm/i.test(t) && !set.includes(t)) set.push(t)
  }
  return set.slice(0, 8)
})
log('侧栏会话候选:', JSON.stringify(sessions))
if (sessions.length) {
  const c2 = await clickExact(page, sessions[0], { side: 'left' })
  log('点击会话:', JSON.stringify(c2), sessions[0])
  await sleep(6000)
  await page.screenshot({ path: path.join(SCR, 'dbg-C-session.png') })
  log('C 打开会话后:', JSON.stringify(await state(page), null, 1))
}

// 试输入
const st = await state(page)
if (st.composer) {
  const el = page.locator('[contenteditable]:not([contenteditable="false"]), [role="textbox"], textarea').first()
  await el.click().catch(() => {})
  await el.type('hello', { delay: 25 })
  await sleep(1500)
  await page.screenshot({ path: path.join(SCR, 'dbg-D-typed.png') })
  log('D 输入后:', JSON.stringify(await state(page), null, 1))
  const cleared = await page.evaluate(() => {
    const el = document.querySelector('[contenteditable]:not([contenteditable="false"]), [role="textbox"], textarea')
    return el ? (el.innerText || el.value || '').slice(0, 40) : null
  })
  log('composer 内容:', JSON.stringify(cleared))
}

await browser.close().catch(() => {})
process.exit(0)
