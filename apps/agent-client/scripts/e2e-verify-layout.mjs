/**
 * e2e-verify-layout.mjs — 验证「最新打包的 DeepSeekAgent.exe」页面能打开、布局无异常。
 *
 * 与 dsh-exe-e2e-test 的原脚本区别：
 *   - 原脚本硬编码 resources/node24/node.exe（已删除）；本脚本改用 Electron 内置 Node：
 *     runtime = D:\DeepSeekAgent\DeepSeekAgent.exe，并注入 ELECTRON_RUN_AS_NODE=1，
 *     复现 main.cjs 在 electron-builtin 模式下 spawn dsh web 的同款链路。
 *   - 用本机已装 Chromium（python venv ms-playwright 的 chromium-1228）通过 executablePath 驱动。
 *   - 聚焦硬指标：页面打开 + 布局为 dsh-web-ui + 截图无异常。多轮对话/智能编码仅 best-effort
 *     （需要 DashScope 外网，沙箱可能不可达），不影响「页面打开/布局」判定。
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const EXE_ROOT = 'D:/DeepSeekAgent';
const ELECTRON_EXE = path.join(EXE_ROOT, 'DeepSeekAgent.exe');
const DSH_DIR = path.join(EXE_ROOT, 'resources', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh');
const LAUNCHER = path.join(EXE_ROOT, 'resources', 'app.asar.unpacked', 'electron', 'plugin-host', 'dsh-web-launcher.cjs');
const CHROME = 'C:/Users/Administrator/.workbuddy/binaries/python/envs/kbtest/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const WORK = 'D:/WorkSpace/deepseek-harness-master';
const REAL_DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home';
const DSH_HOME = REAL_DSH_HOME;
const LOG_DIR = path.join(WORK, '_tmp_exe_logs');
const SCR_DIR = path.join(WORK, '_tmp_exe_screens');
const OUT = path.join(WORK, '_tmp_exe_runtime_result.json');
const DSH_LOG = path.join(LOG_DIR, 'dsh-web-stdio.log');

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SCR_DIR, { recursive: true });

const log = (...a) => console.log('[e2e-verify]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = {
  runtime: { electronExe: false, dshCli: false, launcherLoaded: false, dshWebSpawned: false, tokenUrl: null, webPort: null, builtinNode: true },
  navigation: {}, layout: {}, consoleErrors: [], pageErrors: [], screenshots: [], multiTurn: { skipped: true }, smartCoding: { skipped: true }, imagePaste: { skipped: true },
  overall: false, pass: {},
};

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (free) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(free); } };
    s.on('connect', () => finish(false));
    s.on('error', () => finish(true));
    setTimeout(() => finish(true), 800);
  });
}
async function pickFreePort() {
  for (const p of [5283, 5290, 5291, 5292, 5293]) {
    if (await isPortFree(p)) return p;
  }
  return 5299;
}
function fetchUrl(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', () => resolve({ status: 0, error: 'err' }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

async function preCleanup() {
  try { spawn('taskkill', ['/F', '/IM', 'DeepSeekAgent.exe'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  try {
    spawn('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { (($_.CommandLine -like '*dsh/lib/bin.js*' -or $_.CommandLine -like '*lib\\\\bin.js*') -and $_.CommandLine -like '*web*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, stdio: 'ignore' });
  } catch {}
  await sleep(2500);
  log('preCleanup 完成');
}

let dshWebChild = null;

async function main() {
  results.runtime.electronExe = fs.existsSync(ELECTRON_EXE);
  results.runtime.dshCli = fs.existsSync(path.join(DSH_DIR, 'lib', 'bin.js'));
  let launcher = null;
  try { launcher = require(LAUNCHER); results.runtime.launcherLoaded = !!launcher; }
  catch (e) { results.runtime.launcherError = e.message; }
  if (!results.runtime.electronExe || !results.runtime.dshCli || !launcher) {
    throw new Error('运行时缺失：electronExe=' + results.runtime.electronExe + ' dshCli=' + results.runtime.dshCli + ' launcher=' + results.runtime.launcherLoaded);
  }
  log('Electron 内置 Node 运行 dsh web:', ELECTRON_EXE);

  await preCleanup();

  const launch = launcher.resolveDshLaunch({ cliDir: DSH_DIR });
  if (!launch) throw new Error('resolveDshLaunch 返回 null');
  const WEB_PORT = await pickFreePort();
  log('resolveDshLaunch ->', launch.bin, '| 选用端口', WEB_PORT);

  const dshLogFd = fs.openSync(DSH_LOG, 'w');
  let tokenUrl = null;
  const capture = (s) => {
    try { fs.writeSync(dshLogFd, s + '\n'); } catch {}
    const mm = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_.%-]+)/.exec(s);
    if (mm && !tokenUrl) {
      tokenUrl = mm[1];
      results.runtime.tokenUrl = tokenUrl;
      const p = /:(\d+)\//.exec(tokenUrl);
      results.runtime.webPort = p ? Number(p[1]) : WEB_PORT;
      log('捕获 dsh web token URL:', tokenUrl);
    }
    if (/listening|Server|ECOSYSTEM|workbench|dsh web/i.test(s)) log('[dsh-web]', s.trim().slice(0, 160));
  };

  // 关键：用 Electron 内置 Node（ELECTRON_RUN_AS_NODE=1）跑 dsh web
  const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEBUDDY_SAFE_DELETE_ENABLED: '0' };
  dshWebChild = launcher.spawnDshWeb({
    bin: launch.bin,
    nodeArgs: ['--expose-internals', ...launch.nodeArgs],
    runtime: ELECTRON_EXE,
    port: WEB_PORT,
    dshHome: DSH_HOME,
    baseEnv: childEnv,
    childProcess: { spawn },
    onLog: capture,
  });
  results.runtime.dshWebSpawned = !!dshWebChild;
  if (!dshWebChild) throw new Error('spawnDshWeb 返回 null');

  const deadline = Date.now() + 70000;
  while (Date.now() < deadline) { if (tokenUrl) break; await sleep(1000); }
  if (!tokenUrl) {
    const r = await fetchUrl(`http://127.0.0.1:${WEB_PORT}/`, 2000);
    throw new Error('70s 内未捕获 token URL；端口探活 status=' + r.status + '（dsh web 可能 boot 失败，见 ' + DSH_LOG + '）');
  }
  log('dsh web 就绪，token URL 已捕获');

  const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1' }).catch(() => {});
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') results.consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => results.pageErrors.push('PAGEERROR: ' + e.message));

    log('navigating ->', tokenUrl);
    let gotoErr = null;
    await page.goto(tokenUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => { gotoErr = e.message; });
    results.navigation.gotoError = gotoErr;
    results.navigation.url = page.url();
    results.navigation.title = await page.title().catch(() => '');
    await sleep(9000);
    await screenshot(page, '01-initial-load');

    // 内测声明遮罩
    await dismissDisclaimer(page);
    // 进入会话
    await enterChatWorkspace(page);
    await sleep(3000);
    await screenshot(page, '02-after-enter');

    const layout = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const h = document.body.innerHTML || '';
      return {
        hasComposer: !!document.querySelector('[contenteditable="true"], [role="textbox"], .lexical-contenteditable, textarea'),
        hasSidebar: !!document.querySelector('aside, nav, [class*="sidebar" i], [class*="sider" i]'),
        hasChatHistory: /(新建对话|历史|会话|chat|conversation)/i.test(t),
        hasAgentOrModelSelector: /(模型|model|agent|智能体)/i.test(t),
        hasWorkbenchClass: /workbench|shell|layout|dsh-web-ui/i.test(h),
        hasAppError: /(Application error|Cannot read|TypeError|ReferenceError|白屏|加载失败)/i.test(t + h),
        bodyTextLen: t.replace(/\s+/g, ' ').trim().length,
        bodyTextPreview: t.replace(/\s+/g, ' ').trim().slice(0, 240),
        title: document.title,
      };
    }).catch((e) => ({ error: e.message }));
    results.layout = { url: page.url(), title: layout.title, details: layout, isDshWebUi: !!(layout.hasComposer && (layout.hasSidebar || layout.hasChatHistory || layout.hasWorkbenchClass)) && !layout.hasAppError };
    log('layout isDshWebUi:', results.layout.isDshWebUi, '| appError:', layout.hasAppError, '| bodyLen:', layout.bodyTextLen);
    log('layout preview:', layout.bodyTextPreview);

    // best-effort：尝试发一条消息（沙箱到 DashScope 可能不可达，仅记录，不影响判定）
    try {
      await sendMessage(page, '你好');
      await sleep(8000);
      const r = await page.evaluate(() => (document.body.innerText || '').slice(0, 400)).catch(() => '');
      results.multiTurn.note = '已发送测试消息；沙箱到 DashScope 可能不可达。首屏回复片段: ' + r.replace(/\s+/g, ' ').slice(0, 120);
      await screenshot(page, '03-after-send');
    } catch (e) { results.multiTurn.error = e.message; }

    await screenshot(page, '04-final');
  } finally {
    await browser.close().catch(() => {});
  }

  results.pass = {
    electronBuiltinNode: results.runtime.electronExe,
    dshCliPresent: results.runtime.dshCli,
    dshWebSpawned: results.runtime.dshWebSpawned,
    tokenCaptured: !!results.runtime.tokenUrl,
    pageNavigated: !results.navigation.gotoError,
    layoutIsDshWebUi: !!results.layout.isDshWebUi,
    noAppError: !(results.layout.details && results.layout.details.hasAppError),
    screenshotsCaptured: results.screenshots.length > 0,
    noFatalPageError: results.pageErrors.length === 0,
  };
  results.overall = results.pass.electronBuiltinNode && results.pass.dshCliPresent && results.pass.dshWebSpawned &&
    results.pass.tokenCaptured && results.pass.pageNavigated && results.pass.layoutIsDshWebUi &&
    results.pass.noAppError && results.pass.screenshotsCaptured && results.pass.noFatalPageError;
}

try { await main(); }
catch (e) { results.fatal = e.message; log('FATAL:', e.message); }
finally {
  log('\n========== E2E VERIFY RESULT ==========');
  log(JSON.stringify(results, null, 2));
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  try {
    spawn('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { (($_.CommandLine -like '*dsh/lib/bin.js*' -or $_.CommandLine -like '*lib\\\\bin.js*') -and $_.CommandLine -like '*web*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, stdio: 'ignore' });
  } catch {}
  if (dshWebChild) try { dshWebChild.kill('SIGKILL'); } catch {}
  setTimeout(() => process.exit(results.overall ? 0 : 1), 500);
}

// ---------------- helpers ----------------
function screenshot(page, name) {
  try { const p = path.join(SCR_DIR, `${name}-${Date.now()}.png`); return page.screenshot({ path: p, fullPage: false }).then(() => { results.screenshots.push(p); log('screenshot:', p); }); } catch (e) { log('screenshot warn:', e.message); }
}
async function dismissDisclaimer(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, [role="button"], a')];
      const cont = btns.find((b) => /^(继续|确认|我知道了|同意|Got it|Continue)$/i.test((b.innerText || '').trim()));
      if (cont) { cont.click(); return true; }
      const modal = document.querySelector('[role="dialog"], [class*="modal" i], [class*="dialog" i], [class*="overlay" i]');
      if (modal) { const b = modal.querySelector('button, [role="button"]'); if (b) { b.click(); return true; } }
      return false;
    }).catch(() => false);
    if (clicked) log('已点击「继续」关闭内测声明弹窗');
    await sleep(1200);
    const stillVisible = await page.evaluate(() => {
      const t = document.body.innerText;
      return /内测声明|0\.1 版本仍处在面向 Harness 开发者/i.test(t) &&
        [...document.querySelectorAll('button, [role="button"]')].some((b) => /^(继续|确认|我知道了|同意)$/i.test((b.innerText || '').trim()));
    }).catch(() => false);
    if (!stillVisible) break;
  }
}
async function enterChatWorkspace(page) {
  const opened = await page.evaluate(() => {
    const all = [...document.querySelectorAll('button, [role="button"], a, div[role="button"]')];
    const byText = (re) => all.find((b) => re.test((b.innerText || b.getAttribute('aria-label') || b.title || '').trim()));
    const target = byText(/新会话|新建对话|New Chat/i) ||
      all.find((b) => (b.getAttribute('aria-label') || '').includes('新建会话'));
    if (target) { target.click(); return { ok: true, text: (target.innerText || target.getAttribute('aria-label') || '').slice(0, 40) }; }
    const card = document.querySelector('[class*="workspace" i], [class*="project" i]');
    if (card) { card.click(); return { ok: true, text: 'workspace-card' }; }
    return { ok: false };
  }).catch(() => ({ ok: false }));
  if (opened.ok) log('开启会话入口:', opened.text);
  await sleep(3000);
  await page.evaluate(() => {
    const opts = [...document.querySelectorAll('button, [role="option"], [role="menuitem"], option')];
    const prefer = opts.find((b) => /deepseek-v3|qwen-plus|deepseek-v3-latest/i.test(b.innerText || b.value || ''));
    if (prefer) prefer.click();
  }).catch(() => {});
  await sleep(1000);
}
async function findComposer(page) {
  const sels = ['[contenteditable="true"]', '[role="textbox"]', '.lexical-contenteditable', 'textarea'];
  const candidates = [];
  for (const sel of sels) {
    const els = await page.$$(sel).catch(() => []);
    for (const el of els) {
      const meta = await el.evaluate((e) => ({
        aria: e.getAttribute('aria-label') || '',
        placeholder: e.getAttribute('placeholder') || '',
        rect: e.getBoundingClientRect ? { width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height } : null,
      })).catch(() => ({}));
      if (/选择工作区|workspace/i.test(meta.aria || meta.placeholder || '')) continue;
      candidates.push({ el, meta });
    }
  }
  const prefer = candidates.find((c) => /(输入|消息|Ask|Message|Prompt|Send|发送|chat|composer)/i.test(c.meta.aria + c.meta.placeholder));
  if (prefer) return prefer;
  candidates.sort((a, b) => ((b.meta.rect?.width || 0) * (b.meta.rect?.height || 0)) - ((a.meta.rect?.width || 0) * (a.meta.rect?.height || 0)));
  return candidates[0] || null;
}
async function sendMessage(page, text) {
  const composer = await findComposer(page);
  if (!composer) throw new Error('composer not found');
  await composer.el.evaluate((el) => { el.focus(); el.innerText = ''; }).catch(() => {});
  await composer.el.type(text, { delay: 5 });
  const sendSel = ['button:has-text("发送")', 'button:has-text("Send")', '[aria-label*="发送" i]', 'button[type="submit"]', '[data-testid*="send" i]', '[class*="send" i]'];
  let clicked = false;
  for (const sel of sendSel) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) { await btn.evaluate((el) => el.click()).catch(() => {}); clicked = true; break; }
  }
  if (!clicked) await composer.el.press('Enter');
}
