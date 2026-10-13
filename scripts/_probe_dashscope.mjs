/**
 * 百炼（DashScope）连通性探针 —— 单次、最小 token 的真实 API 调用。
 * 用途：在跑完整 e2e 前先确认 key 有效 + 端点可达 + 列出可用模型，
 *       避免把后续昂贵的 e2e 调用浪费在无效凭证上。
 *
 * 节流：本脚本只发 1 次请求。
 */
import { execSync } from 'node:child_process'

function readMachineEnv(name) {
  const ps = `[Environment]::GetEnvironmentVariable('${name}', 'Machine')`
  const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' })
  return (out || '').trim()
}

const KEY = readMachineEnv('AI_DASHSCOPE_API_KEY')
if (!KEY) { console.error('FATAL: AI_DASHSCOPE_API_KEY 未取到'); process.exit(2) }
console.log('key: length=' + KEY.length + ' prefix=' + KEY.slice(0, 6) + '***')

const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

async function callOnce(model) {
  const body = {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 8,
    stream: false,
  }
  const t0 = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const ms = Date.now() - t0
  return { status: res.status, ms, text }
}

// 先只测一个模型（free tier 限流：全程仅 1 次调用）
const MODEL = process.argv[2] || 'qwen-plus'
console.log('--- single call: model=' + MODEL + ' ---')
const r = await callOnce(MODEL)
console.log('status=' + r.status + ' ms=' + r.ms)
if (r.status === 200) {
  try {
    const j = JSON.parse(r.text)
    console.log('OK reply=' + JSON.stringify(j.choices?.[0]?.message?.content))
    console.log('usage=' + JSON.stringify(j.usage))
  } catch (e) { console.log('parse warn: ' + e.message + ' | raw=' + r.text.slice(0, 300)) }
} else {
  console.log('FAIL body=' + r.text.slice(0, 600))
}
process.exit(r.status === 200 ? 0 : 1)
