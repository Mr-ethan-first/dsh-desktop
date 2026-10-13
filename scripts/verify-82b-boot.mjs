// verify-82b-boot.mjs —— #82 真启动验证：用部署态 EXTENSIONS_DIR 准备 web profile 并实际拉起 dsh web。
// 复用 exe 内部同一 prepareDshHome + spawnDshWeb（runtime=自带 node24），只改端口。
// 目的：确认（a）社区插件进 bundles；（b）10 个 bundle 下 dsh web 仍能正常启动（不因多余 bundle 崩溃）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const RES = 'D:/DeepSeekAgent/resources';
const NODE24 = path.join(RES, 'node24', 'node.exe');
const DSH_BIN = path.join(RES, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const LAUNCHER = path.join(RES, 'app.asar.unpacked', 'electron', 'plugin-host', 'dsh-web-launcher.cjs');
const EXT = path.join(RES, 'packages', 'extensions');
// 每次跑用唯一 HOME：避免 ensureJunction 替换既有目录时触发沙箱
// safe-delete 批量删除守卫（count>50 → SAFE_DELETE_BULK_CONFIRM_REQUIRED）。
// 该守卫是沙箱产物，真实 exe 环境不存在；换唯一目录即可绕开干扰。
const HOME = path.join(os.tmpdir(), 'dsh-home-82-' + Date.now());
const PORT = 5392;
const TOKEN_RE = /(https?:\/\/[^\s"'<>]+?\?token=[A-Za-z0-9_.-]+)/;
const LOG = 'D:/WorkSpace/deepseek-harness-master/_tmp_verify82b.log';

const say = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const launcher = require(LAUNCHER);

function getUrl(url, t = 8000) {
  return new Promise((r) => {
    const req = http.get(url, (res) => { res.resume(); r({ ok: res.statusCode < 400, code: res.statusCode }); });
    req.on('error', (e) => r({ ok: false, err: e.message }));
    req.setTimeout(t, () => { req.destroy(); r({ ok: false, err: 'timeout' }); });
  });
}
function killTree(pid) { if (pid) try { spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch {} }

fs.writeFileSync(LOG, '');
say('=== verify-82b boot start ' + new Date().toISOString() + ' ===');

// 1) 准备 profile（exe 同款）
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
launcher.prepareDshHome({ extensionsDir: EXT, dshHome: HOME, profileName: 'web' });
const bundles = JSON.parse(fs.readFileSync(path.join(HOME, 'profiles', 'web', 'package.json'), 'utf8')).dsh.profile.bundles;
say(`web profile bundles (${bundles.length}): ${bundles.join(', ')}`);
const WANT = ['@deepseek-ai/dsh-market', '@deepseek-ai/dsh-modlens', '@deepseek-ai/dsh-node-flow'];
const missing = WANT.filter(n => !bundles.includes(n));
say(`社区插件挂载: ${missing.length === 0 ? 'ALL 3 OK' : 'MISSING ' + missing.join(',')}`);

// 2) 真实启动 dsh web
say('--- spawn dsh web (node24) ---');
const logs = [];
const child = launcher.spawnDshWeb({
  bin: DSH_BIN, port: PORT, dshHome: HOME, extensionsDir: EXT, runtime: NODE24,
  onLog: (m) => { logs.push(m); say('[dsh] ' + m); },
});
if (!child) { say('=== RESULT: FAIL spawnDshWeb null ==='); process.exit(1); }

const deadline = Date.now() + 60000;
const poll = setInterval(async () => {
  const token = logs.map(l => TOKEN_RE.exec(l)).find(Boolean);
  if (token) {
    clearInterval(poll);
    const r = await getUrl(token[1]);
    killTree(child.pid);
    const bad = logs.filter(l => /(error|invalid|declares no|Cannot find|ERR_)/i.test(l));
    say(`token reachable=${r.ok} code=${r.code}`);
    say(`suspicious log lines (${bad.length}):`);
    bad.slice(0, 12).forEach(l => say('   ! ' + l));
    const pass = missing.length === 0 && r.ok;
    say(`=== RESULT: ${pass ? 'PASS' : 'FAIL'} (bundles=${bundles.length}, token=${!!token}, reachable=${r.ok}) ===`);
    process.exit(pass ? 0 : 1);
  }
  if (Date.now() > deadline) {
    clearInterval(poll);
    killTree(child.pid);
    say('--- dsh web did not emit token in 60s. last logs ---');
    logs.slice(-25).forEach(l => say('   ' + l));
    say(`=== RESULT: FAIL timeout (bundles=${bundles.length}) ===`);
    process.exit(1);
  }
}, 500);
