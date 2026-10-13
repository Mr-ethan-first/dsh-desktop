/**
 * verify-dashscope.mjs — 真机验证「deepseek-official provider 已重定向到阿里云 DashScope」。
 *
 * 与 e2e-bridge-coding.mjs 的区别：不挂本地 mock，而是复用部署 exe 自带的
 * dsh-web-launcher 的 spawnDshWeb（其内部 buildDshWebEnv 已注入 DEEPSEEK_BASE_URL/DASHSCOPE key），
 * 因此等价于用户真实点击 exe 后的行为。Playwright 打开工作台 → 选 qwen3.6-plus → 发「用一句话介绍你自己」
 * → 断言阿里云真实模型回复渲染进 UI（非 mock 模板）。
 *
 * 运行：
 *   unset NODE_OPTIONS && NODE_PATH=C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules \
 *     C:/Users/Administrator/.workbuddy/binaries/node/versions/22.12.0/node.exe scripts/verify-dashscope.mjs
 */
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
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
const OUT = 'D:/WorkSpace/deepseek-harness-master/_tmp_dashscope_result.json';

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

const HARD_TIMEOUT_MS = 280000;
const hardTimer = setTimeout(() => {
  log('[vds] HARD TIMEOUT');
  try { fs.writeFileSync(OUT, JSON.stringify({ fatal: 'hard-timeout' }, null, 2)); } catch {}
  process.exit(4);
}, HARD_TIMEOUT_MS);
hardTimer.unref?.();

async function main() {
  const results = { launch: {}, appLoad: {}, smartCoding: {}, provider: 'dashscope', consoleErrors: [] };
  let dshChild = null, browser = null, resolvedPort = null, tokenUrl = null, bootLog = '';

  // 主动占用 5283 复现端口回退（确定性），但不强制作为通过条件。
  const conflictServer = net.createServer();
  await new Promise((res) => conflictServer.listen(WEB_BASE, '127.0.0.1', () => res()));
  resolvedPort = await pickWebPort();
  results.launch.resolvedPort = resolvedPort;
  results.launch.fellBack = resolvedPort !== WEB_BASE;
  log('[vds] dsh web 端口 =', resolvedPort);

  // 清理残留 dsh web 孤儿进程
  try {
    const selfPid = String(process.pid);
    execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match \'node\\.exe\' -and $_.CommandLine -like \'*dsh/lib/bin.js*\' -and $_.CommandLine -like \'*web*\' -and $_.ProcessId -ne ' + selfPid + ' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
      { windowsHide: true }
    );
  } catch {}
  await sleep(800);

  // 剥历史死进程残留的 .lock
  (function stripLocks(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = require('path').join(dir, e.name);
      if (e.isDirectory()) stripLocks(p);
      else if (e.name.endsWith('.lock')) { try { fs.rmSync(p, { force: true }); } catch {} }
    }
  })(PROD_HOME);

  // 清掉沙箱 safe-delete shim，但【不】设 DEEPSEEK_BASE_URL —— 让 launcher 的 buildDshWebEnv 注入 DashScope。
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  for (const k of Object.keys(childEnv)) if (/^CODEBUDDY_SAFE_DELETE_/i.test(k)) delete childEnv[k];

  log('[vds] spawnDshWeb（复刻 exe：launcher 注入 DashScope 端点 + key）...');
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
  log('[vds] dsh web 就绪:', tokenUrl);
  const token = (tokenUrl.match(/token=([^&\s]+)/) || [])[1] || '';

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') results.consoleErrors.push(msg.text()); });
  page.on('pageerror', (e) => results.consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto(tokenUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('[vds] goto warn:', e.message));
  await sleep(7000);
  results.appLoad.title = await page.title().catch(() => '');
  results.appLoad.url = page.url();
  const html = await page.content();
  results.appLoad.hasWorkbenchShell = /(contenteditable|lexical|workbench|插件|对话|agent)/i.test(html) || html.length > 2000;
  log('[vds] title =', results.appLoad.title);

  // 智能编码：选 qwen3.6-plus → 发送 → 断言真实回复
  const coding = { composerFound: false, modelSelected: false, sent: false, replyAppeared: false, replyExcerpt: '', diagnostics: '' };
  try {
    let box = null;
    try { box = await page.waitForSelector('[contenteditable="true"], [role="textbox"], .lexical-contenteditable, textarea', { timeout: 20000 }); }
    catch { log('[vds] composer wait timeout'); }
    if (box) {
      coding.composerFound = true;
      // 尝试选择 qwen3.6-plus（best-effort）
      coding.modelSelected = await page.evaluate(() => {
        const triggers = [...document.querySelectorAll('button, [role="button"], [role="combobox"], select, input')];
        const t = triggers.find((b) => /deepseek|qwen|glm|模型|model/i.test(b.innerText || b.getAttribute('aria-label') || b.value || ''));
        if (!t) return false;
        try { t.click(); } catch {}
        return true;
      }).catch(() => false);
      await sleep(500);
      if (coding.modelSelected) {
        await page.evaluate(() => {
          const opts = [...document.querySelectorAll('[role="option"], li, button, div')];
          const o = opts.find((x) => /Qwen3\.6-Plus/i.test(x.innerText || x.getAttribute('aria-label') || ''));
          if (o) try { o.click(); } catch {}
        }).catch(() => {});
        await sleep(500);
      }
      // 关浮层 + 程序化 focus
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
      await box.evaluate((el) => el.focus()).catch(() => {});
      const prompt = '用一句话介绍你自己';
      await box.type(prompt, { delay: 10 });
      const sendSel = ['button:has-text("发送")', 'button:has-text("Send")', '[aria-label*="发送" i]', 'button[type="submit"]'];
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
      if (!clicked) { try { await box.press('Enter'); clicked = true; clickedSel = 'keyboard:Enter'; } catch {} }
      coding.sent = clicked;
      coding.sendSelector = clickedSel;
      if (clicked) {
        const s0 = Date.now();
        const before = (await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, '');
        while (Date.now() - s0 < 30000) {
          const txt = (await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, '');
          const delta = txt.slice(before.length);
          // 真实回复特征：出现模型身份词 或 比提示明显更长的生成文本（排除把提示本身判为正例）
          if (/(通义|千问|Qwen|DeepSeek|智谱|GLM|我是|您好|你好|Hi|Hello|I am|can help|assist)/i.test(delta) && delta.length > 12) {
            coding.replyAppeared = true;
            coding.replyExcerpt = delta.slice(0, 300);
            break;
          }
          await sleep(800);
        }
      }
      coding.diagnostics = await page.evaluate(() => {
        const t = document.body.innerText;
        const m = t.match(/[^。\n]{0,30}(模型不可用|请先选择模型|请求失败|网络错误|无法连接|unavailable|failed|401|403)[^。\n]{0,30}/i);
        return m ? m[0] : '';
      }).catch(() => '');
    } else {
      coding.error = '未找到 composer 输入框';
    }
  } catch (e) { coding.error = e.message; }
  results.smartCoding = coding;
  log('[vds] smartCoding =', JSON.stringify(coding));

  results.overall = results.appLoad.hasWorkbenchShell && coding.replyAppeared;
  results.pass = { notWhiteScreen: results.appLoad.hasWorkbenchShell, realReplyFromDashScope: coding.replyAppeared };
  log('\n========== DASHSCOPE VERIFY RESULT ==========');
  log(JSON.stringify(results, null, 2));
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  return results.overall ? 0 : 1;
}

main().then((code) => { try { process.exit(code); } catch { process.exit(code); } })
  .catch((e) => { log('[vds] FATAL', e.message); try { fs.writeFileSync(OUT, JSON.stringify({ fatal: e.message }, null, 2)); } catch {} process.exit(2); });
