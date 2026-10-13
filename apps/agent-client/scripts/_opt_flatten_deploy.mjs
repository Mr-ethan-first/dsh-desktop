/**
 * 安装包瘦身 / 打包前处理：拆掉插件包内「指向运行时 node_modules 的 junction」。
 *
 * 背景
 * ----
 * 每个社区插件目录下的 `node_modules` 里全是指向 `resources/dsh-runtime/node_modules`
 * 的 junction（`@deepseek-ai`、`cordis`、`react`、`ws` ……）。NSIS 的 `File /r` 会把
 * junction **展开成真实目录**，而 `@deepseek-ai` 一棵树约 85MB；它同时在
 * `resources/dsh-runtime`（经 `node_modules/dsh-better-sidebar` 等 junction）
 * 与 `resources/packages` 两条路径各展开一次 → 载荷从 ~620MB 虚增到 ~1.57GB。
 *
 * 做法
 * ----
 * 这些 junction 只为 Node 的向上解析服务，位置无关：Node 对插件取 realpath 后再向上找
 * `node_modules`，因此运行时会在 `<extensions>/node_modules` 建一份共享回退
 * （见 `electron/plugin-host/dsh-web-launcher.cjs` 的 `ensureExtensionsModuleFallback`）。
 * 本脚本因此：
 *   1) 记录插件 `node_modules` 下每个 junction 的 名字→目标（用于审计/报告）；
 *   2) **只 unlink 这些 junction**，保留其中的真实子目录（如 cosmokit/schemastery）；
 *   3) 报告「模拟 NSIS File /r 展开」前后的载荷与条目数，便于打包前预估。
 *
 * 安全约定
 * --------
 * - 默认 dry-run；必须显式 `--apply` 才真正删除。
 * - 只用 `unlinkSync` 删除链接本身，**从不递归删除目录**（绝不 rm -rf）。
 * - 只处理 `<deploy>/resources/packages/**` 下的 `node_modules`，且只删其中的
 *   symbolic link/junction 条目。
 *
 * 用法
 * ----
 *   node scripts/_opt_flatten_deploy.mjs [--deploy D:\\DeepSeekAgent] [--apply] [--predict-only]
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DEPLOY = argVal('--deploy', 'D:\\DeepSeekAgent');
const APPLY = argv.includes('--apply');
const PREDICT_ONLY = argv.includes('--predict-only');
/** 只在这些顶层子树里找「内层 node_modules」（插件包自身携带的解析回退）。 */
const SCOPES = ['resources/packages'];

const log = (...a) => console.log('[flatten]', ...a);
const mb = (b) => (b / 1048576).toFixed(1);

if (!fs.existsSync(DEPLOY)) {
  console.error('deploy dir not found:', DEPLOY);
  process.exit(1);
}

/** 收集某个 node_modules 目录里的 junction 条目（不递归进目录之外的链接）。 */
function collectLinks(nodeModulesDir, sink, relBase) {
  let entries;
  try { entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(nodeModulesDir, e.name);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) {
      let target = '';
      try { target = fs.readlinkSync(abs); } catch { /* 读不到也照样删链接 */ }
      sink.push({ abs, rel: path.relative(relBase, abs), name: e.name, target });
      continue;
    }
    if (!st.isDirectory()) continue;
    // 作用域目录（@scope/xxx）下的链接
    if (e.name.startsWith('@')) collectLinks(abs, sink, relBase);
  }
}

/**
 * 模拟 NSIS `File /r`：跟随 junction 展开，累计条目数与字节数。
 * junction 的展开只跟随一次（NSIS 不做环检测，因此这里也不做，用以暴露问题）。
 */
function simulatePack(entryDir, stats, depth = 0) {
  if (depth > 40) return;
  let entries;
  try { entries = fs.readdirSync(entryDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(entryDir, e.name);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) {
      let real;
      try { real = fs.realpathSync(abs); } catch { stats.linksBroken++; continue; }
      let rst;
      try { rst = fs.statSync(real); } catch { stats.linksBroken++; continue; }
      if (rst.isDirectory()) simulatePack(real, stats, depth + 1);
      else { stats.files++; stats.bytes += rst.size; }
      continue;
    }
    if (st.isDirectory()) { simulatePack(abs, stats, depth + 1); continue; }
    if (st.isFile()) { stats.files++; stats.bytes += st.size; }
  }
}

// ---- 1) 找工作区内层 node_modules 里的链接 ----
const links = [];
for (const scope of SCOPES) {
  const root = path.join(DEPLOY, scope);
  if (!fs.existsSync(root)) continue;
  const stack = [[root, 0]];
  const seen = new Set();
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > 6) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name === 'node_modules') {
        // 跳过 workspace 顶层自己的 node_modules（不存在于 resources/packages 下）
        if (seen.has(abs)) continue;
        seen.add(abs);
        collectLinks(abs, links, DEPLOY);
        continue;
      }
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isDirectory() && !st.isSymbolicLink()) stack.push([abs, depth + 1]);
    }
  }
}

log(`deploy = ${DEPLOY}`);
log(`found ${links.length} junction(s) under ${SCOPES.join(', ')}`);
const byTarget = new Map();
for (const l of links) {
  const key = l.target || '(unreadable)';
  byTarget.set(key, (byTarget.get(key) || 0) + 1);
}
for (const [t, n] of [...byTarget].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  log(`  x${String(n).padStart(3)}  ${t.replace(DEPLOY + path.sep, '')}`);
}

// ---- 2) 预测载荷 ----
function predict() {
  const stats = { files: 0, bytes: 0, linksBroken: 0 };
  for (const sub of ['resources', 'locales']) {
    const p = path.join(DEPLOY, sub);
    if (fs.existsSync(p)) simulatePack(p, stats);
  }
  return stats;
}

// ---- 2.7) 空壳包自愈 ----
// 事故（2026-09-18）：插件 node_modules 下的实体依赖目录（cosmokit/schemastery）内容被
// 清成空壳（有目录无文件、无 package.json）。空壳会遮蔽 Node 向上解析（最近匹配优先），
// 令共享回退失效 → cordis 插件树加载失败 → dsh web 秒退（exit code=1，卡启动页）。
// 该空壳还被 NSIS 如实打包，导致安装版同样崩溃。自愈：删空壳，重建指向运行时
// @deepseek-ai/<name>（其次裸名）的 junction（与原始布局一致，NSIS File /r 会解引用入包）。
function countFilesDeep(d) {
  let n = 0;
  let es;
  try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return 0; }
  for (const x of es) {
    const xa = path.join(d, x.name);
    if (x.isDirectory()) n += countFilesDeep(xa);
    else n++;
  }
  return n;
}

function healHuskedPackages(apply) {
  const extRoot = path.join(DEPLOY, 'resources', 'packages', 'extensions');
  if (!fs.existsSync(extRoot)) return { healed: [], unhealed: [] };
  const rtNm = path.join(DEPLOY, 'resources', 'dsh-runtime', 'node_modules');
  const healed = [];
  const unhealed = [];
  for (const plugin of fs.readdirSync(extRoot, { withFileTypes: true })) {
    if (!plugin.isDirectory() || plugin.name === 'node_modules') continue;
    const nm = path.join(extRoot, plugin.name, 'node_modules');
    if (!fs.existsSync(nm)) continue;
    let es;
    try { es = fs.readdirSync(nm, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      if (e.name.startsWith('@')) continue; // scope 容器目录合法，不属于包
      const abs = path.join(nm, e.name);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      if (fs.existsSync(path.join(abs, 'package.json'))) continue;
      if (countFilesDeep(abs) > 0) continue; // 有文件但缺 package.json：非空壳，人工排查
      const src = [path.join(rtNm, '@deepseek-ai', e.name), path.join(rtNm, e.name)]
        .find((c) => { try { return fs.statSync(c).isDirectory(); } catch { return false; } });
      if (!src) { unhealed.push(`${plugin.name}/node_modules/${e.name} (运行时无源包)`); continue; }
      if (!apply) { healed.push(`(dry-run) ${plugin.name}/node_modules/${e.name} -> ${src}`); continue; }
      try {
        fs.rmSync(abs, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
        fs.symlinkSync(src, abs, 'junction');
        healed.push(`${plugin.name}/node_modules/${e.name} -> ${src}`);
      } catch (err) {
        unhealed.push(`${plugin.name}/node_modules/${e.name} (${err && err.message})`);
      }
    }
  }
  return { healed, unhealed };
}

/**
 * 移除 `dsh-runtime` 下的「跨界 junction」——目标落在 `resources/packages` 里的链接。
 *
 * 事故（2026-09-18）：`dsh-runtime/node_modules/{dsh-better-sidebar,@yuxianglin/dsh-bridge-browser}`
 * 是指向 `resources/packages/extensions/*` 的 junction。`.nsi` 对 `resources/packages` 用
 * `/x "node_modules"` 排除插件自身的 node_modules（改由运行时共享回退重建），但 `dsh-runtime`
 * 是**无排除完整打包**的：makensis 会顺着这两个跨界 junction 进入 packages/extensions，
 * 再遍历到插件内部 `node_modules/{schemastery,cosmokit}` 等 junction —— 越过 `/x node_modules`
 * 边界进入本应排除的子树，一旦火绒对链接 stat/open 返回 EPERM 即整体中断：
 *   File: failed opening file "...\dsh-better-sidebar\node_modules\schemastery"
 *   Error in script "... .nsi" on line 138 -- aborting creation process
 *
 * 安全性：这两个链接纯属运行时解析便利，**不在打包产物中重建**（全新安装的目标机没有它们，
 * prepareDshHome/ensureExtensionsModuleFallback 只在 <extensions>/node_modules 与
 * profiles/<name>/node_modules 建链接），删掉不影响安装态运行。
 *
 * 与 `scripts/_opt_payload_predict.mjs` 的 `broken junctions skipped` 计数对应：
 * 该计数不为 0 即说明存在需要本函数清理的跨界链接。
 */
function removeCrossingJunctions(apply) {
  const rtRoot = path.join(DEPLOY, 'resources', 'dsh-runtime');
  if (!fs.existsSync(rtRoot)) return { found: [], removed: [], failed: [] };
  const pkgsMarker = path.sep + path.join('resources', 'packages') + path.sep;
  const found = [];
  (function walk(d, depth) {
    if (depth > 30) return;
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const abs = path.join(d, e.name);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) {
        let t = '';
        try { t = fs.readlinkSync(abs); } catch { continue; }
        const norm = t.replace(/\//g, path.sep);
        if (norm.includes(pkgsMarker) || norm.includes(path.sep + 'packages' + path.sep)) {
          found.push({ abs, rel: path.relative(DEPLOY, abs), target: t });
        }
        continue;
      }
      if (st.isDirectory()) walk(abs, depth + 1);
    }
  })(rtRoot, 0);

  const removed = [];
  const failed = [];
  for (const f of found) {
    if (!apply) { removed.push(`(dry-run) ${f.rel} -> ${f.target}`); continue; }
    try {
      fs.unlinkSync(f.abs);
      removed.push(`${f.rel} -> ${f.target}`);
    } catch (e) {
      // 火绒可能锁定链接：退化为 .NET Directory.Delete（Windows 下删 reparse point 本身）
      failed.push(`${f.rel}: ${e && e.message}`);
    }
  }
  return { found, removed, failed };
}

const cross0 = removeCrossingJunctions(false);
if (cross0.found.length) {
  log(`跨界 junction 检测（dsh-runtime -> resources/packages）: ${cross0.found.length}`);
  for (const f of cross0.found) log('  cross: ' + f.rel + ' -> ' + f.target);
} else {
  log('跨界 junction 检测: 0（dsh-runtime 无指向 resources/packages 的链接）');
}

const husk0 = healHuskedPackages(false);
if (husk0.healed.length || husk0.unhealed.length) {
  log(`空壳包检测: 可自愈 ${husk0.healed.length}, 无法自愈 ${husk0.unhealed.length}`);
  for (const h of husk0.healed) log('  heal: ' + h);
  for (const h of husk0.unhealed) log('  FAIL: ' + h);
}

if (PREDICT_ONLY) {
  const s = predict();
  log(`PREDICT (with junctions): files=${s.files} bytes=${s.bytes} (${mb(s.bytes)} MB) brokenLinks=${s.linksBroken}`);
  process.exit(0);
}

const before = predict();
log(`payload BEFORE: files=${before.files} bytes=${before.bytes} (${mb(before.bytes)} MB)`);

if (!APPLY) {
  log('dry-run：未做任何修改。加 --apply 执行。');
  process.exit(0);
}

// ---- 2.5) 备份链接清单（可回滚：按 rel -> target 重建 junction） ----
const backupDir = path.join(
  'D:/WorkSpace/deepseek-harness-master/apps/agent-client/release',
  `_flatten-backup-${Date.now()}`,
);
try {
  fs.mkdirSync(backupDir, { recursive: true });
  const rollback = path.join(backupDir, 'links.json');
  fs.writeFileSync(rollback, JSON.stringify({ deploy: DEPLOY, at: new Date().toISOString(), links }, null, 2));
  log(`rollback manifest -> ${rollback}`);
} catch (e) {
  console.error('[flatten] cannot write rollback manifest:', e && e.message);
  process.exit(3);
}

// ---- 3) 删除链接（只 unlink 链接本身） ----
let removed = 0;
const failures = [];
for (const l of links) {
  try {
    fs.unlinkSync(l.abs);
    removed++;
  } catch (e) {
    failures.push(`${l.rel}: ${e && e.message}`);
  }
}
log(`removed ${removed}/${links.length} junction(s)`);
if (failures.length) {
  log(`FAILED ${failures.length}:`);
  for (const f of failures.slice(0, 20)) log('  ' + f);
}

// ---- 3.4) 跨界 junction 清理（apply 模式实际执行）----
// 必须在空壳自愈之后仍保持 0 个跨界链接：否则 makensis 会沿 dsh-runtime 下的链接
// 越界进入 packages/extensions 的 node_modules 子树（本应被 /x "node_modules" 排除），
// 遇火绒 EPERM 时整包构建中断。见 removeCrossingJunctions 注释。
const cross = removeCrossingJunctions(true);
for (const r of cross.removed) log('cross-removed: ' + r);
if (cross.failed.length) {
  console.error('[flatten] 跨界 junction 删除失败（火绒可能锁定链接；makensis 将可能中断）:');
  for (const r of cross.failed) console.error('  ' + r);
  console.error('  提示：用 PowerShell [System.IO.Directory]::Delete(<path>, $false) 绕过 EPERM 后重试。');
  process.exit(5);
}
if (cross.removed.length) log(`跨界 junction: 已清理 ${cross.removed.length}`);

// ---- 3.5) 空壳包自愈（apply 模式实际执行）----
const husk = healHuskedPackages(true);
for (const h of husk.healed) log('healed: ' + h);
if (husk.unhealed.length) {
  console.error('[flatten] 空壳包无法自愈（打包前必须解决，否则安装版会因 cordis 插件树加载失败而卡启动页）:');
  for (const h of husk.unhealed) console.error('  ' + h);
  process.exit(4);
}

const after = predict();
log(`payload AFTER : files=${after.files} bytes=${after.bytes} (${mb(after.bytes)} MB)`);
log(`saved: ${before.files - after.files} entries, ${mb(before.bytes - after.bytes)} MB`);
process.exit(failures.length ? 2 : 0);
