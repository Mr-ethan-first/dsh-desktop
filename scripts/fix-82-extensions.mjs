// fix-82-extensions.mjs v3 —— 免重建修复 #82（最终方案）。
//
// 背景（实测结论）：
//  v1 每个插件建 junction → readCommunityPlugins 用 dirent.isDirectory()，
//     junction 的 isDirectory() 为 false → 插件被跳过，bundles=0。
//  v2 EXTENSIONS_DIR 本身 junction 到整个 @deepseek-ai（244 包）→ bundles=10，
//     多带 5 个官方包（sdk-app/sdk-minimal/headless/acp-app/experimental-agent-team-profile），
//     它们各自的 cordis include 树与 dsh-base 冲突 →
//     "duplicate loader entry id: code-runtime" → dsh web 直接起不来（exit 1）。
//
// v3 方案：EXTENSIONS_DIR 只放 7 个社区插件（与源码态验证过的配置一致 → bundles 恰为
//   base + web-app + market + modlens + node-flow = 5）。
//   要求子目录 isDirectory() 为 true（否则扫描跳过），但又不愿整目录复制（数百 MB）。
//   → 建「轻量壳目录」：拷 package.json + cordis.patch.yml，
//     把 lib / client / data 做成指向 dsh-runtime 真实目录的 junction。
//   这样：扫描读到 dsh.bundle ✓；加载时 main=lib/index.js 经 junction realpath 到
//   dsh-runtime 真实目录，其依赖（js-yaml/undici 等）从 dsh-runtime/node_modules 正常解析 ✓。
//
// 安全：拆卸旧链接只用 unlinkSync（只删链接本身，绝不递归删目标目录）。
import fs from 'node:fs';
import path from 'node:path';

const RES = 'D:/DeepSeekAgent/resources';
const EXT = path.join(RES, 'packages', 'extensions');
const B = path.join(RES, 'dsh-runtime', 'node_modules', '@deepseek-ai');
const SEVEN = ['dsh-node-flow','dsh-market','dsh-modlens','dsh-tool-cordis','dsh-client-ui-cordis','dsh-cordis-host-runner','dsh-cordis-client-runner'];
// 不再用固定清单：各插件构建产物布局不同（market 有 lib/client/data，
// modlens 走 exports["."]="./dsh/index.js" 只有 dsh/dist/skills/src）。
// 统一链接「除 node_modules 外所有顶层子目录」，避免漏链导致加载失败。
const EXCLUDE_SUBS = new Set(['node_modules', '.git', '.cache']);

const say = (s) => console.log(s);

/** 若 p 是 junction/符号链接则 unlink（安全，不动目标）；是真目录则原样保留。 */
function removeLinkIfAny(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { fs.unlinkSync(p); return 'unlinked'; }
    return 'real-dir';
  } catch { return 'absent'; }
}

// 1) 处理 EXT 本身：v2 的顶层 junction 需拆掉，换成真实目录
if (fs.existsSync(EXT)) {
  const kind = removeLinkIfAny(EXT);
  if (kind === 'unlinked') say('已移除 v2 的顶层 junction');
  else if (kind === 'real-dir') say('EXT 已是真实目录（沿用，先清理其下链接）');
}
fs.mkdirSync(EXT, { recursive: true });

// 2) 为 7 个插件建轻量壳目录
let okCount = 0, fail = 0;
for (const name of SEVEN) {
  const real = path.join(B, name);
  const pkg = path.join(real, 'package.json');
  if (!fs.existsSync(pkg)) { say(`SKIP ${name} (runtime 无 package.json)`); fail++; continue; }
  const shim = path.join(EXT, name);
  // 壳目录若是 v1 留下的 junction 则拆掉；若是真目录则保留复用
  const kind = removeLinkIfAny(shim);
  fs.mkdirSync(shim, { recursive: true });
  // 拷 package.json
  fs.copyFileSync(pkg, path.join(shim, 'package.json'));
  // 拷 cordis.patch.yml（bundle 的 patch 清单，若存在）
  const patch = path.join(real, 'cordis.patch.yml');
  if (fs.existsSync(patch)) fs.copyFileSync(patch, path.join(shim, 'cordis.patch.yml'));
  // 重量子目录建 junction：除 EXCLUDE_SUBS 外全部链接
  const linked = [];
  const subs = fs.readdirSync(real, { withFileTypes: true })
    .filter(e => e.isDirectory() && !EXCLUDE_SUBS.has(e.name))
    .map(e => e.name);
  for (const sub of subs) {
    const rs = path.join(real, sub);
    const ss = path.join(shim, sub);
    removeLinkIfAny(ss);
    try { fs.symlinkSync(rs, ss, 'junction'); linked.push(sub); }
    catch (e) { say(`  warn ${name}/${sub}: ${e.message}`); }
  }
  // 顶层小文件（除 package.json/cordis.patch.yml 已拷外）也拷一份，保证 exports 引用完整
  const smallFiles = fs.readdirSync(real, { withFileTypes: true })
    .filter(e => e.isFile() && /\.(yml|yaml|json|md)$/i.test(e.name))
    .map(e => e.name)
    .filter(n => n !== 'package.json' && n !== 'cordis.patch.yml');
  for (const f of smallFiles) {
    try { fs.copyFileSync(path.join(real, f), path.join(shim, f)); } catch {}
  }
  say(`OK ${name} (${kind}) links=[${linked.join(',')}]`);
  okCount++;
}
say(`=== v3 fix done: ok=${okCount} fail=${fail} ===`);

// 3) 自检：扫描应只看到这 7 个真实目录
const dirs = fs.readdirSync(EXT, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
say(`EXT 可见真实目录 (${dirs.length}): ${dirs.join(', ')}`);
process.exit(fail ? 1 : 0);
