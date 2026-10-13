/**
 * 聚焦调试 4：打开会话 -> 点底部模型选择器 -> 选 qwen-plus -> 观察 composer 是否解禁。
 * 不做 LLM 调用（不发送）。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require2 = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/noop.js')
const { chromium } = require2('playwright')

const token = fs.readFileSync('D:/WorkSpace/deepseek-harness-master/_tmp_dsh_token.txt', 'utf8').trim()
const SCR = 'D:/WorkSpace/deepseek-harness-master/_tmp_bailian_screens'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[ws4]', ...a)

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
page.on('response', (r) => { const u = r.url(); if (!/\.(js|css|png|woff2?|svg)/.test(u) && !/plugins\/\?/.test(u)) log('[net]', r.status(), u.slice(0, 130)) })
await page.goto(token, { waitUntil: 'domcontentloaded' }).catch(() => {})
await sleep(9000)

const clickByText = async (text, minX = 0, maxX = 99999) => {
  const box = await page.evaluate(({ text, minX, maxX }) => {
    const c = [...document.querySelectorAll('body *')].filter((e) => {
      const t = (e.innerText || '').trim()
      const r = e.getBoundingClientRect()
      return t === text && r.width > 0 && r.x >= minX && r.x <= maxX
    })
    if (!c.length) return null
    const r = c[c.length - 1].getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }, { text, minX, maxX }).catch(() => null)
  if (!box) return false
  await page.mouse.click(box.x, box.y)
  return true
}

await clickByText('algs4-master', 0, 250)
await sleep(3000)
await clickByText('你是一名顶级算法专家+前端htm\n13小时', 0, 250)
await sleep(1000)
// 会话标题在侧栏被截断，尝试按前缀匹配
const opened = await page.evaluate(() => {
  const c = [...document.querySelectorAll('body *')].filter((e) => {
    const t = (e.innerText || '').trim()
    const r = e.getBoundingClientRect()
    return r.x < 250 && r.width > 0 && t.length < 40 && /助手会话|算法专家/.test(t)
  })
  if (!c.length) return false
  const r = c[c.length - 1].getBoundingClientRect()
  window.__dbgTarget = [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]
  return true
})
if (opened) {
  const [x, y] = await page.evaluate(() => window.__dbgTarget)
  await page.mouse.click(x, y)
  log('已点会话', x, y)
}
await sleep(6000)
await page.screenshot({ path: path.join(SCR, 'ws4-A-session.png') })

const composerCls = () => page.evaluate(() => {
  const e = document.querySelector('[contenteditable]:not([contenteditable="false"]), [contenteditable="true"], [role="textbox"]')
  const all = [...document.querySelectorAll('[contenteditable]')].map((x) => ({ cls: (x.className || '').toString().slice(0, 60), ce: x.getAttribute('contenteditable') }))
  return { all }
})
log('composer 状态:', JSON.stringify(await composerCls(), null, 1))

// 找模型选择器（底部，显示 provider/model）
const modelChip = await page.evaluate(() => {
  const c = [...document.querySelectorAll('button, [role="button"]')].filter((e) => {
    const t = (e.innerText || '').trim()
    const r = e.getBoundingClientRect()
    return /^[a-z0-9-]+\/[a-z0-9.-]+$/i.test(t) && r.y > 600 && r.width > 0
  })
  if (!c.length) return null
  const r = c[c.length - 1].getBoundingClientRect()
  return { text: c[c.length - 1].innerText.trim(), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})
log('模型选择器:', JSON.stringify(modelChip))
if (modelChip) {
  await page.mouse.click(modelChip.x, modelChip.y)
  await sleep(2500)
  await page.screenshot({ path: path.join(SCR, 'ws4-B-modelmenu.png') })
  const items = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => {
    const t = (e.innerText || '').trim()
    const r = e.getBoundingClientRect()
    return t.length < 40 && r.y > 300 && r.width > 0 && /qwen|bailian|deepseek|glm|model|模型/i.test(t)
  }).map((e) => ({ t: (e.innerText || '').trim().slice(0, 40), x: Math.round(e.getBoundingClientRect().x), y: Math.round(e.getBoundingClientRect().y) })).slice(0, 20))
  log('模型菜单项:', JSON.stringify(items, null, 1))
  const hit = items.find((i) => /qwen-plus/i.test(i.t))
  if (hit) {
    await page.mouse.click(hit.x + 40, hit.y + 8)
    log('已选 qwen-plus')
    await sleep(3000)
    await page.screenshot({ path: path.join(SCR, 'ws4-C-picked.png') })
    log('选后 composer:', JSON.stringify(await composerCls(), null, 1))
  }
}

await browser.close().catch(() => {})
process.exit(0)
