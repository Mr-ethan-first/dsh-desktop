/**
 * 打包载荷预测：模拟 NSIS `File /r`（跟随 junction 展开）并套用 `.nsi` 里的排除掩码，
 * 在真正 makensis 之前就得到「归档条目数 / 解压字节数」的预期值，用于改动前后对比。
 *
 * 与 `installer/DeepSeekAgent.nsi` 的 EXCL 列表保持一一对应；改掩码时同步改这里。
 *
 * 用法：node scripts/_opt_payload_predict.mjs [--deploy D:/DeepSeekAgent]
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const i = argv.indexOf('--deploy');
const DEPLOY = i >= 0 && argv[i + 1] ? argv[i + 1] : 'D:/DeepSeekAgent';
// --emit-list=<file>：把预期会被归档的相对路径（反斜杠，相对部署根）写成清单，
// 供 scripts/verify-installer-payload.mjs 与真实 `7z l -slt` 归档做交叉核对。
// 排除规则只有本文件一处定义，避免「NSIS / 预测 / 校验」三份规则漂移。
const emitArg = argv.find((a) => a.startsWith('--emit-list='));
const EMIT = emitArg ? emitArg.slice('--emit-list='.length) : null;

/** 与 .nsi 的 /x 掩码一一对应。`*` 匹配任意字符（含点），与 NSIS 语义一致。 */
const EXCL = [
  '*.spec.ts', '*.spec.tsx', '*.spec.js', '*.spec.mjs', '*.spec.cjs',
  '*.test.ts', '*.test.tsx', '*.test.js', '*.test.mjs', '*.test.cjs',
  'tests', '__tests__',
  // 运行期不需要的类型声明 / sourcemap / 构建信息 / 调试符号
  '*.d.ts', '*.map', '*.tsbuildinfo', '*.pdb',
  // 2026-09-17 新增：TypeScript 源与文档。dsh web 以
  // `node --expose-internals <dsh>/lib/bin.js` 启动（纯 CJS 构建产物），全量 cordis
  // 启动探针实测「启动期间加载 .ts/.md 文件数 = 0」→ 运行时只依赖编译后的
  // lib/*.js + 配置 JSON，这些全是死重。dsh-runtime 290.2MB → 167.6MB。
  // 仍坚持「逐扩展名」原则，绝不用裸名掩码。
  '*.ts', '*.tsx', '*.cts', '*.mts', '*.md', '*.markdown', '*.rst',
  // 纯文档。注意：**不要**用 README*/CHANGELOG*/HISTORY* 这类裸名掩码 —— NSIS 掩码
  // 大小写不敏感且 `*` 跨点，会连 changelog.js、整个 @lexical/history 目录一起删
  // （2026-09-15 实测：安装态缺 dsh-market/lib/changelog.js → dsh web boot 崩 → exe 卡启动页）。
  // 也不能用裸名（README / HISTORY）：裸名同样匹配**同名目录**，@lexical/history 就是这么丢的。
  // 故只列「确切文件名 + 扩展名」。
  'README.md', 'README.txt', 'README.markdown', 'README.rst',
  'CHANGELOG.md', 'CHANGELOG.txt', 'CHANGELOG.markdown', 'CHANGELOG.rst',
  'CONTRIBUTING.md', 'CONTRIBUTING.txt',
  'AUTHORS.md', 'AUTHORS.txt',
  'HISTORY.md', 'HISTORY.txt',
  // 非 win32-x64 的原生预编译产物
  'node-pty-darwin-arm64', 'node-pty-darwin-x64', 'node-pty-linux-arm64',
  'node-pty-linux-x64', 'node-pty-win32-arm64',
  // 仓库/编辑器元数据
  '.github', '.vscode',
  // pnpm 工作区包的「真实存放目录」：同名 junction 已被 File /r 展开成真实目录，
  // 两者内容完全相同，保留一份即可（省去约 85MB 重复）。
  '.dsh-*',
].map((p) => p.toLowerCase());

function excluded(name, extra = []) {
  const n = name.toLowerCase();
  for (const mask of extra.concat(EXCL)) {
    const star = mask.indexOf('*');
    if (star < 0) { if (n === mask) return true; continue; }
    const prefix = mask.slice(0, star);
    const suffix = mask.slice(star + 1);
    if (n.length >= prefix.length + suffix.length && n.startsWith(prefix) && n.endsWith(suffix)) return true;
  }
  return false;
}

/** Electron 运行时根目录必须逐文件打包的文件（.nsi 里逐个 File 的清单）。 */
const ROOT_FILES = [
  'DeepSeekAgent.exe', 'LICENSE', 'LICENSE.electron.txt', 'LICENSES.chromium.html',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak',
  'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat',
  'libEGL.dll', 'libGLESv2.dll', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
  'version', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll',
  // .nsi 把 installer\DeepSeekAgent.cmd 拷成 $INSTDIR\DeepSeekAgent.cmd（来源在 SRC 之外，
  // 但与部署根同名同内容），计入预期清单以保证交叉核对双向可比。
  'DeepSeekAgent.cmd',
];
/** locales 白名单（Electron 只需运行时实际使用的语言包）。 */
const LOCALES = ['zh-CN.pak', 'en-US.pak'];

const stats = { files: 0, bytes: 0, skipJunction: 0 };
const perArea = new Map();
/** 预期归档相对路径（反斜杠），仅在 --emit-list 时使用。 */
const expected = [];
let area = '(root)';

function record(name, size, rel) {
  stats.files++;
  stats.bytes += size;
  if (rel) expected.push(rel);
  const a = perArea.get(area) || { n: 0, b: 0 };
  a.n++; a.b += size;
  perArea.set(area, a);
}

function walk(dir, depth = 0, extra = [], relPrefix = '') {
  if (depth > 40) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (excluded(e.name, extra)) continue;
    const abs = path.join(dir, e.name);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) {
      // NSIS File /r 会跟随 junction 展开成真实目录/文件
      let real, rst;
      try { real = fs.realpathSync(abs); rst = fs.statSync(real); } catch { stats.skipJunction++; continue; }
      if (rst.isDirectory()) walk(real, depth + 1, extra, relPrefix + e.name + '\\');
      else record(e.name, rst.size, relPrefix + e.name);
      continue;
    }
    if (st.isDirectory()) { walk(abs, depth + 1, extra, relPrefix + e.name + '\\'); continue; }
    if (st.isFile()) record(e.name, st.size, relPrefix + e.name);
  }
}

const mb = (b) => (b / 1048576).toFixed(1);

// ---- root ----
for (const f of ROOT_FILES) {
  const p = path.join(DEPLOY, f);
  try { const st = fs.statSync(p); area = '(electron root)'; record(f, st.size, f); } catch { /* 缺失 */ }
}
for (const l of LOCALES) {
  const p = path.join(DEPLOY, 'locales', l);
  try { const st = fs.statSync(p); area = 'locales (whitelist)'; record(l, st.size, 'locales\\' + l); } catch { /* 缺失 */ }
}
const subtrees = [
  // resources/packages 下的任何 node_modules 都不打包：
  //   - <extensions>/node_modules 是运行时按需重建的共享解析回退（内含指向运行时的
  //     junction，打包会被展开成整棵运行时 → +200MB 纯重复）；
  //   - 插件包自身的 node_modules 已由 _opt_flatten_deploy.mjs 清空链接，
  //     其中真实副本（cosmokit/schemastery）由该共享回退覆盖。
  ['resources/app.asar', 'app.asar', []],
  // 随包外挂的独立 Node 运行时（.nsi 的 `File "${SRC}\resources\node.exe"`）：
  // Electron 内置 Node 无法跑 dsh web（HMR 需要真实 --expose-internals），
  // main.cjs 优先用这个二进制。单独列出（顶层 resources 文件，不在任何 subtree walk 内）。
  ['resources/node.exe', 'node.exe', []],
  ['resources/app.asar.unpacked', 'app.asar.unpacked', []],
  ['resources/apps', 'resources/apps', []],
  ['resources/dsh-runtime', 'dsh-runtime', []],
  ['resources/packages', 'resources/packages', ['node_modules']],
  ['resources/browser-extension', 'browser-extension', []],
];
for (const [rel, label, extra] of subtrees) {
  const p = path.join(DEPLOY, rel);
  if (!fs.existsSync(p)) continue;
  const st = fs.statSync(p);
  const relWin = rel.replace(/\//g, '\\');
  area = label;
  if (st.isFile()) record(path.basename(p), st.size, relWin);
  else walk(p, 0, extra, relWin + '\\');
}

// ---- 插件自带 node_modules：空壳硬门禁（不计入载荷）----
// 设计：NSI 对 resources/packages 用 /x "node_modules" 整体排除插件本地 node_modules，
// 运行时由 ensureExtensionsModuleFallback 重建共享回退（<extensions>/node_modules）承接解析
// ——该设计已验证可用（2026-09-17 19:44 完整启动）。事故（2026-09-18）：源树里
// dsh-better-sidebar/node_modules/{schemastery,cosmokit} 被清成空壳目录（有目录无文件），
// 空壳遮蔽向上解析（最近匹配优先）→ 共享回退失效 → cordis 插件树加载失败 → dsh web
// 秒退卡启动页。此处只做健康门禁：非 scope、非链接、缺 package.json 且整棵无文件 → 失败退出，
// 先运行 node scripts/_opt_flatten_deploy.mjs --apply 自愈。
const husks = [];
const EXT_ROOT = path.join(DEPLOY, 'resources', 'packages', 'extensions');
if (fs.existsSync(EXT_ROOT)) {
  for (const plugin of fs.readdirSync(EXT_ROOT, { withFileTypes: true })) {
    if (!plugin.isDirectory() || plugin.name === 'node_modules') continue;
    const nm = path.join(EXT_ROOT, plugin.name, 'node_modules');
    if (!fs.existsSync(nm)) continue;
    let es;
    try { es = fs.readdirSync(nm, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      if (e.name.startsWith('@')) continue; // scope 容器目录合法
      const abs = path.join(nm, e.name);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      if (fs.existsSync(path.join(abs, 'package.json'))) continue;
      let files = 0;
      (function countDeep(d) {
        let xes;
        try { xes = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const x of xes) {
          const xa = path.join(d, x.name);
          if (x.isDirectory()) countDeep(xa);
          else files++;
        }
      })(abs);
      if (files === 0) husks.push(`${plugin.name}/node_modules/${e.name}`);
    }
  }
}
if (husks.length) {
  console.error(`HUSK DETECTED (${husks.length}) — 空壳包会遮蔽共享解析回退，令 cordis 插件树加载失败（安装版卡启动页）:`);
  for (const h of husks) console.error('  ' + h);
  console.error('修复: node scripts/_opt_flatten_deploy.mjs --apply （自愈后重跑本预测器）');
  process.exit(2);
}

// ---- 跨界 junction 硬门禁 ----
// 事故（2026-09-18）：dsh-runtime 下存在指向 resources/packages 的 junction 时，makensis
// 会沿它越界进入 packages/extensions 的 node_modules 子树（.nsi 对 packages 用
// /x "node_modules" 排除，但跨界的 dsh-runtime 子树没有该排除），遇火绒 EPERM 即中断：
//   File: failed opening file "...\dsh-better-sidebar\node_modules\schemastery"
//   Error in script "... .nsi" on line 138 -- aborting creation process
// 修复：node scripts/_opt_flatten_deploy.mjs --apply （removeCrossingJunctions 清理）
const crossing = [];
const rtRoot = path.join(DEPLOY, 'resources', 'dsh-runtime');
(function findCross(d, depth) {
  if (depth > 30) return;
  let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const abs = path.join(d, e.name);
    let st; try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) {
      let t = ''; try { t = fs.readlinkSync(abs); } catch { continue; }
      if (t.replace(/\//g, '\\').includes('\\resources\\packages\\')) {
        crossing.push(path.relative(DEPLOY, abs).replace(/\//g, '\\') + ' -> ' + t.replace(/\//g, '\\'));
      }
      continue;
    }
    if (st.isDirectory()) findCross(abs, depth + 1);
  }
})(rtRoot, 0);
if (crossing.length) {
  console.error(`CROSSING JUNCTION DETECTED (${crossing.length}) — dsh-runtime 下指向 resources/packages 的链接会让 makensis 越界进入本应排除的插件 node_modules（火绒 EPERM 时整包构建中断）:`);
  for (const c of crossing) console.error('  ' + c);
  console.error('修复: node scripts/_opt_flatten_deploy.mjs --apply （清理后重跑本预测器）');
  process.exit(3);
}

console.log(`deploy = ${DEPLOY}`);
console.log(`masks  = ${EXCL.length}`);
console.log(`PREDICTED PAYLOAD: entries=${stats.files} bytes=${stats.bytes} (${mb(stats.bytes)} MB)`);
if (stats.skipJunction) console.log(`broken junctions skipped: ${stats.skipJunction}`);
console.log('--- by area ---');
for (const [k, v] of [...perArea].sort((a, b) => b[1].b - a[1].b)) {
  console.log(`${String(v.n).padStart(7)}  ${mb(v.b).padStart(8)} MB  ${k}`);
}

if (EMIT) {
  fs.writeFileSync(EMIT, [...new Set(expected)].sort().join('\n') + '\n');
  console.log(`--- emitted expected list: ${EMIT} (${expected.length} paths) ---`);
}
