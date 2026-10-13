/**
 * Empirically probe how Baidu search behaves inside the dsh-better-sidebar
 * browser iframe, under three sandbox configurations. A tiny loopback HTTP
 * server hosts the embedder page (mimicking the GUI at 127.0.0.1:5283), and
 * Playwright drives the cross-origin iframe.
 *
 * Usage: node scripts/_baidu_sandbox_probe.cjs [--headed]
 */
const http = require('node:http');
const path = require('node:path');

const PW = 'D:/WorkSpace/deepseek-harness-master/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright';
const { chromium } = require(PW);

// Mirrors BROWSER_IFRAME_SANDBOX from dsh-better-sidebar/lib/client.js
const BASE = 'allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox';
const MODES = {
  current: BASE,
  sameOrigin: `${BASE} allow-same-origin`,
  none: null,
};

const html = (sb) => `<!doctype html><html><head><meta charset="utf-8"><title>embed</title></head>
<body style="margin:0">
<iframe id="f" src="https://www.baidu.com/"${sb ? ` sandbox="${sb}"` : ''} referrerpolicy="no-referrer" allow="" style="width:100%;height:640px;border:0"></iframe>
</body></html>`;

async function run() {
  const server = http.createServer((req, res) => {
    const mode = new URL(req.url, 'http://127.0.0.1').searchParams.get('mode');
    if (mode && mode in MODES) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html(MODES[mode]));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
  const out = [];
  for (const mode of Object.keys(MODES)) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    const navigations = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 160)));
    page.on('framenavigated', (f) => { if (f !== page.mainFrame()) navigations.push(f.url().slice(0, 120)); });

    const rec = { mode };
    try {
      await page.goto(`http://127.0.0.1:${port}/?mode=${mode}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const frame = await (async () => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const f = page.frames().find((x) => /baidu\.com/.test(x.url()));
          if (f) return f;
          await page.waitForTimeout(300);
        }
        return null;
      })();
      if (!frame) throw new Error('baidu iframe never appeared');
      await frame.waitForSelector('#kw, input[name=wd]', { timeout: 20000 });
      await frame.fill('#kw', 'test');
      const su = (await frame.$('#su')) || (await frame.$('input[type=submit]')) || (await frame.$('button[type=submit]'));
      if (!su) throw new Error('no submit control (#su) found');
      await su.click({ timeout: 8000 });
      await page.waitForTimeout(7000);
      const sameFrame = page.frames().find((x) => /baidu\.com/.test(x.url()));
      rec.afterUrl = (sameFrame ? sameFrame.url() : frame.url()).slice(0, 160);
      rec.wentToResults = /\/s\?/.test(rec.afterUrl);
      rec.wentToCaptcha = /wappass|captcha|verify|passport/.test(rec.afterUrl);
    } catch (e) {
      rec.error = String(e && e.message ? e.message : e).slice(0, 200);
    }
    rec.navigations = navigations.slice(0, 4);
    rec.errors = errors.slice(0, 4);
    out.push(rec);
    await ctx.close();
  }
  await browser.close();
  server.close();
  console.log(JSON.stringify(out, null, 2));
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
