// scan-all-ids.mjs — 全量检查所有带 ./client 入口的包的注册 id 是否与包名一致
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai';
const out = [];
const dirs = fs.readdirSync(BASE, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

let mismatch = 0, checked = 0;
for (const name of dirs) {
  const dir = path.join(BASE, name);
  const pjPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pjPath)) continue;
  let pj;
  try { pj = JSON.parse(fs.readFileSync(pjPath, 'utf8')); } catch { continue; }
  const cliExp = (pj.exports && pj.exports['./client']);
  if (!cliExp) continue;
  let cliFile = typeof cliExp === 'string' ? cliExp.replace(/^\.\//, '') : (cliExp.default ? cliExp.default.replace(/^\.\//, '') : null);
  if (!cliFile) continue;
  const fp = path.join(dir, cliFile);
  if (!fs.existsSync(fp)) { out.push(`SKIP ${pj.name}: client file missing ${fp}`); continue; }
  const txt = fs.readFileSync(fp, 'utf8');
  const m = txt.match(/id:\s*['"]([^'"]+)['"]/);
  const regId = m ? m[1] : '(none)';
  checked++;
  const ok = m ? (regId === pj.name) : false;
  if (!ok) { mismatch++; out.push(`MISMATCH ${pj.name} -> registered='${regId}'`); }
}
out.unshift(`checked=${checked} mismatch=${mismatch}`);
console.log(out.join('\n'));
fs.writeFileSync('D:/WorkSpace/deepseek-harness-master/_tmp_all_ids.log', out.join('\n'));
