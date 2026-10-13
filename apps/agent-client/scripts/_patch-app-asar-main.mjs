// 外科式 app.asar 修补：只替换体内 electron/main.cjs（不重跑全量打包）。
//
// 背景：pack-app-asar.mjs 全量打包在火绒实时扫描下需 40min+（每次复制/删除数万文件），
// 对「仅改一个 95KB 主进程文件」的修正是极大浪费。app.asar 只有 260 个条目（主体是
// apps/web/dist），可先 extractAll 到临时目录 → 覆盖目标文件 → createPackage 重打包，
// 全程秒级~十秒级。
//
// 安全：仅当 --apply 才写盘；写盘前备份原 asar；打包后自检体内 main.cjs 与源文件字节一致。
// 用法：node scripts/_patch-app-asar-main.mjs [--apply] [--deploy D:/DeepSeekAgent]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const di = argv.indexOf('--deploy');
const DEPLOY = di >= 0 && argv[di + 1] ? argv[di + 1] : 'D:/DeepSeekAgent';
const APP_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const asarLib = require('D:/WorkSpace/deepseek-harness-master/node_modules/.pnpm/@electron+asar@3.4.1/node_modules/@electron/asar');

const deployAsar = path.join(DEPLOY, 'resources', 'app.asar');
const deployUnpacked = path.join(DEPLOY, 'resources', 'app.asar.unpacked');
const srcMain = path.join(APP_ROOT, 'electron', 'main.cjs');
const srcLauncherDir = path.join(APP_ROOT, 'electron');

if (!fs.existsSync(deployAsar)) { console.error('找不到部署态 app.asar:', deployAsar); process.exit(1); }
if (!fs.existsSync(srcMain)) { console.error('找不到源 main.cjs:', srcMain); process.exit(1); }

// 1) 解包到临时目录
const tmp = path.join(os.tmpdir(), 'dsh-asar-patch-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
asarLib.extractAll(deployAsar, tmp);
console.log('[patch] extracted to', tmp);

// 2) 用源目录的 electron/** 覆盖临时目录（同步所有主进程代码，不止 main.cjs）
const tmpElectron = path.join(tmp, 'electron');
fs.rmSync(tmpElectron, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
fs.mkdirSync(tmpElectron, { recursive: true });
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const b = e.name;
    if (b === 'node_modules' || b === '.git') continue;
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(b)) continue;
    if (b === '__tests__' || b === '__fixtures__') continue;
    const s = path.join(src, b), d = path.join(dst, b);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}
copyTree(srcLauncherDir, tmpElectron);
const newSize = fs.statSync(path.join(tmpElectron, 'main.cjs')).size;
console.log('[patch] main.cjs ->', newSize, 'bytes');

// 3) 重新打包
const outAsar = path.join(tmp, 'app.asar');
await asarLib.createPackage(tmp, outAsar, { unpack: 'electron/**' });
console.log('[patch] repacked app.asar size', fs.statSync(outAsar).size);

// 4) 自检：体内 main.cjs 与源文件字节一致
const rawHeader = asarLib.getRawHeader(outAsar);
const entry = rawHeader?.header?.files?.electron?.files?.['main.cjs'];
if (!entry || entry.size !== newSize) {
  console.error('[patch] 自检失败: 体内 main.cjs size 不符', entry && entry.size, 'vs', newSize);
  process.exit(2);
}
const body = asarLib.extractFile(outAsar, 'electron/main.cjs');
if (!body.equals(fs.readFileSync(srcMain))) {
  console.error('[patch] 自检失败: 体内 main.cjs 与源文件字节不一致');
  process.exit(3);
}
console.log('[patch] 自检通过: 体内 main.cjs 与源文件字节一致');

if (!APPLY) {
  console.log('[patch] dry-run（未写盘）。加 --apply 部署。');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

// 5) 部署（备份原 asar）
const bakDir = path.join(DEPLOY, 'resources', `_bak_asar_${Date.now()}`);
fs.mkdirSync(bakDir, { recursive: true });
fs.copyFileSync(deployAsar, path.join(bakDir, 'app.asar'));
console.log('[patch] 已备份原 asar ->', bakDir);
fs.copyFileSync(outAsar, deployAsar);
console.log('[patch] 已部署 app.asar');

// 6) 同步 app.asar.unpacked/electron（冗余副本，保持与体内一致）
const depUnpackedElectron = path.join(deployUnpacked, 'electron');
fs.rmSync(depUnpackedElectron, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
copyTree(srcLauncherDir, depUnpackedElectron);
console.log('[patch] 已同步 app.asar.unpacked/electron');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[patch] 完成');
