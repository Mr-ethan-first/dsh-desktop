/**
 * pack-prune.cjs — electron-builder afterPack 钩子。
 * 在打包完成后、asar 封包前，删减 dsh-runtime 里的纯开发/测试/跨平台依赖，
 * 防止重新构建把包吹回 600M+。仅作用于构建产物（release/win-unpacked），可安全重复运行。
 *
 * 用法：在 package.json 的 build.afterPack 指向本文件：
 *   "afterPack": "scripts/pack-prune.cjs"
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 安全裁剪清单：仅移除「构建/测试期」依赖。生产运行时（dsh web 工作台 + 原生桥接层）不加载这些包。
// ⚠️ 已实证为 RUNTIME 依赖、绝不可移除（移除后 dsh web 全量 boot 崩，ERR_MODULE_NOT_FOUND）：
//   - @img  （sharp 的彩色/原生依赖，被 dsh-attachment-local 运行时 import）
//   - @babel （@babel/code-frame，被 cordis-plugin-hmr 运行时 import）
// 另 @octokit/@google/@aws-sdk/@vscode 是否为运行时依赖未经全量启动验证，保守保留，不裁剪。
// （与 scripts/prune-dsh-runtime.mjs 的 SAFE 清单保持一致，避免重建时把运行时裁崩。）
const REMOVE = [
  '@biomejs', 'typescript', '@rolldown', '@esbuild', 'playwright-core', 'playwright',
  'jsdom', 'happy-dom', 'lightningcss-win32-x64-msvc', '@oxc-resolver', '@yarnpkg', '@vitejs',
];

function dirSize(d) {
  let total = 0;
  try { const st = fs.statSync(d); if (!st.isDirectory()) return st.size; } catch { return 0; }
  for (const e of fs.readdirSync(d, { withFileTypes: true })) total += dirSize(path.join(d, e.name));
  return total;
}
const MB = (n) => (n / 1024 / 1024).toFixed(1) + 'M';

module.exports = async (context) => {
  const { appOutDir, electronPlatformName } = context;
  if (electronPlatformName !== 'win32') {
    console.log('[pack-prune] 仅处理 win32，跳过', electronPlatformName);
    return;
  }
  const resources = path.join(appOutDir, 'resources');
  const rt = path.join(resources, 'dsh-runtime', 'node_modules');
  if (!fs.existsSync(rt)) {
    console.log('[pack-prune] 未找到', rt, '，跳过');
    return;
  }
  let freed = 0;
  for (const name of REMOVE) {
    const src = path.join(rt, name);
    if (!fs.existsSync(src)) continue;
    const sz = dirSize(src);
    try { fs.rmSync(src, { recursive: true, force: true, maxRetries: 3 }); freed += sz; console.log(`[pack-prune] 删减 ${MB(sz).padStart(8)}  ${name}`); }
    catch (e) { console.error(`[pack-prune] 删除 ${name} 失败:`, e.message); }
  }
  // node-pty 仅保留 win32-x64
  const nptyPre = path.join(rt, 'node-pty', 'prebuilds');
  if (fs.existsSync(nptyPre)) {
    for (const plat of fs.readdirSync(nptyPre)) {
      if (plat === 'win32-x64') continue;
      const p = path.join(nptyPre, plat);
      try { const s = dirSize(p); fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); freed += s; console.log(`[pack-prune] 删减 ${MB(s).padStart(8)}  node-pty/${plat}`); }
      catch (e) { console.error(`[pack-prune] 删除 node-pty/${plat} 失败:`, e.message); }
    }
  }
  // 精简 locales：保留 en-US 与 zh-CN
  const locales = path.join(resources, '..', 'locales');
  const locDir = path.join(appOutDir, 'locales');
  const loc = fs.existsSync(locDir) ? locDir : (fs.existsSync(locales) ? locales : null);
  if (loc) {
    for (const f of fs.readdirSync(loc)) {
      if (!/^(en-US|zh-CN)\.pak$/.test(f)) {
        try { const s = fs.statSync(path.join(loc, f)).size; fs.rmSync(path.join(loc, f), { force: true }); freed += s; } catch {}
      }
    }
  }
  console.log(`[pack-prune] 共释放约 ${MB(freed)}`);
};
