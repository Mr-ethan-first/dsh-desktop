// diag-http.mjs —— 纯 HTTP 层白屏复现：用「完整浏览器请求头」走 token 鉴权链路，
// 打印每一步的 status / location / set-cookie / 响应体，精确定位 400 来源。
// 与浏览器解耦，便于快速迭代定位，也便于对照「Node http.get 无头」为何不触发。
import http from 'node:http';
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
const HOME = path.join(os.tmpdir(), 'dsh-home-http-' + Date.now());
const PORT = Number(process.env.DIAG_PORT || 5411);
const TOKEN_RE = /(https?:\/\/[^\s"'<>]+?\?token=[A-Za-z0-9_.-]+)/;
const LOG = 'D:/WorkSpace/deepseek-harness-master/_tmp_http_diag.log';
// 可选：给 dsh web 追加启动参数（如 --verbose）
const EXTRA_ARGS = (process.env.DSH_EXTRA_ARGS || '').split(' ').filter(Boolean);

fs.writeFileSync(LOG, '');
const say = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const launcher = require(LAUNCHER);
function killTree(pid) { if (pid) try { spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch {} }

/** 发一个手动控制重定向的 GET，返回 {status, headers, body} */
function rawGet(url, headers) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      method: 'GET', headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', (e) => resolve({ status: -1, headers: {}, body: '', err: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: -2, headers: {}, body: '', err: 'timeout' }); });
    req.end();
  });
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Chromium";v="131"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
};

(async () => {
  say('=== HTTP 层白屏复现 ' + new Date().toISOString() + ' ===');
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  launcher.prepareDshHome({ extensionsDir: EXT, dshHome: HOME, profileName: 'web' });

  const logs = [];
  const child = launcher.spawnDshWeb({
    bin: DSH_BIN, port: PORT, dshHome: HOME, extensionsDir: EXT, runtime: NODE24,
    onLog: (m) => { logs.push(m); say('[dsh] ' + m); },
  });
  if (!child) { say('FAIL spawn'); process.exit(1); }

  const deadline = Date.now() + 90000;
  let tokenUrl = null;
  while (Date.now() < deadline) {
    const hit = logs.map((l) => TOKEN_RE.exec(l)).find(Boolean);
    if (hit) { tokenUrl = hit[1]; break; }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!tokenUrl) { say('FAIL no token'); killTree(child.pid); process.exit(1); }

  // 给服务端额外时间完成路由注册（模拟真实冷启动后的首次访问）
  await new Promise((r) => setTimeout(r, 5000));
  say('--- STEP1: 裸请求 / （不带 cookie，应 401） ---');
  let r1 = await rawGet(`http://127.0.0.1:${PORT}/`, BROWSER_HEADERS);
  say(`status=${r1.status} body=${JSON.stringify(r1.body.slice(0, 200))}`);

  say('--- STEP2: 浏览器头 请求 token URL（不跟随重定向） ---');
  const r2 = await rawGet(tokenUrl, BROWSER_HEADERS);
  say(`status=${r2.status}`);
  say(`location=${r2.headers.location}`);
  say(`set-cookie=${JSON.stringify(r2.headers['set-cookie'])}`);
  say(`body=${JSON.stringify(r2.body.slice(0, 300))}`);

  const cookie = (r2.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  say(`cookie jar = ${cookie}`);

  say('--- STEP3: 带 cookie 请求 / ---');
  const r3 = await rawGet(`http://127.0.0.1:${PORT}/`, { ...BROWSER_HEADERS, Cookie: cookie });
  say(`status=${r3.status}`);
  say(`content-type=${r3.headers['content-type']}`);
  say(`body(前 1500 字符)=`);
  say(r3.body.slice(0, 1500));

  say('--- STEP4: 无 Accept-Encoding 对比（验证压缩协商是否仍影响） ---');
  const noAe = { ...BROWSER_HEADERS, Cookie: cookie };
  delete noAe['Accept-Encoding'];
  const r4 = await rawGet(`http://127.0.0.1:${PORT}/`, noAe);
  say(`status=${r4.status} len=${r4.body.length}`);

  say('--- STEP5: 只带 Accept-Encoding: gzip（最简触发） ---');
  const r5 = await rawGet(`http://127.0.0.1:${PORT}/`, { Cookie: cookie, 'Accept-Encoding': 'gzip' });
  say(`status=${r5.status} len=${r5.body.length}`);

  say('');
  say('=== dsh 子进程日志全文 ===');
  logs.forEach((l) => say('  ' + l));

  killTree(child.pid);
  process.exit(0);
})().catch((e) => { say('FATAL ' + (e && e.stack || e)); process.exit(9); });
