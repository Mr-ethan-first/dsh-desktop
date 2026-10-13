/**
 * 修复部署运行时里「指向残缺哈希目录」的 @deepseek-ai 规范名 junction。
 *
 * 背景：哈希目录布局（.dsh-xxx-HASH）中有部分包缺 lib/（甚至完全缺包），
 * 若规范名 junction 指向它，import 仍会失败。源仓库 packages 是完整构建产物
 * （251 包中 250 个有 lib/），因此把这类 junction 重定向到源仓库包目录。
 *
 * 只针对「目标缺 main 入口」的 junction 做重指；其余一律不动。
 */
import { readdirSync, readFileSync, existsSync, lstatSync, unlinkSync, symlinkSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'

const REPO_PK = 'D:/WorkSpace/deepseek-harness-master/packages'
const AI = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai'

// 1. 源仓库包表
const srcPkgs = new Map()
function walk(d, depth) {
  if (depth > 3) return
  let ents
  try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const x of ents) {
    const p = join(d, x.name)
    if (x.isDirectory()) {
      if (['node_modules', 'lib', 'src', 'tests', 'dist', 'scripts'].includes(x.name)) continue
      walk(p, depth + 1)
    } else if (x.name === 'package.json') {
      let j
      try { j = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }
      if (typeof j.name === 'string' && j.name.startsWith('@deepseek-ai/')) {
        srcPkgs.set(j.name, { dir: dirname(p), main: j.main || 'lib/index.js' })
      }
    }
  }
}
walk(REPO_PK, 0)

// 2. 遍历部署侧的规范名条目，找出目标缺 main 的 junction 并重指
let repaired = 0, healthy = 0, unresolved = []
for (const entry of readdirSync(AI)) {
  if (entry.startsWith('.')) continue
  const linkPath = join(AI, entry)
  let st
  try { st = lstatSync(linkPath) } catch { continue }
  if (!st.isSymbolicLink()) continue // 实目录不碰

  const name = '@deepseek-ai/' + entry
  let curTarget = ''
  try { curTarget = readlinkSync(linkPath) } catch {}

  // 当前目标是否有可用入口？
  const curMain = join(curTarget, 'package.json')
  let curOk = false
  if (existsSync(curMain)) {
    try {
      const j = JSON.parse(readFileSync(curMain, 'utf8'))
      curOk = existsSync(join(curTarget, j.main || 'lib/index.js'))
    } catch {}
  }
  if (curOk) { healthy++; continue }

  const src = srcPkgs.get(name)
  if (!src || !existsSync(join(src.dir, src.main))) { unresolved.push(name); continue }

  try {
    unlinkSync(linkPath)                 // 只解除 reparse point，不删目标内容
    symlinkSync(src.dir, linkPath, 'junction')
    repaired++
    console.log('repaired:', entry, '-> ', src.dir)
  } catch (e) { unresolved.push(name + ' (' + e.code + ')') }
}

console.log(`\n结果：重指 ${repaired} 个，本就健康 ${healthy} 个`)
if (unresolved.length) console.log('仍无法解决:', unresolved.join(', '))
