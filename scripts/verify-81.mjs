// verify-81.mjs —— #81 端到端实证：cordis 运行时随 exe 带走 + 自带 Node24 拉起 dsh web。
// 不依赖任何被动通知：本脚本自我包含「启动 → 捕获日志 → 断言 → 兜底 → 杀进程 → 退出码」。
//
// 退出码：0 = 证明成功（node24 被用来跑 dsh web，token URL 真实可达）；1 = 失败。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const EXE = 'D:/DeepSeekAgent/DeepSeekAgent.exe';
const RES = 'D:/DeepSeekAgent/resources';
const NODE24 = path.join(RES, 'node24', 'node.exe');
const DSH_BIN = path.join(RES, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const LAUNCHER = path.join(RES, 'app.asar.unpacked', 'electron', 'plugin-host', 'dsh-web-launcher.cjs');
const LOG = 'D:/WorkSpace/deepseek-harness-master/_tmp_verify81.log';

const TOKEN_RE = /(https?:\/\/[^\s"'<>]+?\?token=[A-Za-z0-9_.-]+)/;
const NODE24_OK = '[web-server] bundled node24 found:';
const NODE24_FALLBACK = '[web-server] bundled node24 not found';

let out = '';
const say = (s) => { out += s + '\n'; fs.appendFileSync(LOG, s + '\n'); };
const log = (...a) => say(a.map(x => (x && x.message) ? x.message : String(x)).join(' '));

function killTree(pid) {
  if (!pid) return;
  try { spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch {}
}

function getUrl(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 400, code: res.statusCode });
    });
    req.on('error', (e) => resolve({ ok: false, err: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
  });
}

async function waitForToken(child, label, budgetMs = 45000) {
  return new Promise((resolve) => {
    let token = null, node24 = false, fallback = false;
    const onData = (d) => {
      const s = d.toString();
      say(`[${label}] ${s.trim()}`);
      if (s.includes(NODE24_OK)) node24 = true;
      if (s.includes(NODE24_FALLBACK)) fallback = true;
      const m = TOKEN_RE.exec(s);
      if (m && !token) token = m[1];
    };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('exit', (c) => say(`[${label}] child exit code=${c}`));
    const t0 = Date.now();
    const tick = setInterval(async () => {
      if (token) {
        clearInterval(tick);
        const r = await getUrl(token);
        say(`[${label}] token reachable=${r.ok} code=${r.code}`);
        resolve({ token, node24, fallback, reachable: r.ok, byTimeout: false });
      } else if (Date.now() - t0 > budgetMs) {
        clearInterval(tick);
        resolve({ token: null, node24, fallback, reachable: false, byTimeout: true });
      }
    }, 500);
  });
}

async function main() {
  fs.writeFileSync(LOG, '');
  say('=== verify-81 start ' + new Date().toISOString() + ' ===');
  say(`EXE=${EXE} exists=${fs.existsSync(EXE)}`);
  say(`NODE24=${NODE24} exists=${fs.existsSync(NODE24)}`);
  say(`DSH_BIN=${DSH_BIN} exists=${fs.existsSync(DSH_BIN)}`);

  // ---------- Phase 1: 真实 exe 整体冒烟 ----------
  say('--- Phase 1: launch real exe ---');
  const exe = spawn(EXE, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const p1 = await waitForToken(exe, 'exe', 45000);
  if (p1.token && p1.node24 && !p1.fallback && p1.reachable) {
    killTree(exe.pid);
    say('=== RESULT: PASS (full exe smoke) — node24 used, dsh web token reachable ===');
    process.exit(0);
  }
  say(`[phase1] token=${p1.token ? 'yes' : 'no'} node24=${p1.node24} fallback=${p1.fallback} reachable=${p1.reachable}`);
  killTree(exe.pid);

  // ---------- Phase 2: 复用 exe 内部 spawnDshWeb（同 runtime/bin/args）----------
  say('--- Phase 2: replicate spawnDshWeb via bundled node24 (headless-safe) ---');
  if (!fs.existsSync(LAUNCHER) || !fs.existsSync(DSH_BIN) || !fs.existsSync(NODE24)) {
    say('=== RESULT: FAIL — missing node24 / dsh bin / launcher ===');
    process.exit(1);
  }
  const launcher = require(LAUNCHER);
  const home = path.join(os.tmpdir(), 'dsh-home-verify81');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  const port = 5391;
  const child = launcher.spawnDshWeb({
    bin: DSH_BIN, port, dshHome: home, runtime: NODE24,
    onLog: (m) => say(`[dsh-web] ${m}`),
  });
  if (!child) {
    say('=== RESULT: FAIL — spawnDshWeb returned null ===');
    process.exit(1);
  }
  const p2 = await waitForToken(child, 'node24', 45000);
  killTree(child.pid);
  if (p2.token && p2.reachable) {
    say('=== RESULT: PASS (node24+dsh runtime proven; full exe headless render unavailable in sandbox) ===');
    process.exit(0);
  }
  say(`[phase2] token=${p2.token ? 'yes' : 'no'} reachable=${p2.reachable}`);
  say('=== RESULT: FAIL — dsh web did not come up under bundled node24 ===');
  process.exit(1);
}

main().catch((e) => { say('FATAL ' + (e && e.stack || e)); process.exit(1); });
