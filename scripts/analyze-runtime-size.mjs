// analyze-runtime-size.mjs —— 量化 dsh-runtime 体积构成，找可安全裁剪项。
// 输出：top 包体积、按类别汇总（.map / 测试目录 / 文档 / 源码 src / 二进制 .node / 缓存）、
// 以及「若是 devDependency 或明显非运行时必需」的候选清单。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.RT || 'D:/DeepSeekAgent/resources/dsh-runtime';
const OUT = 'D:/WorkSpace/deepseek-harness-master/_tmp_size_report.txt';
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

const SKIP_DIRS = new Set(['node_modules']); // 第一层只统计包，node_modules 单独处理

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  const cats = {
    map: 0, test: 0, doc: 0, src: 0, native: 0, cache: 0, ts: 0, other: 0,
  };
  const detail = { map: [], test: [], doc: [], src: [], native: [], cache: [], ts: [] };
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!st.isFile()) continue;
      const size = st.size;
      total += size;
      const lower = e.name.toLowerCase();
      const rel = path.relative(ROOT, p);
      if (lower.endsWith('.map')) { cats.map += size; if (detail.map.length < 8) detail.map.push([rel, size]); }
      else if (/(^|[\\/])(__tests__|tests?|test|spec|__mocks__|fixtures?)([\\/]|$)/i.test(rel)) { cats.test += size; }
      else if (/\.(md|markdown|txt)$/i.test(lower) || /(^|[\\/])(docs?|CHANGELOG|LICENSE|LICENCE)/i.test(rel)) { cats.doc += size; }
      else if (/(^|[\\/])(src|esm|cjs|lib-es|ts-src)([\\/]|$)/i.test(rel)) { cats.src += size; }
      else if (/\.(node|dll|pdb|lib|exp|ilk)$/i.test(lower)) { cats.native += size; if (detail.native.length < 20) detail.native.push([rel, size]); }
      else if (/(^|[\\/])(\.cache|cache|\.turbo|\.vite|coverage)([\\/]|$)/i.test(rel)) { cats.cache += size; }
      else if (/\.(ts|tsx|mts|cts)$/i.test(lower)) { cats.ts += size; }
      else cats.other += size;
    }
  }
  return { total, cats, detail };
}

say('=== dsh-runtime 体积分析 ' + new Date().toISOString() + ' ===');
say('ROOT=' + ROOT);
say('');

// 1) 顶层包体积
const nm = path.join(ROOT, 'node_modules');
const pkgDirs = [];
let ents = [];
try { ents = fs.readdirSync(nm, { withFileTypes: true }); } catch (e) { say('无法读 node_modules: ' + e.message); }
for (const e of ents) {
  if (e.name.startsWith('.')) continue;
  const p = path.join(nm, e.name);
  if (e.isDirectory() && e.name.startsWith('@')) {
    for (const s of fs.readdirSync(p, { withFileTypes: true })) {
      if (s.isDirectory()) pkgDirs.push(path.join(p, s.name));
    }
  } else if (e.isDirectory()) {
    pkgDirs.push(p);
  }
}
say('顶层包数量: ' + pkgDirs.length);
const sizes = pkgDirs.map((p) => ({ p, rel: path.relative(nm, p), size: dirSize(p).total }));
sizes.sort((a, b) => b.size - a.size);
const totalAll = sizes.reduce((a, b) => a + b.size, 0);
const MB = (n) => (n / 1024 / 1024).toFixed(1) + 'M';
say('node_modules 总计: ' + MB(totalAll));
say('');
say('=== TOP 40 包（按体积） ===');
let cum = 0;
sizes.slice(0, 40).forEach((s, i) => {
  cum += s.size;
  say(String(i + 1).padStart(3) + '. ' + MB(s.size).padStart(8) + '  cum=' + String((cum / totalAll * 100).toFixed(1)).padStart(5) + '%  ' + s.rel);
});

// 2) 类别汇总
say('');
say('=== 按类别汇总（可裁剪候选） ===');
const agg = { map: 0, test: 0, doc: 0, src: 0, native: 0, cache: 0, ts: 0, other: 0 };
const allDetail = { native: [] };
for (const s of sizes) {
  const r = dirSize(s.p);
  for (const k of Object.keys(agg)) agg[k] += r.cats[k];
  allDetail.native.push(...r.detail.native);
}
for (const k of Object.keys(agg)) {
  say(k.padEnd(8) + MB(agg[k]).padStart(10) + '   (' + (agg[k] / totalAll * 100).toFixed(1) + '%)');
}
say('');
say('=== 大体积 .node / .dll / .pdb（原生二进制，重点） ===');
allDetail.native.sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([r, s]) => say(MB(s).padStart(9) + '  ' + r));

// 3) 重复副本检测（同名包被多处安装）
say('');
say('=== 嵌套 node_modules（重复副本） ===');
const nested = [];
const walk = (d, depth) => {
  let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    if (!e.isDirectory()) continue;
    const p = path.join(d, e.name);
    if (e.name === 'node_modules' && depth > 0) {
      nested.push(path.relative(ROOT, p));
      continue; // 不递归进嵌套 nm，避免指数爆炸
    }
    walk(p, depth + 1);
  }
};
walk(nm, 0);
say('嵌套 node_modules 数量: ' + nested.length);
nested.slice(0, 30).forEach((n) => say('  ' + n));

fs.writeFileSync(OUT, lines.join('\n'));
say('');
say('报告已写入: ' + OUT);
