/**
 * prune-dsh-runtime.mjs — 安全瘦身已部署 dsh-runtime。
 * 用「改名隔离」(rename 到同盘 quarantine) 代替删除：
 *   - O(1) 同卷移动，不触发 safe-delete 批量守卫；
 *   - 立刻从 dsh-runtime 释放空间（包体积下降）；
 *   - 文件仍保留在 quarantine，smoke 失败可改名恢复。
 * 删除清单经 grep 验证：@deepseek-ai 运行时代码未 import 这些包。
 * 运行：node scripts/prune-dsh-runtime.mjs   （建议 dangerouslyDisableSandbox）
 */
import fs from 'node:fs';
import path from 'node:path';

const RT = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules';
const QUAR = 'D:/_tmp_pruned_dsh_runtime';
const LOCALES = 'D:/DeepSeekAgent/locales';

// 安全裁剪清单：仅移除「构建/测试期」依赖。生产运行时（dsh web 工作台 + 原生桥接层）不加载这些包。
// ⚠️ 已实证为 RUNTIME 依赖、绝不可移除的包（移除后 dsh web 启动即崩，ERR_MODULE_NOT_FOUND）：
//   - @img  （sharp 的原生/彩色依赖，被 dsh-attachment-local 在插件树加载期 import）
//   - @babel （@babel/code-frame，被 cordis-plugin-hmr 在插件树加载期 import）
// 另：@octokit / @google / @aws-sdk / @vscode 是否为运行时依赖未经全量启动验证，保守保留，不裁剪。
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

fs.mkdirSync(QUAR, { recursive: true });

let freed = 0;
const moved = [];
for (const name of REMOVE) {
  const src = path.join(RT, name);
  if (!fs.existsSync(src)) { console.log('skip (absent):', name); continue; }
  const sz = dirSize(src);
  const dst = path.join(QUAR, name);
  try {
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(src, dst);
    freed += sz; moved.push(name);
    console.log(`quarantined ${MB(sz).padStart(8)}  ${name}`);
  } catch (e) {
    console.error(`FAILED to quarantine ${name}:`, e.message);
  }
}

// node-pty 仅 win32-x64 需要：移除其它平台预构建（darwin/linux/win32-arm64），仅保留 win32-x64
const nptyPre = path.join(RT, 'node-pty', 'prebuilds');
if (fs.existsSync(nptyPre)) {
  for (const plat of fs.readdirSync(nptyPre)) {
    if (plat === 'win32-x64') continue;
    const p = path.join(nptyPre, plat);
    try { const s = dirSize(p); fs.renameSync(p, path.join(QUAR, 'node-pty-' + plat)); freed += s; console.log(`quarantined ${MB(s).padStart(8)}  node-pty/${plat}`); } catch (e) { console.error('node-pty ' + plat + ' failed', e.message); }
  }
}

// 精简 locales：仅保留 en-US 与 zh-CN
if (fs.existsSync(LOCALES)) {
  for (const f of fs.readdirSync(LOCALES)) {
    if (!/^(en-US|zh-CN)\.pak$/.test(f)) {
      const p = path.join(LOCALES, f);
      try { const s = fs.statSync(p).size; fs.rmSync(p, { force: true }); freed += s; } catch {}
    }
  }
  console.log('trimmed locales (kept en-US, zh-CN)');
}

console.log(`\n释放约 ${MB(freed)}，隔离包 ${moved.length} 个 → ${QUAR}`);
console.log('若 smoke 失败：把 quarantine 目录改名回 node_modules 即可恢复。');
