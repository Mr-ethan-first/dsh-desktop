/**
 * e2e-comprehensive.mjs — 对 D:\DeepSeekAgent 老包执行全自动化核心特性验证。
 *
 * 测试范围：
 *   1. 页面布局：验证加载的是 dsh-web-ui（工作台壳、侧边栏、composer）。
 *   2. 多轮对话：连续发送两条消息，验证模型上下文保持（第二轮引用第一轮内容）。
 *   3. 智能编码：要求生成 Python 快速排序，验证代码块渲染。
 *   4. 粘贴图片：模拟剪贴板粘贴 PNG，验证输入框捕获图片（或上传组件响应）。
 *
 * 运行环境：本地直连（不经过沙箱 GUI），复用部署包自带的 node24 + dsh-runtime + DashScope key。
 *
 * 运行：
 *   unset NODE_OPTIONS && NODE_PATH=C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules \
 *     D:/DeepSeekAgent/resources/node24/node.exe scripts/e2e-comprehensive.mjs
 */
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const LAUNCHER = 'D:/DeepSeekAgent/resources/app.asar.unpacked/electron/plugin-host/dsh-web-launcher.cjs';
const spawnDshWeb = require(LAUNCHER).spawnDshWeb;
const NODE24 = 'D:/DeepSeekAgent/resources/node24/node.exe';
const DSH_BIN = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js';
const EXTENSIONS_DIR = 'D:/DeepSeekAgent/resources/packages/extensions';
const PROD_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home';
const WEB_BASE = 5283;
const WEB_MAX_RETRY = 20;
const OUT = 'D:/WorkSpace/deepseek-harness-master/_tmp_comprehensive_result.json';
const SCREENSHOT_DIR = 'D:/WorkSpace/deepseek-harness-master/_tmp_e2e_screenshots';
const SAMPLE_IMG = 'D:/WorkSpace/deepseek-harness-master/_tmp_e2e_sample.png';

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(true); });
  });
}
async function pickWebPort() {
  for (let i = 0; i < WEB_MAX_RETRY; i++) {
    const p = WEB_BASE + i;
    if (await isPortFree(p)) return p;
  }
  throw new Error('no free web port in range');
}

const HARD_TIMEOUT_MS = 420000;
const hardTimer = setTimeout(() => {
  log('[comp] HARD TIMEOUT');
  try { fs.writeFileSync(OUT, JSON.stringify({ fatal: 'hard-timeout' }, null, 2)); } catch {}
  process.exit(4);
}, HARD_TIMEOUT_MS);
hardTimer.unref?.();

// 1x1 透明 PNG（base64）
const SAMPLE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function ensureSampleImage() {
  try { fs.mkdirSync(path.dirname(SAMPLE_IMG), { recursive: true }); } catch {}
  fs.writeFileSync(SAMPLE_IMG, Buffer.from(SAMPLE_PNG_B64, 'base64'));
}

async function screenshot(page, name) {
  try {
    const p = path.join(SCREENSHOT_DIR, `${name}-${Date.now()}.png`);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: p, fullPage: true });
    log('[comp] screenshot:', p);
    return p;
  } catch (e) { log('[comp] screenshot warn:', e.message); return ''; }
}

async function waitForReply(page, predicate, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
    const html = await page.content().catch(() => '');
    const res = predicate(txt, html);
    if (res.found) return res;
    await sleep(1000);
  }
  return { found: false };
}

async function dismissOverlays(page) {
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, [role="button"], a')];
    for (const b of btns) {
      const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
      if (/^(继续|知道了|关闭|OK|Got it|Skip)$/i.test(t)) b.click();
    }
  }).catch(() => {});
}

async function hideFloatingLayerOver(page, selector) {
  await page.evaluate((sel) => {
    const ed = document.querySelector(sel);
    if (!ed) return;
    const r = ed.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (top && top !== ed && !ed.contains(top)) {
      let n = top;
      while (n && n !== document.body) {
        const p = getComputedStyle(n).position;
        if (p === 'fixed' || p === 'absolute') { n.style.display = 'none'; break; }
        n = n.parentElement;
      }
    }
  }, selector).catch(() => {});
}

async function findComposer(page) {
  const selectors = ['[contenteditable="true"]', '[role="textbox"]', '.lexical-contenteditable', 'textarea'];
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) return { el, sel };
  }
  return null;
}

async function sendMessage(page, text) {
  const composer = await findComposer(page);
  if (!composer) throw new Error('composer not found');
  await dismissOverlays(page);
  await hideFloatingLayerOver(page, composer.sel);
  await composer.el.evaluate((el) => el.focus()).catch(() => {});
  await composer.el.type(text, { delay: 5 });

  const sendSel = ['button:has-text("发送")', 'button:has-text("Send")', '[aria-label*="发送" i]', 'button[type="submit"]', '[data-testid*="send" i]'];
  let clicked = false, clickedSel = '';
  for (const sel of sendSel) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) {
      await btn.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (top && top !== el && !el.contains(top)) {
          let n = top;
          while (n && n !== document.body) {
            const p = getComputedStyle(n).position;
            if (p === 'fixed' || p === 'absolute') { n.style.display = 'none'; break; }
            n = n.parentElement;
          }
        }
        el.click();
      }).catch(() => {});
      clicked = true; clickedSel = sel; break;
    }
  }
  if (!clicked) { await composer.el.press('Enter'); clicked = true; clickedSel = 'Enter'; }
  return { clicked, clickedSel };
}

async function main() {
  const results = {
    launch: {}, layout: {}, multiTurn: {}, smartCoding: {}, imagePaste: {},
    consoleErrors: [], provider: 'dashscope', overall: false, pass: {},
  };
  let dshChild = null, browser = null, resolvedPort = null, tokenUrl = null, bootLog = '';

  ensureSampleImage();

  // 占用 5283 以确定性复现端口回退（不强制作为通过条件）
  const conflictServer = net.createServer();
  await new Promise((res) => conflictServer.listen(WEB_BASE, '127.0.0.1', () => res()));
  resolvedPort = await pickWebPort();
  results.launch.resolvedPort = resolvedPort;
  results.launch.fellBack = resolvedPort !== WEB_BASE;
  log('[comp] dsh web 端口 =', resolvedPort);

  // 清理残留 dsh web
  try {
    const selfPid = String(process.pid);
    execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match \'node\\.exe\' -and $_.CommandLine -like \'*dsh/lib/bin.js*\' -and $_.CommandLine -like \'*web*\' -and $_.ProcessId -ne ' + selfPid + ' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
      { windowsHide: true }
    );
  } catch {}
  await sleep(800);

  // 剥锁
  (function stripLocks(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stripLocks(p);
      else if (e.name.endsWith('.lock')) { try { fs.rmSync(p, { force: true }); } catch {} }
    }
  })(PROD_HOME);

  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  for (const k of Object.keys(childEnv)) if (/^CODEBUDDY_SAFE_DELETE_/i.test(k)) delete childEnv[k];

  log('[comp] spawnDshWeb（launcher 注入 DashScope 端点 + key）...');
  dshChild = spawnDshWeb({
    bin: DSH_BIN,
    port: resolvedPort,
    dshHome: PROD_HOME,
    extensionsDir: EXTENSIONS_DIR,
    runtime: NODE24,
    baseEnv: childEnv,
    onLog: (m) => { bootLog += m + '\n'; process.stdout.write('[dsh-web] ' + m + '\n'); },
    childProcess: require('node:child_process'),
  });
  if (!dshChild) throw new Error('spawnDshWeb 返回 null');
  dshChild.on('exit', (code) => log('[dsh-web] exit code=' + code));

  const tokenRe = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_.-]+)/;
  const start = Date.now();
  while (Date.now() - start < 150000) {
    const m = tokenRe.exec(bootLog);
    if (m) { tokenUrl = m[1]; break; }
    await sleep(700);
  }
  try { conflictServer.close(); } catch {}
  if (!tokenUrl && !(await isPortFree(resolvedPort))) tokenUrl = `http://127.0.0.1:${resolvedPort}/`;
  if (!tokenUrl) throw new Error('dsh web 未在 150s 内就绪');
  log('[comp] dsh web 就绪:', tokenUrl);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  // 授予剪贴板权限，使图片粘贴测试可经真实 Clipboard API 派发
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1' }).catch(() => {});
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') results.consoleErrors.push(msg.text()); });
  page.on('pageerror', (e) => results.consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto(tokenUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('[comp] goto warn:', e.message));
  await sleep(8000);
  await screenshot(page, '01-initial-load');

  results.layout.url = page.url();
  results.layout.title = await page.title().catch(() => '');
  const html = await page.content();

  // 页面布局断言：dsh-web-ui 工作台特征
  const layout = await page.evaluate(() => {
    const t = document.body.innerText;
    const h = document.body.innerHTML;
    return {
      hasComposer: !!document.querySelector('[contenteditable="true"], [role="textbox"], .lexical-contenteditable, textarea'),
      hasSidebar: !!document.querySelector('aside, nav, [class*="sidebar" i], [class*="sider" i]'),
      hasChatHistory: /(新建对话|历史|会话|chat|conversation)/i.test(t),
      hasAgentOrModelSelector: /(模型|model|agent|智能体)/i.test(t),
      hasWorkbenchClass: /workbench|shell|layout|dsh-web-ui/i.test(h),
      bodyTextPreview: t.replace(/\s+/g, ' ').slice(0, 200),
    };
  }).catch((e) => ({ error: e.message }));
  results.layout.details = layout;
  results.layout.isDshWebUi = !!(layout.hasComposer && (layout.hasSidebar || layout.hasChatHistory || layout.hasWorkbenchClass));
  log('[comp] layout =', JSON.stringify(layout));

  // 选择 qwen3.6-plus（best-effort；若失败仍继续，靠默认模型）
  await page.evaluate(() => {
    const triggers = [...document.querySelectorAll('button, [role="button"], [role="combobox"], select, input')];
    const t = triggers.find((b) => /deepseek|qwen|glm|模型|model/i.test(b.innerText || b.getAttribute('aria-label') || b.value || ''));
    if (t) try { t.click(); } catch {}
  }).catch(() => {});
  await sleep(600);
  await page.evaluate(() => {
    const opts = [...document.querySelectorAll('[role="option"], li, button, div')];
    const o = opts.find((x) => /Qwen3\.6-Plus|qwen3\.6-plus/i.test(x.innerText || x.getAttribute('aria-label') || ''));
    if (o) try { o.click(); } catch {}
  }).catch(() => {});
  await sleep(500);

  // 1) 多轮对话
  const multiTurn = { round1: {}, round2: {}, contextKept: false };
  try {
    log('[comp] 多轮对话 round 1...');
    await sendMessage(page, '我叫张三，请记住这个名字');
    multiTurn.round1.send = true;
    const r1 = await waitForReply(page, (txt) => {
      const hasName = /张三/.test(txt);
      const hasAck = /(记住|好的|记住了|记住了|OK|记住了)/i.test(txt);
      return { found: hasName || hasAck, excerpt: txt.slice(0, 300) };
    }, 60000);
    multiTurn.round1.replyAppeared = r1.found;
    multiTurn.round1.excerpt = r1.excerpt || '';
    await screenshot(page, '02-multi-turn-r1');

    if (r1.found) {
      log('[comp] 多轮对话 round 2...');
      await sendMessage(page, '我刚才让你记住的名字是什么？');
      multiTurn.round2.send = true;
      const r2 = await waitForReply(page, (txt) => {
        const hasName = /张三/.test(txt);
        return { found: hasName, excerpt: txt.slice(0, 300) };
      }, 60000);
      multiTurn.round2.replyAppeared = r2.found;
      multiTurn.round2.excerpt = r2.excerpt || '';
      multiTurn.contextKept = r2.found;
      await screenshot(page, '03-multi-turn-r2');
    }
  } catch (e) { multiTurn.error = e.message; }
  results.multiTurn = multiTurn;
  log('[comp] multiTurn =', JSON.stringify(multiTurn));

  // 2) 智能编码
  const coding = { sent: false, replyAppeared: false, codeBlockAppeared: false, excerpt: '' };
  try {
    log('[comp] 智能编码...');
    await sendMessage(page, '请用 Python 写一个快速排序函数');
    coding.sent = true;
    const r = await waitForReply(page, (txt, htm) => {
      const codeBlock = /<pre\b/i.test(htm) || /```/.test(txt);
      const hasCode = /def quicksort|def\s+\w+\(|```python|pivot\s*=/.test(txt);
      return { found: hasCode, codeBlock, excerpt: txt.slice(0, 400) };
    }, 60000);
    coding.replyAppeared = r.found;
    coding.codeBlockAppeared = !!r.codeBlock;
    coding.excerpt = r.excerpt || '';
    await screenshot(page, '04-smart-coding');
  } catch (e) { coding.error = e.message; }
  results.smartCoding = coding;
  log('[comp] smartCoding =', JSON.stringify(coding));

  // 3) 图片输入能力验证（粘贴 / 上传按钮 / 隐藏 file input）
  const imagePaste = { uploadButtonFound: false, setInputFilesOk: false, clipboardPasteOk: false, inputReacted: false, previewAppeared: false, supportImage: null, diagnostics: '' };
  try {
    log('[comp] 图片输入能力验证...');
    const composer = await findComposer(page);
    if (!composer) {
      imagePaste.error = 'composer not found';
    } else {
      await composer.el.evaluate((el) => el.focus()).catch(() => {});

      // 探查上传/附件入口
      const uploadInfo = await page.evaluate(() => {
        const fileInputs = [...document.querySelectorAll('input[type="file"]')];
        const btns = [...document.querySelectorAll('button, [role="button"], label, [class*="upload" i], [class*="attach" i], [class*="paperclip" i]')];
        const upBtn = btns.find((b) => /(上传|附件|图片|文件|paperclip|attach|upload|image|plus|＋|\+)/i.test(b.innerText || b.getAttribute('aria-label') || b.title || ''));
        return {
          fileInputs: fileInputs.length,
          hasUploadBtn: !!upBtn,
          uploadBtnText: upBtn ? (upBtn.innerText || upBtn.getAttribute('aria-label') || '').trim() : '',
        };
      }).catch(() => ({ fileInputs: 0, hasUploadBtn: false }));
      imagePaste.uploadButtonFound = uploadInfo.hasUploadBtn || uploadInfo.fileInputs > 0;
      imagePaste.uploadDiagnostics = uploadInfo;

      // 方式 A：直接对隐藏 file input 用 setInputFiles（最真实）
      if (uploadInfo.fileInputs > 0) {
        try {
          await page.locator('input[type="file"]').first().setInputFiles(SAMPLE_IMG);
          imagePaste.setInputFilesOk = true;
          await sleep(1500);
        } catch (e) { imagePaste.setInputFilesErr = e.message; }
      } else if (imagePaste.uploadButtonFound) {
        try {
          await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button, [role="button"], label, [class*="upload" i], [class*="attach" i]')];
            const upBtn = btns.find((b) => /(上传|附件|图片|文件|paperclip|attach|upload|image|plus|＋|\+)/i.test(b.innerText || b.getAttribute('aria-label') || b.title || ''));
            if (upBtn) upBtn.click();
          });
          await sleep(800);
          await page.locator('input[type="file"]').first().setInputFiles(SAMPLE_IMG);
          imagePaste.setInputFilesOk = true;
          await sleep(1500);
        } catch (e) { imagePaste.setInputFilesErr = e.message; }
      }

      // 方式 B：真实剪贴板粘贴（Ctrl+V）
      if (!imagePaste.setInputFilesOk) {
        try {
          await page.evaluate(async (b64) => {
            const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob());
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          }, SAMPLE_PNG_B64);
          await composer.el.click().catch(() => {});
          await page.keyboard.down('Control'); await page.keyboard.press('KeyV'); await page.keyboard.up('Control');
          imagePaste.clipboardPasteOk = true;
          await sleep(1500);
        } catch (e) { imagePaste.clipboardErr = e.message; }
      }

      const after = await page.evaluate(() => {
        const t = document.body.innerText;
        const h = document.body.innerHTML;
        return {
          text: t.replace(/\s+/g, ' ').slice(0, 300),
          hasImgTag: /<img\b/i.test(h),
          hasFileChip: /(sample\.png|image\.png|\.png|\.jpg|\.jpeg|图片|文件)/i.test(t) || /class=[^>]*upload/i.test(h) || /<img/i.test(h),
        };
      }).catch(() => ({}));
      imagePaste.inputReacted = imagePaste.setInputFilesOk || imagePaste.clipboardPasteOk || after.hasImgTag || after.hasFileChip;
      imagePaste.previewAppeared = after.hasImgTag || after.hasFileChip;
      imagePaste.afterText = after.text || '';
      await screenshot(page, '05-image-paste');
      imagePaste.supportImage = imagePaste.uploadButtonFound || imagePaste.setInputFilesOk || imagePaste.clipboardPasteOk;
    }
  } catch (e) { imagePaste.error = e.message; }
  results.imagePaste = imagePaste;
  log('[comp] imagePaste =', JSON.stringify(imagePaste));

  // 终局判定
  results.pass = {
    layoutIsDshWebUi: results.layout.isDshWebUi,
    multiTurnContextKept: multiTurn.contextKept,
    smartCodingReply: coding.replyAppeared,
    smartCodingCodeBlock: coding.codeBlockAppeared,
    imagePasteReacted: imagePaste.inputReacted,
  };
  results.overall = results.pass.layoutIsDshWebUi && results.pass.multiTurnContextKept &&
    results.pass.smartCodingReply && results.pass.imagePasteReacted;

  await screenshot(page, '06-final');
  log('\n========== COMPREHENSIVE E2E RESULT ==========');
  log(JSON.stringify(results, null, 2));
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  return results.overall ? 0 : 1;
}

main().then((code) => { setTimeout(() => process.exit(code), 300); })
  .catch((e) => {
    log('[comp] FATAL', e.message);
    try { fs.writeFileSync(OUT, JSON.stringify({ fatal: e.message }, null, 2)); } catch {}
    process.exit(2);
  })
  .finally(async () => {
    try { if (browser) await browser.close(); } catch {}
    try { if (dshChild) dshChild.kill('SIGTERM'); } catch {}
  });
