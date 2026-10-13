// e2e-agent.mjs —— 离线全自动化 E2E（Playwright）
// 流程：启动 mock OpenAI 兼容 SSE LLM 服务 -> 用自带 node24 拉起 dsh web（默认 DeepSeek adapter 指向 mock）
//       -> 真实 Chromium 走 token 鉴权 -> 新建会话 -> 发消息 -> 断言助手回复含代码块（智能编码渲染）
//       -> 全程断言无 console error / pageerror。无需外网 LLM，完全离线。
// 注意：require 必须放在顶层（任何 await 之前），否则本沙箱顶层 await 后 require 会死锁。
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
const launcher = require(LAUNCHER);
const pw = require('playwright');

const MOCK_PORT = Number(process.env.MOCK_PORT || 8011);
const DSH_PORT = Number(process.env.DSH_PORT || 5423);
const HOME = path.join(os.tmpdir(), 'dsh-home-e2e-' + Date.now());
const OUT = 'D:/WorkSpace/deepseek-harness-master/_tmp_e2e';
const LOG = OUT + '.log';
const SHOT = OUT + '.png';
const DBG = OUT + '_dom.json';

fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, '');
const say = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const fail = (msg) => { say('FAIL: ' + msg); };

// ---- mock LLM (OpenAI 兼容 SSE) —— 回复含代码块以验证智能编码渲染 ----
const MOCK_REPLY = [
  '好的，我帮你写一个示例。\n\n',
  '```python\n',
  "def greet(name: str) -> str:\n",
  "    return f'hello, {name}'\n\n",
  "print(greet('world'))\n",
  '```\n\n',
  '这段代码已生成，可直接保存为 hello.py 运行。',
].join('');

function startMock() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
      return;
    }
    if (req.method === 'GET') { res.writeHead(200); res.end('ok'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const chunks = MOCK_REPLY.match(/[\s\S]{1,16}/g) || [MOCK_REPLY];
    let i = 0;
    const timer = setInterval(() => {
      if (i < chunks.length) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`); }
      else { res.write('data: [DONE]\n\n'); clearInterval(timer); res.end(); }
    }, 15);
    req.on('close', () => clearInterval(timer));
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, () => { say(`mock LLM on :${MOCK_PORT}`); resolve(server); }));
}

function killTree(pid) { if (pid) try { spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch {} }

(async () => {
  say('=== E2E start ' + new Date().toISOString() + ' ===');
  const mock = await startMock();
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
  process.env.DEEPSEEK_API_KEY = 'mock-key';

  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  launcher.prepareDshHome({ extensionsDir: EXT, dshHome: HOME, profileName: 'web' });

  const logs = [];
  const child = launcher.spawnDshWeb({
    bin: DSH_BIN, port: DSH_PORT, dshHome: HOME, extensionsDir: EXT, runtime: NODE24,
    onLog: (m) => { logs.push(m); if (logs.length < 60) say('[dsh] ' + m); },
  });
  if (!child) { fail('spawnDshWeb 返回 null'); mock.close(); process.exit(1); }

  const TOKEN_RE = /(https?:\/\/[^\s"'<>]+?\?token=[A-Za-z0-9_.-]+)/;
  let tokenUrl = null;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const hit = logs.map((l) => TOKEN_RE.exec(l)).find(Boolean);
    if (hit) { tokenUrl = hit[1]; break; }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!tokenUrl) { fail('90s 内未获得 token'); logs.slice(-20).forEach((l) => say('  ' + l)); killTree(child.pid); mock.close(); process.exit(1); }
  say('TOKEN_URL=' + tokenUrl);

  const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrs = [], pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));

  let phase = 'goto';
  try {
    await page.goto(tokenUrl, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(9000); // 工作台冷启动
    phase = 'dump-dom';
    // 始终 dump DOM 以便确认选择器（contenteditable / 按钮）
    const dom = await page.evaluate(() => {
      const editable = [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"], input')]
        .map((e) => ({ tag: e.tagName, role: e.getAttribute('role'), ce: e.getAttribute('contenteditable'), ph: e.getAttribute('placeholder'), cls: (e.className || '').toString().slice(0, 90), id: e.id }));
      const buttons = [...new Set([...document.querySelectorAll('button, [role="button"], a')].map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 24))];
      const sendBtns = [...new Set([...document.querySelectorAll('button, [role="button"]')].map((e) => (e.innerText || '').trim()).filter((t) => /发送|生成|send|submit|提交|➤/i.test(t)))];
      return { title: document.title, editable, buttons, sendBtns, bodyHead: document.body.innerText.slice(0, 200) };
    });
    fs.writeFileSync(DBG, JSON.stringify(dom, null, 1));
    say('DOM title=' + dom.title + ' editable=' + dom.editable.length + ' sendBtns=' + JSON.stringify(dom.sendBtns));
    say('DOM editable: ' + JSON.stringify(dom.editable));
    say('DOM buttons: ' + JSON.stringify(dom.buttons.slice(0, 30)));

    phase = 'create-session';
    const newBtn = page.getByText('新会话', { exact: false });
    if (await newBtn.count()) { await newBtn.first().click(); await page.waitForTimeout(2000); }

    phase = 'type-message';
    // 健壮解析 composer：优先 contenteditable（Lexical 编辑器），其次 textarea / role=textbox / input
    const composer = await page.evaluateHandle(() => {
      const cands = [
        () => document.querySelector('[contenteditable="true"]'),
        () => document.querySelector('textarea'),
        () => document.querySelector('[role="textbox"]'),
        () => document.querySelector('input[type="text"]'),
      ];
      for (const f of cands) { const el = f(); if (el && el.offsetParent !== null) return el; }
      return cands.map((f) => f()).find(Boolean) || null;
    });
    if (!composer.asElement()) throw new Error('未找到 composer 输入框（见 ' + DBG + '）');
    const composerEl = composer.asElement();
    const tag = await composerEl.evaluate((e) => e.tagName);
    await composerEl.click();
    await page.waitForTimeout(300);
    const MSG = '请用 Python 写一个问候函数';
    if (tag === 'TEXTAREA') { await composerEl.fill(MSG); }
    else { await page.keyboard.insertText(MSG); }
    say('已输入消息到 composer(tag=' + tag + ')');

    phase = 'send';
    // 发送：优先点发送按钮，否则回车
    let sent = false;
    if (dom.sendBtns.length) {
      for (const label of dom.sendBtns) {
        const b = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
        if (await b.count()) { await b.click(); sent = true; say('点击发送按钮: ' + label); break; }
      }
    }
    if (!sent) { await page.keyboard.press('Enter'); say('按 Enter 发送'); }

    phase = 'wait-response';
    await page.waitForTimeout(8000);
    const bodyText = (await page.evaluate(() => document.body.innerText)).trim();
    const hasCode = await page.evaluate(() => !!document.querySelector('pre code, pre, code'));
    phase = 'assert';
    say('--- 助手回复片段 ---');
    say(bodyText.slice(0, 600));
    say(`hasCodeBlock=${hasCode}`);
    say(`consoleErrors=${consoleErrs.length} pageErrors=${pageErrors.length}`);
    await page.screenshot({ path: SHOT, fullPage: false });

    const ok = hasCode && consoleErrs.length === 0 && pageErrors.length === 0 && bodyText.length > 20;
    if (!ok) {
      fail(`断言未通过: hasCode=${hasCode} console=${consoleErrs.length} pageErr=${pageErrors.length} bodyLen=${bodyText.length}`);
      consoleErrs.slice(0, 10).forEach((l) => say('  CE: ' + l));
      pageErrors.slice(0, 10).forEach((l) => say('  PE: ' + l));
      await browser.close(); killTree(child.pid); mock.close(); process.exit(2);
    }
    say('PASS: 智能体 E2E 通过（工作台加载 + 会话 + 智能编码代码块渲染 + 无报错）');
    await browser.close(); killTree(child.pid); mock.close(); process.exit(0);
  } catch (e) {
    fail(`异常(${phase}): ` + (e && e.message || e));
    try { await page.screenshot({ path: SHOT, fullPage: false }); } catch {}
    // 异常时也 dump DOM
    try {
      const dom2 = await page.evaluate(() => ({
        title: document.title,
        editable: [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"], input')].map((e) => ({ tag: e.tagName, role: e.getAttribute('role'), ce: e.getAttribute('contenteditable'), ph: e.getAttribute('placeholder'), cls: (e.className || '').toString().slice(0, 90), id: e.id })),
        sendBtns: [...new Set([...document.querySelectorAll('button, [role="button"]')].map((e) => (e.innerText || '').trim()).filter((t) => /发送|生成|send|submit|提交|➤/i.test(t)))],
      }));
      fs.writeFileSync(DBG, JSON.stringify(dom2, null, 1));
    } catch {}
    consoleErrs.slice(0, 10).forEach((l) => say('  CE: ' + l));
    pageErrors.slice(0, 10).forEach((l) => say('  PE: ' + l));
    await browser.close(); killTree(child.pid); mock.close(); process.exit(2);
  }
})().catch((e) => { say('FATAL ' + (e && e.stack || e)); process.exit(9); });
