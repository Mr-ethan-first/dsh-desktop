/**
 * 聚焦调试：打开「选择工作区」弹层 -> 鼠标点弹层项 -> 观察 composer 占位是否变化。
 * 复用常驻 dsh web（_tmp_dsh_token.txt），不做 LLM 调用。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require2 = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/noop.js')
const { chromium } = require2('playwright')

const token = fs.readFileSync('D:/WorkSpace/deepseek-harness-master/_tmp_dsh_token.txt', 'utf8').trim()
const SCR = 'D:/WorkSpace/deepseek-harness-master/_tmp_bailian_screens'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[ws2]', ...a)

const snap = (page) => page.evaluate(() => {
  const c = document.querySelector('[contenteditable]:not([contenteditable="false"]), [role="textbox"], textarea')
  return {
    body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(-200),
    composerRect: c ? { x: Math.round(c.getBoundingClientRect().x), y: Math.round(c.getBoundingClientRect().y), w: Math.round(c.getBoundingClientRect().width) } : null,
    trigger: [...document.querySelectorAll('button')].filter((b) => /选择工作区/.test(b.getAttribute('aria-label') || '') || /选择工作区/.test((b.innerText || '').trim())).map((b) => ({ aria: b.getAttribute('aria-label'), x: Math.round(b.getBoundingClientRect().x), y: Math.round(b.getBoundingClientRect().y) })),
    // 弹层项：文本恰好是工作区名的可点元素，且带 data-* 或 role
    items: [...document.querySelectorAll('body *')].filter((e) => {
      const t = (e.innerText || '').trim()
      const r = e.getBoundingClientRect()
      return (t === 'algs4-master' || t === '01-first-vue3' || t === '添加工作区…') && r.width > 0 && r.x > 250
    }).map((e) => ({ t: (e.innerText || '').trim(), tag: e.tagName, cls: (e.className || '').toString().slice(0, 30), x: Math.round(e.getBoundingClientRect().x), y: Math.round(e.getBoundingClientRect().y), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) })),
  }
}).catch((e) => ({ err: e.message }))

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
await page.goto(token, { waitUntil: 'domcontentloaded' }).catch(() => {})
await sleep(9000)
log('初始:', JSON.stringify(await snap(page), null, 1))
await page.screenshot({ path: path.join(SCR, 'ws2-A.png') })

// 点触发按钮
const trig = (await snap(page)).trigger?.[0]
if (trig) { await page.mouse.click(trig.x + 40, trig.y + 10); log('已点触发按钮', JSON.stringify(trig)) }
await sleep(2500)
let s = await snap(page)
log('弹层打开:', JSON.stringify(s, null, 1))
await page.screenshot({ path: path.join(SCR, 'ws2-B.png') })

// 点第一个弹层项
const item = (s.items || []).find((i) => i.t === 'algs4-master')
if (item) {
  await page.mouse.click(item.x + Math.min(60, item.w / 2), item.y + item.h / 2)
  log('已点弹层项', JSON.stringify(item))
} else log('未找到弹层项')
await sleep(4000)
s = await snap(page)
log('点选后:', JSON.stringify(s, null, 1))
await page.screenshot({ path: path.join(SCR, 'ws2-C.png') })

// 看 composer 占位（占位是覆盖层文本）
const ph = await page.evaluate(() => {
  const c = document.querySelector('[contenteditable]:not([contenteditable="false"]), [role="textbox"], textarea')
  if (!c) return null
  const parent = c.closest('div[class]') || c.parentElement
  return { composerText: (c.innerText || ''), parentText: (parent && parent.innerText || '').slice(0, 120) }
}).catch(() => null)
log('composer 文本:', JSON.stringify(ph))

// 试真实键盘输入
await page.mouse.click(700, 430)
await page.keyboard.type('hi', { delay: 30 })
await sleep(1200)
await page.screenshot({ path: path.join(SCR, 'ws2-D.png') })
log('输入后:', JSON.stringify(await page.evaluate(() => {
  const c = document.querySelector('[contenteditable]:not([contenteditable="false"]), [role="textbox"], textarea')
  const send = [...document.querySelectorAll('button')].find((b) => /发送/.test(b.getAttribute('aria-label') || ''))
  return { composer: c ? (c.innerText || '') : null, sendDisabled: send ? (send.disabled || send.getAttribute('aria-disabled')) : 'no-send-btn' }
}), null, 1))

await browser.close().catch(() => {})
process.exit(0)
