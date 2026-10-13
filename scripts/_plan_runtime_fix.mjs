/**
 * 找出每个 SRC-LINK 包名的「真源目录」：
 *   1) desktop/runtime-dist/node_modules/@deepseek-ai/<name>      （首选）
 *   2) 工作区 packages 下二级目录 package.json 中 name === <name>  （次选）
 * 并列出该包运行期依赖，检查在部署态 runtime 中是否可解析。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/WorkSpace/deepseek-harness-master'
const DEPLOY_AI = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai'
const DIST_AI = path.join(ROOT, 'desktop/runtime-dist/node_modules/@deepseek-ai')
const audit = JSON.parse(fs.readFileSync(path.join(ROOT, '_tmp_runtime_audit.json'), 'utf8'))
const names = audit.srcLinks.map((x) => x.name)

// --- 建立 工作区 package name -> dir 索引（只扫 packages/*/*，深度 2） ---
const index = new Map()
const pkgsRoot = path.join(ROOT, 'packages')
for (const g of fs.readdirSync(pkgsRoot)) {
  const gp = path.join(pkgsRoot, g)
  if (!fs.statSync(gp).isDirectory()) continue
  for (const s of fs.readdirSync(gp)) {
    const sp = path.join(gp, s)
    let st; try { st = fs.statSync(sp) } catch { continue }
    if (!st.isDirectory()) continue
    const pj = path.join(sp, 'package.json')
    if (!fs.existsSync(pj)) continue
    try {
      const j = JSON.parse(fs.readFileSync(pj, 'utf8'))
      if (j.name) index.set(j.name, { dir: sp, pkg: j })
    } catch { /* ignore */ }
  }
}
console.log('工作区 package 索引条数:', index.size)

const plan = []
for (const name of names) {
  const distDir = path.join(DIST_AI, name)
  let src = null, why = ''
  if (fs.existsSync(path.join(distDir, 'package.json'))) { src = distDir; why = 'dist' }
  else {
    const hit = index.get('@deepseek-ai/' + name) || index.get(name)
    if (hit) { src = hit.dir; why = 'workspace' }
  }
  let libOk = false, presetsOk = false, hasNm = false, deps = []
  if (src) {
    libOk = fs.existsSync(path.join(src, 'lib/index.js')) || fs.existsSync(path.join(src, 'lib/index.cjs'))
    presetsOk = fs.existsSync(path.join(src, 'presets'))
    hasNm = fs.existsSync(path.join(src, 'node_modules'))
    try {
      const j = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'))
      deps = Object.keys({ ...(j.dependencies || {}), ...(j.peerDependencies || {}) })
    } catch { /* ignore */ }
  }
  // 依赖在部署态的可解析性
  const missing = []
  for (const d of deps) {
    const cand = d.startsWith('@deepseek-ai/')
      ? path.join(DEPLOY_AI, d.slice('@deepseek-ai/'.length))
      : path.join(DEPLOY_AI, '..', d)
    if (!fs.existsSync(cand)) missing.push(d)
  }
  plan.push({ name, src, why, libOk, presetsOk, hasNm, deps: deps.length, missing })
}

console.log('\n=== 修复映射 ===')
for (const p of plan) {
  const tag = p.src ? (p.why === 'dist' ? '[dist ]' : '[wsrc ]') : '[NONE ]'
  console.log(`${tag} ${p.name.padEnd(40)} lib=${p.libOk ? 'y' : 'N'} presets=${p.presetsOk ? 'y' : '-'} nm=${p.hasNm ? 'y' : '-'} deps=${p.deps}${p.missing.length ? ' 缺:' + p.missing.join(',') : ''}`)
}
console.log('\n无真源:', plan.filter((p) => !p.src).map((p) => p.name).join(', ') || '(无)')
console.log('lib 缺失:', plan.filter((p) => p.src && !p.libOk).map((p) => p.name).join(', ') || '(无)')
fs.writeFileSync(path.join(ROOT, '_tmp_fix_plan.json'), JSON.stringify(plan, null, 2))
console.log('\n写入 _tmp_fix_plan.json')
