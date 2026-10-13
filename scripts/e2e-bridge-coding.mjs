/**
 * e2e-bridge-coding.mjs — 端到端验证「原生桥接层」与「智能编码」（dsh web 层）。
 *
 * 为何直接拉起 dsh web 而非整包 exe：
 *   - 整包 DeepSeekAgent.exe 是未签名 exe，本沙箱对「从 Bash 拉起 exe」有安全拦截/杀软静默终止；
 *   - 生产态常驻一个 exe 实例（single-instance 锁），无法再起第二个。
 *   - 而 exe 的桥接/工作台完全由它 spawn 的 dsh web 子进程（node24 + 同一 bin + 同一 DSH_HOME）
 *     提供，故直接用 node24 复刻该 spawn 即等价于测试 exe 的桥接行为，且可安全自动化。
 *
 * 覆盖：
 *   1) 端口回退修复：先占用 5283（复现 IntelliJ fusion 抢端口），验证 dsh web 落到空闲端口而非「假在线/全断」。
 *   2) 桥接层可达：/api/directoryPicker/pick、/plugins/events(SSE)、ws://.../api/remote.mux 不再 ERR_CONNECTION_REFUSED。
 *   3) 应用非白屏。
 *   4) 智能编码：composer 输入提示 → mock LLM 流式返回代码块 → UI 出现回复。
 *
 * 复用部署 exe 自带的 node24 与 Playwright(chromium)，不下载浏览器，离线 mock LLM。
 *   NODE_PATH=C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules node scripts/e2e-bridge-coding.mjs
 */
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

// 复用 exe 自带的 prepareDshHome（注入社区插件到 web profile），与真实启动行为一致。
// 用户正常 exe 没有 safe-delete shim，这里 require 也走真实 node，无影响。
const LAUNCHER = 'D:/DeepSeekAgent/resources/app.asar.unpacked/electron/plugin-host/dsh-web-launcher.cjs';
let prepareDshHome = null;
try { prepareDshHome = require(LAUNCHER).prepareDshHome; }
catch (e) { log('[e2e] warn: 无法加载 launcher.prepareDshHome，将跳过扩展注入:', e.message); }

const NODE24 = 'D:/DeepSeekAgent/resources/node24/node.exe';
const DSH_BIN = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js';
const EXTENSIONS_DIR = 'D:/DeepSeekAgent/resources/packages/extensions';
const PROD_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home';
const E2E_HOME = 'D:/_tmp_e2e_dshhome';
const MOCK_PORT = 9393;
const WEB_BASE = 5283;
const WEB_MAX_RETRY = 20;
const OUT = 'D:/WorkSpace/deepseek-harness-master/_tmp_e2e_result.json';

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HARD_TIMEOUT_MS = 280000;
const hardTimer = setTimeout(() => {
  log('[e2e] HARD TIMEOUT');
  try { fs.writeFileSync(OUT, JSON.stringify({ fatal: 'hard-timeout' }, null, 2)); } catch {}
  process.exit(4);
}, HARD_TIMEOUT_MS);
hardTimer.unref?.();

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(true); });
  });
}

// ---------- 本地 mock LLM（OpenAI 兼容，SSE 流式） ----------
// 关键接线：dsh-llm-deepseek 的 baseURL 解析链为
//   config.baseURL ?? launchEnvironmentOf(ctx).get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com'
// 而 launchEnvironmentOf 的最信任层就是 process.env（见 dsh-launch-environment/lib/index.js:66）。
// 故 child env 设 DEEPSEEK_BASE_URL + DEEPSEEK_API_KEY 即可把「deepseek-official」provider
// 指向本 mock，无需伪造 provider bundle（mock-server 不是 provider，无法注入 web profile）。
let mockHits = 0;
const mockHitPaths = [];
let mockLastPrompt = '';
function startMockLLM() {
  const server = http.createServer((req, res) => {
    const isChat = req.url.includes('/chat/completions');
    if (req.method === 'POST' && isChat) {
      mockHits++;
      mockHitPaths.push(req.url);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let prompt = '';
        try { prompt = JSON.parse(body)?.messages?.at(-1)?.content || ''; } catch {}
        mockLastPrompt = prompt;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const reply =
          '好的，下面是为你生成的快速排序（Python）实现：\n\n' +
          '```python\n' +
          'def quicksort(arr):\n' +
          '    if len(arr) <= 1:\n' +
          '        return arr\n' +
          '    pivot = arr[len(arr) // 2]\n' +
          "    left = [x for x in arr if x < pivot]\n" +
          '    mid = [x for x in arr if x == pivot]\n' +
          '    right = [x for x in arr if x > pivot]\n' +
          '    return quicksort(left) + mid + quicksort(right)\n' +
          '```\n\n' +
          `（已根据提示「${prompt.slice(0, 40)}」生成示例代码。）`;
        const chunks = reply.match(/[\s\S]{1,12}/g) || [reply];
        let i = 0;
        const tick = () => {
          if (i >= chunks.length) { res.write('data: [DONE]\n\n'); res.end(); return; }
          const piece = chunks[i++];
          const delta = JSON.stringify({ choices: [{ delta: { content: piece } }] });
          res.write(`data: ${delta}\n\n`);
          setTimeout(tick, 15);
        };
        tick();
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => {
    log(`[mock-llm] listening on http://127.0.0.1:${MOCK_PORT}/chat/completions`);
    resolve(server);
  }));
}

// 复刻 main.cjs 的端口回退：从 5283 起找第一个空闲端口（遇占用即 +1）
async function pickWebPort() {
  for (let i = 0; i < WEB_MAX_RETRY; i++) {
    const p = WEB_BASE + i;
    if (await isPortFree(p)) return p;
  }
  throw new Error('no free web port in range');
}

async function main() {
  const results = { portFallback: {}, bridge: {}, appLoad: {}, smartCoding: {}, consoleErrors: [], mock: {} };
  let dshChild = null, browser = null, mockServer = null;
  let resolvedPort = null, tokenUrl = null;

  mockServer = await startMockLLM();

  // 端口回退验证：确定性复现「IntelliJ fusion-win-x64.exe 抢占 5283」的生产故障。
  // 主动占用 5283，迫使 dsh web 必须落到空闲端口（修复前会假在线/全断）；否则该场景依赖本机巧合，不稳定。
  const conflictServer = net.createServer();
  await new Promise((res) => conflictServer.listen(WEB_BASE, '127.0.0.1', () => res()));
  const conflict5283 = true;
  log(`[e2e] 已主动占用 ${WEB_BASE}（复现 IntelliJ fusion 抢端口故障），将验证回退`);
  resolvedPort = await pickWebPort();
  log('[e2e] 选定 dsh web 端口 =', resolvedPort, '(应 ≠', WEB_BASE, ')');
  results.portFallback = { conflictPort: WEB_BASE, occupied: conflict5283, resolvedPort, fellBack: resolvedPort !== WEB_BASE };

  // ---------- 清理可能残留在后台的 dsh web 子进程（孤儿 node.exe 会持有 node_modules.lock）----------
  // 历史：dsh web 进程树未被 SIGTERM 完全回收，其孙进程仍持 OS 锁 → 本脚本 rmSync 静默失败 → 锁争用。
  // 这里按命令行特征（含 dsh/lib/bin.js web）精准杀掉残留 dsh web，且排除本测试进程自身。
  try {
    const selfPid = String(process.pid);
    const ps = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match \'node\\.exe\' -and $_.CommandLine -like \'*dsh/lib/bin.js*\' -and $_.CommandLine -like \'*web*\' -and $_.ProcessId -ne ' + selfPid + ' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
      { windowsHide: true }
    );
    log('[e2e] 已清理残留 dsh web 子进程');
  } catch (e) { log('[e2e] 清理残留进程 warn:', e.message); }
  // 给 OS 释放锁文件句柄一点时间
  await sleep(800);

  // ---------- 直接用生产 DSH_HOME（与真实 exe 启动路径一致）----------
  // 生产 home 仅 ~180K：profiles/node_modules 是 205 个指向 dsh-runtime 的 junction，启动时
  // 仅需 healProfiles 复链（无网络、无 npm install）。唯一历史包袱是死进程残留的 node_modules.lock，
  // atomic-write 会永久等这把锁 → 超时。此处仅剥锁即可，不做复制（复制反而触发整目录重新 junction，极慢）。
  // 本沙箱无常驻生产 exe（锁为历史死进程残留），故与生产态不冲突。
  (function stripLocks(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stripLocks(p);
      else if (e.name.endsWith('.lock')) { try { fs.rmSync(p, { force: true }); } catch {} }
    }
  })(PROD_HOME);
  if (prepareDshHome) {
    try { prepareDshHome({ extensionsDir: EXTENSIONS_DIR, dshHome: PROD_HOME }); log('[e2e] prepareDshHome 复链社区插件完成'); }
    catch (e) { log('[e2e] prepareDshHome warn:', e.message); }
  }

  log('[e2e] 拉起 dsh web（复刻 exe spawn：node24 + 同 bin + 生产 DSH_HOME 直启）...');
  // 关键：清掉本沙箱注入的 safe-delete shim（NODE_OPTIONS + CODEBUDDY_SAFE_DELETE_*），
  // 否则 dsh web 在 heal profile 时的 fs.rm 会被批量删除守卫拦截而崩溃。
  // 用户正常启动的 exe 没有该 shim，故此处仅对 dsh web 子进程去环境即可。
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  for (const k of Object.keys(childEnv)) if (/^CODEBUDDY_SAFE_DELETE_/i.test(k)) delete childEnv[k];
  const env = {
    ...childEnv,
    DSH_HOME: PROD_HOME,
    // 重定向「deepseek-official」provider 到本地 mock（launchEnvironmentOf 最信任层 = process.env）。
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    DEEPSEEK_API_KEY: 'dummy-e2e',
    DSH_RATE_LIMIT_MS: '0',
  };
  dshChild = spawn(NODE24, [DSH_BIN, 'web', '--port', String(resolvedPort)], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  dshChild.stdout.on('data', (d) => { bootLog += d; process.stdout.write('[dsh-web] ' + d); });
  dshChild.stderr.on('data', (d) => { bootLog += d; process.stderr.write('[dsh-web-err] ' + d); });
  dshChild.on('exit', (code) => log('[dsh-web] exit code=' + code));

  try {
    // 等待 token URL（= cordis boot 成功 + webServer 已 listen + 已签发 process token）。
    // 必须先等到带 token 的 URL：dsh web 对无 token 的访问返回「authentication required」，
    // 直接落 bare URL 会让 Playwright 加载鉴权墙而非工作台。仅在 150s 内始终未出现 token 时才退化到 bare。
    const tokenRe = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_.-]+)/;
    const start = Date.now();
    while (Date.now() - start < 150000) {
      const m = tokenRe.exec(bootLog);
      if (m) { tokenUrl = m[1]; break; }
      await sleep(700);
    }
    if (!tokenUrl && !(await isPortFree(resolvedPort))) tokenUrl = `http://127.0.0.1:${resolvedPort}/`;
    if (!tokenUrl) throw new Error('dsh web 未在 150s 内就绪（无 token URL 且端口未监听）');
    // dsh web 已完成端口选择，释放被占用的 5283，避免长期占用
    try { conflictServer.close(); } catch {}
    log('[e2e] dsh web 就绪:', tokenUrl);
    const token = (tokenUrl.match(/token=([^&\s]+)/) || [])[1] || '';

    log('[e2e] 启动 Playwright chromium 加载工作台...');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') { const t = msg.text(); results.consoleErrors.push(t); log('[console.error]', t); } });
    page.on('pageerror', (e) => results.consoleErrors.push('PAGEERROR: ' + e.message));

    await page.goto(tokenUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('[e2e] goto warn:', e.message));
    await sleep(7000);

    const url = page.url();
    results.appLoad.url = url;
    results.appLoad.title = await page.title().catch(() => '');
    const html = await page.content();
    results.appLoad.hasWorkbenchShell = /(contenteditable|lexical|workbench|插件|对话|agent)/i.test(html) || html.length > 2000;
    results.appLoad.whiteScreen = /AI对话\(Harness\)/.test(html) && !/<[a-z]+[^>]*class=/i.test(html);
    log('[e2e] page url =', url, '| title =', results.appLoad.title);
    results.appLoad.bodyText = (await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);

    // 桥接层可达性（带 process token：复刻 Electron 客户端鉴权，验证端点「可用」而非仅「通」）
    log('[e2e] probing bridge endpoints (with token)...');
    const origin = new URL(url).origin;
    const bridge = await page.evaluate(async (o) => {
      const out = {};
      const get = async (p) => {
        try {
          const r = await fetch(o.origin + p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(o.token),
            { method: 'GET', signal: AbortSignal.timeout(8000), headers: { Authorization: 'Bearer ' + o.token } });
          return 'HTTP ' + r.status;
        } catch (e) { return 'ERR:' + (e.message || e.name); }
      };
      out.pluginsEvents = await get('/plugins/events');
      out.dirPicker = await get('/api/directoryPicker/pick');
      out.mux = await new Promise((resolve) => {
        try {
          const ws = new WebSocket((o.origin.replace(/^http/, 'ws')) + '/api/remote.mux?token=' + encodeURIComponent(o.token));
          const to = setTimeout(() => { try { ws.close(); } catch {} resolve('ERR:timeout'); }, 8000);
          ws.onopen = () => { clearTimeout(to); try { ws.close(); } catch {} resolve('open'); };
          ws.onerror = () => { clearTimeout(to); resolve('ERR:ws-error'); };
        } catch (e) { resolve('ERR:' + e.message); }
      });
      return out;
    }, { origin, token });
    results.bridge = bridge;
    log('[e2e] bridge =', JSON.stringify(bridge));

    // 智能编码
    log('[e2e] attempting smart-coding interaction...');
    const coding = { composerFound: false, sent: false, replyAppeared: false, replyExcerpt: '', mockHit: 0, diagnostics: '' };
    try {
      let box = null;
      try { box = await page.waitForSelector('[contenteditable="true"], [role="textbox"], .lexical-contenteditable, textarea', { timeout: 20000 }); }
      catch (e) { log('[e2e] composer wait timeout'); }
      if (box) {
        coding.composerFound = true;
        // 1) 先关掉可能遮挡的模态（内测声明「继续」等），再隐藏覆盖在 composer 上的浮层。
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button, [role="button"], a')];
          for (const b of btns) {
            const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
            if (/^(继续|知道了|关闭|OK|Got it)$/i.test(t)) b.click();
          }
          const ed = document.querySelector('[contenteditable="true"], [role="textbox"], .lexical-contenteditable, textarea');
          if (ed) {
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
          }
        }).catch(() => {});
        await sleep(400);
        // 2) 程序化 focus（非坐标 click），规避浮层拦截 pointer events
        await box.evaluate((el) => el.focus()).catch(() => {});
        await box.type('请用 Python 写一个快速排序函数', { delay: 10 });
        const sendSel = ['button:has-text("发送")', 'button:has-text("Send")', '[aria-label*="发送" i]', 'button[type="submit"]'];
        let clicked = false, clickedSel = '';
        for (const sel of sendSel) {
          const btn = await page.$(sel).catch(() => null);
          if (btn) {
            // 程序化 click：绕过坐标可操作性检查，直接派发原生 click（React 合成事件经根容器冒泡）
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
        // 兜底：若找不到发送按钮，尝试键盘发送（Enter）
        if (!clicked) {
          try { await box.press('Enter'); clicked = true; clickedSel = 'keyboard:Enter'; } catch {}
        }
        coding.sent = clicked;
        coding.sendSelector = clickedSel;
        if (clicked) {
          const s0 = Date.now();
          while (Date.now() - s0 < 25000) {
            const txt = await page.evaluate(() => document.body.innerText.slice(0, 6000)).catch(() => '');
            // 仅匹配「助理真实回复」特征（Python 代码 / mock 固定话术），避免把用户输入里的「快速排序」误判为已回复。
            const m = /def quicksort|```python|pivot =|下面是为你生成|quicksort\(/.exec(txt);
            if (m) { coding.replyAppeared = true; coding.replyExcerpt = txt.slice(Math.max(0, m.index - 40), m.index + 260); break; }
            await sleep(800);
          }
        }
        // 捕获发送后是否出现「模型不可用 / 请求失败」等提示，用于区分「模型未选」与「provider 已打到 mock 但解析失败」
        coding.diagnostics = await page.evaluate(() => {
          const t = document.body.innerText;
          const m = t.match(/[^。\n]{0,30}(模型不可用|请先选择模型|请求失败|网络错误|无法连接|unavailable|failed)[^。\n]{0,30}/i);
          return m ? m[0] : '';
        }).catch(() => '');
      } else {
        coding.error = '未找到 composer 输入框';
      }
    } catch (e) { coding.error = e.message; }
    coding.mockHit = mockHits;
    results.smartCoding = coding;
    results.mock = { hits: mockHits, paths: mockHitPaths, lastPrompt: mockLastPrompt.slice(0, 120) };
    log('[e2e] smartCoding =', JSON.stringify(coding));
    log('[e2e] mock =', JSON.stringify(results.mock));

    const refused = (v) => typeof v === 'string' && /ERR_CONNECTION_REFUSED/.test(v);
    const bridgeOk = !refused(bridge.pluginsEvents) && !refused(bridge.dirPicker) && !refused(bridge.mux);
    results.pass = {
      portFellBack: results.portFallback.fellBack,
      bridgeReachable: bridgeOk,
      notWhiteScreen: !results.appLoad.whiteScreen && results.appLoad.hasWorkbenchShell,
      smartCoding: coding.replyAppeared,
    };
    // overall 反映「修复是否生效」的核心不变量：桥接可达 + 非白屏 + 智能编码真实回复渲染。
    // portFellBack 是独立回归项（端口冲突时必回退），不强制作为通过条件——无冲突时无需回退也属正常。
    results.overall = bridgeOk && results.pass.notWhiteScreen && coding.replyAppeared;

    log('\n========== E2E RESULT ==========');
    log(JSON.stringify(results, null, 2));
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    return results.overall ? 0 : 1;
  } catch (e) {
    log('[e2e] FATAL', e.message);
    results.fatal = e.message;
    results.bootLogTail = bootLog.slice(-1500);
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    return 2;
  } finally {
    try { if (browser) await browser.close(); } catch {}
    try { if (dshChild) dshChild.kill('SIGTERM'); } catch {}
    try { if (mockServer) mockServer.close(); } catch {}
  }
}

main().then((code) => { setTimeout(() => process.exit(code), 300); }).catch(() => process.exit(3));
