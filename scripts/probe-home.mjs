// probe-home.mjs —— 启动 dsh web 几秒后杀掉，检查 DSH_HOME 下生成的存储文件
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const RES = 'D:/DeepSeekAgent/resources';
const NODE24 = path.join(RES, 'node24', 'node.exe');
const DSH_BIN = path.join(RES, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const LAUNCHER = path.join(RES, 'app.asar.unpacked', 'electron', 'plugin-host', 'dsh-web-launcher.cjs');
const EXT = path.join(RES, 'packages', 'extensions');
const launcher = require(LAUNCHER);

const DSH_PORT = 5432;
const HOME = path.join(os.tmpdir(), 'dsh-home-probe-' + Date.now());
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
launcher.prepareDshHome({ extensionsDir: EXT, dshHome: HOME, profileName: 'web' });
const logs = [];
const child = launcher.spawnDshWeb({ bin: DSH_BIN, port: DSH_PORT, dshHome: HOME, extensionsDir: EXT, runtime: NODE24, onLog: (m) => { logs.push(m); console.log('[dsh] ' + m); } });
await new Promise((r) => setTimeout(r, 10000));
try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch {}
await new Promise((r) => setTimeout(r, 1000));

function walk(dir, prefix = '') {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) out = out.concat(walk(p, rel));
    else { const st = fs.statSync(p); out.push(`${rel} (${st.size}b)`); }
  }
  return out;
}
console.log('--- HOME files ---');
console.log(walk(HOME).join('\n'));
fs.rmSync(HOME, { recursive: true, force: true });
