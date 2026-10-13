// 模拟用户"双击"启动 exe（通过 explorer 启动，父进程为 explorer，最接近真实双击），
// 监测其是否会在无操作情况下被外部杀软静默杀死（约 10s 闪退）。
// 用法: node scripts/repro-doubleclick.mjs [exe路径] [存活目标秒数]

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const EXE = process.argv[2] || 'D:/DeepSeekAgent/DeepSeek 智能体客户端.exe';
const TARGET_SEC = Number(process.argv[3] || 60);
const MODE = process.argv[4] || 'explorer'; // explorer | cmd | node
const DIAG_DIR = path.join(os.tmpdir(), 'dsh-agent-logs');
const DATE = new Date().toISOString().slice(0, 10);
const IMAGE = 'DeepSeek 智能体客户端.exe';

function log(...a) { console.log('[repro-dblclick]', ...a); }

function isRunning() {
  try {
    const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${IMAGE}`], { encoding: 'utf8', timeout: 5000 });
    return out.stdout.includes(IMAGE);
  } catch { return false; }
}
function killAll() {
  try { spawnSync('taskkill', ['/IM', IMAGE, '/F'], { encoding: 'utf8', timeout: 8000 }); } catch {}
}

function probe(port) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 800 }, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ ok: true, port, body: b }));
    });
    req.on('error', () => res({ ok: false }));
    req.on('timeout', () => { req.destroy(); res({ ok: false }); });
  });
}
async function waitHealthz(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (let p = 5183; p <= 5213; p++) { const r = await probe(p); if (r.ok) return r; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
function readTail(file, lines = 40) {
  try { if (!fs.existsSync(file)) return '(不存在)'; const all = fs.readFileSync(file, 'utf8').split('\n'); return all.slice(-lines).join('\n'); } catch { return '(读取失败)'; }
}

async function main() {
  log('exe =', EXE);
  log('mode =', MODE, '| 目标存活 =', TARGET_SEC, 's');
  if (!fs.existsSync(EXE)) { log('❌ exe 不存在'); process.exit(2); }

  log('清场已有实例...');
  killAll();
  await new Promise((r) => setTimeout(r, 2000));

  // 统一清理可能令 electron 退化为纯 Node 的变量，并暴露 /healthz 供探测；
  // 默认仍显示真实 GUI 窗口（不强制 offscreen），以复现用户"双击打开"的最真实场景。
  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_RUN_AS_NODE;
  baseEnv.DSH_TEST = '1';

  let child;
  if (MODE === 'cmd') {
    // 通过 cmd.exe 派生（模拟"bat 启动器"）：父进程为 cmd.exe，而非 explorer。
    log('以 cmd 方式启动（模拟 bat 启动器，父进程=cmd.exe）...');
    child = spawn('cmd.exe', ['/c', 'start', '', EXE], { detached: true, stdio: 'ignore', windowsHide: false, env: baseEnv });
  } else if (MODE === 'node') {
    log('以 node 子进程方式启动（父进程=node.exe）...');
    child = spawn(EXE, [], { detached: true, stdio: 'ignore', env: baseEnv });
  } else if (MODE === 'clean') {
    // 先清空 ELECTRON_RUN_AS_NODE 再启动（等价于"修复启动器"的效果），用于验证该变量是否为闪退根因。
    const batPath = path.join(os.tmpdir(), 'dsh-launch-clean.bat');
    fs.writeFileSync(batPath, `@echo off\r\nset ELECTRON_RUN_AS_NODE=\r\nstart "" "${EXE}"\r\n`, 'utf8');
    log('以 clean bat 启动（先清空 ELECTRON_RUN_AS_NODE，模拟修复启动器）...');
    child = spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' });
  } else {
    log('以 explorer 方式启动（模拟双击，父进程=explorer.exe，显示真实 GUI 窗口）...');
    child = spawn('explorer.exe', [EXE], { detached: true, stdio: 'ignore', env: baseEnv });
  }
  child.unref?.();
  log('已发出启动请求');

  // 阶段1：等待 /healthz 就绪（最多 40s）
  const hz = await waitHealthz(40000);
  let health = null;
  if (hz) { try { health = JSON.parse(hz.body); } catch {} log(`✅ /healthz ready @ :${hz.port} | uptimeMs=${health?.uptimeMs} | harness.ready=${health?.harness?.ready}`); }
  else log('⚠️ 40s 内未探测到 /healthz（可能启动即被杀，或端口异常）');

  // 阶段2：监测镜像存活
  log(`持续监测镜像 "${IMAGE}" 存活 ${TARGET_SEC}s ...`);
  let alive = true;
  let killedAtSec = null;
  const start = Date.now();
  while (Date.now() - start < TARGET_SEC * 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    alive = isRunning();
    if (!alive) { killedAtSec = Math.round((Date.now() - start) / 1000); break; }
  }

  killAll(); // 清理

  if (alive) {
    log(`✅ 进程存活满 ${TARGET_SEC}s，未被杀 -> PASS`);
    process.exit(0);
  } else {
    log(`❌ 进程在约 ${killedAtSec}s 后消失（被外部杀死）-> FAIL`);
    console.log('\n---- electron-*.log 尾部 ----');
    console.log(readTail(path.join(DIAG_DIR, `electron-${DATE}.log`), 40));
    console.log('================================\n');
    process.exit(1);
  }
}
main().catch((e) => { console.error('[repro-dblclick] 异常:', e); process.exit(3); });
