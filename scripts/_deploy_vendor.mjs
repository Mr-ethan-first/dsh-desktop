/**
 * 把 vendored 核心包（@deepseek-ai/cordis、@deepseek-ai/cosmokit）补部署到
 * D:/DeepSeekAgent 的 dsh-runtime。
 *
 * 背景：部署运行时里 @deepseek-ai 全部是 cordis 插件组哈希目录（.dsh-xxx-HASH），
 * 但 cordis / cosmokit 是 peer 级别的运行时核心，未被纳入哈希布局，导致
 * dsh CLI（lib/bin.js）在 `import '@deepseek-ai/cordis'` 时 ERR_MODULE_NOT_FOUND，
 * 进而 main.cjs resolveDshBin 后 dsh web 无法启动。
 *
 * 只做增量复制 + 规范名目录，不删除任何既有内容。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const VENDOR = 'D:/WorkSpace/deepseek-harness-master/vendor'
const AI = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai'

// 通用：把 vendor/ 下所有 vendored 包补部署到运行时的规范名目录。
// 这些包是 cordis 核心生态（peer 级），不参与插件组哈希布局，因此哈希目录里没有它们。
const PKGS = []
for (const dir of readdirSync(VENDOR)) {
  const pkgPath = join(VENDOR, dir, 'package.json')
  if (!existsSync(pkgPath)) continue
  let name
  try { name = JSON.parse(readFileSync(pkgPath, 'utf8')).name } catch { continue }
  if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) continue
  PKGS.push({ name, src: join(VENDOR, dir), parts: ['lib', 'bin.js', 'package.json', 'LICENSE', 'src'] })
}
console.log('待补部署 vendored 包:', PKGS.map((p) => p.name).join(', '))

mkdirSync(AI, { recursive: true })

for (const p of PKGS) {
  if (!existsSync(p.src)) { console.log('MISS source:', p.src); continue }
  const dst = join(AI, p.name.split('/')[1])
  let copied = 0
  for (const part of p.parts) {
    const s = join(p.src, part)
    if (!existsSync(s)) continue
    const d = join(dst, part)
    if (existsSync(d)) { console.log('skip(exists):', d); continue }
    cpSync(s, d, { recursive: true })
    copied++
  }
  const v = existsSync(join(dst, 'package.json'))
    ? JSON.parse(readFileSync(join(dst, 'package.json'), 'utf8')).version : '?'
  console.log(`deployed ${p.name}@${v} -> ${dst} (新增 ${copied} 项)`)
}

// 校验：dsh CLI 能否启动
const CLI = join(AI, 'dsh', 'lib', 'bin.js')
const nodes = [
  'D:/DeepSeekAgent/DeepSeekAgent.exe',
  'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node.exe',
]
for (const node of nodes) {
  if (!existsSync(node)) continue
  const env = { ...process.env }
  if (node.includes('DeepSeekAgent')) env.ELECTRON_RUN_AS_NODE = '1'
  delete env.NODE_OPTIONS
  const r = spawnSync(node, [CLI, '--version'], { env, encoding: 'utf8', cwd: AI })
  console.log(`--- ${node} ---`)
  console.log('exit=', r.status, '| out=', (r.stdout || '').trim().slice(0, 160))
  if (r.status !== 0) console.log('err=', (r.stderr || '').trim().slice(0, 500))
  if (r.status === 0) { console.log('VERIFY OK'); break }
}
