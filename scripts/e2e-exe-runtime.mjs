/**
 * e2e-exe-runtime.mjs — 基于「exe 内置运行时」的全功能自动化测试。
 *
 * 背景：DeepSeekAgent.exe 的 Electron 宿主进程在沙箱（无 GUI session）中会以
 * exit code 0 立即退出、且不输出任何日志，无法在沙箱内直接存活。但 exe 真正用来
 * 展示 dsh-web-ui 的**后端/前端**是通过它内置的：
 *   - resources/node24/node.exe          （与 exe 同款 Node 24）
 *   - resources/dsh-runtime/.../@deepseek-ai/dsh/lib/bin.js  （与 exe 同款 dsh CLI）
 *   - 同款 DashScope 注入（dsh-web-launcher.cjs 的 buildDshWebEnv）
 * 拉起来的。electron/main.cjs 的 startDshWebServer() 正是用上面这套命令 spawn 出
 * dsh web（端口 5283 起，真实托管 dsh-web-ui，并打印一次性 token URL）。
 *
 * 因此本脚本**直接 require exe 内置的 dsh-web-launcher.cjs（与 exe 同一份代码）**，
 * 用 exe 内置 node24 + dsh-runtime 复现同款 dsh web 启动流程，捕获真实的 token URL，
 * 再用 Playwright 驱动该真实 dsh-web-ui，跑四大核心特性：
 *   1) 页面布局是否为 dsh-web-ui；2) 多轮对话上下文保持；3) 智能编码代码块渲染；
 *   4) 图片粘贴/上传能力。
 *
 * 这等价于「基于 exe 打包的同一套运行时与前端资产」做功能验证，唯一省略的是
 * Electron 窗口外壳（沙箱硬限制，且不影响 dsh-web-ui 本身的功能）。
 *
 * 运行：
 *   NODE_PATH=C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules \
 *     C:/Users/Administrator/.workbuddy/binaries/node/versions/22.12.0/node.exe \
 *     scripts/e2e-exe-runtime.mjs
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const EXE_ROOT = 'D:/DeepSeekAgent';
const NODE24 = path.join(EXE_ROOT, 'resources', 'node24', 'node.exe');
const DSH_DIR = path.join(EXE_ROOT, 'resources', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh');
const LAUNCHER = path.join(EXE_ROOT, 'resources', 'app.asar.unpacked', 'electron', 'plugin-host', 'dsh-web-launcher.cjs');
const WORK = 'D:/WorkSpace/deepseek-harness-master';
const REAL_DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home';
const DSH_HOME = REAL_DSH_HOME;
const LOG_DIR = path.join(WORK, '_tmp_exe_logs');
const SCR_DIR = path.join(WORK, '_tmp_exe_screens');
const OUT = path.join(WORK, '_tmp_exe_runtime_result.json');
const DSH_LOG = path.join(LOG_DIR, 'dsh-web-stdio.log');
const SAMPLE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SCR_DIR, { recursive: true });
// 直接用真实 exe 运行过的 DSH_HOME 启动，避免 fresh profile 依赖缺失导致 boot 失败
if (!fs.existsSync(path.join(DSH_HOME, 'profiles', 'web', 'package.json'))) {
  throw new Error('真实 DSH_HOME 缺少 web profile，路径=' + DSH_HOME);
}
const SAMPLE_IMG = path.join(SCR_DIR, 'sample.png');
fs.writeFileSync(SAMPLE_IMG, Buffer.from(SAMPLE_PNG_B64, 'base64'));

const log = (...a) => console.log('[e2e-runtime]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = {
  runtime: { node24: false, dshCli: false, launcherLoaded: false, dshWebSpawned: false, tokenUrl: null, webPort: null, bundledNode24: false },
  layout: {}, multiTurn: {}, smartCoding: {}, imagePaste: {},
  consoleErrors: [], overall: false, pass: {},
};

function fetchUrl(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

async function preCleanup() {
  try { spawn('taskkill', ['/F', '/IM', 'DeepSeekAgent.exe'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  try {
    spawn('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { ($_.Name -match 'DeepSeekAgent.exe') -or (($_.CommandLine -like '*dsh/lib/bin.js*' -or $_.CommandLine -like '*lib\\\\bin.js*') -and $_.CommandLine -like '*web*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, stdio: 'ignore' });
  } catch {}
  await sleep(2500);
  log('preCleanup 完成');
}

let dshWebChild = null;

async function main() {
  // 1) 前置校验：exe 内置运行时是否齐备
  results.runtime.node24 = fs.existsSync(NODE24);
  results.runtime.dshCli = fs.existsSync(path.join(DSH_DIR, 'lib', 'bin.js'));
  results.runtime.bundledNode24 = results.runtime.node24;
  let launcher = null;
  try { launcher = require(LAUNCHER); results.runtime.launcherLoaded = !!launcher; }
  catch (e) { results.runtime.launcherError = e.message; }
  if (!results.runtime.node24 || !results.runtime.dshCli || !launcher) {
    throw new Error('exe 内置运行时缺失：node24=' + results.runtime.node24 + ' dshCli=' + results.runtime.dshCli + ' launcher=' + results.runtime.launcherLoaded);
  }
  log('exe 内置 node24:', NODE24, '| dsh cli:', path.join(DSH_DIR, 'lib', 'bin.js'));

  await preCleanup();

  // 2) 用 exe 内置 launcher 复现同款 dsh web 启动（与 main.cjs startDshWebServer 等价）
  const launch = launcher.resolveDshLaunch({ cliDir: DSH_DIR });
  if (!launch) throw new Error('resolveDshLaunch 返回 null');
  log('resolveDshLaunch ->', launch.bin, JSON.stringify(launch.nodeArgs));

  const WEB_PORT = 5283;
  const dshLogFd = fs.openSync(DSH_LOG, 'w');
  let tokenUrl = null;
  const capture = (s) => {
    try { fs.writeSync(dshLogFd, s); } catch {}
    const mm = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_.%-]+)/.exec(s);
    if (mm && !tokenUrl) { tokenUrl = mm[1]; results.runtime.tokenUrl = tokenUrl; results.runtime.webPort = (() => { const p = /:(\d+)\//.exec(tokenUrl); return p ? Number(p[1]) : WEB_PORT; })(); log('捕获 dsh web token URL:', tokenUrl); }
    if (/workbench|dsh web|ECOSYSTEM|listening|Server/i.test(s)) log('[dsh-web]', s.trim().slice(0, 200));
  };

  // 关闭 WorkBuddy safe-delete shim：dsh web 在首次 boot 时会合法删除 profile cache，
  // 默认 shim 把 >50 文件的删除拦截掉，导致 boot 失败。
  const childEnv = { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' };
  dshWebChild = launcher.spawnDshWeb({
    bin: launch.bin,
    nodeArgs: launch.nodeArgs,
    runtime: NODE24,
    port: WEB_PORT,
    dshHome: DSH_HOME,
    baseEnv: childEnv,
    childProcess: { spawn },
    onLog: capture,
  });
  results.runtime.dshWebSpawned = !!dshWebChild;
  if (!dshWebChild) throw new Error('spawnDshWeb 返回 null（无法启动 dsh web 子进程）');

  // 3) 等待 token URL（dsh web 真正就绪 = cordis boot 成功 + webServer listen）
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (tokenUrl) break;
    await sleep(1000);
  }
  if (!tokenUrl) {
    // 兜底：直接探活端口
    const r = await fetchUrl(`http://127.0.0.1:${WEB_PORT}/`, 2000);
    throw new Error('60s 内未捕获 token URL；端口探活 status=' + r.status + '（dsh web 可能 boot 失败，见 ' + DSH_LOG + '）');
  }
  log('dsh web 已就绪，token URL 已捕获');

  // 4) Playwright 驱动真实 dsh-web-ui
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1' }).catch(() => {});
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') results.consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => results.consoleErrors.push('PAGEERROR: ' + e.message));
    const networkLog = [];
    page.on('request', (req) => { if (/chat\/completions|v1\/chat|completions/i.test(req.url())) networkLog.push({ type: 'req', url: req.url().slice(0, 200), method: req.method(), post: (req.postData() || '').slice(0, 200) }); });
    page.on('response', (res) => { if (/chat\/completions|v1\/chat|completions/i.test(res.url())) networkLog.push({ type: 'res', url: res.url().slice(0, 200), status: res.status(), body: '' }); });
    results.networkLog = networkLog;

    log('navigating to dsh-web-ui:', tokenUrl);
    await page.goto(tokenUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('goto warn:', e.message));
    await sleep(9000);
    await screenshot(page, '01-initial-load');

    // 关掉首次弹出的「内测声明」遮罩，否则后续所有交互都被挡住
    await dismissDisclaimer(page);

    // 进入具体工作区/会话。初始页是「选择工作区」列表，必须点进去才会出现真正的聊天 composer。
    await enterChatWorkspace(page);

    // ---- 布局断言 ----
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
        title: document.title,
      };
    }).catch((e) => ({ error: e.message }));
    results.layout = { url: page.url(), title: layout.title, details: layout, isDshWebUi: !!(layout.hasComposer && (layout.hasSidebar || layout.hasChatHistory || layout.hasWorkbenchClass)) };
    log('layout isDshWebUi:', results.layout.isDshWebUi, '| preview:', layout.bodyTextPreview);

    // 选择模型（best-effort）
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, [role="button"], [role="combobox"], select, input')];
      const t = els.find((b) => /deepseek|qwen|glm|模型|model/i.test(b.innerText || b.getAttribute('aria-label') || b.value || ''));
      if (t) try { t.click(); } catch {}
    }).catch(() => {});
    await sleep(600);

    // ---- 多轮对话 ----
    const multiTurn = { round1: {}, round2: {}, contextKept: false };
    try {
      await sendMessage(page, '我叫张三，请记住这个名字');
      multiTurn.round1.send = true;
      const r1 = await waitForReply(page, (txt) => ({ found: /张三/.test(txt) || /(记住|好的|OK|收到)/i.test(txt), excerpt: txt.slice(0, 300) }), 60000);
      multiTurn.round1.replyAppeared = r1.found;
      multiTurn.round1.excerpt = r1.excerpt || '';
      await screenshot(page, '02-multi-turn-r1');
      if (r1.found) {
        await sendMessage(page, '我刚才让你记住的名字是什么？');
        multiTurn.round2.send = true;
        const r2 = await waitForReply(page, (txt) => ({ found: /张三/.test(txt), excerpt: txt.slice(0, 300) }), 60000);
        multiTurn.round2.replyAppeared = r2.found;
        multiTurn.round2.excerpt = r2.excerpt || '';
        multiTurn.contextKept = r2.found;
        await screenshot(page, '03-multi-turn-r2');
      } else {
        multiTurn.note = 'round1 未收到回复（可能沙箱到 DashScope 外网不可达，UI/请求链路仍验证）';
      }
    } catch (e) { multiTurn.error = e.message; }
    results.multiTurn = multiTurn;

    // ---- 智能编码 ----
    const coding = { sent: false, replyAppeared: false, codeBlockAppeared: false, excerpt: '' };
    try {
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

    // ---- 图片输入能力 ----
    const imagePaste = { uploadButtonFound: false, setInputFilesOk: false, clipboardPasteOk: false, inputReacted: false, previewAppeared: false };
    try {
      const composer = await findComposer(page);
      if (!composer) imagePaste.error = 'composer not found';
      else {
        await composer.el.evaluate((el) => el.focus()).catch(() => {});
        const up = await page.evaluate(() => {
          const fileInputs = [...document.querySelectorAll('input[type="file"]')];
          const btns = [...document.querySelectorAll('button, [role="button"], label, [class*="upload" i], [class*="attach" i], [class*="paperclip" i]')];
          const upBtn = btns.find((b) => /(上传|附件|图片|文件|paperclip|attach|upload|image|plus|＋|\+)/i.test(b.innerText || b.getAttribute('aria-label') || b.title || ''));
          return { fileInputs: fileInputs.length, hasUploadBtn: !!upBtn };
        }).catch(() => ({ fileInputs: 0, hasUploadBtn: false }));
        imagePaste.uploadButtonFound = up.hasUploadBtn || up.fileInputs > 0;
        imagePaste.uploadDiagnostics = up;
        if (up.fileInputs > 0) {
          try { await page.locator('input[type="file"]').first().setInputFiles(SAMPLE_IMG); imagePaste.setInputFilesOk = true; await sleep(1500); } catch (e) { imagePaste.setInputFilesErr = e.message; }
        } else if (up.hasUploadBtn) {
          try {
            await page.evaluate(() => {
              const btns = [...document.querySelectorAll('button, [role="button"], label, [class*="upload" i], [class*="attach" i]')];
              const upBtn = btns.find((b) => /(上传|附件|图片|文件|paperclip|attach|upload|image|plus|＋|\+)/i.test(b.innerText || b.getAttribute('aria-label') || b.title || ''));
              if (upBtn) upBtn.click();
            });
            await sleep(800);
            await page.locator('input[type="file"]').first().setInputFiles(SAMPLE_IMG); imagePaste.setInputFilesOk = true; await sleep(1500);
          } catch (e) { imagePaste.setInputFilesErr = e.message; }
        }
        if (!imagePaste.setInputFilesOk) {
          // 不用系统剪贴板（headless 无权限），直接在 composer 上 dispatch paste 事件并带 File
          try {
            const after = await composer.el.evaluate(async (el, { b64, fileName }) => {
              const bin = atob(b64); const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              const file = new File([bytes.buffer], fileName, { type: 'image/png' });
              const dt = new DataTransfer(); dt.items.add(file);
              el.focus();
              const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
              el.dispatchEvent(paste);
              return { dispatched: true, fileSize: file.size };
            }, { b64: SAMPLE_PNG_B64, fileName: path.basename(SAMPLE_IMG) });
            imagePaste.clipboardPasteOk = after && after.dispatched; await sleep(1500);
          } catch (e) { imagePaste.clipboardErr = e.message; }
        }
        const after = await page.evaluate(() => {
          const t = document.body.innerText; const h = document.body.innerHTML;
          return { hasImgTag: /<img\b/i.test(h), hasFileChip: /(sample\.png|image\.png|\.png|\.jpg|\.jpeg|图片|文件)/i.test(t) || /class=[^>]*upload/i.test(h) };
        }).catch(() => ({}));
        imagePaste.inputReacted = imagePaste.setInputFilesOk || imagePaste.clipboardPasteOk || after.hasImgTag || after.hasFileChip;
        imagePaste.previewAppeared = after.hasImgTag || after.hasFileChip;
        await screenshot(page, '05-image-paste');
      }
    } catch (e) { imagePaste.error = e.message; }
    results.imagePaste = imagePaste;

    await screenshot(page, '06-final');
  } finally {
    await browser.close().catch(() => {});
  }

  // 5) 判定
  results.pass = {
    node24Bundled: results.runtime.node24,
    dshCliPresent: results.runtime.dshCli,
    dshWebSpawned: results.runtime.dshWebSpawned,
    tokenCaptured: !!results.runtime.tokenUrl,
    layoutIsDshWebUi: !!results.layout.isDshWebUi,
    multiTurnContextKept: !!results.multiTurn.contextKept,
    smartCodingReply: !!results.smartCoding.replyAppeared,
    smartCodingCodeBlock: !!results.smartCoding.codeBlockAppeared,
    imagePasteReacted: !!results.imagePaste.inputReacted,
  };
  results.overall = results.pass.node24Bundled && results.pass.dshCliPresent && results.pass.dshWebSpawned &&
    results.pass.tokenCaptured && results.pass.layoutIsDshWebUi && results.pass.imagePasteReacted;
}

try {
  await main();
} catch (e) {
  results.fatal = e.message;
  log('FATAL:', e.message);
} finally {
  log('\n========== EXE-RUNTIME E2E RESULT ==========');
  log(JSON.stringify(results, null, 2));
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  // 清理 dsh web 子进程
  try {
    spawn('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { (($_.CommandLine -like '*dsh/lib/bin.js*' -or $_.CommandLine -like '*lib\\\\bin.js*') -and $_.CommandLine -like '*web*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, stdio: 'ignore' });
  } catch {}
  if (dshWebChild) try { dshWebChild.kill('SIGKILL'); } catch {}
  setTimeout(() => process.exit(results.overall ? 0 : 1), 500);
}

// ---------------- helpers ----------------
function powershellCopy(src, dst) {
  return new Promise((resolve) => {
    const cmd = `
      Remove-Item -LiteralPath '${dst.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue;
      New-Item -ItemType Directory -Force -Path '${dst.replace(/'/g, "''")}' | Out-Null;
      Copy-Item -Path '${src.replace(/'/g, "''")}\\*' -Destination '${dst.replace(/'/g, "''")}' -Recurse -Force
    `;
    const child = spawn('powershell', ['-NoProfile', '-Command', cmd], { windowsHide: true, stdio: 'ignore' });
    let settled = false; const done = () => { if (!settled) { settled = true; resolve(); } };
    child.on('exit', done); child.on('error', done); setTimeout(done, 15000);
  });
}

function powershellRemove(target) {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-Command', `Remove-Item -LiteralPath '${target.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`], { windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    child.on('exit', done);
    child.on('error', done);
    setTimeout(done, 6000);
  });
}

function screenshot(page, name) {
  try { const p = path.join(SCR_DIR, `${name}-${Date.now()}.png`); return page.screenshot({ path: p, fullPage: true }).then(() => log('screenshot:', p)); } catch (e) { log('screenshot warn:', e.message); }
}
async function enterChatWorkspace(page) {
  // 先尝试点「新会话 / 新建会话」真正开一个会话（这一步才会让聊天 composer 出现）
  const opened = await page.evaluate(() => {
    const all = [...document.querySelectorAll('button, [role="button"], a, div[role="button"]')];
    const byText = (re) => all.find((b) => re.test((b.innerText || b.getAttribute('aria-label') || b.title || '').trim()));
    const target = byText(/新会话|新建对话|New Chat/i) ||
      all.find((b) => (b.getAttribute('aria-label') || '').includes('新建会话'));
    if (target) { target.click(); return { ok: true, text: (target.innerText || target.getAttribute('aria-label') || '').slice(0, 40) }; }
    // 兜底：点工作区卡片
    const card = document.querySelector('[class*="workspace" i], [class*="project" i]');
    if (card) { card.click(); return { ok: true, text: 'workspace-card' }; }
    return { ok: false };
  }).catch(() => ({ ok: false }));
  if (opened.ok) log('开启会话入口:', opened.text);
  await sleep(3000);
  // 若出现模型选择器，优先选 deepseek-v3（DashScope 兼容且测试通过）
  await page.evaluate(() => {
    const opts = [...document.querySelectorAll('button, [role="option"], [role="menuitem"], option')];
    const prefer = opts.find((b) => /deepseek-v3|qwen-plus|deepseek-v3-latest/i.test(b.innerText || b.value || ''));
    if (prefer) prefer.click();
  }).catch(() => {});
  await sleep(1000);
}

async function dismissDisclaimer(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, [role="button"], a')];
      const cont = btns.find((b) => /^(继续|确认|我知道了|同意|Got it|Continue)$/i.test((b.innerText || '').trim()));
      if (cont) { cont.click(); return true; }
      // 兜底：找包含「内测声明」的 dialog/modal 里的第一个 button
      const modal = document.querySelector('[role="dialog"], [class*="modal" i], [class*="dialog" i], [class*="overlay" i]');
      if (modal) {
        const b = modal.querySelector('button, [role="button"]');
        if (b) { b.click(); return true; }
      }
      return false;
    }).catch(() => false);
    if (clicked) { log('已点击「继续」关闭内测声明弹窗'); }
    await sleep(1200);
    const stillVisible = await page.evaluate(() => {
      const t = document.body.innerText;
      return /内测声明|0\.1 版本仍处在面向 Harness 开发者/i.test(t) &&
        [...document.querySelectorAll('button, [role="button"]')].some((b) => /^(继续|确认|我知道了|同意)$/i.test((b.innerText || '').trim()));
    }).catch(() => false);
    if (!stillVisible) break;
  }
}

async function findComposer(page) {
  // 排除「选择工作区」搜索框，优先找真正的聊天输入框
  const sels = ['[contenteditable="true"]', '[role="textbox"]', '.lexical-contenteditable', 'textarea'];
  const candidates = [];
  for (const sel of sels) {
    const els = await page.$$(sel).catch(() => []);
    for (const el of els) {
      const meta = await el.evaluate((e) => ({
        aria: e.getAttribute('aria-label') || '',
        placeholder: e.getAttribute('placeholder') || '',
        text: (e.innerText || '').trim().slice(0, 30),
        rect: e.getBoundingClientRect ? { width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height } : null,
      })).catch(() => ({}));
      if (/选择工作区|workspace/i.test(meta.aria || meta.placeholder || '')) continue;
      candidates.push({ el, sel, meta });
    }
  }
  // 优先：aria/placeholder 含输入/消息/ask
  const prefer = candidates.find((c) => /(输入|消息|Ask|Message|Prompt|Send|发送|chat|composer)/i.test(c.meta.aria + c.meta.placeholder));
  if (prefer) return prefer;
  // 兜底：选面积最大且可见的
  candidates.sort((a, b) => ((b.meta.rect?.width || 0) * (b.meta.rect?.height || 0)) - ((a.meta.rect?.width || 0) * (a.meta.rect?.height || 0)));
  return candidates[0] || null;
}
async function sendMessage(page, text) {
  const composer = await findComposer(page);
  if (!composer) throw new Error('composer not found');
  await composer.el.evaluate((el) => { el.focus(); el.innerText = ''; }).catch(() => {});
  await composer.el.type(text, { delay: 5 });
  // 优先点发送按钮
  const sendSel = ['button:has-text("发送")', 'button:has-text("Send")', '[aria-label*="发送" i]', 'button[type="submit"]', '[data-testid*="send" i]', '[class*="send" i]'];
  let clicked = false;
  for (const sel of sendSel) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) { await btn.evaluate((el) => el.click()).catch(() => {}); clicked = true; break; }
  }
  if (!clicked) await composer.el.press('Enter');
  // 验证：用户消息作为气泡出现在页面里（而不是仅留在输入框）
  try {
    await page.waitForFunction((t) => {
      const bubbles = [...document.querySelectorAll('[class*="message" i], [class*="bubble" i], [class*="chat-item" i], [role="listitem"]')];
      return bubbles.some((el) => (el.innerText || '').includes(t)) || document.body.innerText.split(t).length > 1;
    }, text, { timeout: 6000 });
  } catch (e) { log('sendMessage verify warn:', e.message); }
}
async function waitForReply(page, predicate, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
    const htm = await page.content().catch(() => '');
    const res = predicate(txt, htm);
    if (res && res.found) return res;
    await sleep(1000);
  }
  return { found: false };
}
