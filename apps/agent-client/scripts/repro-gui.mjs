#!/usr/bin/env node
// 复现 GUI 闪退：以非无头模式启动 exe，捕获 stderr/stdout 与崩溃日志，停留 15s。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const PORT = 5183;

function findExe() {
  const dirs = ['release', 'D:/tmp/eb-out'];
  let best = null, bestTime = -1;
  for (const dirName of dirs) {
    const dir = path.isAbsolute(dirName) ? dirName : path.join(ROOT, dirName);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.exe')) continue;
      const fp = path.join(dir, f);
      try {
        const m = fs.statSync(fp).mtimeMs;
        if (m > bestTime) { bestTime = m; best = fp; }
      } catch {}
    }
  }
  return best;
}

const exe = findExe();
if (!exe) { console.error('未找到 exe'); process.exit(2); }
console.log('启动 exe:', exe);

// 启动 mock MCP，复刻自动化测试环境
import http from 'node:http';
const MOCK_PORT = 8799;
const mock = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let rpc; try { rpc = JSON.parse(body || '{}'); } catch { res.statusCode = 400; res.end(); return; }
    const id = rpc.id;
    if (typeof rpc.method === 'string' && rpc.method.startsWith('notifications/')) { res.statusCode = 202; res.end(); return; }
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-office', version: '1.0' } };
    else if (rpc.method === 'tools/list') result = { tools: [{ name: 'echo_tool', description: 'echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } }] };
    else if (rpc.method === 'tools/call') result = { content: [{ type: 'text', text: 'ECHO:' + JSON.stringify(rpc.params?.arguments || {}) }], isError: false };
    else result = {};
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.statusCode = 200;
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ICUBE_ELECTRON_PATH;
env.DSH_MCP_SERVERS = JSON.stringify([{ id: 'mock-office', name: 'Mock Office', url: `http://127.0.0.1:${MOCK_PORT}/mcp` }]);
if (!env.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY = 'dummy-for-repro';
// 关键：不设置 DSH_HEADLESS，但用离屏窗口（show:false）真正加载渲染进程，
// 这样在无显示的沙箱里也能复现「渲染进程崩溃 → 主进程退出」的链路。
env.DSH_OFFSCREEN = '1';

const outPath = path.join(ROOT, 'scripts', 'repro-gui.out.txt');
const out = fs.openSync(outPath, 'w');
const child = spawn(exe, [], {
  cwd: ROOT,
  env,
  detached: true,
  stdio: ['ignore', out, out],
  windowsHide: true,
});
console.log('spawned pid', child.pid, '; 日志写到', outPath);

// 轮询 healthz，确认主进程存活
function healthz() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/healthz`, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => { req.destroy(); resolve(null); });
  });
}

let alive = true;
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const h = await healthz();
  if (!h) {
    console.log(`[t=${i + 1}s] /healthz 无响应 → 主进程已退出`);
    alive = false;
    break;
  }
  console.log(`[t=${i + 1}s] 存活 harness.ready=${h.harness?.ready} mcp=${h.mcpServers?.length}`);
}
if (alive) console.log('15s 内主进程存活（窗口可能仍在）；检查崩溃日志');

try {
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-child.pid, 'SIGKILL');
} catch {}
mock.close();

// 汇总崩溃日志
function findLogs() {
  const base = path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = [];
  for (const name of fs.readdirSync(base)) {
    if (name.toLowerCase().includes('deepseek') || name.toLowerCase().includes('agent') || name.toLowerCase().includes('dsh')) {
      const logs = path.join(base, name, 'logs');
      if (fs.existsSync(logs)) {
        for (const f of fs.readdirSync(logs)) {
          if (f.startsWith('crash-') || f.startsWith('agent-')) candidates.push(path.join(logs, f));
        }
      }
    }
  }
  return candidates;
}
const logs = findLogs();
console.log('\n=== 崩溃/运行日志 ===');
if (logs.length === 0) console.log('（未找到 crash/agent 日志）');
for (const f of logs) {
  console.log('\n---', f, '---');
  const txt = fs.readFileSync(f, 'utf8').split('\n').slice(-40).join('\n');
  console.log(txt);
}
