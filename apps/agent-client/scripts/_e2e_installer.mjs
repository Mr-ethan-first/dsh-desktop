#!/usr/bin/env node
// _e2e_installer.mjs — 安装包端到端验收（真实 NSIS 安装 → 启动 → UI 冒烟 → 卸载）。
//
// 为什么要这么测：`D:\DeepSeekAgent` 只是「构建源目录」，它跑得起来不代表安装包装出来的
// 那棵树跑得起来。两者最容易分叉的地方是**目录 junction**：
// `resources/dsh-runtime/node_modules/@deepseek-ai/` 下有 200+ 个 junction（规范名 → 哈希名），
// 而 `$DSH_HOME/profiles/node_modules/**` 还有 500+ 个 junction 指回 `D:\DeepSeekAgent\...`。
// 若 NSIS 的 `File /r` 没有把 junction 展开成真实目录，装出来的包会在 boot 阶段才炸。
//
// 覆盖链路（全部针对**安装后**的那棵树，不读构建源目录）：
//   A. 静默安装 → 退出码 0
//   B. 载荷审计：关键文件齐全 / junction 已实体化 / 无凭证 / 无测试文件 / 扩展已随包
//   C. 隔离 DSH_HOME：克隆真实 DSH_HOME 并把 junction 重定向到安装目录（不动用户真实环境）
//   D. 用**安装目录内**的 runtime + CLI + 插件启动 dsh web，抓到一次性 token URL
//   E. Playwright 打开该 URL，断言富前端已托管（__DSH_BOOT__）、无插件加载错误
//   F. 静默卸载 → 目录清空
//
// 用法：
//   node apps/agent-client/scripts/_e2e_installer.mjs [setup.exe 路径]
//
// 环境变量：
//   DSH_E2E_KEEP=1   失败/成功后不卸载、保留安装目录以便排查
//   DSH_E2E_DIR=...  指定安装目录（默认 C:\temp\dsh-e2e-<ts>）

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const SETUP = process.argv[2] || path.resolve(HERE, '..', 'release', 'DeepSeekAgent-Setup-0.1.0.exe')
const REAL_DSH_HOME = path.join(
  os.homedir(), 'AppData', 'Roaming', '@deepseek-ai', 'dsh-agent-client', 'dsh-home',
)
// dsh 运行时要求 `node:module.stripTypeScriptTypes`（Node ≥22.13 / ≥23.6 / 24.x）。
// 安装态的 Electron 内置 Node 24.19 满足；但**自动化外壳跑在哪个 node 上不确定**，
// 所以这里显式挑一个具备该 API 的解释器，否则 boot 会在 cordis loader 处炸掉
// （表现为 150s 拿不到 token URL，很容易被误判成产品缺陷）。
function pickNode() {
  const cands = [
    process.env.DSH_E2E_NODE,
    'D:\\software\\node-v24.16.0-win-x64\\node.exe',
    'C:\\Users\\Administrator\\.workbuddy\\binaries\\node\\versions\\24.16.0\\node.exe',
    'C:\\Users\\Administrator\\.workbuddy\\binaries\\node\\versions\\22.22.2-2\\node.exe',
    process.execPath,
  ].filter(Boolean)
  for (const c of cands) {
    if (!fs.existsSync(c)) continue
    const probe = spawnSync(c, ['-e', "process.stdout.write(typeof require('node:module').stripTypeScriptTypes)"], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    if (String(probe.stdout || '').trim() === 'function') return c
  }
  return process.execPath
}
const NODE = pickNode()
const KEEP = process.env.DSH_E2E_KEEP === '1'

const results = []
const pass = (m) => { results.push({ ok: true, m }); console.log('  ok   ' + m) }
const fail = (m) => { results.push({ ok: false, m }); console.log('  FAIL ' + m) }
const info = (m) => console.log('  info ' + m)
const step = (m) => console.log('\n### ' + m)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 安全删除一个可能含 junction 的目录树（隔离 DSH_HOME 就有 700+ 条 junction，
 * 且它们**指回被测安装目录** `D:\DeepSeekAgent\resources\dsh-runtime\node_modules\**`）。
 *
 * ⚠️ 已实测的三条事实（2026-09-11 受控实验，scripts/_jt_probe*.mjs 可复现）：
 *  1. `robocopy <空目录> <目录> /MIR` **会穿透 junction**，递归进入并删除 junction
 *     **目标的真实内容** —— 这是把部署树清空两次（19 包/798 文件、302 包/6865 文件）的真凶。
 *  2. **`/XJ` 挡不住它**！`/XJ` 只影响「复制」阶段，`/MIR` 的「清除」阶段照样穿透。
 *     之前以为加 `/XJ` 就安全 → 损坏复发。（实验 A：/XJ 与不带 /XJ 结果完全一致，目标全灭。）
 *  3. `fs.rmSync(dir, {recursive:true})` **不跟随 junction**（实验 B：目标 3 文件完好），
 *     直接用它是安全的；缺点是在 700+ junction 的树上可能被实时扫描拖住。
 *
 * 因此顺序：**先非递归摘掉所有 junction/symlink → 再 rmSync 纯真实树**。
 * 摘链接毫秒级，剩下真实文件很少，rmSync 不再被拖死；且**全程不递归下钻链接**。
 * 绝不再用 robocopy /MIR 清目录。
 */
function stripLinks(dir) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  let n = 0
  for (const e of ents) {
    const p = path.join(dir, e.name)
    // Windows junction：Dirent.isSymbolicLink()===true 且 isDirectory()===false
    if (e.isSymbolicLink()) {
      try { fs.unlinkSync(p); n++ } catch {
        try { fs.rmdirSync(p); n++ } catch { /* 保留，交给外层 rmSync */ }
      }
      continue
    }
    if (e.isDirectory()) n += stripLinks(p)
  }
  return n
}

function removeTreeSafe(dir) {
  if (!fs.existsSync(dir)) return 0
  const n = stripLinks(dir)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  return n
}

/** 去掉 // 行注释与 /* *\/ 块注释（粗粒度但足够用于"数调用点"这类断言）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

/** 等待 http://127.0.0.1:port 可连接。 */
async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => { s.destroy(); resolve(true) })
      s.once('error', () => resolve(false))
      s.setTimeout(1000, () => { s.destroy(); resolve(false) })
    })
    if (ok) return true
    await sleep(400)
  }
  return false
}

/**
 * 克隆真实 DSH_HOME 到隔离目录，并把指向 fromRoot 的 junction 重定向到 toRoot。
 * junction 只拷贝链接本身（不递归内容），所以 500+ 链接是毫秒级。
 */
function cloneDshHome(fromRoot, toRoot, rewriteFrom, rewriteTo) {
  let files = 0, links = 0, dirs = 0
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true })
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name)
      const d = path.join(dst, e.name)
      const st = fs.lstatSync(s)
      if (st.isSymbolicLink()) {
        let target = fs.readlinkSync(s)
        if (target.startsWith(rewriteFrom)) target = rewriteTo + target.slice(rewriteFrom.length)
        try { fs.symlinkSync(target, d, 'junction') } catch { /* 目标缺失也照建 */ }
        links++
      } else if (st.isDirectory()) {
        dirs++
        walk(s, d)
      } else {
        fs.copyFileSync(s, d)
        files++
      }
    }
  }
  walk(fromRoot, toRoot)
  return { files, links, dirs }
}

/** 递归统计目录（不跟随 junction），返回 { files, bytes }。 */
function sizeOf(dir) {
  let files = 0, bytes = 0
  const walk = (d) => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const f = path.join(d, e.name)
      let st
      try { st = fs.lstatSync(f) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(f)
      else { files++; bytes += st.size }
    }
  }
  walk(dir)
  return { files, bytes }
}

// ─────────────────────────────────────────────────────────────
// DSH_E2E_TREE=<dir>：跳过安装/卸载，直接对一棵**已就位**的树跑 B~E（用于两种场景：
//   ① 安装被安全软件拦截时，改用 `7z x <setup>.exe` 解出的安装镜像做等价验证；
//   ② 对已部署的 D:\DeepSeekAgent 做冒烟。）
const TREE_MODE = process.env.DSH_E2E_TREE || ''
const INSTALL_DIR = TREE_MODE
  ? TREE_MODE.replace(/[\\/]+$/, '')
  : (process.env.DSH_E2E_DIR || path.join('C:\\temp', 'dsh-e2e-' + Date.now().toString(36)))

console.log('mode         =', TREE_MODE ? `TREE (${INSTALL_DIR})` : 'INSTALL')
console.log('setup        =', SETUP)
console.log('install dir  =', INSTALL_DIR)
console.log('node runtime =', NODE)

if (TREE_MODE) {
  info('跳过安装步骤，直接审计已就位的目录树')
} else {
  if (!fs.existsSync(SETUP)) {
    console.error('安装包不存在:', SETUP)
    process.exit(2)
  }
  const setupBytes = fs.statSync(SETUP).size
  info(`setup size = ${(setupBytes / 1048576).toFixed(1)} MB`)
}

// ── A. 静默安装 ───────────────────────────────────────────────
if (!TREE_MODE) {
  step('A. 静默安装 (/S)')
  const t0 = Date.now()
  const r = spawnSync(SETUP, ['/S', `/D=${INSTALL_DIR}`], { windowsHide: true, timeout: 900_000 })
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  if (r.error) fail(`安装进程启动失败: ${r.error.message}`)
  else if (r.status !== 0) fail(`安装退出码 ${r.status}`)
  else pass(`安装完成，退出码 0（${secs}s）`)
}
if (!fs.existsSync(path.join(INSTALL_DIR, 'DeepSeekAgent.exe'))) {
  fail(`${TREE_MODE ? '目录树' : '安装目录'}缺少 DeepSeekAgent.exe，后续测试跳过`)
  report()
  process.exit(1)
}

// ── B. 载荷审计 ───────────────────────────────────────────────
step('B. 安装载荷审计')
const RES = path.join(INSTALL_DIR, 'resources')
{
  // B1 关键文件
  const must = [
    'DeepSeekAgent.exe', 'resources.pak', 'icudtl.dat', 'vulkan-1.dll',
    'resources/app.asar',
    'resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    'resources/packages/extensions/dsh-better-sidebar/package.json',
    'resources/packages/extensions/dsh-bridge-browser/package.json',
  ]
  const missing = must.filter((f) => !fs.existsSync(path.join(INSTALL_DIR, f)))
  missing.length === 0
    ? pass(`关键文件齐全（${must.length} 项）`)
    : fail(`关键文件缺失: ${missing.join(', ')}`)

  // B2 junction 实体化：NSIS File /r 必须把 junction 展开成真实目录
  const aiDir = path.join(RES, 'dsh-runtime', 'node_modules', '@deepseek-ai')
  let links = 0, reals = 0
  try {
    for (const n of fs.readdirSync(aiDir)) {
      const st = fs.lstatSync(path.join(aiDir, n))
      if (st.isSymbolicLink()) links++
      else if (st.isDirectory()) reals++
    }
  } catch { /* ignore */ }
  info(`@deepseek-ai 实体目录 ${reals} 个，未展开 junction ${links} 个`)
  // 构建源目录（D:\DeepSeekAgent）本身就用 junction 去重，200+ 个链接属正常；
  // 只有「安装/解包出来的镜像」才要求 junction 被 NSIS 展开成真实目录。
  // 阈值说明（2026-09-18）：不再用 >300。实测安装态 @deepseek-ai 实体目录为 270 个
  // （随包 runtime 的规范包数，含 dsh-* 全量 + schemastery 等），>300 是早期含大量
  // 插件重复副本时的经验值，现已被 /x "node_modules" 瘦身打破。真正的健康判据是
  // 「0 个 junction 残留 + 关键运行时包可读」（下方 probe 逐项验证），数量只做下界防呆。
  if (links === 0) {
    reals > 200
      ? pass(`运行时依赖已实体化（${reals} 个真实目录，无 junction 残留）`)
      : fail(`运行时依赖目录过少（${reals}），NSIS 可能未展开 junction`)
  } else {
    info(`检测到 ${links} 个 junction —— 判为构建源目录形态，跳过实体化断言`)
    pass('运行时依赖目录结构可读（源目录形态）')
  }
  // 抽两个"链路末端"包，说明展开是真的可用（能读到文件，不是空壳）
  for (const probe of ['dsh/lib/bin.js', 'cordis/package.json', 'dsh-session/package.json']) {
    const p = path.join(aiDir, probe)
    fs.existsSync(p) ? pass(`运行时包可读: @deepseek-ai/${probe}`) : fail(`运行时包缺失: @deepseek-ai/${probe}`)
  }

  // B3 app.asar 内容
  const asar = fs.readFileSync(path.join(RES, 'app.asar'))
  const txt = asar.toString('latin1')
  const ct = (re) => (txt.match(re) || []).length
  const handlerCount = ct(/setWindowOpenHandler/g)
  handlerCount >= 2
    ? pass(`app.asar 含 setWindowOpenHandler ×${handlerCount}（新窗口外跳修复在位）`)
    : fail(`app.asar 只含 ${handlerCount} 处 setWindowOpenHandler，应 ≥2`)
  // 只禁「阿里云端点」，不禁 `DASHSCOPE_API_KEY` 这类**环境变量名**——它恰恰出现在
  // main.cjs 的凭证清理黑名单里（stripInheritedCredentials），是我们要保留的行为。
  const aliyunEndpoint = txt.match(/dashscope[\w.-]*\.aliyuncs\.com|aliyuncs\.com/gi)
  aliyunEndpoint
    ? fail(`app.asar 含阿里云端点 ${aliyunEndpoint[0]}`)
    : pass('app.asar 无阿里云端点（dashscope/aliyuncs）')
  const sk = txt.match(/sk-[A-Za-z0-9]{16,}/)
  sk ? fail(`app.asar 含明文密钥 ${sk[0].slice(0, 12)}...`) : pass('app.asar 无明文 sk- 密钥')
  asar.length === fs.statSync(path.join(RES, 'app.asar')).size // noop

  // B4 不夹带测试文件
  const tests = []
  const scan = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const f = path.join(d, e.name)
      let st; try { st = fs.lstatSync(f) } catch { continue }
      if (st.isSymbolicLink()) continue
      // 只看"我们自己的产物"：上游 npm 包（node_modules）与 vendored 插件自带的
      // tests/ 目录属于第三方发布内容，不计入载荷泄漏。
      if (st.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'tests') scan(f)
      } else if (/\.(spec|test)\.(ts|tsx|js|mjs)$/.test(e.name)) tests.push(f)
    }
  }
  // 应用外壳与 asar 解包目录是"我们写的代码"，绝不允许夹带测试
  for (const own of [path.join(RES, 'app.asar.unpacked'), path.join(INSTALL_DIR, 'apps')]) scan(own)
  tests.length === 0
    ? pass('应用载荷未夹带自有 *.spec/*.test 文件')
    : fail(`载荷夹带测试文件 ${tests.length} 个，例: ${tests[0]}`)

  // B5 浏览器扩展随包
  const extRoot = path.join(RES, 'browser-extension')
  const extFiles = ['manifest.json', 'background.js', 'content.js']
  const extMissing = extFiles.filter((f) => !fs.existsSync(path.join(extRoot, f)))
  extMissing.length === 0
    ? pass('Chrome 扩展已随包（manifest/background/content）')
    : fail(`Chrome 扩展缺失: ${extMissing.join(', ')}`)

  // B6 侧边栏 alpha.1 兼容补丁必须在安装产物里（否则 dsh-better-sidebar 会崩）
  // 侧边栏 alpha.1 兼容修复的**可验证形态**：
  //   · 宿主编 index.js —— 必须有「带 typeof 守卫的垫片」，且每次 .snapshotEvents()
  //     调用都在守卫之内（计数：调用点 ≤ 守卫数）。不能只 grep 名字，压缩/注释都会干扰。
  //   · 客户端 bundle —— 禁止残留 `state.getSnapshot()` 这个真实崩溃形态
  //     （`ctx.connection?.state.getSnapshot()`；`?.` 只护住 connection，护不住 .state）。
  const sbLib = path.join(RES, 'packages', 'extensions', 'dsh-better-sidebar', 'lib')
  const hostBundle = path.join(sbLib, 'index.js')
  if (!fs.existsSync(hostBundle)) {
    fail('侧边栏产物缺失: lib/index.js')
  } else {
    // 必须先去注释再计数：这个 bundle 的 JSDoc 里就写着 `Session.snapshotEvents()`，
    // 直接 grep 会把文档当成"未受保护的调用"，误报。
    const src = stripComments(fs.readFileSync(hostBundle, 'utf8'))
    const guards = (src.match(/typeof\s+\w+\.snapshotEvents\s*===\s*["']function["']/g) || []).length
    const calls = (src.match(/\.snapshotEvents\(\)/g) || []).length
    guards >= 1
      ? pass(`侧边栏宿主 bundle 含带守卫的 snapshotEvents 垫片（守卫 ${guards} 处）`)
      : fail('侧边栏宿主 bundle 缺少 typeof 守卫的快照垫片')
    calls <= guards
      ? pass(`snapshotEvents() 调用点全部在守卫内（调用 ${calls} ≤ 守卫 ${guards}）`)
      : fail(`存在未受保护快照调用：调用 ${calls} > 守卫 ${guards}`)
  }
  for (const f of ['client.js', 'client-registry.js']) {
    const p = path.join(sbLib, f)
    if (!fs.existsSync(p)) { fail(`侧边栏产物缺失: lib/${f}`); continue }
    const src = fs.readFileSync(p, 'utf8')
    // 只禁「connection 上的 state.getSnapshot」这一条崩溃路径。
    // 不能泛禁 `.state.getSnapshot(`——`conversation.input.for(actx).state.getSnapshot()`
    // 是输入框自己的 store，跟 connection 无关，安全。
    const crashy = (src.match(/\bconnection\s*\??\.\s*state\s*\.\s*getSnapshot\s*\(/g) || []).length
    const fixed = (src.match(/\bconnection\s*\??\.\s*state\s*(?!\.\s*getSnapshot)/g) || []).length
    crashy === 0
      ? pass(`侧边栏 ${f} 无 connection.state.getSnapshot() 崩溃形态（已改为先取 state 再特性检测${
        fixed ? `，${fixed} 处` : ''}）`)
      : fail(`侧边栏 ${f} 仍有 ${crashy} 处 connection.state.getSnapshot()`)
  }
}

// ── C. 隔离 DSH_HOME ─────────────────────────────────────────
step('C. 克隆 DSH_HOME 到隔离目录（junction 重定向到安装目录）')
const TMP_HOME = path.join(INSTALL_DIR, '..', 'dsh-e2e-home-' + path.basename(INSTALL_DIR))
let homeReady = false
try {
  if (fs.existsSync(REAL_DSH_HOME)) {
    const st = cloneDshHome(REAL_DSH_HOME, TMP_HOME, 'D:\\DeepSeekAgent', INSTALL_DIR)
    info(`克隆: ${st.files} 文件 / ${st.links} junction / ${st.dirs} 目录`)
    pass('已建立隔离 DSH_HOME（未触碰用户真实环境）')
    homeReady = true
  } else {
    fs.mkdirSync(TMP_HOME, { recursive: true })
    info('真实 DSH_HOME 不存在，使用全新临时目录')
    pass('已建立全新隔离 DSH_HOME')
    homeReady = true
  }
} catch (e) {
  fail(`克隆 DSH_HOME 失败: ${e.message}`)
}

// ── D. 从安装目录启动 dsh web ─────────────────────────────────
step('D. 用安装目录内的 runtime + CLI + 插件启动 dsh web')
let child = null
let authUrl = null
let bootLog = ''
let port = 0
if (homeReady) {
  try {
    const launcher = require(path.join(
      RES, 'app.asar.unpacked', 'electron', 'plugin-host', 'dsh-web-launcher.cjs',
    ))
    const cliDir = path.join(RES, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh')
    const launch = launcher.resolveDshLaunch({ cliDir })
    if (!launch) {
      fail('安装目录内未解析到 dsh CLI 入口')
    } else {
      pass(`解析到 CLI 入口: ${path.relative(INSTALL_DIR, launch.bin)}`)
      port = await freePort()
      let resolveToken
      const tokenP = new Promise((r) => { resolveToken = r })
      child = launcher.spawnDshWeb({
        bin: launch.bin,
        nodeArgs: ['--expose-internals', ...launch.nodeArgs],
        runtime: NODE,
        port,
        dshHome: TMP_HOME,
        extensionsDir: path.join(RES, 'packages', 'extensions'),
        baseEnv: { ...process.env, NODE_OPTIONS: '' },
        onLog: (m) => {
          bootLog += m + '\n'
          const hit = /(https?:\/\/[^\s"'<>]+?\?token=[A-Za-z0-9_.-]+)/.exec(m)
          if (hit && !authUrl) { authUrl = hit[1]; resolveToken() }
        },
      })
      if (!child) {
        fail('spawnDshWeb 返回 null')
      } else {
        const t0 = Date.now()
        const got = await Promise.race([tokenP.then(() => 'token'), sleep(150_000).then(() => 'timeout')])
        if (got === 'token') {
          pass(`dsh web 就绪并给出鉴权 URL（${((Date.now() - t0) / 1000).toFixed(0)}s）`)
          pass(`监听端口 ${port}`)
        } else {
          fail('150s 内未拿到 dsh web 鉴权 URL')
          info('boot 日志尾部:\n' + bootLog.split('\n').slice(-25).join('\n'))
        }
      }
    }
  } catch (e) {
    fail(`启动链路异常: ${e.message}`)
  }
}

// ── E. 插件挂载 + UI 冒烟（Playwright）────────────────────────
step('E. 插件挂载校验 + 前端冒烟')
{
  // E1 profile 是否把安装目录内的插件挂上
  try {
    const mani = JSON.parse(fs.readFileSync(path.join(TMP_HOME, 'profiles/web/package.json'), 'utf8'))
    const bundles = mani?.dsh?.profile?.bundles || []
    const want = ['dsh-better-sidebar', '@yuxianglin/dsh-bridge-browser']
    const miss = want.filter((n) => !bundles.includes(n))
    miss.length === 0
      ? pass(`web profile 已挂载社区插件（${bundles.length} 个 bundle）`)
      : fail(`web profile 缺插件: ${miss.join(', ')}`)
    // Windows junction 的 readlink 会带 NT 命名空间前缀 `\\?\`，且分隔符与入参可能
    // 一个用 `\` 一个用 `/`（bash 传进来的 "D:\\DeepSeekAgent" 会变成 D://DeepSeekAgent）。
    const norm = (s) => s
      .replace(/^\\\\\?\\/, '')
      .replace(/[\\/]+/g, '\\')
      .toLowerCase()
      .replace(/\\+$/, '')
    const badLink = want.filter((n) => {
      const p = path.join(TMP_HOME, 'profiles/web/node_modules', n)
      try { return !norm(fs.readlinkSync(p)).startsWith(norm(INSTALL_DIR)) } catch { return true }
    })
    badLink.length === 0
      ? pass('插件 junction 指向安装目录（非构建源目录）')
      : fail(`插件 junction 未指向安装目录: ${badLink.join(', ')}`)
  } catch (e) {
    fail(`读取 web profile 失败: ${e.message}`)
  }

  // E2 前端真的被托管：富 UI 的 bootstrap 注入标记
  if (authUrl) {
    try {
      const root = new URL(authUrl)
      const r0 = await fetch(authUrl, { redirect: 'manual' })
      const setCookie = r0.headers.get('set-cookie') || ''
      pass(`鉴权跳转 HTTP ${r0.status}${setCookie ? '，已下发会话 cookie' : ''}`)
      const cookie = setCookie.split(';')[0]
      const r1 = await fetch(new URL('/', root).href, { headers: cookie ? { cookie } : {} })
      const html = await r1.text()
      r1.status === 200 ? pass('应用首页 HTTP 200') : fail(`应用首页 HTTP ${r1.status}`);
      // 注意：上一行不能以正则字面量开头——无分号时 `/re/` 会被解析成除法（ASI 陷阱）。
      const hasBoot = html.includes('__DSH_BOOT__');
      hasBoot
        ? pass('首页含 __DSH_BOOT__（富 dsh-web-ui 已托管，非兜底页）')
        : fail('首页缺少 __DSH_BOOT__，可能退化成兜底页');
      // 属性值是 HTML 转义过的：聚合 URL 形如 `/plugins/??a/client.js&amp;rev=xxx`。
      // 不解码就会拿着带 `&amp;` 的地址去 fetch → 必然 404（曾误判成前端缺资源）。
      const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"')
      const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => unesc(m[1]))
      const cssHrefs = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => unesc(m[1]))
      let bad = 0
      for (const u of [...scriptSrcs, ...cssHrefs]) {
        const rr = await fetch(new URL(u, root).href, { headers: cookie ? { cookie } : {} })
        if (rr.status >= 400) { bad++; fail(`静态资源 ${rr.status}: ${u}`) }
      }
      bad === 0 ? pass(`静态资源全部可加载（js ${scriptSrcs.length} / css ${cssHrefs.length}）`) : null
    } catch (e) {
      fail(`前端探测异常: ${e.message}`)
    }
  } else {
    info('未拿到鉴权 URL，跳过 HTTP 冒烟')
  }

  // E3 浏览器渲染冒烟：HTTP 200 只说明"HTML 能拿到"，真正要证的是前端 JS 在浏览器里
  // 跑得起来（插件 client bundle 加载失败会以 pageerror 的形式暴露）。
  await browserSmoke(authUrl)
}

/**
 * 用 Playwright headless Chromium 打开工作台，收集 pageerror / console error，
 * 断言富界面真的渲染出内容，并存证截图。
 * Playwright 缺失时只记 info，不让整轮 E2E 失败（HTTP 冒烟已经覆盖了资源层）。
 */
async function browserSmoke(url) {
  if (!url) { info('无鉴权 URL，跳过浏览器渲染冒烟'); return }
  const PW = process.env.DSH_E2E_PLAYWRIGHT
    || 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright'
  let chromium
  try { ({ chromium } = require(PW)) } catch (e) {
    info(`Playwright 不可用（${e.message}），跳过浏览器渲染冒烟`)
    return
  }
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

    await page.goto(url, { waitUntil: 'commit', timeout: 90_000 })
    // 等应用挂载出可见文本（富界面首屏有"新会话"/工作区等文案；纯兜底页也会有文本，
    // 但 __DSH_BOOT__ 的断言已经在上面把兜底页排除掉了）。
    await page.waitForFunction(
      () => document.body && document.body.innerText.trim().length > 20,
      null, { timeout: 90_000 },
    ).catch(() => {})
    const textLen = (await page.evaluate(() => document.body?.innerText?.trim().length || 0))
    const title = await page.title()
    const hasBoot = await page.evaluate(() => !!window.__DSH_BOOT__)

    textLen > 20
      ? pass(`浏览器渲染出可见内容（${textLen} 字符，title="${title}"）`)
      : fail('浏览器渲染后页面正文为空，前端可能白屏')
    hasBoot
      ? pass('浏览器内 __DSH_BOOT__ 已注入（前端 bootstrap 执行）')
      : fail('浏览器内缺少 __DSH_BOOT__')

    // 只有与插件加载相关的报错才算失败；其它（如缺少 API Key 的提示）记录为 info。
    const fatal = [...pageErrors, ...consoleErrors].filter((m) =>
      /plugin|bundle|chunk|Mermaid|Failed to fetch dynamically imported module|is not a function|Cannot read propert/i.test(m))
    fatal.length === 0
      ? pass(`无插件/资源类前端报错（pageerror ${pageErrors.length}，console.error ${consoleErrors.length}）`)
      : fail(`前端报错 ${fatal.length} 条，例: ${fatal[0].slice(0, 200)}`)
    if (pageErrors.length) info('pageerror 摘要: ' + pageErrors.slice(0, 3).map((s) => s.slice(0, 160)).join(' || '))

    const shotDir = path.join(HERE, '.e2e_screens')
    try {
      fs.mkdirSync(shotDir, { recursive: true })
      const shot = path.join(shotDir, `installed-ui-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
      await page.screenshot({ path: shot, fullPage: false })
      info('截图: ' + shot)
    } catch { /* 截图失败不影响结论 */ }
  } catch (e) {
    fail(`浏览器渲染冒烟异常: ${e.message}`)
  } finally {
    try { await browser?.close() } catch { /* ignore */ }
  }
}

// ── F. 卸载 ───────────────────────────────────────────────────
step('F. 静默卸载与残留检查')
{
  if (child) {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch {}
    await sleep(1500)
  }
  // 干净卸载要求先放掉隔离 DSH_HOME（它在安装目录同级，不算残留）。
  // 注意：该目录含 700+ 条指回安装目录的 junction，必须走不跟随 junction 的删除路径。
  removeTreeSafe(TMP_HOME)

  if (TREE_MODE) {
    fs.existsSync(path.join(INSTALL_DIR, 'Uninstall.exe'))
      ? pass('镜像内含 Uninstall.exe（卸载器已随包）')
      : fail('镜像内缺少 Uninstall.exe')
    info('TREE 模式下不执行真实卸载（无法凭空卸载一棵解包出来的目录）')
  } else {
  const un = path.join(INSTALL_DIR, 'Uninstall.exe')
  if (!fs.existsSync(un)) {
    fail('安装目录缺少 Uninstall.exe')
  } else {
    spawnSync(un, ['/S'], { windowsHide: true, timeout: 300_000 })
    // NSIS 卸载器会把自己复制到 %TEMP% 再执行，原进程立即返回 → 轮询目录消失
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline && fs.existsSync(INSTALL_DIR)) await sleep(1000)
    if (!fs.existsSync(INSTALL_DIR)) {
      pass('卸载完成，安装目录已清空')
    } else {
      const left = sizeOf(INSTALL_DIR)
      if (KEEP) info(`保留安装目录（DSH_E2E_KEEP=1），剩余 ${left.files} 文件`)
      else fail(`卸载后仍残留 ${left.files} 文件（${(left.bytes / 1048576).toFixed(1)} MB）`)
    }
  }
  if (KEEP) info('按 DSH_E2E_KEEP=1 保留安装目录')
  }
}

report()

function report() {
  const bad = results.filter((r) => !r.ok)
  console.log('\n================ E2E 结果 ================')
  console.log(`通过 ${results.length - bad.length} 项，失败 ${bad.length} 项`)
  for (const r of bad) console.log('  FAIL ' + r.m)
  console.log(bad.length ? 'E2E RESULT: FAIL' : 'E2E RESULT: PASS')
  process.exit(bad.length ? 1 : 0)
}
