import fs from 'node:fs';
import path from 'node:path';

const DIR = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai';
const entries = fs.readdirSync(DIR, { withFileTypes: true });
const byPkgName = new Map();
const dirs = [];
for (const e of entries) {
  const p = path.join(DIR, e.name);
  let st;
  try { st = fs.lstatSync(p); } catch { continue; }
  if (st.isSymbolicLink()) continue;
  if (!st.isDirectory()) continue;
  dirs.push(e.name);
  const pj = path.join(p, 'package.json');
  if (!fs.existsSync(pj)) { byPkgName.set(`<no-pkg> ${e.name}`, e.name); continue; }
  try {
    const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
    const key = j.name || `<unnamed> ${e.name}`;
    if (!byPkgName.has(key)) byPkgName.set(key, e.name);
    else byPkgName.set(key + ' #dup', e.name);
  } catch { byPkgName.set(`<bad-pkg> ${e.name}`, e.name); }
}
console.log('real dirs =', dirs.length, 'unique pkg names =', byPkgName.size);

// 未被任何 canonical 链接命中的包
const links = [];
for (const e of entries) {
  const p = path.join(DIR, e.name);
  let st;
  try { st = fs.lstatSync(p); } catch { continue; }
  if (st.isSymbolicLink()) links.push(e.name);
}
console.log('links =', links.length);

const linkTargets = new Set(links);
const unlinked = [];
for (const [pkgName, dirName] of byPkgName.entries()) {
  if (/^</.test(pkgName)) { unlinked.push([pkgName, dirName]); continue; }
  const short = pkgName.startsWith('@deepseek-ai/') ? pkgName.slice('@deepseek-ai/'.length) : pkgName;
  if (!linkTargets.has(short)) unlinked.push([pkgName, dirName]);
}
console.log('\n== 包名未生成顶层 canonical 链接的目录 (' + unlinked.length + ') ==');
for (const [n, d] of unlinked) console.log('  ', n, '->', d);

// broken links 详情
console.log('\n== broken links ==');
for (const l of links) {
  const t = path.basename(fs.readlinkSync(path.join(DIR, l)));
  if (!fs.existsSync(path.join(DIR, t))) {
    // 尝试用包名反查
    const guess = byPkgName.get('@deepseek-ai/' + l);
    console.log('  ', l, '-> (missing)', t, '   guess:', guess || '(none)');
  }
}
