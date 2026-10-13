// fix-runtime-versions.mjs —— 自动修复 hoisting 闭包的「依赖版本错配」。
//
// 背景：hoisting copier 把同一包的多个版本扁平化到顶层时只保留一个，导致消费者
// 拿到不满足 semver range 的版本。已确认的致命案例：
//   - content-type: 顶层 1.0.5，但 negotiator@1.1.0 需要 ^2.1.0
//     → Accept-Encoding 解析抛 invalid media type → dsh web 400 → 浏览器白屏
//   - negotiator: 顶层 1.1.0，但 compression@1.8.1 需要 ~0.6.4
//   - diff: 顶层 8.0.4，但 dsh-tool-fs 需要 ^9.0.0（影响文件编辑 diff）
//
// 策略：不改顶层（会破坏其他消费者），而是给每个「拿错版本」的消费者在其私有
// node_modules 里嵌套一份满足 range 的正确版本。Node 的解析规则保证私有副本优先，
// 因此零副作用、可增量执行、可重复运行（幂等）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const RT = process.env.RT || 'D:/DeepSeekAgent/resources/dsh-runtime';
const NM = path.join(RT, 'node_modules');
const REPO_PNPM = (process.env.PNPM_STORE || 'D:/WorkSpace/deepseek-harness-master/node_modules/.pnpm');
const LOG = 'D:/WorkSpace/deepseek-harness-master/_tmp_fix_versions.log';
const DRY = process.env.DRY_RUN === '1';

// 用仓库里的 semver 做版本筛选（避免依赖托管环境）
let semver;
for (const v of ['semver@7.8.5', 'semver@7.8.2', 'semver@7.7.2', 'semver@7.6.3']) {
  const p = path.join(REPO_PNPM, v, 'node_modules', 'semver');
  if (fs.existsSync(p)) { try { semver = require(p); break; } catch {} }
}
if (!semver) {
  for (const d of fs.readdirSync(REPO_PNPM)) {
    if (!d.startsWith('semver@')) continue;
    const p = path.join(REPO_PNPM, d, 'node_modules', 'semver');
    if (fs.existsSync(p)) { try { semver = require(p); break; } catch {} }
  }
}
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
say('=== 闭包版本错配修复 ' + new Date().toISOString() + ' ===');
say('DRY_RUN=' + DRY);
if (!semver) { say('FATAL: 找不到 semver'); process.exit(3); }

function readPkg(p) {
  try { return JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')); } catch { return null; }
}

/** 枚举闭包内所有包目录（顶层 + @scope 下），返回 [{dir, name, version}] */
function listPkgs() {
  const out = [];
  for (const e of fs.readdirSync(NM, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = path.join(NM, e.name);
    if (e.name.startsWith('@')) {
      for (const s of fs.readdirSync(p, { withFileTypes: true })) {
        if (!s.isDirectory()) continue;
        const j = readPkg(path.join(p, s.name));
        if (j) out.push({ dir: path.join(p, s.name), name: j.name, version: j.version });
      }
    } else {
      const j = readPkg(p);
      if (j) out.push({ dir: p, name: j.name, version: j.version });
    }
  }
  return out;
}

const pkgs = listPkgs();
const topVersion = new Map(pkgs.map((p) => [p.name, p.version]));
say(`闭包包数=${pkgs.length}`);

/** .pnpm 里某依赖的所有可用版本 → 目录名映射（处理 @scope+name@version 编码） */
function pnpmDirName(dep, version) {
  return dep.startsWith('@') ? dep.replace('/', '+') + '@' + version : dep + '@' + version;
}
const availableCache = new Map();
function availableVersions(dep) {
  if (availableCache.has(dep)) return availableCache.get(dep);
  const list = [];
  for (const d of fs.readdirSync(REPO_PNPM)) {
    let name, ver;
    const at = d.lastIndexOf('@');
    if (at <= 0) continue;
    name = d.slice(0, at); ver = d.slice(at + 1);
    if (name.startsWith('@')) name = name.replace('+', '/');
    if (name !== dep) continue;
    const pkgDir = path.join(REPO_PNPM, d, 'node_modules', dep);
    if (fs.existsSync(pkgDir)) list.push({ version: ver, dir: pkgDir });
  }
  availableCache.set(dep, list);
  return list;
}

/** 选一个满足 range 的最高版本 */
function pickVersion(dep, range) {
  const cands = availableVersions(dep)
    .filter((c) => { try { return semver.satisfies(c.version, range, { includePrerelease: true }); } catch { return false; } });
  if (!cands.length) return null;
  cands.sort((a, b) => { try { return semver.rcompare(a.version, b.version); } catch { return 0; } });
  return cands[0];
}

const fixed = [];
const skipped = [];
const failed = [];

for (const pkg of pkgs) {
  const j = readPkg(pkg.dir);
  if (!j) continue;
  for (const [dep, range] of Object.entries(j.dependencies || {})) {
    if (typeof range !== 'string') continue;
    if (range.startsWith('workspace:') || range.startsWith('file:') || range.startsWith('link:') || range.startsWith('npm:')) continue;
    const nestedPath = path.join(pkg.dir, 'node_modules', dep);
    // 已有私有副本且满足 → 无需处理
    if (fs.existsSync(nestedPath)) {
      const nj = readPkg(nestedPath);
      if (nj && semver.satisfies(nj.version, range, { includePrerelease: true })) continue;
    }
    const actual = topVersion.get(dep);
    if (!actual) continue;
    let ok = false;
    try { ok = semver.satisfies(actual, range, { includePrerelease: true }); } catch { ok = true; }
    if (ok) continue;

    // 需要嵌套正确版本
    const pick = pickVersion(dep, range);
    if (!pick) { failed.push(`${j.name} 需要 ${dep}@${range}，但 pnpm store 中无可用版本（顶层=${actual}）`); continue; }
    if (DRY) { skipped.push(`[DRY] ${j.name}: ${dep} ${actual} → ${pick.version}`); continue; }
    try {
      if (fs.existsSync(nestedPath)) fs.rmSync(nestedPath, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(nestedPath), { recursive: true });
      fs.cpSync(pick.dir, nestedPath, { recursive: true, dereference: true });
      fixed.push(`${j.name}: ${dep} ${actual} → ${pick.version} (要求 ${range})`);
    } catch (e) {
      failed.push(`${j.name}: ${dep} → ${pick.version} 失败: ${e.message}`);
    }
  }
}

say('');
say(`=== 修复完成: ${fixed.length} 项 ===`);
fixed.forEach((f) => say('  FIXED  ' + f));
if (skipped.length) { say(''); say(`=== DRY-RUN 计划: ${skipped.length} 项 ===`); skipped.forEach((s) => say('  ' + s)); }
if (failed.length) { say(''); say(`=== 无法修复: ${failed.length} 项 ===`); failed.forEach((f) => say('  FAILED ' + f)); }
fs.writeFileSync(LOG, lines.join('\n'));
say('');
say('日志: ' + LOG);
