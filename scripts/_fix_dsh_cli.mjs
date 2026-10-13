/**
 * 修复部署运行时缺失的 dsh CLI 入口。
 *
 * 现象：D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai 全部是
 *       cordis 插件组哈希目录（.dsh-xxx-HASH），没有规范名目录，且 @deepseek-ai/dsh
 *       缺少 lib/（files: ["lib/*.js"] 未被带入）。
 *       后果：main.cjs resolveDshBin() 返回 null → dsh web 不启动 → 主窗口只剩静态兜底。
 *
 * 修复：
 *   1. 把源仓库 apps/cli 的构建产物 lib/ 复制到 dsh 包目录（哈希目录或规范名目录）。
 *   2. 为 dsh 与其直接依赖 @deepseek-ai/dsh-app-boot 建立规范名 junction，
 *      让 node 的常规解析能找到它们（不影响 cordis 原有的哈希目录机制，纯增量）。
 *
 * 用法：node scripts/_fix_dsh_cli.mjs [--verify-only]
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, symlinkSync, cpSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const RUNTIME_NM = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules'
const AI = join(RUNTIME_NM, '@deepseek-ai')
const SRC_CLI = 'D:/WorkSpace/deepseek-harness-master/apps/cli'

// 1. 依据 package.json 的 name 定位哈希目录
function findByName(scopeDir, pkgName) {
  for (const e of readdirSync(scopeDir)) {
    let j
    try { j = JSON.parse(readFileSync(join(scopeDir, e, 'package.json'), 'utf8')) } catch { continue }
    if (j.name === pkgName) return { dir: join(scopeDir, e), entry: e, pkg: j }
  }
  return null
}

const dsh = findByName(AI, '@deepseek-ai/dsh')
if (!dsh) { console.error('FATAL: 运行时未找到 @deepseek-ai/dsh'); process.exit(2) }
console.log('dsh 包目录:', dsh.entry, 'version:', dsh.pkg.version)

// 2. 补齐 lib/
const srcLib = join(SRC_CLI, 'lib')
if (!existsSync(srcLib)) { console.error('FATAL: 源仓库 apps/cli/lib 不存在，请先构建 CLI'); process.exit(2) }
if (!existsSync(join(dsh.dir, 'lib', 'bin.js'))) {
  cpSync(srcLib, join(dsh.dir, 'lib'), { recursive: true })
  console.log('已复制 apps/cli/lib ->', join(dsh.dir, 'lib'))
} else {
  console.log('lib/bin.js 已存在，跳过复制')
}

// 3. 建立规范名 junction（纯增量，不删除任何既有目录）
function ensureJunction(linkPath, target) {
  if (existsSync(linkPath)) { console.log('已存在(跳过):', linkPath); return }
  mkdirSync(join(linkPath, '..'), { recursive: true })
  symlinkSync(target, linkPath, 'junction')
  console.log('junction:', linkPath, '->', target)
}
ensureJunction(join(AI, 'dsh'), dsh.dir)

const boot = findByName(AI, '@deepseek-ai/dsh-app-boot')
if (boot) ensureJunction(join(AI, 'dsh-app-boot'), boot.dir)
else console.log('WARN: 未找到 @deepseek-ai/dsh-app-boot')

// 4. 校验：用部署可获得的 node 跑 --version
const nodeCandidates = [
  'D:/DeepSeekAgent/DeepSeekAgent.exe',
  'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node.exe',
  'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.12.0/node.exe',
]
for (const node of nodeCandidates) {
  if (!existsSync(node)) continue
  const env = { ...process.env }
  if (node.endsWith('.exe') && node.includes('DeepSeekAgent')) env.ELECTRON_RUN_AS_NODE = '1'
  delete env.NODE_OPTIONS
  const r = spawnSync(node, [join(AI, 'dsh', 'lib', 'bin.js'), '--version'], { env, encoding: 'utf8', cwd: RUNTIME_NM })
  console.log(`--- ${node} ---`)
  console.log('exit=', r.status, '| stdout=', (r.stdout || '').trim().slice(0, 200), '| stderr=', (r.stderr || '').trim().slice(0, 300))
  if (r.status === 0) { console.log('VERIFY OK (runtime=' + node + ')'); break }
}

console.log('done')
