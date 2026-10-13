/**
 * 为部署运行时的 @deepseek-ai 插件组哈希目录建立「规范名 junction」。
 *
 * 背景：D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai 下全是
 * cordis 插件组哈希目录（.dsh-<name>-<hash>），Node 的常规 ESM/CJS 解析不认识它们，
 * 因此 dsh CLI（lib/bin.js）启动链上任何 `import '@deepseek-ai/xxx'` 都会
 * ERR_MODULE_NOT_FOUND —— 表现为 dsh web 起不来、主窗口退化成静态兜底。
 *
 * 修复：为每个哈希目录里的 package.json#name 建一个同 scope 的规范名 junction
 * （@deepseek-ai/<basename> -> .dsh-<name>-<hash>）。纯增量，不删除/不改动既有内容；
 * 已存在的实目录（如刚补部署的 cordis / cosmokit / dsh）会跳过。
 */
import { readdirSync, readFileSync, existsSync, lstatSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const AI = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai'

let created = 0
let skipped = 0
let failed = 0
const collisions = []

for (const entry of readdirSync(AI)) {
  const pkgPath = join(AI, entry, 'package.json')
  let name
  try { name = JSON.parse(readFileSync(pkgPath, 'utf8')).name } catch { continue }
  if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) continue
  const bare = name.slice('@deepseek-ai/'.length)
  if (!bare) continue
  const link = join(AI, bare)
  if (existsSync(link)) {
    skipped++
    // 记录非 junction 的实目录（可能是我们刚补部署的核心包）
    try { if (!lstatSync(link).isSymbolicLink()) collisions.push(bare + ' (实目录)') } catch {}
    continue
  }
  try { symlinkSync(join(AI, entry), link, 'junction'); created++ }
  catch (e) { failed++; console.log('FAIL', bare, e.code) }
}

console.log(`完成：新建 junction ${created} 个，已存在跳过 ${skipped} 个，失败 ${failed} 个`)
if (collisions.length) console.log('已存在的实目录（未被覆盖）：', collisions.join(', '))
