/**
 * 枚举已部署 dsh-runtime 中所有 symlink/junction，按目标根分类，用于判断可交付性。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/DeepSeekAgent/resources/dsh-runtime';
const runtimeRoot = 'D:\\DeepSeekAgent\\resources\\dsh-runtime';

const buckets = new Map();
const list = [];
let dirs = 0;

function walk(d, depth) {
  if (depth > 8) return;
  let es;
  try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  dirs++;
  for (const e of es) {
    const p = path.join(d, e.name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) {
      let t = '';
      try { t = fs.readlinkSync(p); } catch {}
      const norm = t.replace(/^\\\\\?\\/, '').replace(/^\\\?\?\\/, '');
      let key;
      if (norm.toLowerCase().startsWith(runtimeRoot.toLowerCase())) key = 'inside-runtime';
      else if (/^[A-Za-z]:\\WorkSpace\\deepseek-harness-master/i.test(norm)) key = 'repo-dev-link';
      else if (/^[A-Za-z]:\\/.test(norm)) key = 'other-abs';
      else key = 'relative';
      buckets.set(key, (buckets.get(key) || 0) + 1);
      list.push({ rel: path.relative(ROOT, p), key, target: norm });
      continue;
    }
    if (st.isDirectory()) walk(p, depth + 1);
  }
}
walk(ROOT, 0);

console.log('扫描目录数 =', dirs, '链接数 =', list.length);
for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) console.log('  ', k, v);

for (const key of ['repo-dev-link', 'other-abs', 'relative']) {
  const items = list.filter((x) => x.key === key);
  if (!items.length) continue;
  console.log('\n== ' + key + ' (' + items.length + ') ==');
  for (const it of items.slice(0, 40)) console.log('  ', it.rel, '->', it.target);
}
