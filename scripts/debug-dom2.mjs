// debug-dom2.mjs —— 加载工作台并 dump 关键 DOM 选择器（composer / 会话 / 工作区按钮）
// 结果同时写文件 _tmp_dbg_dom.log，避免 stdout 丢失。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const RES = 'D:/DeepSeekAgent/resources';
const NODE24 = path.join(RES, 'node24', 'node.exe');
const DSH_BIN = path.join(RES, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const LAUNCHER = path.join(RES, 'app.asar.unpacked', 'electron', 'plugin-host', 'dsh-web-launcher.cjs');
const EXT = path.join(RES, 'packages', 'extensions');
const DSH_PORT = Number(process.env.DSH_PORT || 5426);
const MOCK_PORT = Number(process.env.MOCK_PORT || 8013);
const HOME = path.join(os.tmpdir(), 'dsh-home-dbg2-' + Date.now());
const LOGF = 'D:/WorkSpace/deepseek-harness-master/_tmp_dbg_dom.log';
fs.writeFileSync(LOGF, '');
const say = (s) => { console.log(s); fs.appendFileSync(LOGF, s + '\n'); };

const server = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`);
  res.write('data: [DONE]\n\n'); res.end();
});
await new Promise((r) => server.listen(MOCK_PORT, () => say('mock on ' + MOCK_PORT)));

process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
process.env.DEEPSEEK_API_KEY = 'mock-key';
const launcher = require(LAUNCHER);
const pw = require('playwright');
fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
launcher.prepareDshHome({ extensionsDir: EXT, dshHome: HOME, profileName: 'web' });
const logs = [];
const child = launcher.spawnDshWeb({ bin: DSH_BIN, port: DSH_PORT, dshHome: HOME, extensionsDir: EXT, runtime: NODE24, onLog: (m) => { logs.push(m); if (logs.length < 40) say('  [dsh] ' + m); } });
say('child pid=' + (child && child.pid));

const TOKEN_RE = /(https?:\/\/[^\s"'<>]+?\?token=[A-Za-z0-9_.-]+)/;
let tokenUrl = null;
for (let i = 0; i < 225; i++) {
  const h = logs.map((l) => TOKEN_RE.exec(l)).find(Boolean);
  if (h) { tokenUrl = h[1]; break; }
  if (i % 10 === 0) say(`  waiting token... ${i * 0.4}s, logs=${logs.length}`);
  await new Promise((r) => setTimeout(r, 400));
}
if (!tokenUrl) { say('TOKEN=null (dsh web 未输出 token)'); say('  last logs:'); logs.slice(-15).forEach((l) => say('    ' + l)); try { server.close(); } catch {} process.exit(1); }
say('TOKEN=' + tokenUrl);

const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const consoleErrs = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });
page.on('pageerror', (e) => consoleErrs.push('PE:' + (e && e.message || e)));
await page.goto(tokenUrl, { waitUntil: 'load', timeout: 45000 });
await page.waitForTimeout(9000);
const info = await page.evaluate(() => {
  const editable = [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"], input')].map((e) => ({ tag: e.tagName, role: e.getAttribute('role'), ce: e.getAttribute('contenteditable'), ph: e.getAttribute('placeholder'), cls: (e.className || '').toString().slice(0, 80), id: e.id }));
  const texts = [...document.querySelectorAll('button, [role="button"], a')].map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 24);
  // 找包含“发送/生成/submit”的按钮
  const sendBtns = [...document.querySelectorAll('button, [role="button"]')].map((e) => (e.innerText || '').trim()).filter((t) => /发送|生成|send|submit|提交/i.test(t));
  return { title: document.title, bodyHead: document.body.innerText.slice(0, 400), editable, buttons: [...new Set(texts)].slice(0, 50), sendBtns: [...new Set(sendBtns)] };
});
say('TITLE: ' + info.title);
say('BODY: ' + JSON.stringify(info.bodyHead));
say('EDITABLE: ' + JSON.stringify(info.editable, null, 1));
say('BUTTONS: ' + JSON.stringify(info.buttons));
say('SEND_BTNS: ' + JSON.stringify(info.sendBtns));
say('CONSOLE_ERRS: ' + JSON.stringify(consoleErrs.slice(0, 15)));
await page.screenshot({ path: 'D:/WorkSpace/deepseek-harness-master/_tmp_dbg_dom.png' });
await browser.close();
try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch {}
try { server.close(); } catch {}
say('DONE');
process.exit(0);
