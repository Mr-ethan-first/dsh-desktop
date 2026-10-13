// verify-82.mjs —— #82 七插件能力验证（部署态，只读探测）。
// 复用 exe 内部同一函数 readCommunityPlugins()（来自 dsh-web-launcher.cjs），
// 对「部署态真实 EXTENSIONS_DIR」做探测：它能把哪些社区插件写进 web profile bundles。
// 同时列出该目录下所有插件子目录（供 in-app 插件宿主扫描用）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const RES = 'D:/DeepSeekAgent/resources';
const LAUNCHER = path.join(RES, 'app.asar.unpacked', 'electron', 'plugin-host', 'dsh-web-launcher.cjs');
const EXT = path.join(RES, 'packages', 'extensions'); // 部署态真实 EXTENSIONS_DIR

const out = [];
const say = (s) => { out.push(s); console.log(s); };

const launcher = require(LAUNCHER);

// 1) EXTENSIONS_DIR 是否存在
say(`EXTENSIONS_DIR = ${EXT}`);
say(`exists = ${fs.existsSync(EXT)}`);

// 2) 目录下所有插件子目录（in-app 宿主扫描全集）
let allDirs = [];
if (fs.existsSync(EXT)) {
  allDirs = fs.readdirSync(EXT, { withFileTypes: true })
    .filter(e => e.isDirectory() || (e.isSymbolicLink()))
    .map(e => e.name);
}
say(`all plugin subdirs (${allDirs.length}): ${allDirs.join(', ') || '(none)'}`);

// 3) 能进 web profile bundles 的（声明 dsh.bundle）
const webBundles = launcher.readCommunityPlugins(EXT).map(p => p.name);
say(`web-profile bundles from EXTENSIONS_DIR (${webBundles.length}): ${webBundles.join(', ') || '(none)'}`);

// 4) 对照：dsh-runtime/node_modules 里 7 插件是否齐全（hoisted 运行时依赖）
const B = path.join(RES, 'dsh-runtime', 'node_modules', '@deepseek-ai');
const SEVEN = ['dsh-node-flow','dsh-market','dsh-modlens','dsh-tool-cordis','dsh-client-ui-cordis','dsh-cordis-host-runner','dsh-cordis-client-runner'];
const runtimePresent = SEVEN.filter(p => fs.existsSync(path.join(B, p)));
say(`7 plugins present in dsh-runtime/node_modules (${runtimePresent.length}/7): ${runtimePresent.join(', ')}`);

// 5) 结论：注意比对的是「全限定名」（@deepseek-ai/xxx），不是短名
const WANT = ['@deepseek-ai/dsh-market','@deepseek-ai/dsh-modlens','@deepseek-ai/dsh-node-flow'];
const missing = WANT.filter(n => !webBundles.includes(n));
// 期望恰好 5 个 bundle（base + web-app + 3 社区）；多于 5 说明混入了官方包，
// 会导致 "duplicate loader entry id: code-runtime"（已实测）。
const extra = webBundles.filter(n => ![
  '@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-market','@deepseek-ai/dsh-modlens','@deepseek-ai/dsh-node-flow',
].includes(n));
const pass = missing.length === 0 && extra.length === 0;
const verdict = pass ? 'PASS' : 'GAP';
say(`=== VERDICT: ${verdict} (bundles=${webBundles.length}) ===`);
if (missing.length) say(`缺失社区插件: ${missing.join(', ')}`);
if (extra.length) say(`多余 bundle（会触发 duplicate loader entry）: ${extra.join(', ')}`);
if (!pass) process.exit(2);
process.exit(0);
