// sync-runtime-lib.mjs
// 把仓库重新构建出的 packages/*/*/lib 同步到已部署运行时
//   D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/<pkg>/lib
// 只覆盖 lib/ 目录（浏览器端 client.js 与 node 端 lib/index.js 等），
// 不动 node_modules 顶层 / 嵌套依赖（negotiator/content-type 嵌套、版本固定等修复保留）。
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/WorkSpace/deepseek-harness-master';
const DEPLOY_BASE = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// 找到所有 packages/<area>/<pkg> 下带 package.json 的目录
function findPackages() {
  const res = [];
  const areas = fs.readdirSync(path.join(REPO, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  for (const area of areas) {
    const areaDir = path.join(REPO, 'packages', area);
    for (const e of fs.readdirSync(areaDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const pkgDir = path.join(areaDir, e.name);
      const pj = path.join(pkgDir, 'package.json');
      if (!fs.existsSync(pj)) continue;
      let name;
      try { name = JSON.parse(fs.readFileSync(pj, 'utf8')).name; } catch { continue; }
      if (typeof name === 'string' && name.startsWith('@deepseek-ai/')) {
        res.push({ name, pkgDir });
      }
    }
  }
  return res;
}

const LOGP = 'D:/WorkSpace/deepseek-harness-master/_tmp_sync_lib.log';
let copied = 0, skipped = 0, errors = 0;
const log = [];
const flush = () => fs.writeFileSync(LOGP, `copied=${copied} skipped=${skipped} errors=${errors}\n` + log.join('\n'));

try {
  const pkgs = findPackages();
  log.push(`found ${pkgs.length} @deepseek-ai packages in repo`);
  flush();
  for (const { name, pkgDir } of pkgs) {
    const short = name.slice('@deepseek-ai/'.length);
    const srcLib = path.join(pkgDir, 'lib');
    const dstLib = path.join(DEPLOY_BASE, short, 'lib');
    if (!fs.existsSync(srcLib)) { skipped++; continue; }
    if (!fs.existsSync(dstLib)) {
      skipped++;
      log.push(`SKIP(no-deploy-dir) ${name}`);
      flush();
      continue;
    }
    const files = walk(srcLib);
    for (const f of files) {
      const rel = path.relative(srcLib, f);
      const dst = path.join(dstLib, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(f, dst);
      copied++;
    }
    log.push(`SYNC ${name} (${files.length} files)`);
    flush();
  }
} catch (e) {
  errors++;
  log.push('FATAL ' + (e && e.stack || e));
  flush();
}
const summary = `copied=${copied} skipped=${skipped} errors=${errors}\n` + log.join('\n');
console.log(summary.slice(0, 2000));
