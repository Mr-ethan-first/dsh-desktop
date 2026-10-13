/**
 * Probe #3 — discriminator: does Baidu's /s captcha come from automation or
 * from the iframe? Warm up on the homepage (top-level), then load /s?wd=test:
 *   (a) top-level tab        (b) inside the sidebar-style iframe
 * If (a) also captchas, the captcha is automation-driven and the iframe is
 * not the cause. If only (b) captchas, the iframe embedding is the cause.
 */
const http = require('node:http');
const PW = 'D:/WorkSpace/deepseek-harness-master/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright';
const { chromium } = require(PW);

const SB = 'allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox allow-same-origin';
const embed = `<!doctype html><html><body style="margin:0"><iframe id="f" src="https://www.baidu.com/" sandbox="${SB}" referrerpolicy="no-referrer" allow="" style="width:100%;height:600px;border:0"></iframe></body></html>`;

const verdict = (u) => (!u ? 'none' : /wappass|captcha|verify/.test(u) ? 'CAPTCHA' : /www\.baidu\.com\/s\?/.test(u) ? 'RESULTS' : u.slice(0, 90));

async function run() {
  const server = http.createServer((req, res) => {
    if (new URL(req.url, 'http://x').pathname === '/embed') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(embed); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({ headless: !process.argv.includes('--headed'), channel: 'chrome', args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const out = {};

  // (a) top-level: warm up on the homepage, then search
  const p1 = await ctx.newPage();
  await p1.goto('https://www.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await p1.waitForTimeout(2500);
  await p1.goto('https://www.baidu.com/s?wd=test', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await p1.waitForTimeout(3000);
  out.topLevel = verdict(p1.url());
  out.topLevelUrl = p1.url().slice(0, 120);

  // (b) inside the sandboxed+same-origin iframe
  const p2 = await ctx.newPage();
  await p2.goto(`http://127.0.0.1:${port}/embed`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p2.waitForTimeout(3000);
  const f0 = p2.frames().find((x) => /baidu\.com/.test(x.url()));
  // warm the frame's own cookies, then navigate the frame to /s
  if (f0) { await f0.goto('https://www.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); await p2.waitForTimeout(2000); }
  const f1 = p2.frames().find((x) => /baidu\.com/.test(x.url()));
  if (f1) { await f1.goto('https://www.baidu.com/s?wd=test', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); }
  await p2.waitForTimeout(3000);
  const f2 = p2.frames().find((x) => /baidu\.com/.test(x.url()));
  out.inIframe = verdict(f2 ? f2.url() : undefined);
  out.inIframeUrl = (f2 ? f2.url() : '').slice(0, 120);

  console.log(JSON.stringify(out, null, 2));
  await browser.close(); server.close();
}
run().catch((e) => { console.error('FATAL', e); process.exit(1); });
