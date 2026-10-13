/**
 * 扫描 extensions 下各插件的 **宿主侧代码（lib/**）** 的外部依赖，列出无法从插件目录解析的包。
 * 只统计 lib/ 是因为 client/dist 是自包含产物，src 是 TS 源（不参与运行）。
 */
import fs from 'node:fs';
import path from 'node:path';

const EXT = 'D:/DeepSeekAgent/resources/packages/extensions';
const BUILTIN = new Set(['assert', 'buffer', 'child_process', 'crypto', 'dgram', 'dns', 'events', 'fs', 'http', 'https', 'net', 'os', 'path', 'process', 'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib', 'module', 'perf_hooks', 'async_hooks', 'inspector', 'cluster', 'constants', 'domain', 'punycode', 'repl', 'sys', 'tracing', 'diagnostics_channel', 'sqlite', 'http2', 'wasi', 'test', 'console', 'node:fs', 'node:path', 'node:url', 'node:os', 'node:crypto', 'node:child_process', 'node:module', 'node:worker_threads', 'node:stream', 'node:events', 'node:util', 'node:buffer', 'node:net', 'node:tty', 'node:process', 'node:assert', 'node:timers', 'node:http', 'node:https', 'node:readline', 'node:zlib', 'node:vm', 'node:async_hooks', 'node:inspector']);
const PKG_RE = /^(?:@[a-z0-9-_.]+\/)?[a-z0-9-_.]+$/i;

function walk(dir, out = []) {
  let es;
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

function resolveFrom(fileDir, pkgName) {
  let d = fileDir;
  for (;;) {
    const cand = path.join(d, 'node_modules', pkgName);
    if (fs.existsSync(path.join(cand, 'package.json'))) return cand;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const RE = /(?:^|[^\w$.])(?:import\s*\(\s*|from\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const plugins = fs.readdirSync(EXT).filter((n) => { try { return fs.statSync(path.join(EXT, n)).isDirectory(); } catch { return false; } });
const result = {};
for (const p of plugins) {
  const libDir = path.join(EXT, p, 'lib');
  if (!fs.existsSync(libDir)) { result[p] = { skipped: 'no lib/' }; continue; }
  const files = walk(libDir);
  const used = new Set();
  const missing = new Set();
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (src.length > 5_000_000) continue;
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src))) {
      const spec = m[1];
      if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
      if (!PKG_RE.test(spec)) continue;
      const parts = spec.split('/');
      const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      if (BUILTIN.has(pkg)) continue;
      used.add(pkg);
      if (!resolveFrom(path.dirname(f), pkg)) missing.add(pkg);
    }
  }
  result[p] = { libFiles: files.length, used: [...used].sort(), missing: [...missing].sort() };
}
console.log(JSON.stringify(result, null, 2));
