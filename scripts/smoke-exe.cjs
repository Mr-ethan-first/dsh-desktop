'use strict';
// 真机冒烟测试：启动打包后的 exe（headless），轮询 /healthz，验证 exe 能真正启动且不崩溃。
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const EXE = process.argv[2] || path.resolve(__dirname, '..', 'apps', 'agent-client', 'release', 'DeepSeekAgent 0.1.0.exe');
const PORT = 5183;
const env = { ...process.env, DSH_HEADLESS: '1', DSH_TEST: '1', DSH_WEB_PROXY_API: '1' };

console.log('[smoke] launching exe:', EXE);
const child = spawn(EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
let out = '';
child.stdout && child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr && child.stderr.on('data', (d) => { out += d.toString(); });
child.on('error', (e) => console.log('[smoke] spawn error:', e.message));
child.on('exit', (code, sig) => console.log('[smoke] exe exited code=' + code + ' signal=' + sig));

function poll(tries) {
  if (tries <= 0) {
    console.log('[smoke] healthz not reachable after retries');
    console.log('[smoke] --- exe stdout/stderr (tail) ---\n' + out.split('\n').slice(-40).join('\n'));
    try { child.kill(); } catch {}
    process.exit(2);
  }
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 2000 }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      console.log('[smoke] /healthz HTTP ' + res.statusCode);
      console.log('[smoke] body: ' + body);
      try { child.kill(); } catch {}
      process.exit(0);
    });
  });
  req.on('error', () => {
    console.log('[smoke] healthz not ready, retries left=' + (tries - 1));
    setTimeout(() => poll(tries - 1), 2000);
  });
  req.on('timeout', () => { req.destroy(); });
}

setTimeout(() => poll(20), 3000);

// 兜底：60s 后强制结束
setTimeout(() => {
  console.log('[smoke] timeout guard reached, killing');
  try { child.kill(); } catch {}
  process.exit(3);
}, 60000);
