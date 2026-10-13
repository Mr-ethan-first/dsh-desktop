/**
 * 修复部署态 dsh-runtime 中 35 个「junction 指回源码仓库」的包：
 *   用真实目录替换 junction，内容取自
 *     1) desktop/runtime-dist/node_modules/@deepseek-ai/<name>   （12 个）
 *     2) 工作区 packages 下的同名包                                （23 个）
 * 拷贝时跳过 node_modules / src / tests，使其依赖统一从部署态 runtime 解析
 * —— 这是消除「两套 cordis 实例」的关键。
 * 原始 junction 目标已记录在 _tmp_runtime_audit.json（可回滚）。
 * 用法：node scripts/_fix_runtime_srclinks.mjs [--dry] [--only a,b,c]
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/WorkSpace/deepseek-harness-master'
const DEPLOY_AI = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai'
const DIST_AI = path.join(ROOT, 'desktop/runtime-dist/node_modules/@deepseek-ai')
const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const onlyIdx = args.indexOf('--only')
const ONLY = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null

const audit = JSON.parse(fs.readFileSync(path.join(ROOT, '_tmp_runtime_audit.json'), 'utf8'))
const plan = JSON.parse(fs.readFileSync(path.join(ROOT, '_tmp_fix_plan.json'), 'utf8'))
const planByName = new Map(plan.map((p) => [p.name, p]))

const SKIP_DIRS = new Set(['node_modules', 'src', 'tests', '.git', 'dist-types'])

function copyPkg(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  let files = 0, bytes = 0
  const walk = (from, to) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue
      if (e.name === 'tsconfig.tsbuildinfo') continue
      const f = path.join(from, e.name)
      const t = path.join(to, e.name)
      if (e.isSymbolicLink()) {
        // 浅链接（极少数）：解引用为真实文件/目录
        const st = fs.statSync(f)
        if (st.isDirectory()) { fs.mkdirSync(t, { recursive: true }); walk(f, t) }
        else { fs.copyFileSync(f, t); files++; bytes += fs.statSync(t).size }
        continue
      }
      if (e.isDirectory()) { fs.mkdirSync(t, { recursive: true }); walk(f, t) }
      else { fs.copyFileSync(f, t); files++; bytes += fs.statSync(t).size }
    }
  }
  walk(src, dst)
  return { files, bytes }
}

const results = []
for (const link of audit.srcLinks) {
  const name = link.name
  if (ONLY && !ONLY.has(name)) continue
  const p = planByName.get(name)
  const full = path.join(DEPLOY_AI, name)
  if (!p?.src) { results.push({ name, ok: false, err: 'no source' }); continue }
  let st
  try { st = fs.lstatSync(full) } catch { results.push({ name, ok: false, err: 'lstat failed' }); continue }
  if (!st.isSymbolicLink()) { results.push({ name, ok: true, skipped: 'not a link' }); continue }
  if (DRY) { results.push({ name, ok: true, dry: true, src: p.src, why: p.why }); continue }
  try {
    fs.unlinkSync(full) // 删除 junction 本身（不跟随）
    if (fs.existsSync(full)) throw new Error('junction 未被移除')
    const r = copyPkg(p.src, full)
    const okLib = fs.existsSync(path.join(full, 'lib/index.js')) || fs.existsSync(path.join(full, 'lib/index.cjs'))
    results.push({ name, ok: okLib, why: p.why, files: r.files, kb: Math.round(r.bytes / 1024) })
  } catch (e) {
    results.push({ name, ok: false, err: String(e.message).slice(0, 120) })
  }
}

const ok = results.filter((r) => r.ok).length
console.log(`=== 实体化结果 ${ok}/${results.length}${DRY ? ' (DRY RUN)' : ''} ===`)
for (const r of results) {
  console.log(` ${r.ok ? ' OK ' : 'FAIL'} ${r.name.padEnd(40)} ${r.why || ''} ${r.files != null ? r.files + ' files ' + r.kb + 'KB' : ''}${r.err ? ' ERR:' + r.err : ''}${r.dry ? ' <- ' + r.src : ''}`)
}
fs.writeFileSync(path.join(ROOT, '_tmp_fix_srclinks_result.json'), JSON.stringify(results, null, 2))

// 复核：确保不再有指回源码仓库的 link
if (!DRY) {
  const left = []
  for (const e of fs.readdirSync(DEPLOY_AI)) {
    const f = path.join(DEPLOY_AI, e)
    try {
      if (fs.lstatSync(f).isSymbolicLink()) {
        const t = (fs.readlinkSync(f) || '').replace(/\//g, '\\')
        if (t.toLowerCase().startsWith('d:\\workspace\\deepseek-harness-master')) left.push(e)
      }
    } catch { /* ignore */ }
  }
  console.log('\n复核：仍指回源码仓库的条目 =', left.length ? left.join(', ') : '0（已清零）')
}
