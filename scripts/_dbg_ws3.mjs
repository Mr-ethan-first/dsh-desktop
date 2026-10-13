/**
 * 聚焦调试 3：打开会话后，枚举所有 contenteditable，挑最大者真实鼠标点击并输入，观察发送按钮是否可用。
 * 不做 LLM 调用（只输入，不发送）。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require2 = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/noop.js')
const { chromium } = require2('playwright')

const token = fs.readFileSync('D:/WorkSpace/deepseek-harness-master/_tmp_dsh_token.txt', 'utf8').trim()
const SCR = 'D:/WorkSpace/deepseek-harness-master/_tmp_bailian_screens'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[ws3]', ...a)

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
await page.goto(token, { waitUntil: 'domcontentloaded' }).catch(() => {})
await sleep(9000)

// 1) 展开侧栏工作区
const clickLeft = async (text) => {
  const box = await page.evaluate((t) => {
    const c = [...document.querySelectorAll('body *')].filter((e) => (e.innerText || '').trim() === t && e.getBoundingClientRect().x < 250 && e.getBoundingClientRect().width > 0)
    if (!c.length) return null
    const r = c[c.length - 1].getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }, text).catch(() => null)
  if (!box) return false
  await page.mouse.click(box.x, box.y)
  return true
}
await clickLeft('algs4-master')
await sleep(3500)
await page.screenshot({ path: path.join(SCR, 'ws3-A-expanded.png') })

// 2) 找并点一个真实会话
const sessionTitles = await page.evaluate(() => {
  const out = []
  for (const e of document.querySelectorAll('body *')) {
    const t = (e.innerText || '').trim()
    const r = e.getBoundingClientRect()
    if (!t || t.length > 40 || r.x >= 250 || r.width <= 0 || /^新会话$/.test(t)) continue
    if (/助手|会话|专家|htm|方案|需求/i.test(t) && !out.includes(t)) out.push(t)
  }
  return out.slice(0, 6)
})
log('会话候选:', JSON.stringify(sessionTitles))
if (sessionTitles.length) { await clickLeft(sessionTitles[0]); await sleep(6000) }
await page.screenshot({ path: path.join(SCR, 'ws3-B-session.png') })

// 3) 枚举 contenteditable
const enumEd = () => page.evaluate(() => [...document.querySelectorAll('[contenteditable], [role="textbox"], textarea')].map((e, i) => {
  const r = e.getBoundingClientRect()
  return { i, tag: e.tagName, ce: e.getAttribute('contenteditable'), role: e.getAttribute('role') || '', cls: (e.className || '').toString().slice(0, 70), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 }
}))
let cands = await enumEd()
log('contenteditable 候选:', JSON.stringify(cands, null, 1))
log('composerDisabled:', cands.some((c) => /inputDisabled/.test(c.cls)))

// 3b) 若被禁用，尝试点「新会话」（此时工作区上下文已绑定）
if (cands.some((c) => /inputDisabled/.test(c.cls))) {
  log('composer 被禁用 -> 尝试点「新会话」')
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /新会话/.test((x.innerText || '').trim()))
    if (b) b.click()
  }).catch(() => {})
  await sleep(6000)
  await page.screenshot({ path: path.join(SCR, 'ws3-B2-newsession.png') })
  cands = await enumEd()
  log('新会话后候选:', JSON.stringify(cands, null, 1))
  log('composerDisabled(新会话后):', cands.some((c) => /inputDisabled/.test(c.cls)))
  const hdr = await page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ')
    return t.slice(0, 220)
  })
  log('页面文本:', hdr)
}

// 4) 点最大的可见候选并输入
const best = cands.filter((c) => c.visible).sort((a, b) => b.w * b.h - a.w * a.h)[0]
log('选中:', JSON.stringify(best))
if (best) {
  await page.mouse.click(best.x + Math.min(120, best.w / 2), best.y + Math.max(5, best.h / 2))
  await sleep(500)
  await page.keyboard.type('这是一条测试消息', { delay: 30 })
  await sleep(1500)
  await page.screenshot({ path: path.join(SCR, 'ws3-C-typed.png') })
  const after = await page.evaluate(() => {
    const ed = [...document.querySelectorAll('[contenteditable], [role="textbox"], textarea')].map((e) => ({ tag: e.tagName, text: (e.innerText || e.value || '').slice(0, 40) }))
    const send = [...document.querySelectorAll('button')].find((b) => /发送/.test(b.getAttribute('aria-label') || ''))
    return { eds: ed, sendExists: !!send, sendDisabled: send ? (send.disabled || send.getAttribute('aria-disabled')) : null }
  })
  log('输入后:', JSON.stringify(after, null, 1))
}

await browser.close().catch(() => {})
process.exit(0)
