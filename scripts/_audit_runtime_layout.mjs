/**
 * 审计部署态 dsh-runtime/node_modules/@deepseek-ai 的链接形态，找出：
 *   A) junction 直接指向源码仓库 D:\WorkSpace\deepseek-harness-master\packages\*  -> 致命（模块身份错乱 + 打包失效）
 *   B) 规范名 junction -> .dsh-xxx-HASH                                            -> 正常
 *   C) 真实目录                                                                    -> 正常
 *   D) 缺失（在 runtime-dist 有、部署态没有）                                       -> 需补
 * 同时对比 desktop/runtime-dist 的对应形态，输出可供修复的映射。
 */
import fs from 'node:fs'
import path from 'node:path'

const DEPLOY = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai'
const DIST = 'D:/WorkSpace/deepseek-harness-master/desktop/runtime-dist/node_modules/@deepseek-ai'
const SRC_PREFIXES = ['D:\\WorkSpace\\deepseek-harness-master', '/d/WorkSpace/deepseek-harness-master']

const linkTarget = (p) => {
  try { return fs.readlinkSync(p) } catch { return null }
}

function classify(entry) {
  const full = path.join(DEPLOY, entry)
  let st
  try { st = fs.lstatSync(full) } catch { return { kind: 'missing' } }
  if (st.isSymbolicLink()) {
    const t = linkTarget(full) || ''
    const norm = t.replace(/\//g, '\\')
    if (SRC_PREFIXES.some((p) => norm.toLowerCase().startsWith(p.replace(/\//g, '\\').toLowerCase()))) {
      return { kind: 'SRC-LINK', target: t }
    }
    if (/\\\.dsh-[^\\]+$|\\\.schemastery-/.test(norm)) return { kind: 'hash-link', target: t }
    return { kind: 'other-link', target: t }
  }
  if (st.isDirectory()) return { kind: 'dir' }
  return { kind: 'file' }
}

const deployEntries = fs.readdirSync(DEPLOY)
const distEntries = new Set(fs.readdirSync(DIST))

const cat = { dir: [], 'hash-link': [], 'other-link': [], 'SRC-LINK': [] }
for (const e of deployEntries) {
  const c = classify(e)
  if (c.kind === 'missing' || c.kind === 'file') continue
  cat[c.kind].push({ name: e, target: c.target })
}

// 部署态规范名集合（排除点开头的 hash 目录）
const canon = new Set(deployEntries.filter((e) => !e.startsWith('.')))
// hashed 目录（.dsh-xxx-HASH）
const hashed = deployEntries.filter((e) => /^\.dsh-|^\.schemastery-/.test(e))
// 无法通过规范名访问的 hash 目录（即没有对应 junction）
const canonTargets = new Set()
for (const e of canon) {
  const t = linkTarget(path.join(DEPLOY, e))
  if (t) canonTargets.add(path.basename(t.replace(/[\\/]+$/, '')))
}
const orphanHash = hashed.filter((h) => !canonTargets.has(h))

console.log('=== 部署态 @deepseek-ai 审计 ===')
console.log('总条目           :', deployEntries.length)
console.log('  真实目录       :', cat.dir.length)
console.log('  hash-link(正常):', cat['hash-link'].length)
console.log('  other-link     :', cat['other-link'].length)
console.log('  SRC-LINK(致命) :', cat['SRC-LINK'].length)
console.log('  hash 目录总数  :', hashed.length)
console.log('  孤立 hash 目录 :', orphanHash.length)

console.log('\n=== SRC-LINK（junction 指回源码仓库，必须修复）===')
for (const x of cat['SRC-LINK'].sort((a, b) => a.name.localeCompare(b.name))) {
  const base = path.basename(x.target.replace(/[\\/]+$/, ''))
  const inDist = distEntries.has(x.name) ? 'dist有同名' : 'dist无同名'
  const hashFor = hashed.find((h) => h === `.${x.name}-` || h.startsWith(`.${x.name}-`))
  console.log(` ${x.name.padEnd(42)} -> .../${base.padEnd(28)} ${inDist}${hashFor ? ' hash存在:' + hashFor : ''}`)
}

console.log('\n=== 部署态有规范名但 dist 没有的（部署独有）===')
for (const e of [...canon].sort()) if (!distEntries.has(e)) console.log('  ', e)

console.log('\n=== dist 有但部署态缺规范名的 ===')
for (const e of [...distEntries].sort()) if (!canon.has(e)) console.log('  ', e)

console.log('\n=== 孤立 hash 目录（无规范名 junction，可能被漏挂）===')
for (const h of orphanHash.sort()) console.log('  ', h)

fs.writeFileSync(
  'D:/WorkSpace/deepseek-harness-master/_tmp_runtime_audit.json',
  JSON.stringify({ summary: { deployTotal: deployEntries.length, dir: cat.dir.length, hashLink: cat['hash-link'].length, otherLink: cat['other-link'].length, srcLink: cat['SRC-LINK'].length, orphanHash: orphanHash.length }, srcLinks: cat['SRC-LINK'], otherLinks: cat['other-link'], orphanHash, deployOnly: [...canon].filter((e) => !distEntries.has(e)), distOnly: [...distEntries].filter((e) => !canon.has(e)) }, null, 2),
)
console.log('\n审计结果写入 _tmp_runtime_audit.json')
