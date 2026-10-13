// 端到端验证 modlens 视觉桥接：用真实图片调用智谱 glm-4v-plus，确认返回文字证据。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeImages, loadModlensConfig } from './harness-dist/modlens.js'

const imgPath = process.argv[2] || 'C:/Users/Administrator/.workbuddy/clipboard-images/clipboard-2026-09-01T11-13-37-203Z-cd05710d.png'
const buf = readFileSync(imgPath)
const b64 = buf.toString('base64')
const mime = imgPath.endsWith('.png') ? 'image/png' : 'image/jpeg'

// 复用 D:\DeepSeekAgent\.env 里的智谱 Key（如存在）
let apiKey = ''
try {
  const envText = readFileSync('D:/DeepSeekAgent/.env', 'utf8')
  for (const line of envText.split('\n')) {
    const m = line.match(/^(ZHIPU_API_KEYS|ZHIPU_API_KEY)=(.*)$/)
    if (m) { apiKey = m[2].trim().split(',')[0]; break }
  }
} catch {}

const cfg = loadModlensConfig(process.env, { apiKey, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' })
console.log('[verify] modlens model=', cfg.model, 'baseUrl=', cfg.baseUrl, 'key?', !!cfg.apiKey)

const t0 = Date.now()
const descs = await describeImages([{ type: 'image', mimeType: mime, data: b64, name: 'clipboard.png' }], cfg)
const dt = Date.now() - t0
console.log('[verify] elapsedMs=', dt)
console.log('[verify] descLen=', descs[0]?.length || 0)
console.log('[verify] descHead=', (descs[0] || '').slice(0, 300))
console.log(descs[0] && descs[0].length > 20 ? 'MODLENS_OK' : 'MODLENS_FAIL')
