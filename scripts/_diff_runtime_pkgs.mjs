/**
 * 对比 desktop/runtime-dist 与已部署 dsh-runtime 的包集合，找出部署态缺失/损坏的包。
 * 输出：missing（runtime-dist 有、部署态无法解析）、extra、以及部署态内部对 .dsh-<hash> 的引用。
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'D:/WorkSpace/deepseek-harness-master/desktop/runtime-dist/node_modules';
const DST = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules';

function readPkgName(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return j.name || null;
  } catch { return null; }
}

function listScoped(root) {
  const out = new Map(); // pkgName -> dir
  for (const scope of ['@deepseek-ai']) {
    const scopeDir = path.join(root, scope);
    if (!fs.existsSync(scopeDir)) continue;
    for (const e of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      const p = path.join(scopeDir, e.name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (!st.isDirectory() && !st.isSymbolicLink()) continue;
      if (!fs.existsSync(path.join(p, 'package.json'))) continue;
      const n = readPkgName(p);
      if (n && !out.has(n)) out.set(n, p);
    }
  }
  return out;
}

const src = listScoped(SRC);
const dst = listScoped(DST);
console.log('runtime-dist @deepseek-ai 包数 =', src.size);
console.log('deployed   @deepseek-ai 包数 =', dst.size);

const missing = [...src.keys()].filter((k) => !dst.has(k)).sort();
console.log('\n== 部署态缺失 (' + missing.length + ') ==');
for (const m of missing) console.log('  ', m);

const extra = [...dst.keys()].filter((k) => !src.has(k)).sort();
console.log('\n== 部署态多出 (' + extra.length + ') ==');
for (const m of extra.slice(0, 30)) console.log('  ', m);

// 部署态内部是否还有对 .dsh-<hash> 名字的引用（重命名前必须确认）
let refs = 0;
const sample = [];
const walk = (d, depth) => {
  if (depth > 4) return;
  let es;
  try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = path.join(d, e.name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isDirectory()) { if (e.name !== 'node_modules') walk(p, depth + 1); continue; }
    if (!/\.(js|mjs|cjs|json)$/.test(e.name)) continue;
    if (st.size > 2_000_000) continue;
    let s;
    try { s = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (/["'./\\]\.dsh-[a-z0-9-]+-[A-Za-z0-9]{8}/.test(s)) { refs++; if (sample.length < 5) sample.push(p); }
  }
};
walk(DST, 0);
console.log('\n== 部署态文件中引用 .dsh-<hash> 名字的数量 =', refs, sample);
