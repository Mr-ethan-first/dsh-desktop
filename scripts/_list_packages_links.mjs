import fs from 'node:fs';
import path from 'node:path';
const ROOT = 'D:/DeepSeekAgent/resources/packages';
const out = [];
function walk(d, depth) {
  if (depth > 6) return;
  let es;
  try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = path.join(d, e.name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) { out.push({ rel: path.relative(ROOT, p), target: fs.readlinkSync(p) }); continue; }
    if (st.isDirectory()) walk(p, depth + 1);
  }
}
walk(ROOT, 0);
console.log('packages 内链接数 =', out.length);
for (const o of out) console.log('  ', o.rel, '->', o.target);
