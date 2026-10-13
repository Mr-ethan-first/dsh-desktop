// One-shot runtime verification: launch the installed DeepSeekAgent.exe (as node) to boot
// the dsh-web backend, capture the startup token, then call /api/llm.providers and
// /api/llm.models to prove the live model picker shows only deepseek-harness defaults.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dshHome = 'C:/temp/rt_verify_home';
const dshRuntime = 'D:/DeepSeekAgent/resources/dsh-runtime';
const exe = 'D:/DeepSeekAgent/DeepSeekAgent.exe';
const port = 5291;

rmSync(dshHome, { recursive: true, force: true });
mkdirSync(join(dshHome, 'profiles', 'web', 'node_modules'), { recursive: true });
writeFileSync(join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true, dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } }
}, null, 2) + '\n');

const logPath = 'C:/temp/rt_verify.log';
const out = (await import('node:fs')).createWriteStream(logPath);

const env = { ...process.env, DSH_HOME: dshHome, NODE_PATH: join(dshRuntime, 'node_modules') };
delete env.NODE_OPTIONS;

const child = spawn(exe, [
  '--expose-internals',
  join(dshRuntime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
  'web', '--port', String(port)
], { env, cwd: 'D:/DeepSeekAgent' });

child.stdout.pipe(out);
child.stderr.pipe(out);

function cleanup(code) {
  try { child.kill('SIGKILL'); } catch {}
  try { rmSync(dshHome, { recursive: true, force: true }); } catch {}
  try { rmSync(logPath, { force: true }); } catch {}
  process.exit(code);
}

const timeout = setTimeout(() => {
  console.error('TIMEOUT: dsh web did not print token within 60s');
  cleanup(2);
}, 60000);

async function waitForToken() {
  for (let i = 0; i < 120; i++) {
    if (existsSync(logPath)) {
      const log = readFileSync(logPath, 'utf8');
      const m = log.match(/(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\]]+)/);
      if (m) return m[1];
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('token not found');
}

try {
  const tokenUrl = await waitForToken();
  clearTimeout(timeout);
  console.log('tokenUrl:', tokenUrl);
  const token = tokenUrl.split('token=')[1];
  const base = `http://127.0.0.1:${port}`;

  // Step 1: exchange token for auth cookie
  const login = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
  const setCookie = login.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  console.log('auth cookie obtained:', cookie ? 'yes' : 'no');

  // Step 2: call llm.providers
  const envelope = (method) => JSON.stringify({ type: 'client-request', rpcId: 'probe-1', method, payload: {} });
  const headers = { 'content-type': 'application/json', cookie };
  const provResp = await fetch(`${base}/api/llm.providers`, { method: 'POST', headers, body: envelope('llm.providers') });
  const provText = await provResp.text();
  console.log('--- /api/llm.providers status', provResp.status, '---');
  console.log(provText.slice(0, 1500));

  const modelsResp = await fetch(`${base}/api/llm.models`, { method: 'POST', headers, body: envelope('llm.models') });
  const modelsText = await modelsResp.text();
  console.log('--- /api/llm.models status', modelsResp.status, '---');
  console.log(modelsText.slice(0, 1500));

  cleanup(0);
} catch (e) {
  console.error('ERROR:', e.message);
  cleanup(1);
}
