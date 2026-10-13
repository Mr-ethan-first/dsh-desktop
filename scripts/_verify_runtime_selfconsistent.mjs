/**
 * 复核部署态运行时是否已「自洽」：
 *  1) 全量扫描 dsh-runtime/node_modules 与 resources/packages，找出任何仍指向
 *     D:\WorkSpace\deepseek-harness-master 的符号链接/目录联接。
 *  2) 对关键包做 module 解析，确认 @deepseek-ai/cordis 与 @deepseek-ai/schemastery
 *     都落到部署态 runtime（单一实例）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const DEPLOY_RT = 'D:/DeepSeekAgent/resources/dsh-runtime'
const ROOTS = [path.join(DEPLOY_RT, 'node_modules'), 'D:/DeepSeekAgent/resources/packages']
const SRC_RE = /^d:[\\/]+workspace[\\/]+deepseek-harness-master/i
const bad = []

function scan(dir, depth) {
  if (depth > 3) return
  let es
  try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of es) {
    const f = path.join(dir, e.name)
    let lst
    try { lst = fs.lstatSync(f) } catch { continue }
    if (lst.isSymbolicLink()) {
      let t = ''
      try { t = fs.readlinkSync(f) || '' } catch { /* ignore */
      }
      if (SRC_RE.test(t)) bad.push(f + '  ->  ' + t)
    } else if (lst.isDirectory() && !/^\.(pnpm|bin|cache)/.test(e.name)) {
      scan(f, depth + 1)
    }
  }
}

for (const r of ROOTS) scan(r, 0)
console.log('=== 仍指回源码仓库的链接数 =', bad.length, '===')
for (const b of bad.slice(0, 60)) console.log('  ', b)
fs.writeFileSync('D:/WorkSpace/deepseek-harness-master/_tmp_srclink_scan.txt', bad.join('\n'))

console.log('\n=== 关键包 module 解析（应全部落在部署态 runtime）===')
const names = [
  'dsh-agent-presets', 'dsh-agent', 'dsh-agent-loop', 'dsh-api-gateway',
  'dsh-persona', 'dsh-system-prompt', 'dsh-tool-subagent',
  'dsh-lsp', 'dsh-storage-sqlite', 'dsh-workspace-panel', 'dsh-tool-session-query',
]
const rel = (p) => p
  .replace(/\\/g, '/')
  .replace('D:/DeepSeekAgent/resources/dsh-runtime/node_modules/', '[RT]/')
  .replace('D:/WorkSpace/deepseek-harness-master/', '[SRC]/')

let cross = 0
for (const n of names) {
  const base = path.join(DEPLOY_RT, 'node_modules/@deepseek-ai', n, 'lib/index.js')
  if (!fs.existsSync(base)) { console.log(n.padEnd(24), '(no lib/index.js)'); continue }
  const r = createRequire(base)
  const out = []
  for (const spec of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
    try {
      const p = r.resolve(spec)
      if (p.includes('deepseek-harness-master')) cross++
      out.push(spec.replace('@deepseek-ai/', '') + '=' + rel(p))
    } catch { out.push(spec.replace('@deepseek-ai/', '') + '=ERR') }
  }
  console.log(' ' + n.padEnd(24), out.join(' | '))
}
console.log('\n跨实例解析次数 =', cross, '(期望 0)')
