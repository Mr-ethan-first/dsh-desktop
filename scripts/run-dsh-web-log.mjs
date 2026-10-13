import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = process.env.P || '5298';
const HOME = process.env.H || 'D:/_tmp_dshweb_log_home';
const BIN = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js';
const NODE = 'D:/DeepSeekAgent/resources/node24/node.exe';
fs.mkdirSync(HOME, { recursive: true });

const child = spawn(NODE, [BIN, 'web', '--port', PORT, '--no-open'], {
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
const w = (b) => { const s = b.toString(); log.push(s); process.stdout.write(s); };
child.stdout.on('data', w);
child.stderr.on('data', w);
child.on('exit', (c, s) => { console.log(`\n[exit] code=${c} signal=${s}`); fs.writeFileSync('D:/WorkSpace/deepseek-harness-master/_tmp_dshweb_boot.log', log.join('')); });

// 60s 后自动杀，避免挂死
setTimeout(() => { console.log('\n[timeout 60s] killing'); try { child.kill('SIGTERM'); } catch {}; fs.writeFileSync('D:/WorkSpace/deepseek-harness-master/_tmp_dshweb_boot.log', log.join('')); process.exit(0); }, 60000);
