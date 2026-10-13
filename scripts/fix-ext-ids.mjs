// fix-ext-ids.mjs — 修正扩展包 client 入口注册 id 与包名不一致的问题
// 只改 id 字面量（注册键），不动 bundle 内容。修复后 loader 才能按包名注册模块。
import fs from 'node:fs';

const DEPLOY = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai';
const REPO = 'D:/WorkSpace/deepseek-harness-master/packages/extensions';

// [pkgDir, clientRelPath, oldId, newId]
const fixes = [
  ['dsh-modlens', 'dsh/client.js', "id: '@liustack/modlens'", "id: '@deepseek-ai/dsh-modlens'"],
  ['dsh-node-flow', 'lib/client.js', 'id: "dsh-node-flow"', 'id: "@deepseek-ai/dsh-node-flow"'],
  ['dsh-market', 'client/client.js', 'id: "dshmarket"', 'id: "@deepseek-ai/dsh-market"'],
];

const log = [];
for (const [pkg, rel, oldId, newId] of fixes) {
  for (const base of [DEPLOY, REPO]) {
    const fp = `${base}/${pkg}/${rel}`;
    if (!fs.existsSync(fp)) { log.push(`SKIP ${fp} (missing)`); continue; }
    const txt = fs.readFileSync(fp, 'utf8');
    const n = txt.split(oldId).length - 1;
    if (n === 0) { log.push(`WARN ${fp}: oldId not found`); continue; }
    if (n > 1) { log.push(`WARN ${fp}: oldId found ${n}x, refusing ambiguous replace`); continue; }
    const out = txt.replace(oldId, newId);
    fs.writeFileSync(fp, out);
    log.push(`FIX  ${fp} (${oldId} -> ${newId})`);
  }
}
console.log(log.join('\n'));
fs.writeFileSync('D:/WorkSpace/deepseek-harness-master/_tmp_fix_ext_ids.log', log.join('\n'));
