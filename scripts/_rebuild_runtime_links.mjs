/**
 * 把源仓库 packages 各子包下所有已构建的 @deepseek-ai 包，以「规范名 junction」形式
 * 补挂进部署运行时的 @deepseek-ai/ 目录。
 *
 * 背景：部署运行时的 @deepseek-ai 是 cordis 插件组哈希布局（.dsh-xxx-HASH），
 * 部分包缺 lib/、部分包完全缺失，导致 dsh web 启动时 loader 逐条 import 失败：
 *   failed to import loader entry agent (@deepseek-ai/dsh-agent): Cannot find package
 * 表现为 exe 永远停在「正在启动 DSH Web 工作台...」。
 *
 * 策略：源仓库 packages 是 0.1.2-alpha.1 与部署版本一致，且 250/251 个包已构建出
 * lib/。直接把源仓库包目录以 junction 挂成规范名，node 解析即可命中完整产物。
 * 纯增量：已存在的路径（含既有哈希目录解析出的 junction）一律跳过，不删任何东西。
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

const REPO_PK = 'D:/WorkSpace/deepseek-harness-master/packages'
const AI = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai'

// 1. 收集源仓库所有已构建的 @deepseek-ai 包
const pkgs = new Map() // name -> { dir, main }
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
        pkgs.set(j.name, { dir: dirname(p), main: j.main || 'lib/index.js', version: j.version })
      }
    }
  }
}
walk(REPO_PK, 0)
console.log('源仓库发现', pkgs.size, '个 @deepseek-ai 包')

mkdirSync(AI, { recursive: true })

// 2. 建立规范名 junction（仅当目标不存在时）
let linked = 0, hashedLinked = 0, skipped = 0, noLib = []
for (const [name, info] of pkgs) {
  const short = name.slice('@deepseek-ai/'.length)
  const link = join(AI, short)

  if (!existsSync(join(info.dir, info.main))) { noLib.push(name); continue }

  if (existsSync(link)) {
    // 已存在：若它不是 junction 或不是指向源仓库，仍保留（可能是刚补部署的核心包）
    skipped++
    continue
  }
  try { symlinkSync(info.dir, link, 'junction'); linked++ }
  catch (e) { console.log('FAIL', short, e.code) }
}
console.log(`规范名 junction 新建 ${linked} 个，已存在跳过 ${skipped} 个`)
if (noLib.length) console.log('无 lib 产物(未链接):', noLib.join(', '))

// 3. 校验关键包可解析 + dsh CLI 可启动
const probes = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-anonymous-user-id',
  '@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-api-settings-controller',
  '@deepseek-ai/dsh-command-feedback', '@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-session-telemetry-otel', '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-fork-in-process', '@deepseek-ai/dsh-subagent-spawn-in-process']
const require = createRequire(join(AI, 'noop.js'))
let ok = 0, fail = []
for (const p of probes) {
  try { require.resolve(p, { paths: [AI] }); ok++ }
  catch (e) { fail.push(p + ' (' + e.code + ')') }
}
console.log(`关键包解析: ${ok}/${probes.length} OK`)
if (fail.length) console.log('解析失败:', fail.join(', '))
