// verify-dep-versions.mjs —— 检查 hoisting 后的运行时闭包是否存在「依赖版本错配」。
//
// 背景（白屏真因）：hoisting copier 把同一包的多个版本扁平化到顶层时，只保留了一个
// 版本。negotiator@1.1.0 依赖 content-type@^2.1.0，但顶层被填入 content-type@1.0.5，
// 于是 Accept-Encoding 解析抛 `invalid media type`，dsh web 返回 400 → 浏览器白屏。
// 这类错配静默且致命，必须全量体检而不是靠运气发现。
//
// 判定：对包 P 的 dependencies 中每一项 (dep, range)，若顶层 node_modules/dep 的
// 实际版本不满足 range，且 P 自己没有嵌套 node_modules/dep，则记为 MISMATCH。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.RT || 'D:/DeepSeekAgent/resources/dsh-runtime';
const NM = path.join(ROOT, 'node_modules');
const OUT = 'D:/WorkSpace/deepseek-harness-master/_tmp_dep_versions.txt';
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

// 优先用闭包自带的 semver，避免额外依赖
let semver = null;
for (const c of [path.join(NM, 'semver'), path.join(NM, 'semver', 'index.js')]) {
  try { semver = (await import('file:///' + c.replace(/\\/g, '/') + (c.endsWith('.js') ? '' : '/index.js'))); break; } catch {}
}
if (!semver || typeof semver.satisfies !== 'function') {
  say('WARN: 闭包内无可用 semver，改用内置简化比较（仅支持 ^ ~ >= < = 与精确版本）');
}

/** 简化 semver 比较：判断 version 是否满足 range */
function satisfiesSimple(version, range) {
  if (!version) return false;
  range = range.trim();
  if (range === '' || range === '*' || range === 'latest' || range === 'x') return true;
  if (range.startsWith('workspace:') || range.startsWith('file:') || range.startsWith('link:')) return true;
  if (range.startsWith('npm:')) return true;
  // 取第一个空格分隔的 comparator（忽略 || 的后续分支过于宽松，仅做尽力判断）
  const first = range.split('||')[0].trim();
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)\.(\d+)\.(\d+)(.*)$/.exec(first);
  if (!m) return true; // 无法解析的范围（如 git url、tag）保守放行
  const op = m[1] || '=';
  const [Maj, Min, Pat] = [Number(m[2]), Number(m[3]), Number(m[4])];
  const vm = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!vm) return true;
  const [a, b, c] = [Number(vm[1]), Number(vm[2]), Number(vm[3])];
  const cmp = (a - Maj) || (b - Min) || (c - Pat);
  switch (op) {
    case '^': return cmp >= 0 && a === Maj;
    case '~': return cmp >= 0 && a === Maj && b === Min;
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    default: return cmp === 0;
  }
}
const satisfies = (v, r) => (semver && typeof semver.satisfies === 'function')
  ? (() => { try { return semver.satisfies(v, r, { includePrerelease: true }); } catch { return true; } })()
  : satisfiesSimple(v, r);

function readPkg(p) {
  try { return JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')); } catch { return null; }
}

// 1) 枚举所有包（顶层 + scope 下）
const pkgs = [];
for (const e of fs.readdirSync(NM, { withFileTypes: true })) {
  if (!e.isDirectory() || e.name.startsWith('.')) continue;
  const p = path.join(NM, e.name);
  if (e.name.startsWith('@')) {
    for (const s of fs.readdirSync(p, { withFileTypes: true })) {
      if (s.isDirectory()) pkgs.push(path.join(p, s.name));
    }
  } else pkgs.push(p);
}

// 2) 顶层版本表
const topVersion = new Map();
for (const e of fs.readdirSync(NM, { withFileTypes: true })) {
  if (!e.isDirectory() || e.name.startsWith('.')) continue;
  const p = path.join(NM, e.name);
  if (e.name.startsWith('@')) {
    for (const s of fs.readdirSync(p, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const j = readPkg(path.join(p, s.name));
      if (j) topVersion.set(j.name, j.version);
    }
  } else {
    const j = readPkg(p);
    if (j) topVersion.set(j.name, j.version);
  }
}

say('=== 依赖版本错配体检 ' + new Date().toISOString() + ' ===');
say('ROOT=' + ROOT);
say('包数量=' + pkgs.length + '  顶层已记录版本=' + topVersion.size);
say('');

const mismatches = [];
let checked = 0;
for (const pkgPath of pkgs) {
  const j = readPkg(pkgPath);
  if (!j) continue;
  const deps = j.dependencies || {};
  for (const [dep, range] of Object.entries(deps)) {
    // 该包自己有嵌套副本 → 以嵌套为准，跳过
    const nested = path.join(pkgPath, 'node_modules', dep);
    if (fs.existsSync(nested)) continue;
    const actual = topVersion.get(dep);
    if (!actual) continue;      // 依赖缺失由别的检查负责
    // workspace: 协议是 pnpm monorepo 内部引用，版本恒等于工作区版本；
    // semver 不认识该协议会全部误判为不满足，必须跳过，否则噪声淹没真实问题。
    if (typeof range === 'string' && range.startsWith('workspace:')) continue;
    checked++;
    if (!satisfies(actual, range)) {
      mismatches.push({
        consumer: j.name + '@' + j.version,
        dep, range, actual,
      });
    }
  }
}

say('已校验依赖边数: ' + checked);
say('错配数量: ' + mismatches.length);
say('');
if (mismatches.length === 0) {
  say('=== VERDICT: PASS（未发现版本错配） ===');
} else {
  say('=== VERDICT: MISMATCH_FOUND ===');
  say('consumer'.padEnd(60) + '| dependency'.padEnd(30) + '| range'.padEnd(22) + '| 实际顶层版本');
  say('-'.repeat(140));
  // 按「被错配的依赖」聚合，便于看出哪些包存在多版本冲突
  const byDep = new Map();
  for (const m of mismatches) {
    if (!byDep.has(m.dep)) byDep.set(m.dep, []);
    byDep.get(m.dep).push(m);
  }
  for (const [dep, list] of [...byDep.entries()].sort((a, b) => b[1].length - a[1].length)) {
    say(`[${dep}]  受影响包数=${list.length}`);
    for (const m of list.slice(0, 12)) {
      say('  ' + m.consumer.padEnd(58) + '| ' + m.dep.padEnd(28) + '| ' + m.range.padEnd(20) + '| ' + m.actual);
    }
    if (list.length > 12) say(`  ... 另有 ${list.length - 12} 个`);
  }
  say('');
  say('=== 多版本冲突 TOP（同一包在仓库中存在多个版本） ===');
  const versionMap = new Map();
  for (const [name, ver] of topVersion) {
    if (!versionMap.has(name)) versionMap.set(name, new Set());
    versionMap.get(name).add(ver);
  }
  const conflictDeps = [...byDep.keys()];
  for (const dep of conflictDeps) {
    say(`  ${dep}: 顶层=${topVersion.get(dep)}  (需求范围: ${[...new Set(byDep.get(dep).map((m) => m.range))].join(' | ')})`);
  }
}

fs.writeFileSync(OUT, lines.join('\n'));
say('');
say('报告: ' + OUT);
