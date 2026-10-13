// scan-ext-ids.mjs — 检查各扩展包的 client 入口注册 id 是否与包名一致
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai';
const exts = ['dsh-modlens', 'dsh-node-flow', 'dsh-market', 'dsh-tool-cordis', 'dsh-client-ui-cordis', 'dsh-cordis-host-runner', 'dsh-cordis-client-runner'];

const out = [];
for (const name of exts) {
  const dir = path.join(BASE, name);
  if (!fs.existsSync(dir)) { out.push(`${name} MISSING`); continue; }
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const cliExp = (pj.exports && pj.exports['./client']) || (pj.dsh && pj.dsh.client && pj.dsh.client.entry);
  let cliFile = null;
  if (typeof cliExp === 'string') cliFile = cliExp.replace(/^\.\//, '');
  else if (cliExp && cliExp.default) cliFile = cliExp.default.replace(/^\.\//, '');
  let line = `== ${name} (pkg=${pj.name}) client=${cliFile}`;
  if (!cliFile) { out.push(line + ' | no ./client export'); continue; }
  const fp = path.join(dir, cliFile);
  if (!fs.existsSync(fp)) { out.push(line + ` | client file MISSING: ${fp}`); continue; }
  const txt = fs.readFileSync(fp, 'utf8');
  const m = txt.match(/id:\s*['"]([^'"]+)['"]/);
  const regId = m ? m[1] : '(none)';
  const ok = m ? (regId === pj.name) : false;
  out.push(line + ` | registered id=${regId} | match=${ok}`);
}
console.log(out.join('\n'));
fs.writeFileSync('D:/WorkSpace/deepseek-harness-master/_tmp_ext_ids.log', out.join('\n'));
