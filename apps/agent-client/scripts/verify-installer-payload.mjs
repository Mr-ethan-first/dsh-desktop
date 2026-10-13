#!/usr/bin/env node
// verify-installer-payload.mjs —— 安装包载荷交叉核对（7z 归档 ↔ 部署树）。
//
// 目的：NSIS 的 `File /r` + 掩码 + `/x node_modules` 一旦写错，产物会「少文件」而
// 不一定报错（少一个插件依赖 = 装完才炸）。本脚本把「按 .nsi 规则**应该**被打包的
// 每一个文件」与「归档里**实际**存在的每一个文件」做双向 diff：
//   - MISSING   = 应该打包却没进包（功能丢失，必须为 0，非 0 直接 exit 1）
//   - UNEXPECTED= 进了包但规则说不该有（可能是排除规则失效，需人工确认）
// 排除规则唯一定义在 `_opt_payload_predict.mjs`（用 --emit-list 导出预期清单），
// 本脚本只做 diff，避免出现「NSIS / 预测 / 校验」三份规则互相漂移。
//
// 用法：
//   node scripts/verify-installer-payload.mjs [setup.exe 路径] [--deploy D:/DeepSeekAgent]
// 环境变量：DSH_7Z 指定 7z 可执行文件（默认探测常见路径）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const di = argv.indexOf('--deploy');
const DEPLOY = di >= 0 && argv[di + 1] ? argv[di + 1] : 'D:/DeepSeekAgent';
const SETUP = argv.find((a) => !a.startsWith('--') && a !== DEPLOY)
  || path.join(APP_ROOT, 'release', 'DeepSeekAgent-Setup-0.1.0.exe');

const failures = [];
const notes = [];
const check = (cond, msg) => { if (cond) notes.push('  ok   ' + msg); else failures.push(msg); };

// ---- 7z 定位 ----
function pick7z() {
  const cands = [
    process.env.DSH_7Z,
    'D:/software/7-Zip/7z.exe',
    'C:/Program Files/7-Zip/7z.exe',
    'C:/Program Files (x86)/7-Zip/7z.exe',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  const w = spawnSync('7z', ['i'], { windowsHide: true });
  return w.status === 0 ? '7z' : null;
}
const SEVEN_Z = pick7z();
if (!SEVEN_Z) { console.error('找不到 7z（用 DSH_7Z 指定）'); process.exit(1); }
if (!fs.existsSync(SETUP)) { console.error('安装包不存在:', SETUP); process.exit(1); }

// ---- 1) 导出预期清单（复用预测脚本，排除规则唯一来源） ----
const listFile = path.join(os.tmpdir(), `dsh-expected-payload-${process.pid}.txt`);
const emit = spawnSync(process.execPath,
  [path.join(__dirname, '_opt_payload_predict.mjs'), '--deploy', DEPLOY, `--emit-list=${listFile}`],
  { encoding: 'utf8', windowsHide: true });
if (emit.status !== 0) {
  console.error('预测脚本失败:\n', emit.stdout, emit.stderr);
  process.exit(1);
}
const expected = new Set(
  fs.readFileSync(listFile, 'utf8').split(/\r?\n/).filter(Boolean),
);
try { fs.unlinkSync(listFile); } catch { /* ignore */ }

// ---- 2) 读取归档清单 ----
const lz = spawnSync(SEVEN_Z, ['l', '-slt', SETUP], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
if (lz.status !== 0) { console.error('7z 列举失败:', lz.stderr); process.exit(1); }
const setupBase = path.basename(SETUP);
const actual = new Set();
for (const line of lz.stdout.split(/\r?\n/)) {
  if (!line.startsWith('Path = ')) continue;
  const p = line.slice('Path = '.length).trim();
  // 归档自身的根条目（7z 会把 setup.exe 以「相对路径 + 文件名」列出）
  if (!p || path.basename(p) === setupBase) continue;
  actual.add(p);
}

// ---- 3) 双向 diff ----
// `uninstall.exe` 由 NSIS `WriteUninstaller` 在安装期生成并内嵌，7z 会把它列出，
// 但它不是被 `File` 打包的载荷 → 属于预期的「多出来」条目。
// 归档里允许存在、但不属于「部署树载荷」的合法条目。
//   - uninstall.exe：NSIS WriteUninstaller 在安装期生成并内嵌，7z 会把它列出。
//   - $PLUGINSDIR\System.dll：NSIS 官方 System 插件（提供 System::Call）。安装脚本用它
//     调 kernel32::SetEnvironmentVariable 来触发 DSH_WARMUP=1 预热（`--warmup` 命令行会
//     被 Electron 自己解析并报 bad option）。它是 makensis 自动注入的运行时依赖，
//     不是我们不打包的部署文件，因此必须白名单，否则反向核对会把它当「部署树缺失」误报。
const BENIGN_EXTRA = new Set(['uninstall.exe', '$PLUGINSDIR\\System.dll']);
const missing = [...expected].filter((p) => !actual.has(p));
const unexpected = [...actual].filter((p) => !expected.has(p) && !BENIGN_EXTRA.has(p));

// ---- 3.5) 反向核对：归档里每个载荷文件都必须真实存在于部署树 ----
// 为什么必需：上面的 `expected` 是**从部署树 walk 出来的**。一旦部署树被清空（例如清临时
// 目录时 `robocopy /MIR` 跟随 junction 穿透删掉了 dsh-runtime 的包），expected 会同步变小，
// MISSING 恒为 0 → 门禁「通过」但实际安装树已缺文件（真实发生过：commander 等 6865 个文件
// 被清空而门禁仍报 15/15 PASS）。反向核对把这类静默损坏钉死。
const deployMissing = [...actual].filter(
  (p) => !BENIGN_EXTRA.has(p) && !fs.existsSync(path.join(DEPLOY, p)),
);

console.log(`setup    = ${SETUP} (${(fs.statSync(SETUP).size / 1048576).toFixed(1)} MB)`);
console.log(`deploy   = ${DEPLOY}`);
console.log(`expected = ${expected.size} files`);
console.log(`archived = ${actual.size} files`);

check(missing.length === 0, `归档文件完整：应打包 ${expected.size} 个，缺失 ${missing.length} 个`);
check(actual.size >= expected.size * 0.98, `归档条目数与预期同量级（${actual.size} vs ${expected.size}）`);
check(deployMissing.length === 0,
  `部署树未被静默损坏：归档 ${actual.size} 个载荷在 ${DEPLOY} 缺失 ${deployMissing.length} 个`);

// 测试/规格文件绝不随包
const testFiles = [...actual].filter((p) => /\.(spec|test)\.[cm]?[jt]sx?$/i.test(p));
check(testFiles.length === 0, `归档不含 *.spec/*.test（实测 ${testFiles.length}）`);

// 关键产物
const REQUIRED = [
  'DeepSeekAgent.exe',
  'resources\\app.asar',
  'resources\\dsh-runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  'resources\\packages\\extensions\\dsh-better-sidebar\\cordis.patch.yml',
  'resources\\browser-extension\\manifest.json',
  'locales\\zh-CN.pak',
];
for (const r of REQUIRED) check(actual.has(r), `归档含关键文件 ${r}`);

// 刻意排除项不得回流（会成倍放大体积）
const FORBIDDEN_SUBSTR = [
  '\\node_modules\\node-pty-darwin-arm64\\',
  '\\node_modules\\node-pty-linux-x64\\',
  '\\.github\\',
  '\\.vscode\\',
  '\\.pnpm\\',
];
for (const s of FORBIDDEN_SUBSTR) {
  const hit = [...actual].filter((p) => p.includes(s)).length;
  check(hit === 0, `归档不含被排除项 ${s}（实测 ${hit}）`);
}
// resources/packages 下的 node_modules 必须为空（运行期由共享回退重建）
const pkgNm = [...actual].filter((p) => /^resources\\packages\\[^\\]+\\node_modules\\/i.test(p));
check(pkgNm.length === 0, `resources/packages/**/node_modules 未随包（实测 ${pkgNm.length}；运行期由共享解析回退重建）`);

// ---- 载荷排除模式不得误伤代码/资源文件 ----
// NSIS 的 /x 掩码**大小写不敏感且 `*` 跨点**：历史掩码 README* / CHANGELOG* / HISTORY*
// 把 changelog.js、甚至整个 @lexical/history 目录一起删了。2026-09-15 实测事故：
// 安装态缺 resources\packages\extensions\dsh-market\lib\changelog.js，而 dsh-market 的
// routes.js `import './changelog.js'` → 整棵插件树加载失败 → dsh web exit code 1 →
// exe 永久卡在「正在启动 DSH Web 工作台…」。此检查只读扫描部署树：凡「名字命中 prose
// 掩码、扩展名却是代码/资源」的文件，必须出现在归档里（这类文件没有任何理由被排除）。
// 判定用「代码/资源扩展名白名单」而非 prose 黑名单：只有这些扩展名的文件被排除才可能是事故，
// prose（.md/.txt/.yaml…）剔不剔都无害，用黑名单会把 README.i18n.yaml 之类算成误伤（噪声）。
//
// 注意（2026-09-18）：白名单**不含** .ts/.tsx/.mts/.cts —— 它们是 2026-09-17 新增掩码
// （*.ts / *.tsx / *.cts / *.mts）的**刻意排除项**：dsh web 以 `node --expose-internals
// <dsh>/lib/bin.js` 启动（纯 CJS 构建产物），cordis boot 探针实测「启动期间加载 0 个 .ts」，
// TS 源是死重（dsh-runtime 因此从 290.2MB 降到 167.6MB）。把 TS 列入白名单会让本断言把
// 设计内排除误判为事故。真正要守住的是**运行期 JS**（.js/.cjs/.mjs）与资源不被误删
// —— 2026-09-15 的事故正是 changelog.js / @lexical/history 这类 JS 被裸名掩码扫掉。
const CODE_EXT = new Set([
  '.js', '.cjs', '.mjs', '.jsx',
  '.css', '.html', '.htm', '.node', '.wasm', '.vue', '.svelte', '.json',
]);
const PROSE_MASKS = [/^readme/i, /^changelog/i, /^contributing/i, /^authors/i, /^history/i];
const mustShip = [];
const walkDeploy = (dir, insideProseDir = false) => {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue; // 不跟随链接：junction 会拖进整棵运行时树
    // 刻意的整目录排除（不算误伤）：
    //   .dsh-*                pnpm 工作区包的「真实存储」副本，同名 junction 已被 File /r 展开
    //   <extensions>/node_modules  运行期由 ensureExtensionsModuleFallback 重建
    if (/\\\.dsh-/.test(p) || /\\packages\\[^\\]+\\node_modules\\/.test(p)) continue;
    // 目录名命中 prose 掩码同样危险：NSIS 的 "HISTORY*" 曾把整个 @lexical/history 目录删掉，
    // 而目录内的文件（index.js 等）文件名并不带 history —— 只看文件名会漏判。
    const proseNamedDir = PROSE_MASKS.some((r) => r.test(e.name));
    if (st.isDirectory()) { walkDeploy(p, insideProseDir || proseNamedDir); continue; }
    const nameHit = insideProseDir || PROSE_MASKS.some((r) => r.test(e.name));
    if (!nameHit) continue;
    if (!CODE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    if (/\.d\.[cm]?ts$/i.test(e.name)) continue; // 类型声明是刻意排除项（运行期不读）
    mustShip.push(path.relative(DEPLOY, p));
  }
};
walkDeploy(DEPLOY);
const proseDropped = mustShip.filter((p) => !actual.has(p));
check(proseDropped.length === 0,
  `排除模式未误伤代码文件：部署树有 ${mustShip.length} 个「prose 名 + 代码扩展」文件，归档缺 ${proseDropped.length} 个` +
  (proseDropped.length ? '；例：' + proseDropped.slice(0, 5).join(' / ') : ''));
// 具名锚点：dsh-market 的 routes.js -> ./changelog.js 是 dsh web boot 的硬依赖
check(actual.has('resources\\packages\\extensions\\dsh-market\\lib\\changelog.js'),
  '归档含 dsh-market/lib/changelog.js（dsh web boot 硬依赖）');

// ---- 报告 ----
if (unexpected.length) {
  console.log(`\n--- UNEXPECTED (${unexpected.length})，前 20 条 ---`);
  for (const p of unexpected.slice(0, 20)) console.log('  ' + p);
}
if (missing.length) {
  console.log(`\n--- MISSING (${missing.length})，前 20 条 ---`);
  for (const p of missing.slice(0, 20)) console.log('  ' + p);
}
if (deployMissing.length) {
  console.log(`\n--- 部署树缺失 (${deployMissing.length})，前 20 条 ---`);
  for (const p of deployMissing.slice(0, 20)) console.log('  ' + p);
}

console.log('\n================ 结果 ================');
console.log(`通过 ${notes.length} 项，失败 ${failures.length} 项`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length ? 1 : 0);
