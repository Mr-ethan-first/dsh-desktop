/**
 * 为 resources/packages/extensions 下的社区插件补齐运行时依赖解析。
 *
 * 问题：cordis 从插件目录 `resources/packages/extensions/<plugin>/` 加载其 lib/index.js，
 * 而该目录不在 dsh-runtime 树下，插件 `import 'undici'`（dsh-market 的 net.js）会沿
 *   extensions/dsh-market/node_modules → extensions/node_modules → packages/node_modules → resources/node_modules
 * 向上查找，全部落空 → ERR_MODULE_NOT_FOUND → 整个插件树 apply 失败 → dsh web 退出。
 *
 * 方案：在每个插件目录下建 node_modules，并把 dsh-runtime/node_modules 里的顶层依赖
 * 以 junction 逐个挂进来（只挂该插件 package.json 声明且运行时确实存在的依赖）。
 * 纯增量，不删除任何内容。
 */
import { existsSync, mkdirSync, symlinkSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const EXT = 'D:/DeepSeekAgent/resources/packages/extensions'
const RT_NM = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules'

for (const dir of readdirSync(EXT)) {
  const pkgDir = join(EXT, dir)
  const pkgPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) continue
  let pkg
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { continue }

  // 该插件声明的运行期依赖（dependencies + peerDependencies）
  const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.peerDependencies || {})])
  if (!declared.size) continue

  const nm = join(pkgDir, 'node_modules')
  let made = 0
  for (const dep of declared) {
    // @deepseek-ai/* 由 runtime 侧解析（那里已有规范名 junction），此处跳过
    if (dep.startsWith('@deepseek-ai/')) continue
    const src = join(RT_NM, dep)
    if (!existsSync(src)) continue
    const link = join(nm, dep)
    if (existsSync(link)) continue
    mkdirSync(join(link, '..'), { recursive: true })
    try { symlinkSync(src, link, 'junction'); made++ }
    catch (e) { console.log('FAIL', dir, dep, e.code) }
  }
  if (made) console.log(`${dir}: 挂载 ${made} 个依赖 -> node_modules`)
}

// 校验：逐个插件解析其声明的运行期依赖
console.log('\n--- 校验 ---')
for (const dir of readdirSync(EXT)) {
  const pkgDir = join(EXT, dir)
  const pkgPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) continue
  let pkg
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { continue }
  const deps = Object.keys(pkg.dependencies || {}).filter((d) => !d.startsWith('@deepseek-ai/'))
  if (!deps.length) continue
  const require = createRequire(join(pkgDir, 'noop.js'))
  const bad = []
  for (const d of deps) { try { require.resolve(d) } catch { bad.push(d) } }
  console.log(bad.length ? `✗ ${dir}: 缺 ${bad.join(', ')}` : `✓ ${dir}: ${deps.length} 个依赖均可解析`)
}
