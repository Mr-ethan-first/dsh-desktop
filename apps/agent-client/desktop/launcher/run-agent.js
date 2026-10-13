'use strict';
/**
 * DeepSeekAgent 启动器 —— 由 Electron 内置 Node（ELECTRON_RUN_AS_NODE=1）执行。
 *
 * 背景（2026-09-03）：Electron 44.1.1 已内置 Node v24.19.0，不再随包外挂约 92MB 的
 * node.exe（resources/node24）。本脚本改用「同一个 exe 自身当 node」来点火：
 *   桌面 DeepSeekAgent.cmd/.vbs 设置 ELECTRON_RUN_AS_NODE=1 后以
 *   `DeepSeekAgent.exe run-agent.js` 启动本脚本（exe 此时等价于纯 Node）；
 *   本脚本剔除该变量后，以真正的 GUI 模式重新拉起同一个 exe，并把
 *   stdout/stderr 统一写进 logs/agent-<ts>.log，避免根目录散落以 PID 命名的日志文件。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname; // 本脚本位于 D:\DeepSeekAgent\，__dirname 即交付根目录
const EXE = process.execPath; // 当前进程就是 DeepSeekAgent.exe

const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `agent-${Date.now()}.log`);

const ts = () => new Date().toISOString();

function start() {
  if (!fs.existsSync(EXE)) {
    console.error(`[run-agent] 未找到 ${EXE}`);
    process.exit(1);
  }

  const out = fs.openSync(LOG_FILE, 'a');
  const err = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(out, `[${ts()}] run-agent: exe-as-node 启动, EXE=${EXE}\n`);

  // 剔除 ELECTRON_RUN_AS_NODE，确保子进程进入真正的 GUI 模式（否则会再当 node 跑）。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(EXE, [], {
    cwd: ROOT,
    detached: true,
    windowsHide: false,
    env,
    stdio: ['ignore', out, err]
  });

  fs.writeSync(out, `[${ts()}] run-agent: 已拉起 GUI 子进程 PID=${child.pid}, 日志=${LOG_FILE}\n`);
  console.log(`[run-agent] DeepSeekAgent started (PID=${child.pid}), log -> ${LOG_FILE}`);

  child.unref();
  // 父进程（exe-as-node）立即退出，由 GUI 子进程独立运行。
  setTimeout(() => process.exit(0), 50);
}

start();
