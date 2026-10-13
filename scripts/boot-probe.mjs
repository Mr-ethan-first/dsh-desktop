// Boot dsh web on a fresh port, capture ALL stdout/stderr, and report whether
// boot throws an activation error (assertEntriesActivated) vs. serves.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';

const require = createRequire('D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
const launcher = require('D:/DeepSeekAgent/resources/app.asar.unpacked/electron/plugin-host/dsh-web-launcher.cjs');

const PORT = 6123 + Math.floor(Math.random() * 50);
const DSH_HOME = 'D:/WorkSpace/deepseek-harness-master/_tmp_boot_dsh_home';
fs.rmSync(DSH_HOME, { recursive: true, force: true });
fs.mkdirSync(DSH_HOME, { recursive: true });
launcher.prepareDshHome({ extensionsDir: 'D:/DeepSeekAgent/resources/packages/extensions', dshHome: DSH_HOME, profileName: 'web' });

const cliDir = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh';
const launch = launcher.resolveDshLaunch({ cliDir, extraBins: [cliDir + '/lib/bin.js'] });
const env = { ...process.env, DSH_HOME };

const logFile = 'D:/WorkSpace/deepseek-harness-master/_tmp_boot.log';
fs.writeFileSync(logFile, `PORT=${PORT}\n`);
const child = spawn('D:/DeepSeekAgent/resources/node24/node.exe', [...launch.nodeArgs, launch.bin, 'web', '--port', String(PORT)], { env });
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
  const ok = await waitReady(20000);
  fs.appendFileSync(logFile, `\n[probe] web ready=${ok}\n`);
  child.kill('SIGKILL');
  console.log('done PORT=' + PORT + ' ready=' + ok + ' -> ' + logFile);
}, 25000);
