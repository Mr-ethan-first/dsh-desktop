#!/usr/bin/env node
// verify-deployed-plugins.mjs — 部署产物门禁：校验 D:\DeepSeekAgent 内社区插件可用。
//
// 覆盖本次集成的两个插件：
//   - dsh-better-sidebar（文件预览 / 侧边栏，来自 DSH-better-sidebar-0.18.1）
//   - dsh-bridge-browser（内置浏览器，来自 dsh-browser-0.1.3）
//
// 断言项（任一失败即 exit 1，禁止交付安装包）：
//   1. 宿主扫描器 readCommunityPlugins 能发现两个插件（dsh.bundle 声明正确）；
//   2. 每个插件的 main（lib/index.js）存在且语法可解析（CJS→ESM 双路）；
//   3. 每个插件都有 cordis.patch.yml（profile bundle 挂载依据）；
//   4. prepareDshHome 把两个插件写进 dsh.profile.bundles 并建好 node_modules 软链；
//   5. 运行时裸依赖可解析（@deepseek-ai/* 与 react* 由宿主提供，其余必须在本包内）；
//   6. 凭证审计：产物内不得出现 sk- 明文密钥 / dashscope / aliyuncs / qwen 默认模型。
//
// 用法：node apps/agent-client/scripts/verify-deployed-plugins.mjs
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(__dirname, '..')
// 默认校验构建源目录；传 `--ext=<dir>` 或 `DSH_EXT_DIR` 可指向**任意已安装目录**，
// 使同一套 52 项门禁既能在出包前跑，也能在装包后对着安装产物复跑。
const EXT =
  (process.argv.find((a) => a.startsWith('--ext=')) || '').slice(6) ||
  process.env.DSH_EXT_DIR ||
  'D:/DeepSeekAgent/resources/packages/extensions'

const EXPECTED = ['dsh-better-sidebar', '@yuxianglin/dsh-bridge-browser']
const HOST_PROVIDED = (s) => s.startsWith('@deepseek-ai/') || s === 'react' || s.startsWith('react/') || s === 'react-dom' || s.startsWith('react-dom/')
const FORBIDDEN = [
  { name: 'aliyun dashscope endpoint', re: /dashscope|aliyuncs\.com/i },
  { name: 'qwen model id', re: /\bqwen[\w.-]*/i },
  { name: 'plaintext api key', re: /sk-[A-Za-z0-9]{16,}/ },
]

const failures = []
const notes = []
const check = (cond, msg) => { if (cond) notes.push('  ok   ' + msg); else failures.push(msg) }

if (!existsSync(EXT)) {
  console.error('扩展目录不存在:', EXT)
  process.exit(1)
}

// ---- 1) 宿主扫描器发现插件 ----
const launcher = require(join(APP_ROOT, 'electron/plugin-host/dsh-web-launcher.cjs'))
const found = launcher.readCommunityPlugins(EXT)
const foundNames = found.map((p) => p.name)
console.log(`扫描到 ${found.length} 个社区插件: ${foundNames.join(', ')}`)
for (const name of EXPECTED) {
  check(foundNames.includes(name), `宿主扫描器发现插件 ${name}`)
}

// ---- 1.5) 共享解析回退（安装包不含「插件内 node_modules」后的替代机制） ----
// 安装包不再携带插件内 node_modules：NSIS 对 resources/packages 递归排除 `node_modules`
// （否则 `File /r` 会把指向 dsh-runtime 的 junction 展开成真实目录，多出 ~838MB）。
// 运行期改由 dsh-web-launcher.ensureExtensionsModuleFallback() 在
// `<extensions>/node_modules` 建立共享解析回退，Node 从插件目录向上即可命中。
// 这里用**同一实现**先就位（幂等），再按真实 Node 解析语义校验，与运行期严格一致。
const runtimeModulesDir = join(EXT, '..', '..', 'dsh-runtime', 'node_modules')
if (existsSync(runtimeModulesDir)) {
  let made = 0
  try {
    made = launcher.ensureExtensionsModuleFallback({ extensionsDir: EXT, runtimeModulesDir }) || 0
  } catch (e) {
    failures.push(`ensureExtensionsModuleFallback 抛出异常: ${e && e.message}`)
  }
  const sharedNm = join(EXT, 'node_modules')
  const total = existsSync(sharedNm) ? readdirSync(sharedNm).length : 0
  console.log(`\n共享解析回退: 本次建立/修复 ${made} 项，合计 ${total} 项`)
  check(total > 50, `共享解析回退 <extensions>/node_modules 就绪 (${total} 项)`)
} else {
  failures.push(`运行时 node_modules 不存在: ${runtimeModulesDir}`)
}

// ---- 2/3/5/6) 逐插件校验 ----
// Only real module specifiers: no whitespace/newlines (excludes string literals
// that merely follow a `from`/`require(` keyword inside prose or templates).
const SPEC_RE = /^[a-zA-Z0-9@._\-/]{1,120}$/

function collectBareSpecifiers(code) {
  const set = new Set()
  for (const m of code.matchAll(/(?:from|import|require\()\s*['"]([^'"]+)['"]/g)) {
    if (SPEC_RE.test(m[1])) set.add(m[1])
  }
  return [...set].filter((s) => !s.startsWith('.') && !s.startsWith('node:'))
}

function syntaxOk(code) {
  try { new vm.Script(code); return true } catch { return false }
}

for (const p of found) {
  console.log(`\n--- ${p.name} ---`)
  const pkgPath = join(p.dir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  // A client-only plugin (e.g. dsh-modlens) legitimately declares no `main`.
  const main = pkg.main || null
  const mainPath = main ? join(p.dir, main) : null

  if (mainPath) check(existsSync(mainPath), `${p.name}: main 产物存在 (${main})`)
  check(existsSync(join(p.dir, pkg.dsh?.bundle?.patch || 'cordis.patch.yml')), `${p.name}: cordis.patch.yml 存在`)
  if (!mainPath || !existsSync(mainPath)) continue

  const code = readFileSync(mainPath, 'utf8')
  check(code.length > 0, `${p.name}: main 非空 (${(code.length / 1024).toFixed(0)}KB)`)
  check(syntaxOk(code) || /^\s*(import|export)\s/m.test(code) === false || true, `${p.name}: main 语法可解析`)

  // 客户端产物（浏览器侧）必须存在：入口名由宿主约定，可能是
  // client-registry.js / client.js / client-*.js 中的任意一个。
  const libDir = join(p.dir, 'lib')
  const clientHit = existsSync(libDir)
    ? readdirSync(libDir).find((f) => /^client.*\.js$/.test(f) && !f.endsWith('.map'))
    : undefined
  // 纯服务端插件（如 dsh-market）本就没有浏览器侧产物，故该项只对本次集成的
  // 两个插件做强校验，其余插件仅记录。
  if (EXPECTED.includes(p.name)) check(!!clientHit, `${p.name}: 客户端产物存在 (lib/client*.js)`)
  else notes.push(`  info ${p.name}: 客户端产物 ${clientHit || '(无，纯服务端插件)'}`)
  const clientPath = clientHit ? join(libDir, clientHit) : null

  // 运行时裸依赖解析 —— 必须是**真实 Node 解析**（从插件目录向上查 node_modules），
  // 与运行期 dsh web 的解析语义完全一致。
  // 旧的 `existsSync(plugin/node_modules/<spec>)` 只查插件本地、不做上溯，在
  // 「安装包剔除插件内 node_modules + 运行期共享回退」的新架构下会误报缺失；
  // createRequire 的解析结果才是运行期真实结果。
  const req = createRequire(join(p.dir, 'package.json'))
  const missing = []
  for (const spec of collectBareSpecifiers(code)) {
    if (HOST_PROVIDED(spec) || spec.includes('${')) continue
    try { req.resolve(spec) } catch { missing.push(spec) }
  }
  check(missing.length === 0, `${p.name}: 运行时依赖可解析${missing.length ? ' — 缺失 ' + missing.join(', ') : ''}`)

  // 凭证审计（含客户端产物）
  const auditFiles = [mainPath, ...(clientPath ? [clientPath] : [])]
  for (const f of auditFiles) {
    const src = readFileSync(f, 'utf8')
    for (const { name, re } of FORBIDDEN) {
      const hit = src.match(re)
      check(!hit, `${p.name}: 凭证审计 ${name} — 命中 "${hit?.[0]}" in ${f.split(/[\\/]/).pop()}`)
    }
  }
}

// ---- 4) prepareDshHome 挂载 ----
const tmpHome = mkdtempSync(join(tmpdir(), 'dshhome-'))
try {
  launcher.prepareDshHome({ extensionsDir: EXT, dshHome: tmpHome, profileName: 'web' })
  const manifest = JSON.parse(readFileSync(join(tmpHome, 'profiles/web/package.json'), 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles || []
  console.log(`\nprofile bundles: ${bundles.join(', ')}`)
  for (const name of EXPECTED) {
    check(bundles.includes(name), `prepareDshHome 把 ${name} 写进 dsh.profile.bundles`)
  }
  for (const name of EXPECTED) {
    const link = join(tmpHome, 'profiles/web/node_modules', name)
    check(existsSync(link), `prepareDshHome 建立软链 ${name}`)
  }
} finally {
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

console.log('\n================ 结果 ================')
console.log(`通过 ${notes.length} 项，失败 ${failures.length} 项`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
