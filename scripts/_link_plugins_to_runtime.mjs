/**
 * 把已部署的社区插件挂进 dsh-runtime/node_modules，使 cordis-plugin-loader
 * 能按包名解析它们。
 *
 * 背景：cordis-plugin-loader 的 import 上下文是
 *   D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js
 * 因此 `import 'dsh-better-sidebar'` 会沿 dsh-runtime/node_modules 向上查找。
 * 官方插件（dsh-market 等）在 runtime 里有对应哈希目录，故可解析；
 * 新部署的两个插件只在 profile 目录里，runtime 里没有 → 启动期 loader 报
 *   failed to import loader entry better-sidebar (dsh-better-sidebar): Cannot find package
 * 导致整个插件树 apply 失败、dsh web 退出、exe 永远停在启动页。
 *
 * 修复：在 dsh-runtime/node_modules 下为每个插件建 junction，指向其部署目录。
 * 纯增量，不删除任何内容。
 */
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

const EXT = 'D:/DeepSeekAgent/resources/packages/extensions'
const RT_NM = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules'

// 需要挂载的插件：包名 -> 部署目录名
const PLUGINS = [
  { name: 'dsh-better-sidebar', dir: 'dsh-better-sidebar' },
  { name: '@yuxianglin/dsh-bridge-browser', dir: 'dsh-bridge-browser' },
]

mkdirSync(RT_NM, { recursive: true })

for (const p of PLUGINS) {
  const target = join(EXT, p.dir)
  const link = join(RT_NM, p.name)
  if (!existsSync(target)) { console.log('SKIP(源不存在):', target); continue }
  if (existsSync(link)) { console.log('已存在(跳过):', link); continue }
  mkdirSync(dirname(link), { recursive: true })
  try {
    symlinkSync(target, link, 'junction')
    console.log('linked:', link, '->', target)
  } catch (e) { console.log('FAIL', p.name, e.code) }
}

// 校验：以 loader 的上下文解析
const require = createRequire(join(RT_NM, 'noop.js'))
let ok = 0
for (const p of PLUGINS) {
  try { const r = require.resolve(p.name, { paths: [RT_NM] }); console.log('解析 OK  ', p.name, '->', r); ok++ }
  catch (e) { console.log('解析 FAIL', p.name, '->', e.code) }
}
console.log(`\n解析结果: ${ok}/${PLUGINS.length}`)
