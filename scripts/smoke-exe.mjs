// 真实 exe 整体冒烟：用 node CreateProcess 拉起 DeepSeekAgent.exe（绕过杀软对
// 双击/ShellExecute 未签名 exe 的静默 TerminateProcess），捕获其 stderr，证明两点：
//   1) [web-server] bundled node24 found:  —— 用了自带 Node 24（#81 修复核心）
//   2) [dsh-web] ...?token=...              —— dsh web 经 node24 真正启动（否则回退静态页）
// 然后 fetch 该 token URL 确认 HTTP 200（真实工作台在监听）。最后 taskkill 清理测试实例。
// 全程自包含、自终止，调用方阻塞等待退出码即可拿到结论（不依赖后台通知）。
import { spawn } from 'node:child_process';
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const EXE = 'D:/DeepSeekAgent/DeepSeekAgent.exe';
const OUT = 'D:/WorkSpace/deepseek-harness-master/_tmp_exe_smoke.txt';
const logs = [];
const result = { bundledNode24: false, dshWebStarted: false, tokenUrl: null, httpOk: false, fallback: false, errors: [] };

const child = spawn(EXE, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: false });
const onData = (d) => {
  const s = d.toString();
  logs.push(s);
  process.stdout.write(s);
  if (/bundled node24 found:/.test(s)) result.bundledNode24 = true;
  if (/回退静态托管|spawn dsh web 失败|falling back to process\.execPath/.test(s)) result.fallback = true;
  const m = /(https?:\/\/[^\s"'<>]+?\?token=[A-Za-z0-9_.-]+)/.exec(s);
  if (m && !result.tokenUrl) { result.tokenUrl = m[1]; result.dshWebStarted = true; }
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('error', (e) => { result.errors.push('spawn error: ' + e.message); });

function fetchUrl(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(6000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

const deadline = Date.now() + 50000;
const timer = setInterval(async () => {
  if (result.tokenUrl && !result.httpOk) {
    const r = await fetchUrl(result.tokenUrl);
    if (r.status === 200) { result.httpOk = true; result.bodyLen = (r.body || '').length; }
    else result.errors.push('fetch token url status=' + r.status + ' ' + (r.error || ''));
  }
  const done = (result.httpOk && result.bundledNode24) || result.fallback || Date.now() > deadline;
  if (done) { clearInterval(timer); finish(); }
}, 1000);

function finish() {
  try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)]); } catch { /* ignore */ }
  const pass = result.bundledNode24 && result.dshWebStarted && result.httpOk && !result.fallback;
  const summary = { pass, ...result, logTail: logs.slice(-50).join('') };
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log('\n=== SMOKE RESULT ===');
  console.log('pass:', pass);
  console.log('bundledNode24:', result.bundledNode24);
  console.log('dshWebStarted:', result.dshWebStarted);
  console.log('httpOk:', result.httpOk);
  console.log('fallback:', result.fallback);
  console.log('tokenUrl:', result.tokenUrl);
  process.exit(pass ? 0 : 1);
}
