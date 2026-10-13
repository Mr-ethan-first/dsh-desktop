// 实证探针：拉起 dsh web，检查 web 端口是否真的提供 /api/remote.mux 与 /api/directoryPicker/pick
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';

const require = createRequire('D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
const WebSocket = require('ws');
const launcher = require('D:/DeepSeekAgent/resources/app.asar.unpacked/electron/plugin-host/dsh-web-launcher.cjs');

const PORT = Number(process.env.PROBE_PORT || 5440);
const DSH_HOME = 'D:/WorkSpace/deepseek-harness-master/_tmp_probe_dsh_home';
fs.rmSync(DSH_HOME, { recursive: true, force: true });
fs.mkdirSync(DSH_HOME, { recursive: true });

const log = (m) => { fs.appendFileSync('D:/WorkSpace/deepseek-harness-master/_tmp_probe_mux.log', m + '\n'); console.log(m); };

// 复用 launcher 的真实 node24 + dsh 入口
const cliDir = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh';
const launch = launcher.resolveDshLaunch({ cliDir, extraBins: [cliDir + '/lib/bin.js'] });
log('launch=' + JSON.stringify(launch));

const child = launcher.spawnDshWeb({
  bin: launch.bin,
  port: PORT,
  dshHome: DSH_HOME,
  extensionsDir: 'D:/DeepSeekAgent/resources/packages/extensions',
  runtime: 'D:/DeepSeekAgent/resources/node24/node.exe',
  nodeArgs: launch.nodeArgs,
  onLog: (m) => log('[dsh-web] ' + m),
});

function waitReady(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const s = net.connect(PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => { s.destroy(); if (Date.now() - start > timeoutMs) resolve(false); else setTimeout(tick, 500); });
    };
    tick();
  });
}

(async () => {
  const ok = await waitReady(60000);
  log('web ready=' + ok);
  if (!ok) { child && child.kill(); process.exit(1); }

  // 1) HTTP GET /api/directoryPicker/pick
  await new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/directoryPicker/pick', timeout: 5000 }, (r) => {
      log('directoryPicker HTTP status=' + r.statusCode);
      r.resume();
      res();
    });
    req.on('error', (e) => { log('directoryPicker HTTP error=' + e.code + ' ' + e.message); res(); });
    req.on('timeout', () => { log('directoryPicker HTTP timeout'); req.destroy(); res(); });
  });

  // 2) WebSocket /api/remote.mux
  await new Promise((res) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/api/remote.mux');
    const to = setTimeout(() => { log('remote.mux WS timeout (no open/error)'); try { ws.terminate(); } catch {} res(); }, 6000);
    ws.on('open', () => { clearTimeout(to); log('remote.mux WS OPEN ok'); try { ws.close(); } catch {} res(); });
    ws.on('error', (e) => { clearTimeout(to); log('remote.mux WS error=' + e.message); res(); });
    ws.on('unexpected-response', (req, r) => { clearTimeout(to); log('remote.mux WS unexpected-response status=' + r.statusCode); res(); });
  });

  // 3) 列出 web profile 实际 bundles（看 API 包是否在）
  try {
    const pj = JSON.parse(fs.readFileSync(DSH_HOME + '/profiles/web/package.json', 'utf8'));
    log('web profile bundles=' + JSON.stringify(pj.dsh && pj.dsh.profile && pj.dsh.profile.bundles));
  } catch (e) { log('profile read err=' + e.message); }

  child && child.kill();
  process.exit(0);
})();
