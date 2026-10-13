/**
 * 决定性验证：在真实 UI 上把模型切到 bailian/qwen-plus，输入一句话并发送，
 * 观察是否真的发起了 LLM 请求并拿到回复。只发 1 条消息（省额度）。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require2 = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/noop.js')
const { chromium } = require2('playwright')

const token = fs.readFileSync('D:/WorkSpace/deepseek-harness-master/_tmp_dsh_token.txt', 'utf8').trim()
const SCR = 'D:/WorkSpace/deepseek-harness-master/_tmp_bailian_screens'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[send]', ...a)

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
const net = []
page.on('response', (r) => {
  const u = r.url()
  if (!/\.(js|css|png|woff2?|svg|map)(\?|$)/.test(u) && !/\/api\/commands\/list/.test(u)) { net.push({ s: r.status(), u: u.slice(0, 150) }); log('[net]', r.status(), u.slice(0, 140)) }
})
page.on('console', (m) => { if (m.type() === 'error') log('[console.err]', m.text().slice(0, 160)) })
await page.goto(token, { waitUntil: 'domcontentloaded' }).catch(() => {})

const composerInfo = () => page.evaluate(() => {
  const e = document.querySelector('[contenteditable]')
  const send = [...document.querySelectorAll('button')].find((b) => /发送消息|发送/.test(b.getAttribute('aria-label') || ''))
  return {
    ce: e ? e.getAttribute('contenteditable') : null,
    cls: e ? (e.className || '').toString().slice(0, 50) : null,
    text: e ? (e.innerText || '') : null,
    sendExists: !!send,
    sendDisabled: send ? !!(send.disabled || send.getAttribute('aria-disabled') === 'true') : null,
  }
})

// 轮询等待 composer 可用（应用启动 + 自动建会话需要时间）
let info = null
for (let i = 0; i < 40; i++) {
  await sleep(2500)
  info = await composerInfo()
  if (i % 4 === 0) log(`等待 composer 就绪 (${(i + 1) * 2.5}s):`, JSON.stringify(info))
  if (info.ce === 'true') break
  // 点一下主区，触发交互态
  if (i === 8) await page.mouse.click(900, 400).catch(() => {})
}
log('初始 composer:', JSON.stringify(info))
await page.screenshot({ path: path.join(SCR, 'send-A0-ready.png') })

// 1) 打开模型选择器
const chip = await page.evaluate(() => {
  const c = [...document.querySelectorAll('button, [role="button"]')].filter((e) => {
    const t = (e.innerText || '').trim()
    const r = e.getBoundingClientRect()
    return /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(t) && r.y > 600 && r.width > 0
  })
  if (!c.length) return null
  const r = c[c.length - 1].getBoundingClientRect()
  return { text: c[c.length - 1].innerText.trim(), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})
log('模型 chip:', JSON.stringify(chip))
if (!chip) { console.error('未找到模型选择器'); await browser.close(); process.exit(3) }
await page.mouse.click(chip.x, chip.y)
await sleep(2500)
await page.screenshot({ path: path.join(SCR, 'send-A-modelmenu.png') })

// 2) dump 菜单项（放宽条件）
const items = await page.evaluate(() => {
  const out = []
  for (const e of document.querySelectorAll('body *')) {
    const t = (e.innerText || '').trim()
    const r = e.getBoundingClientRect()
    if (!t || t.length > 80 || r.width <= 0 || r.height <= 0) continue
    if (r.y < 250) continue
    out.push({ t, tag: e.tagName, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })
  }
  return out.slice(-60)
})
log('菜单候选(尾部 60):')
for (const i of items) log('   ', JSON.stringify(i))

// 3) 选一条包含 qwen-plus 或 bailian 的
const hit = items.slice().reverse().find((i) => /bailian|qwen-plus|qwen3\./i.test(i.t))
if (hit) {
  await page.mouse.click(hit.x + Math.min(80, hit.w / 2), hit.y + Math.min(10, hit.h / 2))
  log('已点击模型项:', JSON.stringify(hit))
  await sleep(3000)
} else log('未找到匹配的模型项')
await page.screenshot({ path: path.join(SCR, 'send-B-afterpick.png') })

// 4) 输入并发送
info = await composerInfo()
log('输入前:', JSON.stringify(info))
const box = await page.evaluate(() => {
  const e = document.querySelector('[contenteditable]')
  if (!e) return null
  const r = e.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
})
if (box) {
  await page.mouse.click(box.x, box.y)
  await sleep(400)
  await page.keyboard.type('请只回复两个字：收到了', { delay: 40 })
  await sleep(1200)
  await page.screenshot({ path: path.join(SCR, 'send-C-typed.png') })
  log('输入后:', JSON.stringify(await composerInfo()))
  const sent = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /发送消息|发送/.test(x.getAttribute('aria-label') || ''))
    if (!b) return 'no-button'
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') return 'disabled'
    b.click()
    return 'clicked'
  })
  log('发送:', sent)
  if (sent === 'disabled' || sent === 'no-button') {
    await page.keyboard.press('Enter')
    log('回退 Enter 提交')
  }
}

// 5) 等待请求 + 回复
const deadline = Date.now() + 120000
let llmSeen = null
let reply = null
while (Date.now() < deadline) {
  if (!llmSeen) llmSeen = net.find((n) => /dashscope|compatible-mode|completions|chat/i.test(n.u))
  const t = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ')).catch(() => '')
  if (/收到了/.test(t) || /失败|错误|error/i.test(t)) { reply = t.slice(-400); if (/收到了/.test(t)) break }
  await sleep(2500)
}
await page.screenshot({ path: path.join(SCR, 'send-D-final.png') })
log('LLM 请求:', JSON.stringify(llmSeen))
log('回复片段:', JSON.stringify(reply))
log('最终 composer:', JSON.stringify(await composerInfo()))

await browser.close().catch(() => {})
process.exit(0)
