// 闪退自动化复现 / 监测脚本
// 用法: node scripts/crash-loop-test.mjs [exe路径] [存活目标秒数] [offscreen|gui]
//   - 启动 exe（清除 ELECTRON_RUN_AS_NODE，避免 electron 退化为纯 Node）
//   - 同时挂 DSH_TEST=1 暴露 /healthz 供探测；offscreen 模式设 DSH_OFFSCREEN=1（不显示窗口，仍跑渲染+GPU 进程）
//   - 轮询：进程是否存活 / /healthz 是否 ready
//   - 运行 目标秒数 后判定：存活且 harness ready => PASS；进程提前退出 => FAIL
//   - 失败则收集 crash-*.log 新增、electron-*.log 尾部、WER dump 目录，输出结构化诊断
//
// 退出码：0 = PASS，1 = FAIL（崩溃），2 = 启动失败/无法探测。

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const EXE = process.argv[2] || 'D:/tmp/eb-out/DeepSeekAgent/DeepSeek 智能体客户端.exe';
const TARGET_SEC = Number(process.argv[3] || 75);
const MODE = process.argv[4] || 'offscreen'; // offscreen | gui
const DIAG_DIR = path.join(os.tmpdir(), 'dsh-agent-logs');
const DATE = new Date().toISOString().slice(0, 10);

function log(...a) { console.log('[crash-test]', ...a); }

function probe(port) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 800 }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => res({ ok: true, port, body: b }));
    });
    req.on('error', () => res({ ok: false }));
    req.on('timeout', () => { req.destroy(); res({ ok: false }); });
  });
}

async function waitHealthz(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (let p = 5183; p <= 5213; p++) {
      const r = await probe(p);
      if (r.ok) return r;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

function readTail(file, lines = 60) {
  try {
    if (!fs.existsSync(file)) return '(不存在)';
    const txt = fs.readFileSync(file, 'utf8');
    const all = txt.split('\n');
    return all.slice(-lines).join('\n');
  } catch (e) {
    return '(读取失败: ' + e.message + ')';
  }
}

function crashLogPath() { return path.join(DIAG_DIR, `crash-${DATE}.log`); }
function electronLogPath() { return path.join(DIAG_DIR, `electron-${DATE}.log`); }

function collectWerDumps() {
  const dirs = [
    path.join(os.homedir(), 'AppData', 'Local', 'CrashDumps'),
    'C:/ProgramData/Microsoft/Windows/WER/ReportQueue',
    path.join(os.tmpdir(), 'CrashDumps'),
  ];
  const found = [];
  for (const d of dirs) {
    try {
      if (!fs.existsSync(d)) continue;
      const names = fs.readdirSync(d).filter((n) => /\.dmp$/i.test(n) || /DeepSeek|electron|agent/i.test(n));
      if (names.length) found.push({ dir: d, files: names.slice(-20) });
    } catch {}
  }
  return found;
}

function isAlive(pid) {
  try {
    const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8', timeout: 5000 });
    return out.stdout.includes(String(pid));
  } catch {
    return false;
  }
}

async function main() {
  log('exe =', EXE);
  log('mode =', MODE, '| 目标存活 =', TARGET_SEC, 's');
  if (!fs.existsSync(EXE)) {
    log('❌ exe 不存在:', EXE);
    process.exit(2);
  }

  // 基线：记录启动前 crash 日志行数，用于判断本次是否新产生崩溃记录
  let crashBaseline = 0;
  try { crashBaseline = fs.existsSync(crashLogPath()) ? fs.readFileSync(crashLogPath(), 'utf8').split('\n').filter(Boolean).length : 0; } catch {}
  log('crash 日志基线行数 =', crashBaseline);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 关键：避免 electron 被当成纯 Node 跑
  env.DSH_TEST = '1'; // 暴露 /healthz、/test/mcp/call
  if (MODE === 'offscreen') env.DSH_OFFSCREEN = '1';

  const ring = [];
  let exited = false;
  let exitCode = null;
  let exitSignal = null;

  log('spawn 启动中...');
  const child = spawn(EXE, [], {
    env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  log('主进程 PID =', pid);

  child.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim()) continue;
      ring.push(line);
      if (ring.length > 200) ring.shift();
    }
  });
  child.stderr.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim()) continue;
      ring.push('[stderr] ' + line);
      if (ring.length > 200) ring.shift();
    }
  });
  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    log(`子进程退出: code=${code} signal=${signal}`);
  });
  child.on('error', (e) => {
    log('spawn 错误:', e.message);
    process.exit(2);
  });

  // 阶段1：等待 harness 就绪（healthz）
  log('等待 /healthz 就绪（最多 40s）...');
  const hz = await waitHealthz(40000);
  if (!hz) {
    log('❌ 始终未探测到 /healthz（进程可能启动即崩或端口异常）');
    if (!exited && child && !child.killed) {
      try { child.kill('SIGKILL'); } catch {}
    }
    dumpDiagnosis({ started: false });
    process.exit(2);
  }
  let health = null;
  try { health = JSON.parse(hz.body); } catch {}
  log(`✅ /healthz ready @ :${hz.port} | uptimeMs=${health?.uptimeMs} | harness.ready=${health?.harness?.ready} | mcpServers=${(health?.mcpServers || []).length}`);
  if (health?.harness?.error) log('   harness.error =', health.harness.error);
  if (health?.harness?.ready === false) log('   ⚠️ harness 未就绪（但进程活着）');

  // 阶段2：持续监测存活直到目标时长
  log(`持续监测存活 ${TARGET_SEC}s ...`);
  const monitorStart = Date.now();
  const deadline = monitorStart + TARGET_SEC * 1000;
  let lastAliveCheck = true;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exited) {
      log(`⚠️ 在监测期间进程退出（存活约 ${Math.round((Date.now() - monitorStart) / 1000)}s）`);
      break;
    }
    const alive = isAlive(pid);
    lastAliveCheck = alive;
    if (!alive && !exited) {
      log('⚠️ tasklist 检测 PID 不存在，但 exit 事件未触发（可能被外部强杀）');
      exited = true;
      exitCode = null;
      exitSignal = 'EXTERNAL_KILL?';
      break;
    }
  }

  // 收尾
  if (!exited) {
    log(`✅ 进程存活满 ${TARGET_SEC}s，未闪退 -> PASS`);
    try { if (child && !child.killed) child.kill('SIGKILL'); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    process.exit(0);
  } else {
    log(`❌ 进程退出（code=${exitCode} signal=${exitSignal}）-> FAIL`);
    dumpDiagnosis({ started: true, health, exitCode, exitSignal });
    process.exit(1);
  }
}

function dumpDiagnosis({ started, health, exitCode, exitSignal }) {
  console.log('\n================ 诊断信息 ================');
  const crashPath = crashLogPath();
  let crashLines = [];
  try {
    if (fs.existsSync(crashPath)) {
      const all = fs.readFileSync(crashPath, 'utf8').split('\n').filter(Boolean);
      crashLines = all;
    }
  } catch {}
  console.log('crash 日志新增行数 =', crashLines.length);
  if (crashLines.length) {
    console.log('---- crash-*.log 尾部 ----');
    console.log(crashLines.slice(-15).join('\n'));
  }
  console.log('---- electron-*.log 尾部 ----');
  console.log(readTail(electronLogPath(), 50));
  console.log('---- 子进程 stdout/stderr 环形缓冲(最近30) ----');
  console.log((ring.slice(-30).join('\n')) || '(空)');
  const wers = collectWerDumps();
  if (wers.length) {
    console.log('---- WER / dump 目录命中 ----');
    for (const w of wers) console.log(w.dir, '=>', w.files.join(', '));
  } else {
    console.log('---- 未命中 WER/dump 目录 ----');
  }
  console.log('==========================================\n');
}

main().catch((e) => {
  console.error('[crash-test] 脚本异常:', e);
  process.exit(3);
});
