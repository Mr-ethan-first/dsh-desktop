// 轻量冒烟：验证删除 dsh-runtime 跨界 junction 后，dsh web 仍能启动（首次启动流程）。
// 复用部署树自带的 launcher，用全新 DSH_HOME 触发 ensureExtensionsModuleFallback +
// prepareDshHome（与全新安装首启一致），再用随包 node.exe 拉起 dsh web，等待 token URL。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const DEPLOY = 'D:/DeepSeekAgent';
const req = createRequire(import.meta.url);
const launcher = req(path.join(DEPLOY, 'resources/app.asar.unpacked/electron/plugin-host/dsh-web-launcher.cjs'));

const extensionsDir = path.join(DEPLOY, 'resources/packages/extensions');
const runtimeModulesDir = path.join(DEPLOY, 'resources/dsh-runtime/node_modules');
const bin = path.join(DEPLOY, 'resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
const runtime = path.join(DEPLOY, 'resources/node.exe');
const port = 5300;
const dshHome = path.join('C:/temp', 'dsh-smoke-' + Date.now());

const logs = [];
function onLog(m) { logs.push(m); }

// 1) 准备 DSH_HOME（首次启动流程，含共享解析回退）
try {
  launcher.prepareDshHome({ extensionsDir, dshHome, profileName: 'web', runtimeModulesDir, onLog });
  console.log('[smoke] prepareDshHome OK; dshHome=' + dshHome);
} catch (e) {
  console.error('[smoke] prepareDshHome FAILED: ' + (e && e.stack || e));
  process.exit(2);
}

// 2) 拉起 dsh web
const env = { ...process.env };
env.DSH_HOME = dshHome;
delete env.NODE_OPTIONS;
env.NODE_COMPILE_CACHE = path.join(dshHome, 'compile-cache');
fs.mkdirSync(env.NODE_COMPILE_CACHE, { recursive: true });

const child = spawn(runtime, ['--expose-internals', bin, 'web', '--port', String(port), '--no-open'], {
  env, stdio: ['ignore', 'pipe', 'pipe'],
});
let tokenUrl = null;
const tokenRe = /(https?:\/\/\S+\?token=\S+)/;
function scan(d) {
  const s = d.toString();
  const m = s.match(tokenRe);
  if (m) tokenUrl = m[1];
  process.stdout.write('[dsh-web] ' + s.trim() + '\n');
}
child.stdout.on('data', scan);
child.stderr.on('data', scan);
child.on('error', (e) => { console.error('[smoke] spawn error: ' + e.message); process.exit(3); });

const deadline = Date.now() + 90000;
const timer = setInterval(() => {
  if (tokenUrl) {
    clearInterval(timer);
    console.log('[smoke] TOKEN_READY: ' + tokenUrl);
    try { child.kill('SIGKILL'); } catch {}
    // 清理 DSH_HOME
    try { fs.rmSync(dshHome, { recursive: true, force: true }); } catch {}
    process.exit(0);
  }
  if (Date.now() > deadline) {
    clearInterval(timer);
    console.error('[smoke] TIMEOUT: dsh web 未在 90s 内就绪');
    try { child.kill('SIGKILL'); } catch {}
    fs.writeFileSync('C:/temp/dsh-smoke-timeout.log', logs.join('\n'));
    try { fs.rmSync(dshHome, { recursive: true, force: true }); } catch {}
    process.exit(4);
  }
}, 1000);
