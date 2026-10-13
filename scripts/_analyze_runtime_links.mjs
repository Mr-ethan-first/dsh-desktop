import fs from 'node:fs';
import path from 'node:path';

const DIR = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai';
const entries = fs.readdirSync(DIR, { withFileTypes: true });
const links = [];
const realDirs = [];
for (const e of entries) {
  const p = path.join(DIR, e.name);
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) {
    let target = '';
    try { target = fs.readlinkSync(p); } catch {}
    links.push({ name: e.name, target: path.basename(target) });
  } else if (st.isDirectory()) {
    realDirs.push(e.name);
  }
}
const byTarget = new Map();
for (const l of links) {
  if (!byTarget.has(l.target)) byTarget.set(l.target, []);
  byTarget.get(l.target).push(l.name);
}
const aliases = [...byTarget.entries()].filter(([, v]) => v.length > 1);
console.log('links =', links.length, 'realDirs =', realDirs.length);
console.log('targets referenced =', byTarget.size);
console.log('targets with >1 link =', aliases.length);
for (const [t, v] of aliases) console.log('  ', t, '<=', v.join(', '));
const brokenLinks = links.filter((l) => !fs.existsSync(path.join(DIR, l.target)));
console.log('broken =', brokenLinks.length, brokenLinks.slice(0, 10).map((b) => b.name));
// 目标是否都是本地 real dir
const nonLocal = links.filter((l) => !realDirs.includes(l.target));
console.log('links whose target is not a sibling real dir =', nonLocal.length, nonLocal.slice(0, 10));
