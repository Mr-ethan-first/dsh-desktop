/**
 * 通过 dsh web 的 RPC API 完成真实闭环验证（比 UI 驱动稳）：
 *   session/create -> session/selectModel(bailian/qwen-plus) -> session/prompt -> session/follow 读回复
 * 只发起 1 次真实 LLM 调用（省额度）。
 * 用法：node scripts/e2e-api-bailian.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const TOKEN_FILE = 'D:/WorkSpace/deepseek-harness-master/_tmp_dsh_token.txt'
const OUT = 'D:/WorkSpace/deepseek-harness-master/_tmp_api_bailian_result.json'
const COOKIE_FILE = 'D:/WorkSpace/deepseek-harness-master/_tmp_ck.txt'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[api-e2e]', ...a)

const tokenUrl = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
const ORIGIN = new URL(tokenUrl).origin
const TOKEN = new URL(tokenUrl).searchParams.get('token')

let cookie = ''
// 始终用最新 token 换 cookie（旧的 cookie 属于上一次服务实例，会 401）
{
  const r = await fetch(tokenUrl, { redirect: 'manual' })
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean)
  cookie = sc.map((c) => c.split(';')[0]).join('; ')
  if (!cookie) {
    const r2 = await fetch(tokenUrl, { redirect: 'follow' })
    const sc2 = r2.headers.getSetCookie ? r2.headers.getSetCookie() : [r2.headers.get('set-cookie')].filter(Boolean)
    cookie = sc2.map((c) => c.split(';')[0]).join('; ')
  }
}
fs.writeFileSync(COOKIE_FILE, '# refreshed by e2e-api-bailian\n' + cookie + '\n')
log('cookie:', cookie ? cookie.slice(0, 40) + '...' : '(empty)')

async function rpc(method, payload, { expectStream = false } = {}) {
  const body = { type: 'client-request', rpcId: randomUUID(), method, payload: { args: payload } }
  const res = await fetch(`${ORIGIN}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* stream or html */ }
  return { status: res.status, json, text, res }
}

const results = { steps: [], overall: false }

// 1) 建会话（绑定真实工作区）
const cwd = 'D:/WorkSpace/algs4-master'
let r = await rpc('session/create', { request: { cwd } })
log('session/create ->', r.status, JSON.stringify(r.json).slice(0, 300))
results.steps.push({ step: 'create', status: r.status, body: r.json })
const sessionId = r.json?.result?.value?.sessionId
if (!sessionId) { results.error = 'no sessionId'; fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); process.exit(2) }
log('sessionId =', sessionId)
results.sessionId = sessionId

// 2) 选模型：bailian / qwen-plus
r = await rpc('session/selectModel', { request: { sessionId, provider: 'bailian', model: 'qwen-plus' } })
log('session/selectModel ->', r.status, JSON.stringify(r.json).slice(0, 300))
results.steps.push({ step: 'selectModel', status: r.status, body: r.json })

// 3) 读一屏历史（address 必须带 kind，见官方 smoke-real.e2e.js）
//    throughSeq 不能超过会话游标，故先从 session/list 的 projections.asOfSeq 取游标。
//    session/follow 走 WebSocket /api/remote.mux，不走 HTTP POST，故此处只探测 page。
const readPage = async (maxMessages = 40) => rpc('session/page', {
  request: { address: { kind: 'session', sessionId }, throughSeq: await cursorOf(sessionId), maxMessages },
})
async function cursorOf(id) {
  const l = await rpc('session/list', { _request: {} })
  const it = (l.json?.result?.value?.items || []).find((x) => x.sessionId === id)
  const seq = it?.projections?.asOfSeq
  return Number.isSafeInteger(seq) ? seq : 0
}
r = await readPage(10)
log('session/page ->', r.status, JSON.stringify(r.json).slice(0, 400))
results.steps.push({ step: 'page-probe', status: r.status, body: r.json })

// 3b) 会话列表（args 用 _request）
r = await rpc('session/list', { _request: {} })
log('session/list ->', r.status, JSON.stringify(r.json).slice(0, 300))
results.steps.push({ step: 'list-probe', status: r.status, body: r.json })

// 4) 发一条真实消息（唯一一次 LLM 调用）
const SKIP_PROMPT = process.env.SKIP_PROMPT === '1'
if (SKIP_PROMPT) {
  log('SKIP_PROMPT=1，跳过真实调用（仅校验 API 形态）')
  results.overall = r.json?.result?.ok === true
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2))
  process.exit(0)
}
const requestId = randomUUID()
const prompt = '请只回复三个字：收到了'
r = await rpc('session/prompt', { request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] } })
log('session/prompt ->', r.status, JSON.stringify(r.json).slice(0, 300))
results.steps.push({ step: 'prompt', status: r.status, body: r.json, prompt })
results.promptSent = !!r.json?.result?.ok

// 5) 用 session/list 的会话元数据判定 LLM 是否真正回复（session/page 只返回事件流、不持久化消息体）
let reply = null
let lastText = ''
const deadline = Date.now() + 150000
while (Date.now() < deadline) {
  const l = await rpc('session/list', { _request: {} })
  const it = (l.json?.result?.value?.items || []).find((x) => x.sessionId === sessionId)
  const stats = it?.projections?.values?.sessionStats
  const tok = it?.projections?.values?.tokenUsage
  if (stats && stats.llmMs > 0 && tok && tok.outputTokens > 0) {
    reply = JSON.stringify({ llmMs: stats.llmMs, outputTokens: tok.outputTokens, title: it?.projections?.values?.title })
    break
  }
  lastText = JSON.stringify(it?.projections?.values || {}).slice(0, 600)
  await sleep(3000)
}
results.replyFound = !!reply
results.replySample = (reply || lastText).slice(0, 3000)
log('回复是否出现:', results.replyFound)

results.overall = !!sessionId && !!results.promptSent && results.replyFound
fs.writeFileSync(OUT, JSON.stringify(results, null, 2))
log('结果写入', OUT)
process.exit(results.overall ? 0 : 1)
