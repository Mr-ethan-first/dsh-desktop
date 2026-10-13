import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';

const EXE = 'D:/DeepSeekAgent/DeepSeekAgent.exe';
const UD = 'D:/_tmp_e2e_ud';
const DBG = 'D:/WorkSpace/deepseek-harness-master/_tmp_exe_dbg.txt';
const KILL_FIRST = process.argv.includes('--kill');
const log = (...a) => { const s = a.join(' '); fs.appendFileSync(DBG, s + '\n'); console.log(s); };

fs.writeFileSync(DBG, '');
if (KILL_FIRST) {
  try { spawn('taskkill', ['/F', '/IM', 'DeepSeekAgent.exe'], { stdio: 'ignore' }); } catch {}
  log('killed existing, wait 2.5s');
  await new Promise(r => setTimeout(r, 2500));
}
try { fs.rmSync(UD, { recursive: true, force: true }); } catch {}
fs.mkdirSync(UD, { recursive: true });

const env = { ...process.env, DSH_USER_DATA_DIR: UD, DSH_REMOTE_DEBUGGING_PORT: '9333', DSH_HOME: 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home' };
const c = spawn(EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let alive = true;
c.stdout.on('data', d => fs.appendFileSync(DBG, '[out] ' + d));
c.stderr.on('data', d => fs.appendFileSync(DBG, '[err] ' + d));
c.on('exit', (code, sig) => { alive = false; log('EXE_EXIT code=' + code + ' sig=' + sig); });
c.on('error', e => log('SPAWN_ERROR ' + e.message));

for (const t of [1, 3, 6, 10]) {
  setTimeout(() => {
    log('alive@' + t + 's=' + alive);
    if (alive) {
      const s = net.connect(9333, '127.0.0.1');
      s.once('connect', () => { log('PORT9333 OPEN @' + t + 's'); s.destroy(); });
      s.once('error', () => s.destroy());
      // also check DevToolsActivePort
      try { const p = parseInt(fs.readFileSync(UD + '/DevToolsActivePort', 'utf8').split(/\r?\n/)[0]); if (p) log('DevToolsActivePort=' + p + ' @' + t + 's'); } catch {}
    }
  }, t * 1000);
}
setTimeout(() => { log('final alive=' + alive); if (alive) c.kill('SIGTERM'); process.exit(0); }, 13000);
