// 安装包瘦身 / 启动提速：部署树体积与文件数清点（只读，不修改任何文件）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || 'D:\\DeepSeekAgent';

function walk(dir, stats, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) {
      stats.links++;
      let tgt = '';
      try { tgt = fs.readlinkSync(p); } catch {}
      stats.linkList.push({ p: path.relative(ROOT, p), tgt });
      continue;
    }
    if (st.isDirectory()) {
      if (depth < 40) walk(p, stats, depth + 1);
      continue;
    }
    stats.files++;
    stats.bytes += st.size;
    const ext = path.extname(e.name).toLowerCase();
    stats.byExt[ext] = stats.byExt[ext] || { n: 0, b: 0 };
    stats.byExt[ext].n++;
    stats.byExt[ext].b += st.size;
  }
}

const targets = process.argv.slice(3);
const stats = { files: 0, bytes: 0, links: 0, linkList: [], byExt: {} };
for (const t of targets.length ? targets : ['.']) {
  walk(path.join(ROOT, t), stats);
}
const mb = (b) => (b / 1048576).toFixed(1);
console.log(`files=${stats.files} bytes=${stats.bytes} (${mb(stats.bytes)} MB) links=${stats.links}`);
const exts = Object.entries(stats.byExt).sort((a, b) => b[1].b - a[1].b).slice(0, 40);
console.log('--- by ext (top40) ---');
for (const [e, v] of exts) console.log(`${(e || '(none)').padEnd(12)} n=${String(v.n).padStart(7)} ${mb(v.b).padStart(9)} MB`);
if (stats.linkList.length) {
  console.log('--- link samples ---');
  for (const l of stats.linkList.slice(0, 10)) console.log(l.p, '->', l.tgt);
}
