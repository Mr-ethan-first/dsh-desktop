#!/usr/bin/env node
/**
 * UI 回归验证（针对 dist 构建产物，无需启动 Electron）：
 *  ① 侧栏收起后布局正常（chat-main 在第 2 列、无内容挤到左缘）
 *  ② 输入框可粘贴剪贴板截图（出现附件 chip）
 * 启动静态服务托管 dist（SPA 回退），Playwright chromium 驱动。
 */
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { chromium } = require('D:/WorkSpace/deepseek-harness-master/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');

const ROOT = 'D:/WorkSpace/deepseek-harness-master/apps/agent-client';
const DIST = path.join(ROOT, 'dist');
const PORT = 5189;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  let fp = path.join(DIST, p);
  if (!fp.startsWith(DIST) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    fp = path.join(DIST, 'index.html'); // SPA 回退
  }
  res.setHeader('content-type', MIME[path.extname(fp)] || 'application/octet-stream');
  res.end(fs.readFileSync(fp));
});

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  console.log('static server on', PORT);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1092, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('textarea', { timeout: 15000 });

  // ---------- ① 侧栏收起布局 ----------
  await page.screenshot({ path: 'D:/WorkSpace/deepseek-harness-master/ui-before-collapse.png' });
  const collapseBtn = page.locator('.sidebar-collapse-btn').first();
  await collapseBtn.click();
  await page.waitForTimeout(600);

  const layout = await page.evaluate(() => {
    const chat = document.querySelector('.chat');
    const main = document.querySelector('.chat-main');
    const sidebar = document.querySelector('.chat-sidebar');
    const cs = chat ? getComputedStyle(chat) : null;
    const mr = main ? main.getBoundingClientRect() : null;
    const cols = cs ? cs.gridTemplateColumns : '';
    return {
      hideLeft: document.documentElement.dataset.hideLeft,
      cols,
      sidebarDisplay: sidebar ? getComputedStyle(sidebar).display : 'n/a',
      mainRect: mr ? { x: mr.x, w: mr.width, h: mr.height } : null,
      mainVisible: !!mr && mr.width > 300 && mr.height > 200,
    };
  });
  console.log('collapse layout:', JSON.stringify(layout));
  await page.screenshot({ path: 'D:/WorkSpace/deepseek-harness-master/ui-after-collapse.png' });

  // 重新展开，确认可恢复
  const reopen = page.locator('.sidebar-reopen-btn').first();
  if (await reopen.count()) {
    await reopen.click();
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      hideLeft: document.documentElement.dataset.hideLeft,
      sidebarBack: !!document.querySelector('.chat-sidebar'),
    }));
    console.log('reopen:', JSON.stringify(after));
  }

  // ---------- ② 粘贴截图 ----------
  // 生成 1x1 png
  const pngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pngBytes = Buffer.from(pngB64, 'base64');
  await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], 'clipboard-image.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ta = document.querySelector('textarea');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
  }, pngB64);
  await page.waitForTimeout(800);
  const paste = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('.attachment-chip, [class*=attachment]')).map(
      (n) => n.textContent?.slice(0, 40),
    );
    return { chipCount: chips.length, chips };
  });
  console.log('paste:', JSON.stringify(paste));
  await page.screenshot({ path: 'D:/WorkSpace/deepseek-harness-master/ui-paste.png' });

  console.log('pageerrors:', errors.length ? errors : 'none');
  const ok =
    layout.mainVisible &&
    layout.sidebarDisplay === 'none' &&
    paste.chipCount > 0 &&
    errors.length === 0;
  console.log(ok ? 'UI_VERIFY_PASS' : 'UI_VERIFY_FAIL');
  await browser.close();
  server.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
