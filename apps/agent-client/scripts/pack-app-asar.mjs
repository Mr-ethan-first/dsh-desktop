#!/usr/bin/env node
// pack-app-asar.mjs — 绕开 electron-builder 的 asar 直打包脚本
//
// 背景：本沙箱内 electron-builder@26.x 因 @electron/get 枚举崩溃 + node undici TLS 失败，
// 无法走 `electron-builder --win dir/nsis`（且复制 runtime-dist 会被 Lenovo/火绒实时扫描拖死 >25min）。
// 本脚本用 @electron/asar 直接产出 app.asar + app.asar.unpacked，与 electron-builder 的 dir 产物布局一致，
// 且不需要 electron-builder 下载/复制任何东西。
//
// 用法：
//   node scripts/pack-app-asar.mjs                # 仅打包到 apps/agent-client/{app.asar,app.asar.unpacked}
//   node scripts/pack-app-asar.mjs --skip-build   # 跳过 tsc/vite（dist/ 与 electron/harness-dist/ 已存在时）
//   node scripts/pack-app-asar.mjs --deploy D:\DeepSeekAgent
//        # 打包后直接将 app.asar / app.asar.unpacked 覆盖进目标 resources/，
//        # 并补 resources/app/apps/web/dist（代码 WEB_DIST_DIR 要求 APP_ROOT=resources/app）。
//
// 注意：apps/web/dist 源码可能不存在（未构建前端时），此时回退到已部署目录
// D:\DeepSeekAgent\resources\apps\web\dist（仅打包需要，不会改动它）。

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..'); // apps/agent-client
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..'); // 仓库根
const STAGE = path.join(APP_ROOT, '_asar_stage');

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const deployIdx = args.indexOf('--deploy');
const deployTarget = deployIdx >= 0 ? args[deployIdx + 1] : null;

function log(...a) { console.log('[pack-app-asar]', ...a); }
function fail(msg) { console.error('[pack-app-asar] ERROR:', msg); process.exit(1); }

// 阶段计时：本机（火绒实时扫描）曾两次出现 pack 进程长时间无输出（首次 21 分钟被强杀，
// 部署树留在「app.asar 已更新、unpacked 为空」的半态；2026-09-15 再次卡在 asar pack 阶段）。
// 有了这些打点，下次卡住可直接看出停在哪一步，不必靠人工复现。
let lastMark = Date.now();
function mark(label) {
  const now = Date.now();
  log(`[phase] ${label} (+${now - lastMark}ms)`);
  lastMark = now;
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

// 递归删除目录（junction 安全版）。**不要用 robocopy /MIR**：
// 2026-09-11 受控实验（scripts/_jt_probe*.mjs）证明 `robocopy <空目录> <目录> /MIR`
// **会穿透 junction 并删掉目标的真实内容**，而且 **`/XJ` 挡不住**（/XJ 只作用于复制阶段，
// /MIR 的清除阶段照样穿透）——本项目曾因此两次清空部署树（19 包/798 文件 → 302 包/6865 文件）。
// `fs.rm(dir,{recursive:true})` 不跟随 junction（安全），但在实时扫描下可能被拖住，
// 故先**非递归摘掉所有 junction/symlink**（毫秒级、绝不下钻），再 rm 掉纯真实树。
function stripLinks(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let n = 0;
  for (const e of ents) {
    const p = path.join(dir, e.name);
    // Windows junction：Dirent.isSymbolicLink()===true 且 isDirectory()===false
    if (e.isSymbolicLink()) {
      try { fs.unlinkSync(p); n++; } catch {
        try { fs.rmdirSync(p); n++; } catch { /* 保留，交给外层 rm */ }
      }
      continue;
    }
    if (e.isDirectory()) n += stripLinks(p);
  }
  return n;
}

/**
 * 目录内是否含 junction/symlink（深度上限 8，命中即返回）。
 * 用于决定「能否安全用 fs.cp 复制该目录做备份」：源含链接时 fs.cp 会下钻到链接目标，
 * 可能复制进巨量子树（甚至形成环形）而长时间不返回。
 */
function hasLinks(dir, depth = 0) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of ents) {
    if (e.isSymbolicLink()) return true;
    if (e.isDirectory() && depth < 8 && hasLinks(path.join(dir, e.name), depth + 1)) return true;
  }
  return false;
}

async function removeTree(dir) {
  if (!(await exists(dir))) return;
  const t0 = Date.now();
  const stripped = stripLinks(dir);
  if (stripped) log(`removeTree: 先摘掉 ${stripped} 个链接 ${dir}`);
  // 裸 fs.rm(recursive) 在本机（火绒实时扫描）会**永久挂起**：删除过程中文件被扫描器
  // 短暂锁定即卡住，且原先 .catch(()=>{}) 把失败吞掉、调用方以为已删干净。
  // 2026-09-15 复现：部署阶段在删除 app.asar.unpacked 时卡死 21 分钟，pack 进程被强杀，
  // 部署树被留在「app.asar 已更新、unpacked 为空」的半态。故：显式重试 + 只在真失败时告警。
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      if (attempt > 1) log(`removeTree: 第 ${attempt} 次尝试删除成功 ${dir}`);
      return;
    } catch (e) {
      lastErr = e;
      log(`removeTree: 第 ${attempt} 次删除失败 ${dir}: ${e && e.message}（重新摘链接后重试）`);
      stripLinks(dir); // 删除过程可能暴露新的 junction（子目录被删后父链接才可见）
    }
  }
  log(`WARN: removeTree 未能完全删除 ${dir}（${Date.now() - t0}ms，${lastErr && lastErr.message}）`);
}

// ---- 1) 构建（可选） ----
if (!skipBuild) {
  log('构建 harness (tsc -p electron/harness/tsconfig.json) ...');
  const r1 = spawnSync(process.execPath,
    [path.join(REPO_ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'electron/harness/tsconfig.json'],
    { cwd: APP_ROOT, stdio: 'inherit' });
  if (r1.status !== 0) fail('harness tsc 失败');

  // 旧自研兜底 SPA（apps/agent-client/src + dist）已删除：主窗口只渲染官方
  // dsh-web-ui。源码目录不存在时必须跳过 vite build，否则 rollup 会因
  // index.html -> /src/main.tsx 无法解析而直接失败，阻断整个打包。
  const spaSrc = path.join(APP_ROOT, 'src');
  const spaEntryHtml = path.join(APP_ROOT, 'index.html');
  if (!(await exists(spaSrc)) || !(await exists(spaEntryHtml))) {
    log('跳过前端 vite build（旧兜底 SPA 源码已移除，仅部署 harness + dsh-web-ui）');
  } else {
    log('构建前端 (vite build) ...');
    const viteBin = await (async () => {
      const pnpm = path.join(REPO_ROOT, 'node_modules/.pnpm');
      const ents = await fs.readdir(pnpm).catch(() => []);
      const hit = ents.find(e => /^vite@/.test(e));
      return hit
        ? path.join(pnpm, hit, 'node_modules/vite/bin/vite.js')
        : path.join(REPO_ROOT, 'node_modules/vite/bin/vite.js');
    })();
    const r2 = spawnSync(process.execPath, [viteBin, 'build'], { cwd: APP_ROOT, stdio: 'inherit' });
    if (r2.status !== 0) fail('vite build 失败');
  }
} else {
  log('--skip-build：跳过 tsc/vite');
}

// ---- 2) 准备 stage 目录 ----
mark('构建阶段结束（stage 清理开始）');
await removeTree(STAGE);
mark('stage 清理完成');
await fs.mkdir(path.join(STAGE, 'electron'), { recursive: true });
await fs.mkdir(path.join(STAGE, 'apps/web'), { recursive: true });

const exclude = (src) => {
  const b = path.basename(src);
  if (b === 'node_modules' || b === '.git') return false;
  if (b === '_asar_stage' || b === 'app.asar' || b === 'app.asar.unpacked') return false;
  // 测试专用产物绝不随包：*.test.* / *.spec.* 及 __tests__/__fixtures__ 目录。
  // 部分 e2e 测试源码内含 dashscope.aliyuncs.com 等端点常量，运行期从不加载，
  // 打进发行包既无意义又与「仅原生 DeepSeek」的交付审计冲突。
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(b)) return false;
  if (b === '__tests__' || b === '__fixtures__') return false;
  return true;
};

const distSrc = path.join(APP_ROOT, 'dist');
const electronSrc = path.join(APP_ROOT, 'electron');
const pkgSrc = path.join(APP_ROOT, 'package.json');
// 源码真正的 web 构建产物在仓库根 apps/web/dist；但本地未必做过完整 web 构建
// （可能只是占位 stub，无 index.html）。stub 直接随包会渲染出残页，因此必须校验
// index.html 存在才算「可构建源」，否则回退到已部署目录的整包。
const webDistSrc = path.join(REPO_ROOT, 'apps/web/dist');
const webDistFallback = 'D:/DeepSeekAgent/resources/apps/web/dist';

// 旧自研 SPA（apps/agent-client/dist）已移除，主窗口仅用官方 dsh-web-ui；
// 因此打包不再要求 SPA dist 存在——缺失则跳过，不影响 harness / dsh-web-ui 部署。
if (await exists(distSrc)) {
  await fs.cp(distSrc, path.join(STAGE, 'dist'), { recursive: true, filter: exclude });
  log('旧 SPA dist 已随包（兼容旧部署）');
} else {
  log('WARN: 未找到 apps/agent-client/dist（旧 SPA 已移除），跳过 SPA 打包；仅部署 harness + dsh-web-ui');
}
await fs.cp(electronSrc, path.join(STAGE, 'electron'), { recursive: true, filter: exclude });
await fs.cp(pkgSrc, path.join(STAGE, 'package.json'));

// 生产运行时依赖：sql.js（harness 会话 SQLite 持久化，package.json dependencies）。
// electron-builder 会按 dependencies 自动收集进包；本直打包脚本此前漏掉，导致主进程
// 每次启动都记「sql.js 不可用，回退到文件持久化」。sql.js 自身零依赖，整目录拷贝即可。
const sqlJsSrc = path.join(APP_ROOT, 'node_modules/sql.js');
if (await exists(sqlJsSrc)) {
  await fs.cp(sqlJsSrc, path.join(STAGE, 'node_modules/sql.js'), { recursive: true, dereference: true });
  log('sql.js 已随包（SQLite 持久化启用）');
} else {
  log('WARN: 未找到 node_modules/sql.js，包内将回退文件持久化');
}

// 仅当源码 web/dist 含 index.html（完整构建）时才使用，占位 stub 一律回退。
const webDistComplete = (await exists(webDistSrc))
  && (await exists(path.join(webDistSrc, 'index.html')));
if (webDistComplete) {
  await fs.cp(webDistSrc, path.join(STAGE, 'apps/web/dist'), { recursive: true, filter: exclude });
  log('apps/web/dist 取自源码（完整构建）');
} else if (await exists(webDistFallback)) {
  await fs.cp(webDistFallback, path.join(STAGE, 'apps/web/dist'), { recursive: true, filter: exclude });
  log(`apps/web/dist 回退取到 ${webDistFallback}（源码未构建前端）`);
} else {
  fail('找不到 apps/web/dist（源码与回退目录均缺失）');
}

// ---- 3) 解析 @electron/asar 二进制（选最高版本，避免 3.2.1 的 --unpack 不抽 unpacked 目录） ----
async function findAsarBin() {
  const pnpm = path.join(REPO_ROOT, 'node_modules/.pnpm');
  const ents = await fs.readdir(pnpm).catch(() => []);
  const hits = ents.filter(e => /^@electron\+asar@/.test(e));
  if (hits.length === 0) return path.join(REPO_ROOT, 'node_modules/@electron/asar/bin/asar.js');
  hits.sort((a, b) => {
    const va = (a.match(/@(\d+\.\d+\.\d+)/) || [0, '0'])[1];
    const vb = (b.match(/@(\d+\.\d+\.\d+)/) || [0, '0'])[1];
    return vb.localeCompare(va, undefined, { numeric: true });
  });
  return path.join(pnpm, hits[0], 'node_modules/@electron/asar/bin/asar.js');
}
const asarBin = await findAsarBin();
if (!(await exists(asarBin))) fail(`找不到 @electron/asar 二进制: ${asarBin}`);

// ---- 4) 打包 app.asar（electron/** 必须 unpacked） ----
const appAsar = path.join(APP_ROOT, 'app.asar');
const appAsarUnpacked = path.join(APP_ROOT, 'app.asar.unpacked');
await fs.rm(appAsar, { force: true });
await removeTree(appAsarUnpacked);

const r3 = spawnSync(process.execPath,
  [asarBin, 'pack', STAGE, appAsar, '--unpack', 'electron/**'],
  { cwd: APP_ROOT, stdio: 'inherit' });
if (r3.status !== 0) fail('asar pack 失败');
mark('asar pack 完成');

// ⚠️ 2026-09-11 实测修正（勿再改回）：asar 3.4.1 在本环境的 `--unpack electron/**`
// **并不会**把 electron/** 抽出 asar 体——header 里 electron/** 条目保留真实 offset、
// 没有 unpacked 标记。Electron 运行时**从 asar 体内加载 electron/****（包括
// electron/plugin-host/dsh-web-launcher.cjs），`app.asar.unpacked/electron/**` 只是
// 下面的手工冗余副本，改它不生效（曾导致「修复只写进 unpacked 死副本，问题依旧」）。
// 校验部署态主进程代码必须读 app.asar 体内字节。这里保留手工复制仅作冗余兜底。
await fs.mkdir(path.join(appAsarUnpacked, 'electron'), { recursive: true });
await fs.cp(path.join(STAGE, 'electron'), path.join(appAsarUnpacked, 'electron'),
  { recursive: true, filter: exclude });

const unpackedOk = await exists(path.join(appAsarUnpacked, 'electron/main.cjs'));
if (!unpackedOk) fail('app.asar.unpacked/electron/main.cjs 未生成（unpack 失败）');
mark('unpacked 冗余副本就绪');

// ---- 4.5) 打包自检：asar 体内 electron/** 必须与源文件一致 ----
// 防回归：launcher 修复曾只落到 app.asar.unpacked 死副本（见上注释），exe 实际加载
// asar 体内的旧版，问题依旧。此处直接读 asar header 比对体内 launcher 与源文件大小，
// 不一致即拒绝出包。
const asarLib = (() => {
  const require = createRequire(import.meta.url);
  const pkgRoot = path.resolve(asarBin, '..', '..'); // <pkg>/bin/asar.js → <pkg>
  try { return require(pkgRoot); } catch { return require(path.join(pkgRoot, 'lib', 'asar.js')); }
})();
const srcLauncher = path.join(APP_ROOT, 'electron', 'plugin-host', 'dsh-web-launcher.cjs');
const srcLauncherSize = (await fs.stat(srcLauncher)).size;
const rawHeader = asarLib.getRawHeader(appAsar);
const asarLauncher =
  rawHeader?.header?.files?.electron?.files?.['plugin-host']?.files?.['dsh-web-launcher.cjs'];
if (!asarLauncher) {
  fail('自检失败: app.asar 体内未找到 electron/plugin-host/dsh-web-launcher.cjs（electron/** 必须真实打进 asar 体，exe 从体内加载）');
}
if (asarLauncher.size !== srcLauncherSize) {
  fail(`自检失败: asar 体内 launcher(${asarLauncher.size}B) 与源文件(${srcLauncherSize}B)不一致 —— 打包混入陈旧 electron/ 源，拒绝出包`);
}
log(`自检通过: asar 体内 launcher ${asarLauncher.size}B 与源文件一致（Electron 从 asar 体内加载 electron/**）`);

const size = (await fs.stat(appAsar)).size;
const unpackedCount = (await fs.readdir(path.join(appAsarUnpacked, 'electron'), { recursive: true })).length;
log(`app.asar 已生成 (${(size/1024/1024).toFixed(1)}MB)，electron/ 已 unpacked (${unpackedCount} 项)`);

// ---- 5) 可选部署 ----
if (deployTarget) {
  const resDir = path.join(deployTarget, 'resources');
  if (!(await exists(resDir))) fail(`部署目标 resources 不存在: ${resDir}`);
  // 备份用 copyFile 而非 rename：本机 Lenovo/火绒实时扫描会锁文件，rename 会 EBUSY。
  const bak = path.join(resDir, `_bak_${Date.now()}`);
  if (await exists(path.join(resDir, 'app.asar'))) {
    await fs.mkdir(bak, { recursive: true });
    const tBak = Date.now();
    await fs.copyFile(path.join(resDir, 'app.asar'), path.join(bak, 'app.asar'));
    const srcUnpacked = path.join(resDir, 'app.asar.unpacked');
    if (await exists(srcUnpacked)) {
      if (hasLinks(srcUnpacked)) {
        // 含 junction 的旧 unpacked 不做整树备份：fs.cp 会下钻链接目标，可能复制巨量子树
        // 而长时间不返回（备份只是安全网，不值得为它冒卡死风险）。
        log('跳过旧 unpacked 备份：源含 junction/symlink（fs.cp 会下钻，可能巨量或挂起）');
      } else {
        await fs.cp(srcUnpacked, path.join(bak, 'app.asar.unpacked'), { recursive: true });
      }
    }
    log(`已备份旧 asar 到 ${bak}（${Date.now() - tBak}ms）`);
  }
  // 覆盖（copyFile 等同原地写，AV 允许；先尽力清旧 unpacked 避免陈旧文件）
  await fs.copyFile(appAsar, path.join(resDir, 'app.asar'));
  await removeTree(path.join(resDir, 'app.asar.unpacked'));
  await fs.cp(appAsarUnpacked, path.join(resDir, 'app.asar.unpacked'), { recursive: true });
  // 补代码要求的 resources/app/apps/web/dist
  const workbenchDir = path.join(resDir, 'app/apps/web/dist');
  await fs.mkdir(workbenchDir, { recursive: true });
  await fs.cp(path.join(STAGE, 'apps/web/dist'), workbenchDir, { recursive: true });

  // 外挂独立 Node：Electron 内置 Node 作为 ELECTRON_RUN_AS_NODE=1 运行时无法暴露
  // cordis-plugin-hmr 所需的内部 loader，会导致 dsh web 启动即崩溃、exe 卡在启动页。
  // 因此随包附带一个「已知且经过版本校验」的 Node.exe（resources/node.exe），main.cjs 会优先使用它。
  //
  // 严禁用 process.execPath 作为源盲拷：跑本脚本的 node 可能是任意版本的 managed node
  // （如 22.12.0），一旦落在 <22.13 / 非 v24 的 node 上，会把 dsh web 必需的不兼容 Node
  // 写进部署树，导致 exe 永久卡在「正在启动 DSH Web 工作台」（2026-09-17 险些踩中）。
  // 固定候选：① DSH_BUNDLED_NODE 显式指定；② 本机已知 v24.16.0 路径。必须校验版本为 v24 才采用。
  const bundledNodeTarget = path.join(resDir, 'node.exe');
  const NODE24_CANDIDATES = [
    process.env.DSH_BUNDLED_NODE,
    'D:/software/node-v24.16.0-win-x64/node.exe',
  ].filter(Boolean);
  function nodeVer(p) {
    try {
      const r = spawnSync(p, ['--version'], { timeout: 20000, windowsHide: true });
      if (r.status === 0) return (r.stdout || '').toString().trim();
    } catch {}
    return null;
  }
  let nodeSource = null, nodeSourceVer = null;
  for (const c of NODE24_CANDIDATES) {
    if (/node\.exe$/i.test(c) && (await exists(c))) {
      const v = nodeVer(c);
      if (v && /^v24\./.test(v)) { nodeSource = c; nodeSourceVer = v; break; }
      else log(`跳过候选 Node 源（版本不符，需 v24.x）: ${c} -> ${v || 'unknown'}`);
    } else {
      log(`跳过候选 Node 源（不存在或非 node.exe）: ${c}`);
    }
  }
  if (process.platform === 'win32' && nodeSource) {
    const targetVer = (await exists(bundledNodeTarget)) ? nodeVer(bundledNodeTarget) : null;
    // 目标已是合法 v24 且与源版本一致时，跳过 92MB 复制（避免火绒实时扫描重复开销 + 半态风险）
    if (targetVer && targetVer === nodeSourceVer) {
      log(`部署树 node.exe 已是 ${targetVer}，跳过复制（源 ${nodeSource}）`);
    } else {
      try {
        await fs.copyFile(nodeSource, bundledNodeTarget);
        log(`已外挂独立 Node: ${bundledNodeTarget} (源: ${nodeSource}, 覆盖旧版 ${targetVer || '无'})`);
      } catch (e) {
        log(`WARN: 复制 Node.exe 失败: ${e && (e.message || e)}`);
      }
    }
  } else if (!nodeSource) {
    // 找不到任何合法的 v24 源：宁可保留部署树现有 node.exe（可能已是正确 v24），也绝不用
    // 不兼容 Node 覆盖，避免把 dsh web 运行环境打坏。
    log(`WARN: 未找到合法的 v24 Node 源，保留现有 ${bundledNodeTarget}（不覆盖，避免破坏 dsh web 运行环境）`);
  } else {
    log(`WARN: 非 win32 平台，跳过外挂 Node`);
  }

  // 部署后自检（硬门禁）：部署树 node.exe 必须真的是 v24，否则 dsh web 起不来、exe 会卡在
  // 「正在启动 DSH Web 工作台」。这一步把「用错版本 Node 覆盖」从"可能疏忽"变为"构建期直接失败"。
  if (process.platform === 'win32') {
    const finalVer = (await exists(bundledNodeTarget)) ? nodeVer(bundledNodeTarget) : null;
    if (!(finalVer && /^v24\./.test(finalVer))) {
      fail(`部署树 node.exe 不是 v24（${finalVer || '缺失'}），dsh web 将无法启动；请检查 DSH_BUNDLED_NODE`);
    }
    log(`自检通过：部署树 node.exe = ${finalVer}`);
  }

  log(`已部署到 ${resDir}（含 resources/app/apps/web/dist）`);
  mark('部署完成');
} else {
  log('未指定 --deploy，产物留在 apps/agent-client/{app.asar,app.asar.unpacked}');
}

log('完成。');
