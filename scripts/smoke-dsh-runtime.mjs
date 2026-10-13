/**
 * smoke-dsh-runtime.mjs — 验证「裁剪后的 dsh-runtime」仍能正常启动 dsh web。
 * 不依赖 Playwright：仅用 node24 复刻 exe 的 spawnDshWeb，等 token/端口就绪，
 * 再探一个桥接端点（/plugins/events）确认非 ERR_CONNECTION_REFUSED。
 * 用于 prune 之后快速回归，避免把生产运行时裁坏。
 *   运行：unset NODE_OPTIONS; node scripts/smoke-dsh-runtime.mjs   （建议 dangerouslyDisableSandbox）
 */
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const NODE24 = 'D:/DeepSeekAgent/resources/node24/node.exe';
const DSH_BIN = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js';
const EXTENSIONS_DIR = 'D:/DeepSeekAgent/resources/packages/extensions';
const PROD_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home';
const SMOKE_PORT = 5299;
const OUT = 'D:/WorkSpace/deepseek-harness-master/_tmp_smoke_result.json';

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(true); });
  });
}
function waitPortListen(port, ms) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (Date.now() - start > ms) return resolve(false);
      if (await isPortFree(port)) { await sleep(500); return tick(); }
      resolve(true);
    };
    tick();
  });
}

async function main() {
  const res = { boot: false, bridge: '', err: '' };
  let child = null;
  try {
    // 清理残留 dsh web 子进程（孤儿会持 node_modules.lock）
    try {
      const selfPid = String(process.pid);
      execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match \'node\\.exe\' -and $_.CommandLine -like \'*dsh/lib/bin.js*\' -and $_.CommandLine -like \'*web*\' -and $_.ProcessId -ne ' + selfPid + ' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"');
    } catch {}
    await sleep(600);
    // 剥除陈旧 .lock
    (function strip(d) { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const p = path.join(d, x.name); if (x.isDirectory()) strip(p); else if (x.name.endsWith('.lock')) { try { fs.rmSync(p, { force: true }); } catch {} } } })(PROD_HOME);
    // 复刻 exe 的 prepareDshHome（注入社区插件 junction）
    try { require('D:/DeepSeekAgent/resources/app.asar.unpacked/electron/plugin-host/dsh-web-launcher.cjs').prepareDshHome({ extensionsDir: EXTENSIONS_DIR, dshHome: PROD_HOME }); } catch (e) { log('[smoke] prepareDshHome warn:', e.message); }

    const childEnv = { ...process.env };
    delete childEnv.NODE_OPTIONS;
    for (const k of Object.keys(childEnv)) if (/^CODEBUDDY_SAFE_DELETE_/i.test(k)) delete childEnv[k];
    const env = { ...childEnv, DSH_HOME: PROD_HOME };
    child = spawn(NODE24, [DSH_BIN, 'web', '--port', String(SMOKE_PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log2 = '';
    child.stdout.on('data', (d) => { log2 += d; process.stdout.write('[dsh-web] ' + d); });
    child.stderr.on('data', (d) => { log2 += d; process.stderr.write('[dsh-web-err] ' + d); });
    child.on('exit', (c) => log('[dsh-web] exit code=' + c));

    const tokenRe = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_.-]+)/;
    const start = Date.now();
    let tokenUrl = null;
    while (Date.now() - start < 120000) {
      const m = tokenRe.exec(log2);
      if (m) { tokenUrl = m[1]; break; }
      if (!(await isPortFree(SMOKE_PORT))) { tokenUrl = `http://127.0.0.1:${SMOKE_PORT}/`; break; }
      await sleep(700);
    }
    if (!tokenUrl) throw new Error('dsh web 未在 120s 内就绪（裁剪后运行时可能无法 boot）');

    res.boot = true;
    log('[smoke] dsh web 就绪:', tokenUrl);
    // 探桥接端点
    const ok = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${SMOKE_PORT}/plugins/events`, { timeout: 8000 }, (r) => { res.bridge = 'HTTP ' + r.statusCode; r.resume(); resolve(true); });
      req.on('error', (e) => { res.bridge = 'ERR:' + (e.message || e.name); resolve(false); });
      req.on('timeout', () => { req.destroy(); res.bridge = 'ERR:timeout'; resolve(false); });
    });
    res.ok = ok && res.bridge !== 'ERR:timeout';
    log('[smoke] bridge =', res.bridge);
    res.pass = res.boot && res.ok;
    fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
    return res.pass ? 0 : 1;
  } catch (e) {
    res.err = e.message;
    log('[smoke] FATAL', e.message);
    fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
    return 2;
  } finally {
    try { if (child) child.kill('SIGTERM'); } catch {}
  }
}
main().then((c) => { setTimeout(() => process.exit(c), 300); }).catch(() => process.exit(3));
