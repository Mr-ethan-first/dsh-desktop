import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const exe = path.resolve('release/win-unpacked/DeepSeek 智能体客户端.exe');
const PORT = 5183;

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'], body: d }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

const env = { ...process.env, DSH_HEADLESS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ICUBE_ELECTRON_PATH;
const child = spawn(exe, [], { cwd: process.cwd(), env, detached: true, stdio: 'ignore', windowsHide: true });
child.on('exit', (c, s) => console.log('[child exit]', c, s));

async function waitReady() {
  for (let i = 0; i < 25; i++) {
    const h = await get(`http://127.0.0.1:${PORT}/healthz`);
    if (h && h.status === 200) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const ok = await waitReady();
console.log('[ready]', ok);
if (ok) {
  const html = await get(`http://127.0.0.1:${PORT}/`);
  const asset = (html?.body || '').match(/assets\/[^"']+\.js/)?.[0];
  const css = (html?.body || '').match(/assets\/[^"']+\.css/)?.[0];
  console.log('[html status]', html?.status, 'asset=', asset, 'css=', css);
  if (asset) {
    const a = await get(`http://127.0.0.1:${PORT}/${asset}`);
    console.log('[JS asset]', asset, '=>', a?.status, a?.ct, 'bodyLen=', a?.body?.length);
  }
  if (css) {
    const c = await get(`http://127.0.0.1:${PORT}/${css}`);
    console.log('[CSS asset]', css, '=>', c?.status, c?.ct, 'bodyLen=', c?.body?.length);
  }
}
child.kill('SIGKILL');
process.exit(0);
