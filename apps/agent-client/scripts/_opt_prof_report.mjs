// 解析 .cpuprofile，按自耗时（self time）聚合，输出启动热点。
import fs from 'node:fs';

const file = process.argv[2] || 'C:/temp/dsh-prof/boot.cpuprofile';
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
let total = 0;
const dt = p.timeDeltas || [];
const samples = p.samples || [];
for (let i = 0; i < samples.length; i++) {
  const d = dt[i] || 0;
  total += d;
  self.set(samples[i], (self.get(samples[i]) || 0) + d);
}
const rows = [];
for (const [id, us] of self) {
  const n = byId.get(id);
  if (!n) continue;
  const cf = n.callFrame || {};
  rows.push({
    us,
    fn: cf.functionName || '(anonymous)',
    url: (cf.url || '').replace(/^file:\/\/\//, '').replace(/^.*node_modules[\\/]/, 'nm/'),
    line: cf.lineNumber,
  });
}
rows.sort((a, b) => b.us - a.us);

const ms = (us) => (us / 1000).toFixed(0);
console.log(`profile span: ${(total / 1000).toFixed(0)} ms, samples=${samples.length}`);
console.log('--- top 30 by SELF time ---');
for (const r of rows.slice(0, 30)) console.log(`${ms(r.us).padStart(6)}ms  ${r.fn.slice(0, 42).padEnd(42)} ${r.url.slice(0, 78)}`);

// 按脚本聚合
const byScript = new Map();
for (const r of rows) {
  const key = r.url || '(native)';
  byScript.set(key, (byScript.get(key) || 0) + r.us);
}
const srows = [...byScript].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log('--- top 25 by SCRIPT ---');
for (const [k, v] of srows) console.log(`${ms(v).padStart(6)}ms  ${k.slice(0, 100)}`);

// 按目录聚合
const byDir = new Map();
for (const r of rows) {
  if (!r.url || r.url.startsWith('node:') || r.url.startsWith('internal')) continue;
  const parts = r.url.split(/[\\/]/);
  const i = parts.indexOf('@deepseek-ai');
  let key;
  if (i >= 0) key = '@deepseek-ai/' + (parts[i + 1] || '');
  else key = parts.slice(0, 3).join('/');
  byDir.set(key, (byDir.get(key) || 0) + r.us);
}
console.log('--- top 25 by PACKAGE DIR ---');
for (const [k, v] of [...byDir].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${ms(v).padStart(6)}ms  ${k.slice(0, 100)}`);

// 函数名聚合（跨包）
const byFn = new Map();
for (const r of rows) {
  if (!r.fn || r.fn === '(anonymous)' || r.fn === '(root)' || r.fn === '(program)') continue;
  byFn.set(r.fn, (byFn.get(r.fn) || 0) + r.us);
}
console.log('--- top 20 by FUNCTION NAME ---');
for (const [k, v] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`${ms(v).padStart(6)}ms  ${k.slice(0, 100)}`);
