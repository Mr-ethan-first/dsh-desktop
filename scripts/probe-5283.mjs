// Spawn a FRESH dsh web on the now-free port 5283 and verify /api routes + mux work.
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';

const DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home';
const PORT = 5283;
const logFile = 'D:/WorkSpace/deepseek-harness-master/_tmp_probe5283.log';
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
function httpGet(path) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 5000 }, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ code: r.statusCode, body: b.slice(0, 120) }));
    });
    req.on('error', (e) => res({ err: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); res({ err: 'timeout' }); });
  });
}

setTimeout(async () => {
  const ok = await waitReady(25000);
  fs.appendFileSync(logFile, `\n[probe] web ready=${ok}\n`);
  if (ok) {
    fs.appendFileSync(logFile, `[probe] /api/directoryPicker/pick => ${JSON.stringify(await httpGet('/api/directoryPicker/pick'))}\n`);
    fs.appendFileSync(logFile, `[probe] /plugins/events => ${JSON.stringify(await httpGet('/plugins/events'))}\n`);
  }
  child.kill('SIGKILL');
  console.log('done -> ' + logFile);
}, 30000);
