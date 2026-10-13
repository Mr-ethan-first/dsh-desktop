/**
 * Probe #2 — decisive: load Baidu's search RESULTS url directly inside the
 * sidebar-style iframe (current sandbox vs +allow-same-origin), and report the
 * frame's final URL (results vs wappass captcha) plus cookie storage.
 */
const http = require('node:http');
const PW = 'D:/WorkSpace/deepseek-harness-master/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright';
const { chromium } = require(PW);

const BASE = 'allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox';
const MODES = { current: BASE, sameOrigin: `${BASE} allow-same-origin` };

const page = (sb) => `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<iframe id="f" src="https://www.baidu.com/s?wd=test"${sb ? ` sandbox="${sb}"` : ''} referrerpolicy="no-referrer" allow="" style="width:100%;height:600px;border:0"></iframe>
</body></html>`;

async function run() {
  const server = http.createServer((req, res) => {
    const mode = new URL(req.url, 'http://127.0.0.1').searchParams.get('mode');
    if (mode && mode in MODES) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(MODES[mode])); return; }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({
    headless: !process.argv.includes('--headed'),
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const out = [];
  for (const mode of Object.keys(MODES)) {
    const ctx = await browser.newContext({ locale: 'zh-CN' });
    const p = await ctx.newPage();
    const errs = [];
    p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 140)); });
    const rec = { mode };
    try {
      await p.goto(`http://127.0.0.1:${port}/?mode=${mode}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const deadline = Date.now() + 25000;
      let f = null;
      while (Date.now() < deadline) { f = p.frames().find((x) => /baidu\.com/.test(x.url())); if (f && /\/s\?|\/s$|wappass|test/.test(f.url())) break; await p.waitForTimeout(400); }
      await p.waitForTimeout(6000);
      f = p.frames().find((x) => /baidu\.com/.test(x.url())) || f;
      rec.finalUrl = f ? f.url().slice(0, 200) : null;
      rec.isResults = !!f && /www\.baidu\.com\/s\?/.test(f.url());
      rec.isCaptcha = !!f && /wappass|captcha|verify/.test(f.url());
      rec.secErrors = errs.filter((e) => /sandboxed and lacks|x-same-origin|SecurityError/i.test(e)).slice(0, 2);
    } catch (e) { rec.error = String(e && e.message || e).slice(0, 160); }
    out.push(rec);
    await ctx.close();
  }
  await browser.close(); server.close();
  console.log(JSON.stringify(out, null, 2));
}
run().catch((e) => { console.error('FATAL', e); process.exit(1); });
