// diag-blank.mjs —— 白屏取证：复用 exe 内部同一 prepareDshHome + spawnDshWeb 拉起 dsh web，
// 再用真实 Chromium（Playwright）走 token URL 完成鉴权并加载工作台，全量捕获：
//   console / pageerror / requestfailed / HTTP>=400 / 最终 DOM 内容 / 截图
// 目的：把「白屏」从现象定性为具体错误（SPA 报错 / 资源 404 / 401 未鉴权 / CSP 拦截）。
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
const HOME = path.join(os.tmpdir(), 'dsh-home-blank-' + Date.now());
const PORT = Number(process.env.DIAG_PORT || 5401);
const TOKEN_RE = /(https?:\/\/[^\s"'<>]+?\?token=[A-Za-z0-9_.-]+)/;
const OUT = 'D:/WorkSpace/deepseek-harness-master/_tmp_blank_diag';
const LOG = OUT + '.log';
const SHOT = OUT + '.png';

fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, '');
const say = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const launcher = require(LAUNCHER);
let pw;
try {
  pw = require('playwright');
} catch (e) {
  say('FATAL: 无法加载 playwright: ' + e.message);
  say('提示：设置 NODE_PATH 指向托管 workspace 的 node_modules');
  process.exit(3);
}

function killTree(pid) { if (pid) try { spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch {} }

(async () => {
  say('=== 白屏取证 start ' + new Date().toISOString() + ' ===');
  say(`NODE24=${NODE24} exists=${fs.existsSync(NODE24)}`);
  say(`DSH_BIN=${DSH_BIN} exists=${fs.existsSync(DSH_BIN)}`);
  say(`EXT=${EXT} exists=${fs.existsSync(EXT)}`);

  // 1) 准备 profile（与 exe 完全一致）
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  launcher.prepareDshHome({ extensionsDir: EXT, dshHome: HOME, profileName: 'web' });
  const bundles = JSON.parse(fs.readFileSync(path.join(HOME, 'profiles', 'web', 'package.json'), 'utf8')).dsh.profile.bundles;
  say(`bundles(${bundles.length}): ${bundles.join(', ')}`);

  // 2) 拉起 dsh web
  const logs = [];
  const child = launcher.spawnDshWeb({
    bin: DSH_BIN, port: PORT, dshHome: HOME, extensionsDir: EXT, runtime: NODE24,
    onLog: (m) => { logs.push(m); say('[dsh] ' + m); },
  });
  if (!child) { say('FAIL: spawnDshWeb returned null'); process.exit(1); }

  // 3) 等 token
  const deadline = Date.now() + 90000;
  let tokenUrl = null;
  while (Date.now() < deadline) {
    const hit = logs.map((l) => TOKEN_RE.exec(l)).find(Boolean);
    if (hit) { tokenUrl = hit[1]; break; }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!tokenUrl) {
    say('FAIL: 90s 内未获得 token URL');
    logs.slice(-30).forEach((l) => say('  ' + l));
    killTree(child.pid);
    process.exit(1);
  }
  say('TOKEN_URL=' + tokenUrl);

  // 4) 真实 Chromium 走鉴权链路
  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();

  const consoleErrs = [];
  const pageErrors = [];
  const failedReqs = [];
  const badResp = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') consoleErrs.push(`[${t}] ${m.text()}`);
  });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
  page.on('requestfailed', (r) => failedReqs.push(`${r.failure()?.errorText} ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) badResp.push(`${r.status()} ${r.url()}`); });

  say('--- goto token URL ---');
  let navErr = null;
  try {
    await page.goto(tokenUrl, { waitUntil: 'load', timeout: 45000 });
  } catch (e) { navErr = e.message; say('NAV_ERR=' + navErr); }

  // 给 SPA 充分时间执行（冷启动 + 插件 tree 加载）
  await page.waitForTimeout(12000);

  const info = await page.evaluate(() => {
    const root = document.getElementById('root');
    const txt = (document.body && document.body.innerText || '').trim();
    return {
      title: document.title,
      url: location.href,
      hasRoot: !!root,
      rootChildren: root ? root.children.length : -1,
      rootHtmlLen: root ? root.innerHTML.length : -1,
      bodyTextLen: txt.length,
      bodyTextHead: txt.slice(0, 400),
      scriptCount: document.scripts.length,
      hasBoot: typeof window.__DSH_BOOT__ !== 'undefined',
      bootKeys: (typeof window.__DSH_BOOT__ === 'object' && window.__DSH_BOOT__) ? Object.keys(window.__DSH_BOOT__).slice(0, 20) : [],
    };
  });

  try { await page.screenshot({ path: SHOT, fullPage: false }); say('screenshot=' + SHOT); }
  catch (e) { say('screenshot failed: ' + e.message); }

  say('');
  say('=== 页面状态 ===');
  say('title       : ' + info.title);
  say('url         : ' + info.url);
  say('#root       : has=' + info.hasRoot + ' children=' + info.rootChildren + ' htmlLen=' + info.rootHtmlLen);
  say('bodyTextLen : ' + info.bodyTextLen);
  say('__DSH_BOOT__: ' + info.hasBoot + ' keys=' + JSON.stringify(info.bootKeys));
  say('bodyTextHead: ' + JSON.stringify(info.bodyTextHead));
  say('');
  say(`=== console error/warn (${consoleErrs.length}) ===`);
  consoleErrs.slice(0, 25).forEach((l) => say('  ' + l));
  say(`=== pageerror (${pageErrors.length}) ===`);
  pageErrors.slice(0, 25).forEach((l) => say('  ' + l));
  say(`=== requestfailed (${failedReqs.length}) ===`);
  failedReqs.slice(0, 25).forEach((l) => say('  ' + l));
  say(`=== HTTP >=400 (${badResp.length}) ===`);
  badResp.slice(0, 25).forEach((l) => say('  ' + l));

  // 5) 定性
  const blank = info.rootHtmlLen <= 0 || (info.bodyTextLen === 0 && info.rootChildren === 0);
  let cause = 'UNKNOWN';
  if (blank) {
    if (pageErrors.length) cause = 'SPA_RUNTIME_ERROR（页面 JS 抛异常，React 未挂载）';
    else if (badResp.some((l) => l.startsWith('401'))) cause = 'AUTH_401（鉴权 cookie 未生效）';
    else if (badResp.length) cause = 'RESOURCE_HTTP_ERROR（静态资源 404/5xx）';
    else if (failedReqs.length) cause = 'RESOURCE_LOAD_FAILED（请求被拒/CSP/网络）';
    else cause = 'EMPTY_RENDER（无报错但无内容，可能 boot 数据缺失）';
  }
  say('');
  say(`=== VERDICT: ${blank ? 'BLANK_SCREEN' : 'RENDERED_OK'} | cause=${cause} ===`);

  await browser.close();
  killTree(child.pid);
  process.exit(blank ? 2 : 0);
})().catch((e) => {
  say('FATAL ' + (e && e.stack || e));
  process.exit(9);
});
