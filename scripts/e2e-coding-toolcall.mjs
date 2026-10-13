/**
 * e2e-coding-toolcall.mjs — 验证「工具调用空名」修复后，agent 能真正生成代码。
 *
 * 直接 require exe 内置 dsh-web-launcher.cjs（与 exe 同款运行时），拉起 dsh web，
 * 用 Playwright 进入会话、发送用户原始触发语「帮我写一个Vue3的演示html文件」，
 * 轮询页面 + dsh web 日志，确认：
 *   - 不再出现 `unknown tool ""` / `工具调用 · Error`
 *   - 工具调用成功，页面出现代码块 / 文件保存结果（即「能正常生成代码」）
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const EXE_ROOT = 'D:/DeepSeekAgent';
const NODE24 = path.join(EXE_ROOT, 'resources', 'node24', 'node.exe');
const DSH_DIR = path.join(EXE_ROOT, 'resources', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh');
const LAUNCHER = path.join(EXE_ROOT, 'resources', 'app.asar.unpacked', 'electron', 'plugin-host', 'dsh-web-launcher.cjs');
const WORK = 'D:/WorkSpace/deepseek-harness-master';
const REAL_DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home';
const DSH_HOME = REAL_DSH_HOME;
const LOG_DIR = path.join(WORK, '_tmp_coding_logs');
const SCR_DIR = path.join(WORK, '_tmp_coding_screens');
const OUT = path.join(WORK, '_tmp_coding_toolcall_result.json');
const DSH_LOG = path.join(LOG_DIR, 'dsh-web-stdio.log');

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SCR_DIR, { recursive: true });
if (!fs.existsSync(path.join(DSH_HOME, 'profiles', 'web', 'package.json')))
  throw new Error('真实 DSH_HOME 缺少 web profile: ' + DSH_HOME);

const log = (...a) => console.log('[coding-e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {
  spawned: false, tokenUrl: null, entered: false, sent: false,
  unknownToolErrorSeen: false, unknownToolErrorSource: null,
  toolCallSucceeded: false, codeGenerated: false, successSignal: null,
  pageExcerpt: '', overall: false,
};

function fetchUrl(url, t = 3000) {
  return new Promise((res) => {
    const r = http.get(url, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, body: b })); });
    r.on('error', (e) => res({ status: 0, error: e.message }));
    r.setTimeout(t, () => { r.destroy(); res({ status: 0, error: 'timeout' }); });
  });
}
async function preCleanup() {
  // 1) 按命令行特征杀掉残留 dsh web
  try {
    spawn('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { (($_.CommandLine -like '*dsh/lib/bin.js*' -or $_.CommandLine -like '*lib\\\\bin.js*') -and $_.CommandLine -like '*web*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, stdio: 'ignore' });
  } catch {}
  // 2) 按端口 5283 兜底杀（防止命令行特征没匹配到）
  try {
    spawn('powershell', ['-NoProfile', '-Command',
      "$pids = (Get-NetTCPConnection -LocalPort 5283 -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique; foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, stdio: 'ignore' });
  } catch {}
  await sleep(5000);
}
function screenshot(page, name) { try { const p = path.join(SCR_DIR, `${name}-${Date.now()}.png`); return page.screenshot({ path: p }).then(() => p); } catch { return null; } }

async function main() {
  const launcher = require(LAUNCHER);
  const launch = launcher.resolveDshLaunch({ cliDir: DSH_DIR });
  if (!launch) throw new Error('resolveDshLaunch null');
  await preCleanup();
  const WEB_PORT = 5283;
  const dshLogFd = fs.openSync(DSH_LOG, 'w');
  let tokenUrl = null;
  const capture = (s) => {
    try { fs.writeSync(dshLogFd, s); } catch {}
    const mm = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_.%-]+)/.exec(s);
    if (mm && !tokenUrl) { tokenUrl = mm[1]; log('token URL:', tokenUrl); }
  };
  const childEnv = { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' };
  const child = launcher.spawnDshWeb({ bin: launch.bin, nodeArgs: launch.nodeArgs, runtime: NODE24, port: WEB_PORT, dshHome: DSH_HOME, baseEnv: childEnv, childProcess: { spawn }, onLog: capture });
  results.spawned = !!child;
  if (!child) throw new Error('spawnDshWeb null');
  const dl = Date.now() + 60000;
  while (Date.now() < dl && !tokenUrl) await sleep(1000);
  if (!tokenUrl) throw new Error('60s 内未捕获 token URL');
  results.tokenUrl = tokenUrl;

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push('PAGEERROR: ' + e.message));

    await page.goto(tokenUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('goto warn', e.message));
    await sleep(9000);
    await screenshot(page, '01-initial');

    // 关闭内测声明
    for (let i = 0; i < 3; i++) {
      const c = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button, [role="button"], a')].find((x) => /^(继续|确认|我知道了|同意|Got it|Continue)$/i.test((x.innerText || '').trim()));
        if (b) { b.click(); return true; }
        const modal = document.querySelector('[role="dialog"], [class*="modal" i]');
        if (modal) { const x = modal.querySelector('button'); if (x) { x.click(); return true; } }
        return false;
      }).catch(() => false);
      if (c) log('关闭内测声明');
      await sleep(1200);
    }

    // 进入新会话
    const opened = await page.evaluate(() => {
      const all = [...document.querySelectorAll('button, [role="button"], a, div[role="button"]')];
      const t = all.find((b) => /新会话|新建对话|New Chat/i.test((b.innerText || b.getAttribute('aria-label') || '').trim())) ||
        all.find((b) => (b.getAttribute('aria-label') || '').includes('新建会话'));
      if (t) { t.click(); return (t.innerText || '').slice(0, 30); }
      const card = document.querySelector('[class*="workspace" i], [class*="project" i]');
      if (card) { card.click(); return 'card'; }
      return null;
    }).catch(() => null);
    if (opened) log('进入会话入口:', opened);
    results.entered = !!opened;
    await sleep(3000);

    // 选模型（best-effort）
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, [role="button"], [role="combobox"], select, input')];
      const t = els.find((b) => /deepseek|qwen|glm|模型|model/i.test(b.innerText || b.getAttribute('aria-label') || b.value || ''));
      if (t) try { t.click(); } catch {}
    }).catch(() => {});
    await sleep(800);

    // 发送用户原始触发语
    const composer = await (async () => {
      const sels = ['[contenteditable="true"]', '[role="textbox"]', '.lexical-contenteditable', 'textarea'];
      for (const sel of sels) {
        const els = await page.$$(sel).catch(() => []);
        for (const el of els) {
          const meta = await el.evaluate((e) => ({ aria: e.getAttribute('aria-label') || '', ph: e.getAttribute('placeholder') || '' })).catch(() => ({}));
          if (/选择工作区|workspace/i.test(meta.aria || meta.ph)) continue;
          return el;
        }
      }
      return null;
    })();
    if (!composer) throw new Error('composer not found');
    await composer.evaluate((el) => { el.focus(); el.innerText = ''; }).catch(() => {});
    await composer.type('帮我写一个Vue3的演示html文件', { delay: 5 });
    const sendSel = ['button:has-text("发送")', 'button:has-text("Send")', '[aria-label*="发送" i]', 'button[type="submit"]', '[class*="send" i]'];
    let clicked = false;
    for (const sel of sendSel) { const b = await page.$(sel).catch(() => null); if (b) { await b.evaluate((el) => el.click()).catch(() => {}); clicked = true; break; } }
    if (!clicked) await composer.press('Enter');
    results.sent = true;
    log('已发送触发语，开始轮询…');

    // 轮询：捕捉 unknown tool 错误 / 工具成功 / 代码生成
    const start = Date.now();
    const TIMEOUT = 150000;
    let lastExcerpt = '';
    while (Date.now() - start < TIMEOUT) {
      const info = await page.evaluate(() => {
        const t = document.body.innerText;
        const h = document.body.innerHTML;
        return {
          t,
          hasCodeBlock: /<pre\b/i.test(h) || /```/.test(t),
          hasVueCode: /<!DOCTYPE html>|<html|createApp|vue\.global|Vue\.createApp|<script src=.*vue/i.test(t),
          hasUnknownTool: /unknown tool/i.test(t) || /工具调用\s*·\s*Error/i.test(t) || /unknown tool ""/.test(t),
          hasFileResult: /(已保存|保存成功|文件已|文件已创建|写入|demo\.html|vue3-demo\.html|\.html)/i.test(t),
          toolCallsMade: /(\d+\s*次工具调用|工具调用\s*成功|创建成功|文件已创建)/i.test(t),
        };
      }).catch(() => ({}));
      lastExcerpt = info.t || '';
      if (info.hasUnknownTool) {
        results.unknownToolErrorSeen = true;
        results.unknownToolErrorSource = 'page';
        results.pageExcerpt = (info.t || '').replace(/\s+/g, ' ').slice(0, 500);
        log('❌ 页面出现 unknown tool 错误');
        break;
      }
      if (info.toolCallsMade && (info.hasFileResult || info.hasCodeBlock || info.hasVueCode)) {
        results.toolCallSucceeded = true;
        results.codeGenerated = true;
        results.successSignal = 'tool-calls-made-and-file-or-code';
        results.pageExcerpt = (info.t || '').replace(/\s+/g, ' ').slice(0, 600);
        log('✅ 工具调用成功且生成了文件/代码');
        break;
      }
      if (info.hasCodeBlock && info.hasVueCode) {
        results.toolCallSucceeded = true;
        results.codeGenerated = true;
        results.successSignal = 'vue-code-block';
        results.pageExcerpt = (info.t || '').replace(/\s+/g, ' ').slice(0, 500);
        log('✅ 检测到 Vue 代码块生成');
        break;
      }
      await sleep(2000);
    }
    // 兜底：若超时仍未判定，抓取当前文本
    if (!results.unknownToolErrorSeen && !results.codeGenerated) {
      const t = await page.evaluate(() => document.body.innerText).catch(() => '');
      results.pageExcerpt = t.replace(/\s+/g, ' ').slice(0, 800);
      const unknownInLog = pageErrors.some((e) => /unknown tool/i.test(e));
      if (unknownInLog) { results.unknownToolErrorSeen = true; results.unknownToolErrorSource = 'console'; }
    }
    await screenshot(page, '02-result');
  } finally {
    await browser.close().catch(() => {});
  }

  // 检查 dsh web 日志是否有 unknown tool
  try {
    const logText = fs.readFileSync(DSH_LOG, 'utf8');
    if (/unknown tool/i.test(logText)) { results.unknownToolErrorSeen = true; results.unknownToolErrorSource = results.unknownToolErrorSource || 'dsh-web-log'; }
  } catch {}

  results.overall = results.spawned && results.sent && !results.unknownToolErrorSeen && results.codeGenerated;
}

try { await main(); }
catch (e) { results.fatal = e.message; log('FATAL', e.message); }
finally {
  log('\n========== CODING TOOLCALL E2E ==========');
  log(JSON.stringify(results, null, 2));
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  try { spawn('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { (($_.CommandLine -like '*dsh/lib/bin.js*' -or $_.CommandLine -like '*lib\\\\bin.js*') -and $_.CommandLine -like '*web*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { windowsHide: true, stdio: 'ignore' }); } catch {}
  setTimeout(() => process.exit(results.overall ? 0 : 1), 500);
}
