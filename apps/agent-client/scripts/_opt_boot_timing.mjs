// 冷启动计时探针：直接从部署运行时拉起 `dsh web`，记录每行输出的相对时间，定位启动热点。
// 只读：仅在隔离的临时 DSH_HOME 下写入 profile 清单，不触碰用户真实环境。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const launcher = require('../electron/plugin-host/dsh-web-launcher.cjs');

const DEPLOY = process.env.DSH_OPT_DEPLOY || 'D:\\DeepSeekAgent';
const NODE = process.env.DSH_OPT_NODE || 'D:\\software\\node-v24.16.0-win-x64\\node.exe';
const RUNTIME = path.join(DEPLOY, 'resources', 'dsh-runtime');
const CLI = path.join(RUNTIME, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const EXTDIR = path.join(DEPLOY, 'resources', 'packages', 'extensions');
const HOME = process.env.DSH_OPT_HOME || path.join(os.tmpdir(), `dsh-opt-home-${process.pid}`);
const PORT = Number(process.env.DSH_OPT_PORT || 5399 + (process.pid % 200));

// 默认每次用全新的隔离 DSH_HOME（避免命中宿主 safe-delete 守卫）。
// DSH_OPT_REUSE=1 时复用同一 DSH_HOME —— 用于模拟「真实应用已有 DSH_HOME」的稳态。
if (process.env.DSH_OPT_REUSE !== '1') {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* 首次不存在 */ }
}
fs.mkdirSync(HOME, { recursive: true });
launcher.prepareDshHome({
  extensionsDir: EXTDIR,
  dshHome: HOME,
  runtimeModulesDir: path.join(RUNTIME, 'node_modules'),
  onLog: (m) => console.log('[prepare]', m),
});

const t0 = Date.now();
const marks = [];
let tokenAt = null;
const env = { ...process.env, DSH_HOME: HOME };
delete env.NODE_OPTIONS;

const extraArgs = process.env.DSH_OPT_NODEARGS ? process.env.DSH_OPT_NODEARGS.split(' ').filter(Boolean) : [];
const child = spawn(NODE, [...extraArgs, '--expose-internals', CLI, 'web', '--port', String(PORT), '--no-open'], {
  env, stdio: ['ignore', 'pipe', 'pipe'],
});

const onData = (buf) => {
  const s = buf.toString();
  for (const line of s.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const ms = Date.now() - t0;
    marks.push({ ms, line: line.slice(0, 200) });
    if (/token=/.test(line) && tokenAt == null) {
      tokenAt = ms;
      console.log(`\n>>> TOKEN READY at ${ms} ms`);
      if (process.env.DSH_OPT_NOKILL === '1') {
        console.log('[probe] NOKILL：保持子进程存活，等待外部（剖面）自行收尾');
      } else {
        child.kill();
        finish();
      }
    }
  }
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('exit', (c) => { console.log(`[exit] code=${c} at ${Date.now() - t0}ms`); finish(); });

let done = false;
function finish() {
  if (done) return;
  done = true;
  console.log('--- timeline ---');
  for (const m of marks) console.log(`${String(m.ms).padStart(7)}ms  ${m.line}`);
  console.log(`--- total ${Date.now() - t0}ms, token=${tokenAt}ms ---`);
  setTimeout(() => process.exit(0), 200);
}
setTimeout(() => { console.log('!! TIMEOUT 180s'); child.kill(); finish(); }, 180_000);
