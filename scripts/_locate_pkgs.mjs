import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const PK = 'D:/WorkSpace/deepseek-harness-master/packages'
const WANT = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-anonymous-user-id',
  '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-agent-presets']

const map = new Map()
function walk(d, depth) {
  if (depth > 3) return
  let ents
  try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const x of ents) {
    const p = join(d, x.name)
    if (x.isDirectory()) {
      if (['node_modules', 'lib', 'src', 'tests', 'dist'].includes(x.name)) continue
      walk(p, depth + 1)
    } else if (x.name === 'package.json') {
      let j
      try { j = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }
      if (j.name) map.set(j.name, { dir: dirname(p), main: j.main || 'lib/index.js', version: j.version })
    }
  }
}
walk(PK, 0)
console.log('源仓库共发现', map.size, '个 @deepseek-ai 包')
for (const w of WANT) {
  const hit = map.get(w)
  if (!hit) { console.log('✗', w, '(源仓库也没有)'); continue }
  const lib = join(hit.dir, hit.main)
  console.log('✓', w, '@' + hit.version, '| lib:', existsSync(lib) ? '有' : '缺!', '|', hit.dir)
}
