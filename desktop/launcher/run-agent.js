/**
 * DeepSeekAgent 启动器（便捷入口）。
 *
 * 2026-09-03 升级 Electron 44.1.1 后：包内已不再外挂 node.exe（原
 * resources/node24/node.exe ≈ 92MB）。本脚本改由 **Electron 二进制自身** 以
 * `ELECTRON_RUN_AS_NODE=1` 运行 —— 该模式下 Electron 可执行文件等价于纯 Node：
 * 不拉起 Chromium、不创建窗口，可直接执行 JS 入口。
 *
 * 因此启动链变成：
 *   DeepSeekAgent.cmd / .vbs
 *     └─ ELECTRON_RUN_AS_NODE=1 DeepSeekAgent.exe run-agent.js   ← 当 node 用
 *          └─ spawn DeepSeekAgent.exe（env 中剔除 ELECTRON_RUN_AS_NODE）← 真 GUI
 *
 * 本启动器的价值（与"绕过杀软"无关，实测未签名 exe 双击可正常打开）：
 *   1) 显式以 cwd = exe 所在目录拉起，避免入口 cwd 不对导致启动即退出；
 *   2) 单实例管理便利（重复点击只聚焦已有窗口，由主进程 requestSingleInstanceLock 处理）；
 *   3) 统一把 stdout/stderr 重定向到 logs/agent-<ts>.log，避免根目录散落 PID 日志。
 */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;
const EXE = path.join(ROOT, 'DeepSeekAgent.exe');

const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `agent-${Date.now()}.log`);

function now() {
  return new Date().toISOString();
}

/** 构造子进程的 env：必须以 GUI 模式启动 exe，因此剔除 run-as-node 开关。 */
function guiEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

function start() {
  if (!fs.existsSync(EXE)) {
    console.error(`[run-agent] 未找到 ${EXE}`);
    process.exit(1);
  }

  const out = fs.openSync(LOG_FILE, 'a');
  const err = fs.openSync(LOG_FILE, 'a');

  const launcher = process.versions && process.versions.electron
    ? 'electron-run-as-node'
    : 'node';
  fs.writeSync(out, `[${now()}] run-agent: starting ${EXE} (launcher=${launcher})\n`);

  const child = spawn(EXE, [], {
    cwd: ROOT,
    env: guiEnv(),
    detached: true,
    windowsHide: false,
    stdio: ['ignore', out, err],
  });

  fs.writeSync(out, `[${now()}] run-agent: PID=${child.pid}, log=${LOG_FILE}\n`);
  console.log(`[run-agent] DeepSeekAgent started (PID=${child.pid}), log -> ${LOG_FILE}`);

  child.unref();

  // 父进程立即退出，由子进程独立运行
  setTimeout(() => process.exit(0), 50);
}

start();
