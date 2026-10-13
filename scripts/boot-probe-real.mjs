// Run the REAL dsh web binary against the REAL persistent dsh-home. Capture all
// output and check whether it binds the port (i.e. whether boot settles).
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';

const DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home';
const PORT = 6455 + Math.floor(Math.random() * 20);
const logFile = 'D:/WorkSpace/deepseek-harness-master/_tmp_bootreal.log';
fs.writeFileSync(logFile, `PORT=${PORT}\n`);

const child = spawn('D:/DeepSeekAgent/resources/node24/node.exe',
  ['D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web', '--port', String(PORT)],
  { env: { ...process.env, DSH_HOME } });
child.stdout.on('data', (d) => fs.appendFileSync(logFile, '[out] ' + d.toString()));
child.stderr.on('data', (d) => fs.appendFileSync(logFile, '[err] ' + d.toString()));
child.on('exit', (c) => fs.appendFileSync(logFile, `\n[exit] code=${c}\n`));

function waitReady(ms) {
  return new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const s = net.connect(PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => { s.destroy(); Date.now() - t0 > ms ? res(false) : setTimeout(tick, 500); });
    };
    tick();
  });
}

setTimeout(async () => {
  const ok = await waitReady(30000);
  fs.appendFileSync(logFile, `\n[probe] web ready=${ok}\n`);
  // If ready, probe /api/directoryPicker/pick and remote.mux
  if (ok) {
    await new Promise((res) => {
      const http = await import('node:http');
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/directoryPicker/pick', timeout: 5000 }, (r) => {
        fs.appendFileSync(logFile, `[probe] directoryPicker HTTP status=${r.statusCode}\n`); r.resume(); res();
      });
      req.on('error', (e) => { fs.appendFileSync(logFile, `[probe] directoryPicker err=${e.code}\n`); res(); });
      req.on('timeout', () => { fs.appendFileSync(logFile, `[probe] directoryPicker timeout\n`); req.destroy(); res(); });
    });
  }
  child.kill('SIGKILL');
  console.log('done PORT=' + PORT + ' ready=' + ok + ' -> ' + logFile);
}, 35000);
